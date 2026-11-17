import { Router, type RequestHandler } from 'express';
import {
  Channel,
  createApiTokenRequestSchema,
  idParamSchema,
  Permission,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requireChannel, requirePermission } from '../auth/auth.middleware.js';
import type { ApiTokenService } from './api-token.service.js';

/** /me/api-tokens — 본인 토큰 관리 (웹 전용) */
export function apiTokensRouter(deps: {
  apiTokenService: ApiTokenService;
  authenticate: RequestHandler;
}): Router {
  const { apiTokenService, authenticate } = deps;
  const router = Router();
  const guard = [
    authenticate,
    requireChannel(Channel.WEB),
    requirePermission(Permission.TOKEN_MANAGE_OWN),
  ];

  router.get('/me/api-tokens', ...guard, async (req, res) => {
    res.json({ data: await apiTokenService.listFor(req.auth!.adminId) });
  });

  router.post('/me/api-tokens', ...guard, async (req, res) => {
    const input = createApiTokenRequestSchema.parse(req.body);
    res
      .status(201)
      .json({ data: await apiTokenService.create(req.auth!, input, auditContextOf(req)) });
  });

  router.delete('/me/api-tokens/:tokenId', ...guard, async (req, res) => {
    await apiTokenService.revoke(
      req.auth!.adminId,
      idParamSchema.parse(req.params.tokenId),
      auditContextOf(req),
    );
    res.status(204).end();
  });

  return router;
}
