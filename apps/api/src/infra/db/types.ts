import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { MySqlDatabase } from 'drizzle-orm/mysql-core';
import type { MySql2PreparedQueryHKT, MySql2QueryResultHKT } from 'drizzle-orm/mysql2';
import type * as schema from './schema/index.js';

export type Schema = typeof schema;

/**
 * db 와 트랜잭션(tx) 모두 받을 수 있는 쿼리 실행기 타입.
 * Repository 함수는 이 타입을 받아서, Service 가 트랜잭션 경계를 정한다 (architecture.md 1.3).
 */
export type Executor = MySqlDatabase<
  MySql2QueryResultHKT,
  MySql2PreparedQueryHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** mysql2 UPDATE/DELETE 결과에서 영향받은 행 수 */
export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}
