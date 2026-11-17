import { z } from 'zod';
import { confirmationTokenSchema, reasonSchema, uniqueBy } from './common.js';
import { MAIL_MAX_REWARDS, rewardSchema } from './mails.js';

/**
 * 순위 기준 (database.md 4.4): ① 점수 높은 순 ② 같은 점수면 먼저 기록한 순(기록 순서 번호)
 * Redis ZSET 점수에는 원점수만 넣으므로 double 정밀도(2^53) 안에서 넉넉한 상한을 둔다.
 */
export const RANKING_SCORE_MAX = 1_000_000_000_000;

export const rankingQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type RankingQuery = z.infer<typeof rankingQuerySchema>;

export const rankingManageRequestSchema = z.object({
  reason: reasonSchema,
  /** 초기화(L3): 웹에서 빨간 경고 확인 후 두 번째 요청에 */
  confirmationToken: confirmationTokenSchema.optional(),
});

/** 랭킹 종류 (아레나, 월드아레나 …) — 보드마다 시즌이 따로 진행된다 */
export interface RankingBoardView {
  id: number;
  code: string;
  name: string;
}

export interface RankingSeasonView {
  id: number;
  board: RankingBoardView;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  resetCount: number;
}

export interface RankingEntry {
  rank: number;
  publicId: string;
  nickname: string;
  score: number;
  achievedAt: string;
}

export interface UserRankView {
  season: RankingSeasonView;
  me: RankingEntry | null;
  /** 내 위·아래 5명 */
  neighbors: RankingEntry[];
}

/** RESET: 초기화 직전 순위 / BACKUP: 스냅샷 복원 직전 자동 보관 */
export const SnapshotKind = { RESET: 'RESET', BACKUP: 'BACKUP', FINAL: 'FINAL' } as const;
export type SnapshotKind = (typeof SnapshotKind)[keyof typeof SnapshotKind];

export interface RankingSnapshotSummary {
  snapshotId: string;
  kind: SnapshotKind;
  reason: string;
  count: number;
  createdAt: string;
  /** 이 스냅샷으로 순위 보상을 지급했으면 그 기록 */
  payout: RankingRewardPayoutView | null;
}

export interface RankingRewardPayoutView {
  id: number;
  recipientCount: number;
  /** 탈퇴 등으로 제외된 인원 */
  skippedCount: number;
  mailIds: number[];
  createdAt: string;
}

/** 스냅샷 복원 (L3) — 현재 순위를 스냅샷 내용으로 교체, 직전 상태는 BACKUP 스냅샷으로 보관 */
export const rankingRestoreRequestSchema = z.object({
  snapshotId: z.string().uuid(),
  reason: reasonSchema,
  confirmationToken: confirmationTokenSchema.optional(),
});
export type RankingRestoreRequest = z.infer<typeof rankingRestoreRequestSchema>;

export interface RankingRestoreResult {
  restoredCount: number;
  backupSnapshotId: string | null;
}

/**
 * 순위 보상 한도
 * - 구간은 20개까지, 순위는 제한 없음 (끝 순위를 비우면 "그 순위부터 마지막까지")
 * - 한 번에 받는 인원은 100,000명까지: 지급이 트랜잭션 하나라서 크기를 제한 (요청·실행 시점 모두 검사)
 */
export const RANKING_REWARD_MAX_TIERS = 20;
export const RANKING_REWARD_MAX_RECIPIENTS = 100_000;

export const rankingRewardTierSchema = z
  .object({
    fromRank: z.number().int().min(1),
    /** null = 마지막 순위까지 */
    toRank: z.number().int().min(1).nullable(),
    rewards: z
      .array(rewardSchema)
      .min(1)
      .max(MAIL_MAX_REWARDS)
      .refine((v) => uniqueBy(v, (r) => `${r.type}:${r.code}`), '같은 보상이 중복되었습니다.'),
  })
  .refine((t) => t.toRank === null || t.fromRank <= t.toRank, {
    message: '시작 순위가 끝 순위보다 클 수 없습니다.',
    path: ['toRank'],
  });
export type RankingRewardTier = z.infer<typeof rankingRewardTierSchema>;

/** 구간 끝 (마지막까지면 무한대) */
export const tierEnd = (t: { toRank: number | null }) => t.toRank ?? Number.POSITIVE_INFINITY;

/** 스냅샷 순위 보상 요청 (L3) — 구간마다 우편 1통 발송, 같은 스냅샷에는 한 번만 */
export const rankingRewardRequestSchema = z
  .object({
    snapshotId: z.string().uuid(),
    /** 우편 제목 앞부분. 실제 제목은 "<제목> (1~3위)" */
    title: z.string().trim().min(1).max(38),
    body: z.string().trim().min(1).max(500),
    expiresInDays: z.number().int().min(1).max(30).default(7),
    tiers: z.array(rankingRewardTierSchema).min(1).max(RANKING_REWARD_MAX_TIERS),
    reason: reasonSchema,
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const sorted = [...v.tiers].sort((a, b) => a.fromRank - b.fromRank);
    // "마지막까지" 구간은 하나만, 그리고 가장 뒤 구간이어야 함 (아니면 뒤 구간과 겹침 — 아래 검사가 잡음)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.fromRank <= tierEnd(sorted[i - 1]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers'],
          message: `순위 구간이 겹칩니다 (${sorted[i]!.fromRank}위).`,
        });
        return;
      }
    }
  });
export type RankingRewardRequest = z.infer<typeof rankingRewardRequestSchema>;

export interface RankingRewardResult {
  payoutId: number;
  recipientCount: number;
  skippedCount: number;
  mails: { fromRank: number; toRank: number | null; mailId: number; recipientCount: number }[];
}

/** 구간 이름: "1위", "2~3위" */
export const tierLabel = (t: { fromRank: number; toRank: number | null }) =>
  t.toRank === null
    ? `${t.fromRank}위~`
    : t.fromRank === t.toRank
      ? `${t.fromRank}위`
      : `${t.fromRank}~${t.toRank}위`;

/** 스냅샷 인원 기준 구간 대상 수 */
export const tierSize = (t: { fromRank: number; toRank: number | null }, snapshotCount: number) =>
  Math.max(0, Math.min(tierEnd(t), snapshotCount) - t.fromRank + 1);

export interface RankingResetResult {
  snapshotId: string;
  archivedCount: number;
}
