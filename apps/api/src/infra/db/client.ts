import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Env } from '../../config/env.js';
import * as schema from './schema/index.js';

export function createDb(env: Env) {
  const pool = mysql.createPool({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectionLimit: env.MYSQL_POOL_SIZE,
    // 모든 시각은 UTC 로 저장/해석 (database.md)
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });

  const db = drizzle(pool, { schema, mode: 'default' });

  return {
    db,
    pool,
    async ping(): Promise<boolean> {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

export type DbHandle = ReturnType<typeof createDb>;
