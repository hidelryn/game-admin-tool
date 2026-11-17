import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { MySqlContainer } from '@testcontainers/mysql';
import { RedisContainer } from '@testcontainers/redis';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';

/**
 * 통합 테스트용 MySQL·Redis 컨테이너를 한 번 띄우고, 실제 마이그레이션을 적용한다.
 * 로컬 docker compose DB 와 완전히 분리되어 개발 데이터에 영향 없음.
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export default async function setup(project: TestProject) {
  if (!existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
    throw new Error('마이그레이션 파일이 없습니다. 먼저 `npm run db:generate` 를 실행하세요.');
  }

  const [mysqlC, redisC] = await Promise.all([
    new MySqlContainer('mysql:8.4')
      .withDatabase('game_admin_test')
      .withUsername('test')
      .withUserPassword('test-password')
      .withCommand(['--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci'])
      .start(),
    new RedisContainer('redis:7.4-alpine').start(),
  ]);

  const conn = {
    host: mysqlC.getHost(),
    port: mysqlC.getPort(),
    user: mysqlC.getUsername(),
    password: mysqlC.getUserPassword(),
    database: mysqlC.getDatabase(),
  };

  const connection = await mysql.createConnection({ ...conn, multipleStatements: true });
  try {
    await migrate(drizzle(connection), { migrationsFolder });
  } finally {
    await connection.end();
  }

  project.provide('mysql', conn);
  project.provide('redisUrl', redisC.getConnectionUrl());

  return async () => {
    await Promise.all([mysqlC.stop(), redisC.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mysql: { host: string; port: number; user: string; password: string; database: string };
    redisUrl: string;
  }
}
