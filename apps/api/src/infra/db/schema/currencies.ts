import {
  bigint,
  boolean,
  index,
  int,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { amount, createdAt, fk, pk, updatedAt } from './columns.js';
import { users } from './users.js';

/** 재화 마스터 — id 는 시드에서 고정값으로 넣는다 */
export const currencies = mysqlTable('currencies', {
  id: int('id', { unsigned: true }).primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 30 }).notNull(),
  isPaid: boolean('is_paid').notNull(),
  maxBalance: amount('max_balance').notNull(),
  grantLimitPerRequest: amount('grant_limit_per_request').notNull(),
});

export const userCurrencies = mysqlTable(
  'user_currencies',
  {
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    currencyId: int('currency_id', { unsigned: true })
      .notNull()
      .references(() => currencies.id),
    balance: amount('balance').notNull().default(0),
    version: int('version', { unsigned: true }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.currencyId] })],
);

/** 재화 원장 — append only, FK 없음 */
export const currencyTransactions = mysqlTable(
  'currency_transactions',
  {
    id: pk(),
    userId: fk('user_id').notNull(),
    currencyId: int('currency_id', { unsigned: true }).notNull(),
    delta: amount('delta').notNull(),
    balanceBefore: amount('balance_before').notNull(),
    balanceAfter: amount('balance_after').notNull(),
    /** ADMIN | MAIL | GAME */
    source: varchar('source', { length: 10 }).notNull(),
    reason: varchar('reason', { length: 200 }),
    adminId: fk('admin_id'),
    channel: varchar('channel', { length: 10 }),
    mailId: fk('mail_id'),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_ctx_user').on(t.userId, t.createdAt),
    index('idx_ctx_admin').on(t.adminId, t.createdAt),
    index('idx_ctx_created_currency').on(t.createdAt, t.currencyId),
  ],
);

export const items = mysqlTable('items', {
  id: int('id', { unsigned: true }).primaryKey(),
  code: varchar('code', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  stackable: boolean('stackable').notNull().default(true),
});

export const userItems = mysqlTable(
  'user_items',
  {
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    itemId: int('item_id', { unsigned: true })
      .notNull()
      .references(() => items.id),
    quantity: bigint('quantity', { mode: 'number', unsigned: true }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] })],
);
