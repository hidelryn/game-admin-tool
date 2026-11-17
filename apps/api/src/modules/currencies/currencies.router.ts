import { Router, type RequestHandler } from 'express';
import {
  bulkGrantRequestSchema,
  changeCurrencyRequestSchema,
  currencyTransactionsQuerySchema,
  Permission,
  publicIdSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { ChangeOp, CurrencyService } from './currency.service.js';

export function currenciesRouter(deps: {
  currencyService: CurrencyService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
}): Router {
  const { currencyService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.CURRENCY_READ)];
  const pid = (v: unknown) => publicIdSchema.parse(v);

  router.get('/currencies', ...read, async (_req, res) => {
    res.json({ data: await currencyService.list() });
  });

  router.get('/users/:publicId/currencies', ...read, async (req, res) => {
    res.json({ data: await currencyService.balances(pid(req.params.publicId)) });
  });

  router.get('/users/:publicId/currency-transactions', ...read, async (req, res) => {
    const q = currencyTransactionsQuerySchema.parse({
      ...req.query,
      publicId: pid(req.params.publicId),
    });
    const { items, meta } = await currencyService.transactions(q);
    res.json({ data: items, meta });
  });

  router.get('/currency-transactions', ...read, async (req, res) => {
    const { items, meta } = await currencyService.transactions(
      currencyTransactionsQuerySchema.parse(req.query),
    );
    res.json({ data: items, meta });
  });

  const changeRoute = (op: ChangeOp, permission: Permission): RequestHandler[] => [
    authenticate,
    requirePermission(permission),
    async (req, res) => {
      const publicId = pid(req.params.publicId);
      const input = changeCurrencyRequestSchema.parse(req.body);
      const { confirmationToken: _token, ...stable } = input;
      // 확인 토큰은 재시도마다 달라지므로 요청 해시에서 제외 → 같은 Idempotency-Key 로 2차 호출 가능
      await idempotency.run(req, res, { op, publicId, ...stable }, async (record) => {
        const result = await currencyService.change(
          req.auth!,
          op,
          publicId,
          input,
          auditContextOf(req),
          (tx, r) => record(tx, 200, { data: r }),
        );
        return { status: 200, body: { data: result } };
      });
    },
  ];

  router.post(
    '/users/:publicId/currencies/grant',
    ...changeRoute('GRANT', Permission.CURRENCY_GRANT),
  );
  router.post(
    '/users/:publicId/currencies/deduct',
    ...changeRoute('DEDUCT', Permission.CURRENCY_DEDUCT),
  );

  router.post(
    '/currencies/bulk-grant',
    authenticate,
    requirePermission(Permission.CURRENCY_GRANT),
    async (req, res) => {
      const input = bulkGrantRequestSchema.parse(req.body);
      await idempotency.run(req, res, input, async (record) => {
        const result = await currencyService.bulkGrant(
          req.auth!,
          input,
          auditContextOf(req),
          record,
        );
        return { status: 200, body: { data: result } };
      });
    },
  );

  return router;
}
