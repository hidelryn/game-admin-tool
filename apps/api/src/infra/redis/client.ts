import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../common/logger.js';

export function createRedis(env: Env, logger: Logger) {
  const redis = new Redis(env.REDIS_URL, {
    keyPrefix: env.REDIS_KEY_PREFIX,
    // 연결이 끊겨도 요청이 무한 대기하지 않도록 (architecture.md 7.3 — Redis 장애 시 빠르게 실패)
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  redis.on('ready', () => logger.info('redis connected'));

  return {
    redis,
    connect: () => redis.connect(),
    async ping(): Promise<boolean> {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}

export type RedisHandle = ReturnType<typeof createRedis>;
