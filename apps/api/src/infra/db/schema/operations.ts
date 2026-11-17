import {
  char,
  date,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { amount, createdAt, fk, pk, updatedAt } from './columns.js';

/** 감사 로그 — append only. UPDATE/DELETE API 없음 (FR-LOG-04) */
export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: pk(),
    adminId: fk('admin_id'),
    apiTokenId: fk('api_token_id'),
    /** WEB | MCP | SYSTEM */
    channel: varchar('channel', { length: 10 }).notNull(),
    action: varchar('action', { length: 50 }).notNull(),
    targetType: varchar('target_type', { length: 30 }),
    targetId: varchar('target_id', { length: 64 }),
    reason: varchar('reason', { length: 200 }),
    beforeData: json('before_data'),
    afterData: json('after_data'),
    /** SUCCESS | FAILURE */
    result: varchar('result', { length: 10 }).notNull(),
    errorCode: varchar('error_code', { length: 50 }),
    requestId: varchar('request_id', { length: 64 }),
    ip: varchar('ip', { length: 45 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_audit_admin').on(t.adminId, t.createdAt),
    index('idx_audit_target').on(t.targetType, t.targetId, t.createdAt),
    index('idx_audit_action').on(t.action, t.createdAt),
    index('idx_audit_created').on(t.createdAt),
  ],
);

/** 중복 실행 최종 방어 (architecture.md 6장) */
export const idempotencyKeys = mysqlTable(
  'idempotency_keys',
  {
    id: pk(),
    adminId: fk('admin_id').notNull(),
    idemKey: varchar('idem_key', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    responseStatus: int('response_status').notNull(),
    responseBody: json('response_body'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_idem_admin_key').on(t.adminId, t.idemKey),
    index('idx_idem_created').on(t.createdAt),
  ],
);

export const dailyKpis = mysqlTable('daily_kpis', {
  statDate: date('stat_date', { mode: 'string' }).primaryKey(),
  dau: int('dau', { unsigned: true }).notNull().default(0),
  nru: int('nru', { unsigned: true }).notNull().default(0),
  suspendedTotal: int('suspended_total', { unsigned: true }).notNull().default(0),
  updatedAt: updatedAt(),
});

export const dailyCurrencyStats = mysqlTable(
  'daily_currency_stats',
  {
    statDate: date('stat_date', { mode: 'string' }).notNull(),
    currencyId: int('currency_id', { unsigned: true }).notNull(),
    issued: amount('issued').notNull().default(0),
    consumed: amount('consumed').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.statDate, t.currencyId] })],
);
