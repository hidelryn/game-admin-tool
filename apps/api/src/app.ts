import express, { type Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import type { Logger } from './common/logger.js';
import { requestId } from './common/middleware/request-id.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { healthRouter, type HealthDeps } from './modules/health/health.router.js';

export interface AppDeps {
  logger: Logger;
  corsOrigins: string[];
  health: HealthDeps;
  /** 기능 라우터 묶음 (bootstrap.ts 에서 조립). 없으면 헬스 체크만 */
  apiRouter?: Router;
}

/**
 * Express 앱 조립. listen 은 server.ts 에서 — 테스트는 이 함수만 import 한다.
 */
export function createApp(deps: AppDeps) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Nginx 뒤에서 실제 클라이언트 IP 사용

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
      customProps: (req) => ({ requestId: (req as express.Request).id }),
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: deps.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use('/health', healthRouter(deps.health));
  if (deps.apiRouter) api.use(deps.apiRouter);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
