import { boolean, index, int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk, updatedAt } from './columns.js';

/**
 * 업로드 이미지 (docs/schedule.md 6장)
 * 파일은 저장소(로컬 → S3)에, 여기엔 판별된 형식·크기만. storage_key 는 추측 불가 UUID
 */
export const assets = mysqlTable(
  'assets',
  {
    id: pk(),
    storageKey: varchar('storage_key', { length: 64 }).notNull(),
    mime: varchar('mime', { length: 20 }).notNull(),
    size: int('size', { unsigned: true }).notNull(),
    width: int('width', { unsigned: true }).notNull(),
    height: int('height', { unsigned: true }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    originalName: varchar('original_name', { length: 200 }).notNull(),
    createdBy: fk('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_assets_key').on(t.storageKey), index('idx_assets_sha').on(t.sha256)],
);

/**
 * 라이브 운영 일정 — 랭킹 시즌 · 게임 이벤트
 * 상태(예정·진행·종료)는 시각으로 계산, 취소만 canceled_at 으로 저장
 * version: 낙관적 잠금 (동시 수정 시 뒤 요청은 409)
 */
export const schedules = mysqlTable(
  'schedules',
  {
    id: pk(),
    /** RANKING_SEASON | EVENT */
    kind: varchar('kind', { length: 16 }).notNull(),
    title: varchar('title', { length: 50 }).notNull(),
    description: varchar('description', { length: 1000 }).notNull().default(''),
    startsAt: dt('starts_at').notNull(),
    endsAt: dt('ends_at').notNull(),
    /** kind=RANKING_SEASON 일 때 1:1 */
    rankingSeasonId: int('ranking_season_id', { unsigned: true }),
    popupEnabled: boolean('popup_enabled').notNull().default(false),
    /** ONCE | DAILY | EVERY_LOGIN */
    popupFrequency: varchar('popup_frequency', { length: 12 }).notNull().default('DAILY'),
    bannerEnabled: boolean('banner_enabled').notNull().default(false),
    priority: int('priority', { unsigned: true }).notNull().default(0),
    imageAssetId: fk('image_asset_id'),
    link: varchar('link', { length: 300 }),
    canceledAt: dt('canceled_at'),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdBy: fk('created_by').notNull(),
    updatedBy: fk('updated_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_schedules_period').on(t.startsAt, t.endsAt),
    uniqueIndex('uq_schedules_season').on(t.rankingSeasonId),
  ],
);
