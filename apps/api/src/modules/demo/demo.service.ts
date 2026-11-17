import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuditAction, RoleCode } from '@game-admin/shared';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../common/logger.js';
import type { DbHandle } from '../../infra/db/client.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import type { AssetStorage } from '../../infra/storage/asset-storage.js';
import { admins, roles } from '../../infra/db/schema/index.js';
import { seedCore } from '../../infra/db/seed/core.js';
import { seedGame, type SeedScale } from '../../infra/db/seed/game.js';
import { backfill } from '../../jobs/kpi.js';
import { systemAuditContext, writeAudit } from '../audit/audit.writer.js';
import type { PasswordHasher } from '../auth/password.js';

/**
 * 체험 모드 (docs/demo-mode.md)
 * - 공개 체험 계정: 운영자 권한, 비밀번호 변경·API 토큰 발급 불가, 로그인 실패로 잠기지 않음(IP 제한은 유지)
 * - 매일 초기화: 운영 데이터 전부 지우고 기준·가상 데이터를 다시 넣는다 (운영자 계정·권한은 유지)
 */
export const DEMO_ACCOUNT_NAME = '체험 운영자';
export { DEMO_RESET_HOUR_KST } from './demo-info.js';

/** 초기화해도 남기는 표: 마이그레이션 기록, 운영자·역할·권한, 토큰·세션 */
const KEEP_TABLES = new Set([
  '__drizzle_migrations',
  'admins',
  'roles',
  'permissions',
  'role_permissions',
  'admin_permission_overrides',
  'api_tokens',
  'refresh_tokens',
]);

export { isDemoEmail } from './is-demo.js';
export { demoInfo, nextResetAt } from './demo-info.js';

/** 체험 계정을 만들거나 env 값에 맞춘다 (비밀번호·역할·잠금 해제). 여러 번 실행해도 안전 */
export async function ensureDemoAccount(deps: {
  db: DbHandle['db'];
  env: Env;
  hasher: PasswordHasher;
}): Promise<'created' | 'updated' | 'skipped'> {
  const { db, env, hasher } = deps;
  if (!env.DEMO_MODE || !env.DEMO_ACCOUNT_PASSWORD) return 'skipped';
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, RoleCode.OPERATOR))
    .limit(1);
  if (!role) throw new Error('OPERATOR 역할이 없습니다. 먼저 db:seed 를 실행하세요.');

  const [row] = await db
    .select()
    .from(admins)
    .where(eq(admins.email, env.DEMO_ACCOUNT_EMAIL))
    .limit(1);
  if (!row) {
    await db.insert(admins).values({
      email: env.DEMO_ACCOUNT_EMAIL,
      name: DEMO_ACCOUNT_NAME,
      roleId: role.id,
      passwordHash: await hasher.hash(env.DEMO_ACCOUNT_PASSWORD),
    });
    return 'created';
  }
  const samePassword = await hasher.verify(row.passwordHash, env.DEMO_ACCOUNT_PASSWORD);
  await db
    .update(admins)
    .set({
      name: DEMO_ACCOUNT_NAME,
      roleId: role.id,
      status: 'ACTIVE',
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
      ...(samePassword
        ? {}
        : {
            passwordHash: await hasher.hash(env.DEMO_ACCOUNT_PASSWORD),
            permVersion: row.permVersion + 1,
          }),
      ...(row.roleId !== role.id ? { permVersion: row.permVersion + 1 } : {}),
    })
    .where(eq(admins.id, row.id));
  return 'updated';
}

/**
 * 매일 초기화 ⚠️ 운영 데이터를 전부 지운다 — DEMO_MODE·DEMO_DAILY_RESET 둘 다 켜져 있어야 실행
 * 순서: 표 비우기(운영자·권한 제외) → Redis(작업 큐 제외) → 업로드 파일 → 기준 데이터 → 가상 데이터 → 체험 계정 → KPI → 감사 로그 1건
 */
export async function resetDemoData(deps: {
  db: DbHandle;
  redis: RedisHandle;
  env: Env;
  logger: Logger;
  storage: AssetStorage;
  hasher: PasswordHasher;
  /** 테스트에서 줄여 쓰기 */
  scale?: SeedScale;
  now?: Date;
}) {
  const { db, redis, env, logger, storage, hasher } = deps;
  if (!env.DEMO_MODE || !env.DEMO_DAILY_RESET) {
    throw new Error('체험 초기화는 DEMO_MODE·DEMO_DAILY_RESET 이 모두 켜져 있을 때만 실행합니다.');
  }
  const started = Date.now();

  // 1) 표 비우기
  const conn = await db.pool.getConnection();
  let truncated = 0;
  try {
    const [rows] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { t } of rows as { t: string }[]) {
      if (KEEP_TABLES.has(t)) continue;
      await conn.query(`TRUNCATE TABLE \`${t}\``);
      truncated += 1;
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
    conn.release();
  }

  // 2) Redis: 이 환경 접두어의 키 중 작업 큐(bull*)만 남기고 삭제
  //    scan 결과는 접두어가 붙은 전체 키, del 은 접두어를 자동으로 붙이므로 떼고 넘긴다
  const prefix = env.REDIS_KEY_PREFIX;
  let redisKeys = 0;
  const stream = redis.redis.scanStream({ match: `${prefix}*`, count: 500 });
  for await (const batch of stream as AsyncIterable<string[]>) {
    const keys = batch
      .filter((k) => !k.startsWith(`${prefix}bull`))
      .map((k) => k.slice(prefix.length));
    if (keys.length) {
      await redis.redis.del(...keys);
      redisKeys += keys.length;
    }
  }

  // 3) 업로드 이미지
  const files = await storage.clear();

  // 4) 기준 데이터 (운영자 계정은 이미 있으므로 비밀번호는 바뀌지 않음) + 가상 데이터 + 체험 계정
  await seedCore(db.db, { adminPasswordHash: await hasher.hash(randomUUID()) });
  const game = await seedGame(db.db, { scale: deps.scale ?? 'small', now: deps.now });
  await ensureDemoAccount({ db: db.db, env, hasher });
  await backfill(db.db, env.STAT_TZ_OFFSET_MINUTES, 60);

  const result = { truncated, redisKeys, files, game, ms: Date.now() - started };
  await writeAudit(db.db, systemAuditContext(null, `demo-reset:${new Date().toISOString()}`), {
    action: AuditAction.DEMO_RESET,
    after: result,
  });
  logger.warn(result, 'demo data reset');
  return result;
}
