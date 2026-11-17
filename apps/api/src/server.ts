import { loadEnv } from './config/env.js';
import { createLogger } from './common/logger.js';
import { createDb } from './infra/db/client.js';
import { createRedis } from './infra/redis/client.js';
import { buildApp } from './bootstrap.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });

const db = createDb(env);
const redis = createRedis(env, logger);

// Redis 연결 실패는 기동을 막지 않는다 (랭킹 외 기능은 동작해야 함 — requirements NFR 가용성)
await redis
  .connect()
  .catch((err: Error) => logger.warn({ err: err.message }, 'redis initial connect failed'));

if (!(await db.ping())) {
  logger.warn('mysql not reachable at startup — /health/ready 가 503 을 반환합니다');
}

const app = buildApp({ env, logger, db, redis });

const server = app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'api server listening');
});

// Graceful shutdown (architecture.md 7.3)
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('graceful shutdown timeout — forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'http server close error');
    await Promise.allSettled([db.close(), redis.close()]);
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});
