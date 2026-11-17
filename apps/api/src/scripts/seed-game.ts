import { count } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createDb } from '../infra/db/client.js';
import { users } from '../infra/db/schema/index.js';
import { GAME_TABLES, SEED_SCALES, seedGame, type SeedScale } from '../infra/db/seed/game.js';

/**
 * 가상 게임 데이터 시드: npm run db:seed:game -- [--scale=small|medium|large] [--reset]
 * - 기본 small(회원 1천 명). 성능 측정은 large(10만 명).
 * - 이미 회원이 있으면 --reset 없이는 실행하지 않는다.
 */
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);
const scale = (args.get('scale') ?? process.env.SEED_SCALE ?? 'small') as SeedScale;
if (!(scale in SEED_SCALES)) {
  console.error(`[seed:game] scale 은 ${Object.keys(SEED_SCALES).join(' | ')} 중 하나여야 합니다.`);
  process.exit(1);
}

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('[seed:game] production 환경에서는 실행할 수 없습니다.');
  process.exit(1);
}

const db = createDb(env);
try {
  const [{ n } = { n: 0 }] = await db.db.select({ n: count() }).from(users);
  if (n > 0 && !args.has('reset')) {
    console.error(
      `[seed:game] 이미 회원 ${n}명이 있습니다. 다시 만들려면 --reset 을 붙이세요 (게임 데이터만 삭제).`,
    );
    process.exit(1);
  }
  if (args.has('reset')) {
    const conn = await db.pool.getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of GAME_TABLES) await conn.query(`TRUNCATE TABLE \`${t}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      conn.release();
    }
    console.warn('[seed:game] 게임 데이터 초기화 완료');
  }

  const started = Date.now();
  console.warn(
    `[seed:game] scale=${scale} (${SEED_SCALES[scale].users.toLocaleString()}명, ${SEED_SCALES[scale].days}일)`,
  );
  const r = await seedGame(db.db, { scale, log: (m) => console.warn(m) });
  console.warn(
    `[seed:game] 완료 ${((Date.now() - started) / 1000).toFixed(1)}s — 회원 ${r.users.toLocaleString()}, 활동 ${r.activities.toLocaleString()}, 원장 ${r.transactions.toLocaleString()}`,
  );
} finally {
  await db.close();
}
