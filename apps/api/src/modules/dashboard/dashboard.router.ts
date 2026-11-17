import { Router, type RequestHandler } from 'express';
import { currencyFlowsQuerySchema, Permission, trendsQuerySchema } from '@game-admin/shared';
import { requirePermission } from '../auth/auth.middleware.js';
import type { DashboardService } from './dashboard.service.js';

export function dashboardRouter(deps: {
  dashboardService: DashboardService;
  authenticate: RequestHandler;
}): Router {
  const { dashboardService, authenticate } = deps;
  const router = Router();
  const guard = [authenticate, requirePermission(Permission.DASHBOARD_READ)];

  router.get('/dashboard/summary', ...guard, async (_req, res) => {
    res.json({ data: await dashboardService.summary() });
  });

  router.get('/dashboard/trends', ...guard, async (req, res) => {
    res.json({ data: await dashboardService.trends(trendsQuerySchema.parse(req.query)) });
  });

  router.get('/dashboard/currency-flows', ...guard, async (req, res) => {
    res.json({
      data: await dashboardService.currencyFlows(currencyFlowsQuerySchema.parse(req.query)),
    });
  });

  return router;
}
