import { Router, type RequestHandler } from 'express';
import {
  activitiesQuerySchema,
  listUsersQuerySchema,
  Permission,
  publicIdSchema,
  suspendUserRequestSchema,
  unsuspendUserRequestSchema,
} from '@game-admin/shared';
import { auditContextOf } from '../audit/audit.writer.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { UserService } from './user.service.js';

export function usersRouter(deps: {
  userService: UserService;
  authenticate: RequestHandler;
}): Router {
  const { userService, authenticate } = deps;
  const router = Router();
  const read = [authenticate, requirePermission(Permission.USER_READ)];
  const pid = (v: unknown) => publicIdSchema.parse(v);

  router.get('/users', ...read, async (req, res) => {
    const { items, meta } = await userService.list(listUsersQuerySchema.parse(req.query));
    res.json({ data: items, meta });
  });

  router.get('/users/:publicId', ...read, async (req, res) => {
    res.json({ data: await userService.detail(pid(req.params.publicId)) });
  });

  router.get(
    '/users/:publicId/pii',
    authenticate,
    requirePermission(Permission.USER_READ_PII),
    async (req, res) => {
      res.json({ data: await userService.pii(pid(req.params.publicId), auditContextOf(req)) });
    },
  );

  router.get('/users/:publicId/activities', ...read, async (req, res) => {
    const { items, meta } = await userService.activities(
      pid(req.params.publicId),
      activitiesQuerySchema.parse(req.query),
    );
    res.json({ data: items, meta });
  });

  router.get('/users/:publicId/suspensions', ...read, async (req, res) => {
    res.json({ data: await userService.suspensions(pid(req.params.publicId)) });
  });

  router.post(
    '/users/:publicId/suspend',
    authenticate,
    requirePermission(Permission.USER_SUSPEND),
    async (req, res) => {
      const input = suspendUserRequestSchema.parse(req.body);
      res.status(201).json({
        data: await userService.suspend(
          req.auth!,
          pid(req.params.publicId),
          input,
          auditContextOf(req),
        ),
      });
    },
  );

  router.post(
    '/users/:publicId/unsuspend',
    authenticate,
    requirePermission(Permission.USER_SUSPEND),
    async (req, res) => {
      const input = unsuspendUserRequestSchema.parse(req.body);
      await userService.unsuspend(req.auth!, pid(req.params.publicId), input, auditContextOf(req));
      res.status(204).end();
    },
  );

  return router;
}
