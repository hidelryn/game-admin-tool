import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnv } from '../../config/env.js';

/**
 * 마이그레이션 실행기. 컨테이너 기동 전/CI 에서 `npm run db:migrate` 로 실행.
 * - 소스 실행(tsx): apps/api/src/infra/db → ../../../drizzle
 * - 번들 실행(dist): apps/api/dist → ../drizzle
 */
const env = loadEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  (here.endsWith(path.join('src', 'infra', 'db'))
    ? path.resolve(here, '../../../drizzle')
    : path.resolve(here, '../drizzle'));

if (!existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
  // 아직 생성된 마이그레이션이 없음 (Phase 3 에서 첫 스키마 생성 예정) — 실패가 아니라 할 일이 없는 상태
  console.warn(`[migrate] 실행할 마이그레이션이 없습니다: ${migrationsFolder}`);
  process.exit(0);
}

const connection = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  multipleStatements: true,
});

try {
  await migrate(drizzle(connection), { migrationsFolder });
  console.warn(`[migrate] 완료: ${migrationsFolder}`);
} finally {
  await connection.end();
}
