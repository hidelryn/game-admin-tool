import { passwordPolicySchema } from '@game-admin/shared';
import { loadEnv } from '../config/env.js';
import { createDb } from '../infra/db/client.js';
import { seedCore, SEED_ADMINS } from '../infra/db/seed/core.js';
import { createPasswordHasher } from '../modules/auth/password.js';

/**
 * 기준 데이터 시드: npm run db:seed
 * 운영자 비밀번호는 .env 의 SEED_ADMIN_PASSWORD 로만 받는다 (코드에 하드코딩 금지).
 */
const env = loadEnv();
const password = process.env.SEED_ADMIN_PASSWORD;
const checked = passwordPolicySchema.safeParse(password);
if (!checked.success) {
  console.error(
    '[seed] SEED_ADMIN_PASSWORD 가 없거나 정책(10자 이상, 영문·숫자 포함)에 맞지 않습니다.',
  );
  process.exit(1);
}

const db = createDb(env);
try {
  const hasher = createPasswordHasher({
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
  });
  await seedCore(db.db, { adminPasswordHash: await hasher.hash(checked.data) });
  console.warn('[seed] 완료. 운영자 계정:');
  for (const a of SEED_ADMINS) console.warn(`  - ${a.email} (${a.roleCode})`);
} finally {
  await db.close();
}
