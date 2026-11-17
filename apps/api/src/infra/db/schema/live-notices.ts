import { boolean, index, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk, updatedAt } from './columns.js';

/**
 * 게임 점검 (docs/maintenance-notice.md 3장)
 * 상태(예정·진행·종료·취소)는 시각으로 계산. 기간은 겹칠 수 없다(이름 잠금으로 검사)
 * - started_at: 실제 시작 처리(세션 세대 증가) 시각 — 워커 조건부 UPDATE 로 한 번만
 * - ended_at: "지금 열기"로 앞당겨 끝낸 시각
 * - session_epoch: 시작할 때 부여한 세대 번호. 현재 세대 = MAX(session_epoch)
 */
export const maintenances = mysqlTable(
  'maintenances',
  {
    id: pk(),
    title: varchar('title', { length: 50 }).notNull(),
    message: varchar('message', { length: 500 }).notNull(),
    startsAt: dt('starts_at').notNull(),
    endsAt: dt('ends_at').notNull(),
    startedAt: dt('started_at'),
    endedAt: dt('ended_at'),
    canceledAt: dt('canceled_at'),
    allowPublicIds: json('allow_public_ids').$type<string[]>().notNull(),
    sessionEpoch: int('session_epoch', { unsigned: true }),
    noticeId: fk('notice_id'),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdBy: fk('created_by').notNull(),
    updatedBy: fk('updated_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_maintenances_period').on(t.startsAt, t.endsAt)],
);

/**
 * 공지 — 목록 + 로비 한 줄 공지(티커)
 * 본문은 평문만 저장·전달 (HTML 로 그리지 않는다)
 */
export const notices = mysqlTable(
  'notices',
  {
    id: pk(),
    /** NOTICE | UPDATE | EVENT | MAINTENANCE */
    category: varchar('category', { length: 12 }).notNull(),
    title: varchar('title', { length: 60 }).notNull(),
    body: varchar('body', { length: 5000 }).notNull(),
    startsAt: dt('starts_at').notNull(),
    /** NULL = 내릴 때까지 계속 */
    endsAt: dt('ends_at'),
    pinned: boolean('pinned').notNull().default(false),
    tickerEnabled: boolean('ticker_enabled').notNull().default(false),
    tickerText: varchar('ticker_text', { length: 80 }),
    hiddenAt: dt('hidden_at'),
    maintenanceId: fk('maintenance_id'),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdBy: fk('created_by').notNull(),
    updatedBy: fk('updated_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_notices_period').on(t.startsAt, t.endsAt),
    index('idx_notices_maintenance').on(t.maintenanceId),
  ],
);
