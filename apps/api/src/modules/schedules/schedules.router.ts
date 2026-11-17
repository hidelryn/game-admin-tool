import { Router, type RequestHandler } from 'express';
import {
  createScheduleRequestSchema,
  idParamSchema,
  listSchedulesQuerySchema,
  Permission,
  scheduleActionRequestSchema,
  updateScheduleRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Idempotency } from '../safety/idempotency.js';
import type { ScheduleService } from './schedule.service.js';

/**
 * /schedules (docs/schedule.md)
 * - 생성: 멱등 키 필수 (더블 클릭으로 같은 일정이 두 개 생기지 않게)
 * - 수정·취소·조기 종료: version 으로 동시 수정 방지, 진행 중이면 확인 토큰(L2)
 */
export function schedulesRouter(deps: {
  scheduleService: ScheduleService;
  idempotency: Idempotency;
  authenticate: RequestHandler;
}): Router {
  const { scheduleService, idempotency, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.SCHEDULE_READ)];
  const manage = [authenticate, requirePermission(Permission.SCHEDULE_MANAGE)];
  const id = (v: unknown) => idParamSchema.parse(v);

  router.get('/schedules', ...read, async (req, res) => {
    res.json({ data: await scheduleService.list(listSchedulesQuerySchema.parse(req.query)) });
  });

  router.get('/schedules/:id', ...read, async (req, res) => {
    res.json({ data: await scheduleService.get(id(req.params.id)) });
  });

  router.post('/schedules', ...manage, async (req, res) => {
    const input = createScheduleRequestSchema.parse(req.body);
    await idempotency.run(req, res, input, async (record) => {
      const view = await scheduleService.create(
        req.auth!,
        input,
        auditContextOf(req),
        (tx, newId) => record(tx, 201, { data: { id: newId } }),
      );
      return { status: 201, body: { data: view } };
    });
  });

  router.put('/schedules/:id', ...manage, async (req, res) => {
    const input = updateScheduleRequestSchema.parse(req.body);
    res.json({
      data: await scheduleService.update(req.auth!, id(req.params.id), input, auditContextOf(req)),
    });
  });

  router.post('/schedules/:id/cancel', ...manage, async (req, res) => {
    const input = scheduleActionRequestSchema.parse(req.body);
    res.json({
      data: await scheduleService.cancel(req.auth!, id(req.params.id), input, auditContextOf(req)),
    });
  });

  router.post('/schedules/:id/end-now', ...manage, async (req, res) => {
    const input = scheduleActionRequestSchema.parse(req.body);
    res.json({
      data: await scheduleService.endNow(req.auth!, id(req.params.id), input, auditContextOf(req)),
    });
  });

  return router;
}
