import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Express } from 'express';
import { loadEnv } from '../../src/config/env.js';
import { createDb } from '../../src/infra/db/client.js';
import { createRedis } from '../../src/infra/redis/client.js';
import { seedCore } from '../../src/infra/db/seed/core.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import { buildApp, buildServices, type AppContext, type Services } from '../../src/bootstrap.js';
import { createMemoryAssetStorage } from '../../src/infra/storage/asset-storage.js';
import { userCurrencies, users } from '../../src/infra/db/schema/index.js';
import type { Executor } from '../../src/infra/db/types.js';

export const TEST_PASSWORD = 'Test-password-1234';

export const ADMIN = {
  super: 'super@example.com',
  operator: 'operator@example.com',
  cs: 'cs@example.com',
  viewer: 'viewer@example.com',
} as const;

export const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

export interface TestContext {
  app: Express;
  ctx: AppContext;
  /** 라우트가 없는 기능(우편 수령, 점수 기록 등)을 직접 호출할 때 */
  services: Services;
  /** 모든 테이블 비우고 기준 데이터 시드 */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const m = inject('mysql');
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MYSQL_HOST: m.host,
    MYSQL_PORT: String(m.port),
    MYSQL_USER: m.user,
    MYSQL_PASSWORD: m.password,
    MYSQL_DATABASE: m.database,
    REDIS_URL: inject('redisUrl'),
    REDIS_KEY_PREFIX: `ga:test:${randomUUID().slice(0, 8)}:`,
    JWT_ACCESS_SECRET: 'integration-test-secret-'.padEnd(48, 'x'),
    ARGON2_MEMORY_KIB: '4096',
    ARGON2_TIME_COST: '2',
    REFRESH_REUSE_GRACE_SEC: '0',
    ...overrides,
  });
  const logger = pino({ level: 'silent' });
  const db = createDb(env);
  const redis = createRedis(env, logger);
  await redis.connect();
  const ctx: AppContext = { env, logger, db, redis, assetStorage: createMemoryAssetStorage() };
  const hasher = createPasswordHasher({ memoryCost: 4096, timeCost: 2 });
  const passwordHash = await hasher.hash(TEST_PASSWORD);

  const services = buildServices(ctx);
  return {
    app: buildApp(ctx, services),
    ctx,
    services,
    async reset() {
      const conn = await db.pool.getConnection();
      try {
        const [rows] = await conn.query(
          `SELECT table_name AS t FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations'`,
        );
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const { t } of rows as { t: string }[]) await conn.query(`TRUNCATE TABLE \`${t}\``);
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      } finally {
        conn.release();
      }
      await redis.redis.flushdb();
      await seedCore(db.db, { adminPasswordHash: passwordHash });
    },
    async close() {
      await Promise.allSettled([db.close(), redis.close()]);
    },
  };
}

export async function login(app: Express, email: string, password = TEST_PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const cookie = setCookie.find((c) => c.startsWith('ga_rt='))!.split(';')[0]!;
  return { accessToken: res.body.data.accessToken as string, cookie, body: res.body };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Idempotency-Key 헤더 */
export const idem = (key = randomUUID()) => ({ 'Idempotency-Key': key });

let userSeq = 0;
export async function createUser(
  db: Executor,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<{ id: number; publicId: string }> {
  userSeq += 1;
  const publicId =
    overrides.publicId ?? `T${String(userSeq).padStart(6, '0')}${randomUUID().slice(0, 4)}`;
  const [row] = await db
    .insert(users)
    .values({
      publicId,
      nickname: `테스터${userSeq}`,
      email: `tester${userSeq}@example.com`,
      registeredAt: new Date(),
      ...overrides,
    })
    .$returningId();
  return { id: row!.id, publicId };
}

export async function setBalance(
  db: Executor,
  userId: number,
  currencyId: number,
  balance: number,
) {
  await db
    .insert(userCurrencies)
    .values({ userId, currencyId, balance, version: 0 })
    .onDuplicateKeyUpdate({ set: { balance } });
}

export async function getBalance(db: Executor, userId: number, currencyId: number) {
  const [row] = await db
    .select({ balance: userCurrencies.balance })
    .from(userCurrencies)
    .where(and(eq(userCurrencies.userId, userId), eq(userCurrencies.currencyId, currencyId)));
  return row?.balance ?? 0;
}

export const CURRENCY = { GOLD: 1, GEM: 2, STAMINA: 3, FREE_GEM: 4 } as const;
