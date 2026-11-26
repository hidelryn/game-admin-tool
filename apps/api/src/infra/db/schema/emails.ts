import {
  boolean,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk } from './columns.js';

/**
 * 이메일 발송 캠페인 (docs/email.md)
 * 예약·즉시 모두 한 행. Worker(또는 즉시 발송이면 API)가 SCHEDULED → SENDING 으로 "가져가서" 처리한다
 */
export const emailCampaigns = mysqlTable(
  'email_campaigns',
  {
    id: pk(),
    /** USERS | ALL | ADDRESS */
    targetType: varchar('target_type', { length: 10 }).notNull(),
    targetPublicIds: json('target_public_ids').$type<string[]>(),
    /** 주소 직접 입력 (ADDRESS) */
    targetAddress: varchar('target_address', { length: 191 }),
    subject: varchar('subject', { length: 150 }).notNull(),
    body: text('body').notNull(),
    isAd: boolean('is_ad').notNull().default(false),
    /** 본문 아래 버튼 (선택) */
    ctaLabel: varchar('cta_label', { length: 30 }),
    ctaUrl: varchar('cta_url', { length: 500 }),
    /** SCHEDULED | SENDING | DONE | CANCELED */
    status: varchar('status', { length: 10 }).notNull(),
    scheduledAt: dt('scheduled_at').notNull(),
    startedAt: dt('started_at'),
    finishedAt: dt('finished_at'),
    canceledAt: dt('canceled_at'),
    canceledBy: fk('canceled_by'),
    /** 만든 운영자가 체험 계정이면 회원 대상 발송은 모두 가상 */
    demo: boolean('demo').notNull().default(false),
    totalCount: int('total_count', { unsigned: true }).notNull().default(0),
    sentCount: int('sent_count', { unsigned: true }).notNull().default(0),
    virtualCount: int('virtual_count', { unsigned: true }).notNull().default(0),
    skippedCount: int('skipped_count', { unsigned: true }).notNull().default(0),
    failedCount: int('failed_count', { unsigned: true }).notNull().default(0),
    reason: varchar('reason', { length: 200 }).notNull(),
    createdBy: fk('created_by'),
    channel: varchar('channel', { length: 10 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_email_campaigns_due').on(t.status, t.scheduledAt),
    index('idx_email_campaigns_created').on(t.createdAt),
  ],
);

/** 수신자별 처리 결과 — append only, FK 없음 */
export const emailDeliveries = mysqlTable(
  'email_deliveries',
  {
    id: pk(),
    campaignId: fk('campaign_id').notNull(),
    /** 주소 직접 입력이면 NULL */
    userId: fk('user_id'),
    address: varchar('address', { length: 191 }).notNull(),
    /** SENT | VIRTUAL | SKIPPED_* | FAILED */
    status: varchar('status', { length: 20 }).notNull(),
    error: varchar('error', { length: 300 }),
    messageId: varchar('message_id', { length: 200 }),
    processedAt: dt('processed_at').notNull(),
  },
  (t) => [
    // 재시작해도 같은 회원에게 두 번 보내지 않는다 (주소 직접 입력은 user_id NULL 이라 영향 없음)
    uniqueIndex('uk_email_deliveries_user').on(t.campaignId, t.userId),
    index('idx_email_deliveries_campaign').on(t.campaignId, t.status),
  ],
);
