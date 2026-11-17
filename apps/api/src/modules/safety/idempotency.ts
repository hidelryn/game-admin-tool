import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { ErrorCode } from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  UnauthorizedError,
} from '../../common/errors/app-error.js';
import { hashPayload } from '../../common/http/stable-hash.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import type { Executor } from '../../infra/db/types.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import { idempotencyKeys } from '../../infra/db/schema/index.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const LOCK_TTL_SEC = 60;
const RESULT_TTL_SEC = 24 * 3600;

interface StoredResponse {
  status: number;
  body: unknown;
  hash: string;
}

/** 업무 트랜잭션 안에서 호출: 결과를 idempotency_keys 에 같이 커밋 */
export type RecordResult = (tx: Executor, status: number, body: unknown) => Promise<void>;

/**
 * 중복 실행 방지 (architecture.md 6장) — Redis 락(빠른 거절) + DB 유니크(최종 보장)
 *
 * 1. Idempotency-Key 헤더 필수
 * 2. Redis SET NX 로 처리 중 표시 → 이미 처리 중이면 409, 완료된 결과가 있으면 그대로 재응답
 * 3. DB 에 같은 키가 있으면: 같은 요청 → 저장된 응답 재응답 / 다른 요청 → 422
 * 4. 업무 트랜잭션 안에서 결과를 함께 INSERT (유니크) → 커밋
 * 5. 실패(에러, 확인 필요 등)는 저장하지 않고 키를 해제 → 같은 키로 재시도 가능
 */
export function createIdempotency(deps: { db: Executor; redis: RedisHandle; logger: Logger }) {
  const { db, redis, logger } = deps;

  const redisKey = (adminId: number, key: string) => `idem:${adminId}:${key}`;

  async function tryRedis<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'idempotency redis unavailable — DB 유니크 제약으로만 보호',
      );
      return fallback;
    }
  }

  async function findStored(adminId: number, key: string) {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.adminId, adminId), eq(idempotencyKeys.idemKey, key)))
      .limit(1);
    return row;
  }

  function replay(res: Response, stored: { status: number; body: unknown }) {
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(stored.status).json(stored.body);
  }

  return {
    /**
     * @param payload 요청을 대표하는 값 (확인 토큰처럼 재시도 시 바뀌는 값은 빼고 전달)
     * @param op 업무 실행. 성공 결과를 같은 트랜잭션에서 record() 로 저장해야 한다
     */
    async run(
      req: Request,
      res: Response,
      payload: unknown,
      op: (record: RecordResult) => Promise<{ status: number; body: unknown }>,
    ): Promise<void> {
      const auth = req.auth;
      if (!auth) throw new UnauthorizedError();
      const key = req.header('idempotency-key');
      if (!key || !KEY_PATTERN.test(key)) {
        throw new AppError(
          400,
          ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          'Idempotency-Key 헤더가 필요합니다 (UUID 권장).',
        );
      }
      const hash = hashPayload({ method: req.method, path: req.baseUrl + req.path, payload });
      const rKey = redisKey(auth.adminId, key);

      // 1) Redis: 처리 중 표시
      const locked = await tryRedis(
        async () => (await redis.redis.set(rKey, 'IN_PROGRESS', 'EX', LOCK_TTL_SEC, 'NX')) === 'OK',
        true,
      );
      if (!locked) {
        const cached = await tryRedis(() => redis.redis.get(rKey), null);
        if (cached && cached !== 'IN_PROGRESS') {
          const stored = JSON.parse(cached) as StoredResponse;
          if (stored.hash !== hash) throw keyReused();
          return replay(res, stored);
        }
        throw new ConflictError(
          ErrorCode.REQUEST_IN_PROGRESS,
          '같은 요청을 처리 중입니다. 잠시 후 다시 시도하세요.',
        );
      }

      let done = false;
      try {
        // 2) DB: 이미 처리된 키인지
        const existing = await findStored(auth.adminId, key);
        if (existing) {
          if (existing.requestHash !== hash) throw keyReused();
          done = true;
          await cacheResult(rKey, {
            status: existing.responseStatus,
            body: existing.responseBody,
            hash,
          });
          return replay(res, { status: existing.responseStatus, body: existing.responseBody });
        }

        // 3) 실행
        let result: { status: number; body: unknown };
        try {
          result = await op(async (tx, status, body) => {
            await tx.insert(idempotencyKeys).values({
              adminId: auth.adminId,
              idemKey: key,
              requestHash: hash,
              responseStatus: status,
              responseBody: body,
            });
          });
        } catch (err) {
          // Redis 없이 동시 실행된 경우: 먼저 커밋된 쪽 결과를 돌려준다
          if (isDuplicateKeyError(err)) {
            const winner = await findStored(auth.adminId, key);
            if (winner) {
              if (winner.requestHash !== hash) throw keyReused();
              done = true;
              return replay(res, { status: winner.responseStatus, body: winner.responseBody });
            }
          }
          throw err;
        }
        done = true;
        await cacheResult(rKey, { ...result, hash });
        res.status(result.status).json(result.body);
      } finally {
        if (!done) await tryRedis(() => redis.redis.del(rKey), 0);
      }
    },
  };

  async function cacheResult(rKey: string, stored: StoredResponse) {
    await tryRedis(() => redis.redis.set(rKey, JSON.stringify(stored), 'EX', RESULT_TTL_SEC), null);
  }
}

function keyReused() {
  return new BusinessRuleError(
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    '같은 Idempotency-Key 로 다른 요청을 보낼 수 없습니다.',
  );
}

export type Idempotency = ReturnType<typeof createIdempotency>;
