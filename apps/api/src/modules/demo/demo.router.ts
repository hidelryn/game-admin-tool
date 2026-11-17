import { Router } from 'express';
import type { Env } from '../../config/env.js';
import { demoInfo } from './demo-info.js';

/** GET /public/demo — 로그인 화면용 체험 계정 안내 (인증 없음). 체험 모드가 꺼져 있으면 enabled=false */
export function demoRouter(deps: { env: Env }): Router {
  const router = Router();
  router.get('/public/demo', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: demoInfo(deps.env) });
  });
  return router;
}
