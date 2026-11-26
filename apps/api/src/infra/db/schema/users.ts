import { boolean, index, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk, updatedAt } from './columns.js';

/** 게임 회원(플레이어). 운영자(admins)와 다르다 */
export const users = mysqlTable(
  'users',
  {
    id: pk(),
    publicId: varchar('public_id', { length: 20 }).notNull().unique(),
    nickname: varchar('nickname', { length: 30 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    level: int('level', { unsigned: true }).notNull().default(1),
    /** 최고 클리어 스테이지 (STAGE_CLEAR 이벤트로 갱신) — 이탈·과금 구간 분석용 */
    maxStage: int('max_stage', { unsigned: true }).notNull().default(0),
    /** 광고성 이메일 수신 동의 / 야간(21~08시) 광고 수신 동의 — docs/email.md */
    adEmailOptIn: boolean('ad_email_opt_in').notNull().default(false),
    nightOptIn: boolean('night_opt_in').notNull().default(false),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    registeredAt: dt('registered_at').notNull(),
    lastLoginAt: dt('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_users_nickname').on(t.nickname),
    index('idx_users_status_registered').on(t.status, t.registeredAt),
    index('idx_users_last_login').on(t.lastLoginAt),
  ],
);

export const userSuspensions = mysqlTable(
  'user_suspensions',
  {
    id: pk(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id),
    reason: varchar('reason', { length: 200 }).notNull(),
    startsAt: dt('starts_at').notNull(),
    /** NULL = 영구 정지 */
    endsAt: dt('ends_at'),
    suspendedBy: fk('suspended_by'),
    releasedAt: dt('released_at'),
    releasedBy: fk('released_by'),
    releaseReason: varchar('release_reason', { length: 200 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_suspensions_user').on(t.userId, t.createdAt),
    index('idx_suspensions_expiry').on(t.releasedAt, t.endsAt),
  ],
);

/** 대용량 append 테이블 — 파티셔닝 대비 FK 없음 (database.md 3장) */
export const userActivityLogs = mysqlTable(
  'user_activity_logs',
  {
    id: pk(),
    userId: fk('user_id').notNull(),
    type: varchar('type', { length: 30 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>(),
    occurredAt: dt('occurred_at').notNull(),
  },
  (t) => [
    index('idx_activity_user').on(t.userId, t.occurredAt),
    index('idx_activity_type').on(t.type, t.occurredAt),
  ],
);
