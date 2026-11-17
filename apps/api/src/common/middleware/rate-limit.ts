import type { Request, RequestHandler } from 'express';
import { ErrorCode } from '@game-admin/shared';
import type { Logger } from '../logger.js';
import { AppError } from '../errors/app-error.js';
import type { RedisHandle } from '../../infra/redis/client.js';

/**
 * Redis 고정 윈도 Rate Limit (architecture.md 5장)
 * - INCR + 첫 요청 시 EXPIRE → 윈도 안에서 limit 초과 시 429 + Retry-After
 * - Redis 장애 시 fail-open (경고 로그) — 로그인 무차별 대입은 DB 계정 잠금이 따로 막는다
 */
export function createRateLimit(opts: {
  redis: RedisHandle;
  logger: Logger;
  name: string;
  limit: number;
  windowSec: number;
  keyOf?: (req: Request) => string;
}): RequestHandler {
  const keyOf = opts.keyOf ?? ((req) => req.ip ?? 'unknown');
  return async (req, res, next) => {
    const key = `rl:${opts.name}:${keyOf(req)}`;
    let count: number;
    let ttl: number;
    try {
      const results = await opts.redis.redis
        .multi()
        .incr(key)
        .expire(key, opts.windowSec, 'NX')
        .ttl(key)
        .exec();
      count = Number(results?.[0]?.[1] ?? 0);
      ttl = Number(results?.[2]?.[1] ?? opts.windowSec);
    } catch (err) {
      opts.logger.warn(
        { err: (err as Error).message, name: opts.name },
        'rate limit skipped (redis unavailable)',
      );
      return next();
    }
    res.setHeader('RateLimit-Limit', String(opts.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - count)));
    if (count > opts.limit) {
      res.setHeader('Retry-After', String(Math.max(1, ttl)));
      throw new AppError(
        429,
        ErrorCode.RATE_LIMITED,
        `요청이 너무 많습니다. ${Math.max(1, ttl)}초 후 다시 시도하세요.`,
      );
    }
    next();
  };
}
