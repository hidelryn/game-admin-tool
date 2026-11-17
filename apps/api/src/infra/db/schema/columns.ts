import { sql } from 'drizzle-orm';
import { bigint, datetime } from 'drizzle-orm/mysql-core';

/** drizzle 의 timestamp().defaultNow() 와 같은 표현. datetime 빌더에는 defaultNow 가 없다 */
const NOW = sql`(now())`;

/**
 * 공통 컬럼 헬퍼 (database.md 1장)
 * - PK: BIGINT UNSIGNED AUTO_INCREMENT. 값 범위가 2^53 이하라 JS number 로 다룬다.
 * - 시각: DATETIME, UTC 저장. updated_at 은 애플리케이션에서 갱신.
 */
export const pk = () =>
  bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey();

export const fk = (name: string) => bigint(name, { mode: 'number', unsigned: true });

export const createdAt = () => datetime('created_at', { mode: 'date' }).notNull().default(NOW);

export const updatedAt = () =>
  datetime('updated_at', { mode: 'date' })
    .notNull()
    .default(NOW)
    .$onUpdate(() => new Date());

export const dt = (name: string) => datetime(name, { mode: 'date' });

/** 금액·수량 (정수) */
export const amount = (name: string) => bigint(name, { mode: 'number' });
