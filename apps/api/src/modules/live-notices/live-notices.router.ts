import { Router, type RequestHandler } from 'express';
import {
  createMaintenanceRequestSchema,
  createNoticeRequestSchema,
  hideNoticeRequestSchema,
  idParamSchema,
  listMaintenancesQuerySchema,
  listNoticesQuerySchema,
  maintenanceActionRequestSchema,
  Permission,
  updateMaintenanceRequestSchema,
  updateNoticeRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { MaintenanceService } from './maintenance.service.js';
import type { NoticeService } from './notice.service.js';

/**
 * /maintenances, /notices (docs/maintenance-notice.md)
 * - 생성: 멱등 키 필수
 * - 수정·취소·지금 열기: version 으로 동시 수정 방지, 긴급 시작·연장·지금 열기는 확인 토큰(L2)
 * - 점검 목록 조회는 notice:read (전 역할) — 점검 중인지 누구나 알아야 하므로
 */
export function liveNoticesRouter(deps: {
  maintenanceService: MaintenanceService;
  noticeService: NoticeService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
}): Router {
  const { maintenanceService, noticeService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.NOTICE_READ)];
  const manageMaintenance = [authenticate, requirePermission(Permission.MAINTENANCE_MANAGE)];
  const manageNotice = [authenticate, requirePermission(Permission.NOTICE_MANAGE)];
  const id = (v: unknown) => idParamSchema.parse(v);

  // ───────── 점검 ─────────

  /** 상단 띠용 — 로그인한 운영자 누구나 */
  router.get('/maintenances/current', authenticate, async (_req, res) => {
    res.json({ data: await maintenanceService.current() });
  });

  router.get('/maintenances', ...read, async (req, res) => {
    const { items, meta } = await maintenanceService.list(
      listMaintenancesQuerySchema.parse(req.query),
    );
    res.json({ data: items, meta });
  });

  router.get('/maintenances/:id', ...read, async (req, res) => {
    res.json({ data: await maintenanceService.get(id(req.params.id)) });
  });

  router.post('/maintenances', ...manageMaintenance, async (req, res) => {
    const input = createMaintenanceRequestSchema.parse(req.body);
    await idempotency.run(req, res, input, async (record) => {
      const view = await maintenanceService.create(
        req.auth!,
        input,
        auditContextOf(req),
        (tx, newId) => record(tx, 201, { data: { id: newId } }),
      );
      return { status: 201, body: { data: view } };
    });
  });

  router.put('/maintenances/:id', ...manageMaintenance, async (req, res) => {
    const input = updateMaintenanceRequestSchema.parse(req.body);
    res.json({
      data: await maintenanceService.update(
        req.auth!,
        id(req.params.id),
        input,
        auditContextOf(req),
      ),
    });
  });

  router.post('/maintenances/:id/cancel', ...manageMaintenance, async (req, res) => {
    const input = maintenanceActionRequestSchema.parse(req.body);
    res.json({
      data: await maintenanceService.cancel(
        req.auth!,
        id(req.params.id),
        input,
        auditContextOf(req),
      ),
    });
  });

  router.post('/maintenances/:id/open-now', ...manageMaintenance, async (req, res) => {
    const input = maintenanceActionRequestSchema.parse(req.body);
    res.json({
      data: await maintenanceService.openNow(
        req.auth!,
        id(req.params.id),
        input,
        auditContextOf(req),
      ),
    });
  });

  // ───────── 공지 ─────────

  router.get('/notices', ...read, async (req, res) => {
    const { items, meta } = await noticeService.list(listNoticesQuerySchema.parse(req.query));
    res.json({ data: items, meta });
  });

  router.get('/notices/:id', ...read, async (req, res) => {
    res.json({ data: await noticeService.get(id(req.params.id)) });
  });

  router.post('/notices', ...manageNotice, async (req, res) => {
    const input = createNoticeRequestSchema.parse(req.body);
    await idempotency.run(req, res, input, async (record) => {
      const view = await noticeService.create(req.auth!, input, auditContextOf(req), (tx, newId) =>
        record(tx, 201, { data: { id: newId } }),
      );
      return { status: 201, body: { data: view } };
    });
  });

  router.put('/notices/:id', ...manageNotice, async (req, res) => {
    const input = updateNoticeRequestSchema.parse(req.body);
    res.json({
      data: await noticeService.update(req.auth!, id(req.params.id), input, auditContextOf(req)),
    });
  });

  router.post('/notices/:id/hide', ...manageNotice, async (req, res) => {
    const input = hideNoticeRequestSchema.parse(req.body);
    res.json({
      data: await noticeService.hide(req.auth!, id(req.params.id), input, auditContextOf(req)),
    });
  });

  return router;
}
