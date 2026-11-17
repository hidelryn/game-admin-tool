import { Router, type RequestHandler } from 'express';
import { idParamSchema, listAuditLogsQuerySchema, Permission } from '@game-admin/shared';
import { requirePermission } from '../auth/auth.middleware.js';
import type { AuditService } from './audit.service.js';

export function auditRouter(deps: {
  auditService: AuditService;
  authenticate: RequestHandler;
}): Router {
  const { auditService, authenticate } = deps;
  const router = Router();
  const guard = [authenticate, requirePermission(Permission.AUDIT_READ)];

  router.get('/audit-logs', ...guard, async (req, res) => {
    const { items, meta } = await auditService.list(
      req.auth!,
      listAuditLogsQuerySchema.parse(req.query),
    );
    res.json({ data: items, meta });
  });

  router.get('/audit-logs/:id', ...guard, async (req, res) => {
    res.json({ data: await auditService.get(req.auth!, idParamSchema.parse(req.params.id)) });
  });

  return router;
}
