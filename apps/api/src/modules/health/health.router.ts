import { Router } from 'express';
import type { HealthReadyResponse } from '@game-admin/shared';

export interface HealthDeps {
  pingDb: () => Promise<boolean>;
  pingRedis: () => Promise<boolean>;
}

/**
 * /health/live  : 프로세스 생존 여부 (의존성 확인 안 함)
 * /health/ready : MySQL·Redis 연결 확인. 하나라도 실패하면 503
 */
export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });

  router.get('/ready', async (_req, res) => {
    const [mysql, redis] = await Promise.all([deps.pingDb(), deps.pingRedis()]);
    const body: HealthReadyResponse = {
      status: mysql && redis ? 'ok' : 'degraded',
      checks: { mysql: mysql ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    };
    res.status(body.status === 'ok' ? 200 : 503).json({ data: body });
  });

  return router;
}
