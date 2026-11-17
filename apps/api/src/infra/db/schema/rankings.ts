import {
  bigint,
  char,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { amount, createdAt, dt, fk, pk } from './columns.js';

/**
 * 랭킹 종류 (아레나, 월드아레나 …) — 보드마다 시즌이 따로, 기간이 겹쳐도 됨
 * id 는 시드에서 고정 (1 = 아레나: 보드 도입 전 시즌 전부)
 */
export const rankingBoards = mysqlTable(
  'ranking_boards',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 20 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    sortOrder: int('sort_order', { unsigned: true }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_ranking_boards_code').on(t.code)],
);

export const rankingSeasons = mysqlTable('ranking_seasons', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  /** 기존 시즌은 기본값 1(아레나). FK 대신 애플리케이션에서 검증 (마이그레이션 때 기존 행이 보드보다 먼저 존재) */
  boardId: int('board_id', { unsigned: true }).notNull().default(1),
  name: varchar('name', { length: 50 }).notNull(),
  /** SCHEDULED(시작 전) | ACTIVE | ENDED | CANCELED(시작 전 취소) — 스케줄 워커가 시각에 맞춰 전환 */
  status: varchar('status', { length: 10 }).notNull(),
  startsAt: dt('starts_at').notNull(),
  endsAt: dt('ends_at'),
  resetCount: int('reset_count', { unsigned: true }).notNull().default(0),
  createdAt: createdAt(),
});

/** 랭킹 원본 점수 (Redis ZSET 의 source of truth) */
export const rankingScores = mysqlTable(
  'ranking_scores',
  {
    seasonId: int('season_id', { unsigned: true })
      .notNull()
      .references(() => rankingSeasons.id),
    userId: fk('user_id').notNull(),
    score: amount('score').notNull(),
    achievedAt: dt('achieved_at').notNull(),
    /** 이 점수를 기록한 순서 (시간 기반 번호, seq-generator.ts). 동점이면 작은 쪽이 상위 */
    achievedSeq: bigint('achieved_seq', { mode: 'number', unsigned: true }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.userId] }),
    index('idx_scores_rank').on(t.seasonId, t.score, t.achievedSeq),
    // 재구성 따라잡기: 특정 번호 이후 기록만 조회
    index('idx_scores_seq').on(t.seasonId, t.achievedSeq),
  ],
);

export const rankingSnapshots = mysqlTable(
  'ranking_snapshots',
  {
    id: pk(),
    seasonId: int('season_id', { unsigned: true }).notNull(),
    snapshotId: char('snapshot_id', { length: 36 }).notNull(),
    rankNo: int('rank_no', { unsigned: true }).notNull(),
    userId: fk('user_id').notNull(),
    score: amount('score').notNull(),
    /** RESET: 초기화 직전 / BACKUP: 스냅샷 복원 직전 자동 보관 / FINAL: 시즌 종료 시 최종 순위 */
    kind: varchar('kind', { length: 10 }).notNull().default('RESET'),
    reason: varchar('reason', { length: 200 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('idx_snapshots').on(t.seasonId, t.snapshotId, t.rankNo)],
);

/**
 * 스냅샷 순위 보상 지급 기록 — snapshot_id UNIQUE 로 같은 스냅샷 중복 지급을 DB 가 최종 차단
 * (확인 화면 전에도 미리 확인하지만, 동시 실행 같은 경합은 이 제약이 막는다)
 */
export const rankingRewardPayouts = mysqlTable(
  'ranking_reward_payouts',
  {
    id: pk(),
    seasonId: int('season_id', { unsigned: true }).notNull(),
    snapshotId: char('snapshot_id', { length: 36 }).notNull(),
    /** 요청 그대로의 구간·보상 (감사·재현용) */
    tiers: json('tiers').notNull(),
    mailIds: json('mail_ids').$type<number[]>().notNull(),
    recipientCount: int('recipient_count', { unsigned: true }).notNull(),
    skippedCount: int('skipped_count', { unsigned: true }).notNull(),
    createdBy: fk('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_reward_payouts_snapshot').on(t.snapshotId)],
);
