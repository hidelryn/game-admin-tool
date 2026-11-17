import { Router, type RequestHandler } from 'express';
import {
  churnQuerySchema,
  Permission,
  purchaseAnalyticsQuerySchema,
  retentionQuerySchema,
  spendingQuerySchema,
} from '@game-admin/shared';
import { requirePermission } from '../auth/auth.middleware.js';
import type { AnalyticsService } from './analytics.service.js';

/** 유저 분석 (docs/analytics.md) — 조회 전용, 웹·MCP 모두 */
export function analyticsRouter(deps: {
  analyticsService: AnalyticsService;
  authenticate: RequestHandler;
}): Router {
  const { analyticsService, authenticate } = deps;
  const router = Router();
  const guard = [authenticate, requirePermission(Permission.ANALYTICS_READ)];

  router.get('/analytics/churn', ...guard, async (req, res) => {
    res.json({ data: await analyticsService.churn(churnQuerySchema.parse(req.query)) });
  });
  router.get('/analytics/retention', ...guard, async (req, res) => {
    res.json({ data: await analyticsService.retention(retentionQuerySchema.parse(req.query)) });
  });
  router.get('/analytics/purchases', ...guard, async (req, res) => {
    res.json({
      data: await analyticsService.purchases(purchaseAnalyticsQuerySchema.parse(req.query)),
    });
  });
  router.get('/analytics/spending', ...guard, async (req, res) => {
    res.json({ data: await analyticsService.spending(spendingQuerySchema.parse(req.query)) });
  });

  return router;
}
