import { Router, type RequestHandler } from 'express';
import {
  cancelMailRequestSchema,
  idParamSchema,
  listMailsQuerySchema,
  pageQuerySchema,
  Permission,
  publicIdSchema,
  sendGlobalMailRequestSchema,
  sendMailRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { MailService } from './mail.service.js';

export function mailsRouter(deps: {
  mailService: MailService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
}): Router {
  const { mailService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.MAIL_READ)];

  router.get('/items', ...read, async (_req, res) => {
    res.json({ data: await mailService.listItems() });
  });

  router.get('/mails', ...read, async (req, res) => {
    const { items, meta } = await mailService.list(listMailsQuerySchema.parse(req.query));
    res.json({ data: items, meta });
  });

  router.get('/mails/:mailId', ...read, async (req, res) => {
    res.json({ data: await mailService.detail(idParamSchema.parse(req.params.mailId)) });
  });

  router.get('/mails/:mailId/recipients', ...read, async (req, res) => {
    const { page, size } = pageQuerySchema.parse(req.query);
    const { items, meta } = await mailService.recipients(
      idParamSchema.parse(req.params.mailId),
      page,
      size,
    );
    res.json({ data: items, meta });
  });

  router.get('/users/:publicId/mails', ...read, async (req, res) => {
    res.json({ data: await mailService.mailbox(publicIdSchema.parse(req.params.publicId)) });
  });

  router.post('/mails', authenticate, requirePermission(Permission.MAIL_SEND), async (req, res) => {
    const input = sendMailRequestSchema.parse(req.body);
    await idempotency.run(req, res, input, async (record) => {
      const result = await mailService.sendToUsers(req.auth!, input, auditContextOf(req), (tx, r) =>
        record(tx, 201, { data: r }),
      );
      return { status: 201, body: { data: result } };
    });
  });

  router.post(
    '/mails/global',
    authenticate,
    requirePermission(Permission.MAIL_SEND_ALL),
    async (req, res) => {
      const input = sendGlobalMailRequestSchema.parse(req.body);
      await idempotency.run(req, res, input, async (record) => {
        const result = await mailService.sendGlobal(
          req.auth!,
          input,
          auditContextOf(req),
          (tx, r) => record(tx, 201, { data: r }),
        );
        return { status: 201, body: { data: result } };
      });
    },
  );

  router.post(
    '/mails/:mailId/cancel',
    authenticate,
    requirePermission(Permission.MAIL_SEND),
    async (req, res) => {
      const input = cancelMailRequestSchema.parse(req.body);
      res.json({
        data: await mailService.cancel(
          req.auth!,
          idParamSchema.parse(req.params.mailId),
          input,
          auditContextOf(req),
        ),
      });
    },
  );

  return router;
}
