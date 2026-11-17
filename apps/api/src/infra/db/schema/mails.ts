import { index, int, json, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';
import { amount, createdAt, dt, fk, pk } from './columns.js';
import { users } from './users.js';

export const mails = mysqlTable(
  'mails',
  {
    id: pk(),
    /** USER(개별) | GLOBAL(전체) — database.md 4.3 */
    type: varchar('type', { length: 10 }).notNull(),
    title: varchar('title', { length: 50 }).notNull(),
    body: varchar('body', { length: 500 }).notNull(),
    /** SCHEDULED | SENT | CANCELED (예약 발송 확장 대비) */
    status: varchar('status', { length: 20 }).notNull(),
    scheduledAt: dt('scheduled_at'),
    sentAt: dt('sent_at'),
    expiresAt: dt('expires_at').notNull(),
    targetFilter: json('target_filter').$type<Record<string, unknown>>(),
    createdBy: fk('created_by').notNull(),
    reason: varchar('reason', { length: 200 }).notNull(),
    canceledAt: dt('canceled_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_mails_type_created').on(t.type, t.createdAt),
    index('idx_mails_status_scheduled').on(t.status, t.scheduledAt),
  ],
);

export const mailRewards = mysqlTable(
  'mail_rewards',
  {
    id: pk(),
    mailId: fk('mail_id')
      .notNull()
      .references(() => mails.id),
    /** CURRENCY | ITEM */
    rewardType: varchar('reward_type', { length: 10 }).notNull(),
    refId: int('ref_id', { unsigned: true }).notNull(),
    quantity: amount('quantity').notNull(),
  },
  (t) => [index('idx_mail_rewards_mail').on(t.mailId)],
);

export const mailRecipients = mysqlTable(
  'mail_recipients',
  {
    mailId: fk('mail_id')
      .notNull()
      .references(() => mails.id),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    readAt: dt('read_at'),
    claimedAt: dt('claimed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.mailId, t.userId] }),
    index('idx_mail_recipients_user').on(t.userId, t.claimedAt),
  ],
);

export const globalMailClaims = mysqlTable(
  'global_mail_claims',
  {
    mailId: fk('mail_id')
      .notNull()
      .references(() => mails.id),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    claimedAt: dt('claimed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.mailId, t.userId] })],
);
