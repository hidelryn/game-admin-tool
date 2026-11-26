import { Router, type RequestHandler } from 'express';
import {
  cancelEmailRequestSchema,
  emailPreviewRequestSchema,
  emailRenderRequestSchema,
  EmailTargetType,
  idParamSchema,
  listEmailCampaignsQuerySchema,
  listEmailDeliveriesQuerySchema,
  Permission,
  sendEmailRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { EmailService } from './email.service.js';

/** 이메일 발송 (docs/email.md) */
export function emailsRouter(deps: {
  emailService: EmailService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
  /** 체험 계정의 주소 직접 입력 발송 — IP 당 시간당 횟수 제한. 그 외 요청은 통과 */
  demoAddressLimit?: RequestHandler;
}): Router {
  const { emailService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.EMAIL_READ)];
  const send = [authenticate, requirePermission(Permission.EMAIL_SEND)];
  const demoAddressLimit: RequestHandler = deps.demoAddressLimit ?? ((_req, _res, next) => next());

  router.get('/emails', ...read, async (req, res) => {
    const { items, meta } = await emailService.list(listEmailCampaignsQuerySchema.parse(req.query));
    res.json({ data: items, meta });
  });

  router.get('/emails/limits', ...read, (req, res) => {
    res.json({ data: emailService.limits(req.auth!) });
  });

  router.get('/emails/:campaignId', ...read, async (req, res) => {
    res.json({ data: await emailService.detail(idParamSchema.parse(req.params.campaignId)) });
  });

  router.get('/emails/:campaignId/deliveries', ...read, async (req, res) => {
    const { items, meta } = await emailService.deliveries(
      idParamSchema.parse(req.params.campaignId),
      listEmailDeliveriesQuerySchema.parse(req.query),
    );
    res.json({ data: items, meta });
  });

  /** 작성 화면 미리보기 — 아무것도 보내지 않음 */
  router.post('/emails/preview', ...send, async (req, res) => {
    res.json({
      data: await emailService.preview(req.auth!, emailPreviewRequestSchema.parse(req.body)),
    });
  });

  /** "메일 미리보기" — 보낼 디자인 그대로 HTML (아무것도 보내지 않음) */
  router.post('/emails/render', ...send, (req, res) => {
    res.json({ data: emailService.render(req.auth!, emailRenderRequestSchema.parse(req.body)) });
  });

  router.post(
    '/emails',
    ...send,
    (req, res, next) =>
      (req.body as { target?: { type?: string } } | undefined)?.target?.type ===
      EmailTargetType.ADDRESS
        ? demoAddressLimit(req, res, next)
        : next(),
    async (req, res) => {
      const input = sendEmailRequestSchema.parse(req.body);
      await idempotency.run(req, res, input, async (record) => {
        const result = await emailService.send(req.auth!, input, auditContextOf(req), (tx, r) =>
          record(tx, 201, { data: r }),
        );
        return { status: 201, body: { data: result } };
      });
    },
  );

  router.post('/emails/:campaignId/cancel', ...send, async (req, res) => {
    res.json({
      data: await emailService.cancel(
        req.auth!,
        idParamSchema.parse(req.params.campaignId),
        cancelEmailRequestSchema.parse(req.body),
        auditContextOf(req),
      ),
    });
  });

  return router;
}
