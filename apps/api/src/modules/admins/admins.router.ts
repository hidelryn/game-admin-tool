import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  createAdminRequestSchema,
  idParamSchema,
  listAdminsQuerySchema,
  Permission,
  permissionOverridesRequestSchema,
  reasonSchema,
  resetPasswordRequestSchema,
  updateAdminRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { ApiTokenService } from '../api-tokens/api-token.service.js';
import type { AdminService } from './admin.service.js';

const revokeBodySchema = z.object({ reason: reasonSchema });

/** /admins, /roles, /permissions — 모두 admin:manage 필요 */
export function adminsRouter(deps: {
  adminService: AdminService;
  apiTokenService: ApiTokenService;
  authenticate: RequestHandler;
}): Router {
  const { adminService, apiTokenService, authenticate } = deps;
  const router = Router();
  const guard = [authenticate, requirePermission(Permission.ADMIN_MANAGE)];

  router.get('/admins', ...guard, async (req, res) => {
    const { items, meta } = await adminService.list(listAdminsQuerySchema.parse(req.query));
    res.json({ data: items, meta });
  });

  router.post('/admins', ...guard, async (req, res) => {
    const input = createAdminRequestSchema.parse(req.body);
    res
      .status(201)
      .json({ data: await adminService.create(req.auth!, input, auditContextOf(req)) });
  });

  router.get('/admins/:adminId', ...guard, async (req, res) => {
    res.json({ data: await adminService.get(idParamSchema.parse(req.params.adminId)) });
  });

  router.patch('/admins/:adminId', ...guard, async (req, res) => {
    const id = idParamSchema.parse(req.params.adminId);
    const input = updateAdminRequestSchema.parse(req.body);
    res.json({ data: await adminService.update(req.auth!, id, input, auditContextOf(req)) });
  });

  router.put('/admins/:adminId/permission-overrides', ...guard, async (req, res) => {
    const id = idParamSchema.parse(req.params.adminId);
    const input = permissionOverridesRequestSchema.parse(req.body);
    res.json({ data: await adminService.setOverrides(req.auth!, id, input, auditContextOf(req)) });
  });

  router.post('/admins/:adminId/reset-password', ...guard, async (req, res) => {
    const id = idParamSchema.parse(req.params.adminId);
    const input = resetPasswordRequestSchema.parse(req.body);
    res.json({ data: await adminService.resetPassword(req.auth!, id, input, auditContextOf(req)) });
  });

  router.get('/admins/:adminId/api-tokens', ...guard, async (req, res) => {
    res.json({ data: await apiTokenService.listFor(idParamSchema.parse(req.params.adminId)) });
  });

  router.delete('/admins/:adminId/api-tokens/:tokenId', ...guard, async (req, res) => {
    const adminId = idParamSchema.parse(req.params.adminId);
    const tokenId = idParamSchema.parse(req.params.tokenId);
    const { reason } = revokeBodySchema.parse(req.body ?? {});
    await apiTokenService.revoke(adminId, tokenId, auditContextOf(req), reason);
    res.status(204).end();
  });

  router.get('/roles', ...guard, async (_req, res) => {
    res.json({ data: await adminService.listRoles() });
  });

  router.get('/permissions', ...guard, async (_req, res) => {
    res.json({ data: await adminService.listPermissions() });
  });

  return router;
}
