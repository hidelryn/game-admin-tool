import { z } from 'zod';
import { statDateSchema } from './dashboard.js';
import { publicIdSchema } from './common.js';

/**
 * 유저 분석 (docs/analytics.md) — 이탈·리텐션·과금·재화 소비처
 * 구간 = 스테이지 진행도 10 단위. "다음 도전 스테이지" 기준 (예: 최고 클리어 19 → 11~20 구간)
 */
export const STAGE_MAX = 120;
export const STAGE_BUCKET_SIZE = 10;
export const ANALYTICS_MAX_DAYS = 90;
export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const;

/** 최고 클리어 스테이지 → 구간 시작 스테이지 (1, 11, 21 …). 끝까지 깬 회원은 마지막 구간 */
export function stageBucketOf(maxStage: number): number {
  const next = Math.min(maxStage + 1, STAGE_MAX);
  return Math.floor((next - 1) / STAGE_BUCKET_SIZE) * STAGE_BUCKET_SIZE + 1;
}
export const stageBucketLabel = (from: number) =>
  `${from}~${Math.min(from + STAGE_BUCKET_SIZE - 1, STAGE_MAX)}`;

const rangeQuery = {
  from: statDateSchema.optional(),
  to: statDateSchema.optional(),
};

export const churnQuerySchema = z.object({
  /** 이 일수 이상 접속하지 않으면 이탈 */
  inactiveDays: z.coerce.number().int().min(1).max(60).default(7),
});
export type ChurnQuery = z.infer<typeof churnQuerySchema>;

export interface ChurnBucket {
  /** 구간 시작 스테이지 */
  stageFrom: number;
  stageTo: number;
  /** 이 구간까지 도달한 회원 (판정 대상) */
  reached: number;
  /** 이 구간에서 멈춘 회원 (아직 플레이 중 포함) */
  stopped: number;
  /** 이 구간에서 멈춘 채 이탈한 회원 */
  churned: number;
  /** churned / reached */
  churnRate: number;
}
export interface ChurnReport {
  inactiveDays: number;
  /** 판정 대상: 탈퇴 제외, 가입 후 inactiveDays 이상 지난 회원 */
  evaluated: number;
  churned: number;
  buckets: ChurnBucket[];
  generatedAt: string;
}

export const retentionQuerySchema = z.object(rangeQuery);
export type RetentionQuery = z.infer<typeof retentionQuerySchema>;

export interface RetentionCohort {
  /** 가입일 (KST) */
  date: string;
  size: number;
  /** 키: 1·3·7·14·30. 값: 0~1, 아직 그날이 안 왔으면 null */
  rates: Record<string, number | null>;
}
export interface RetentionReport {
  days: readonly number[];
  cohorts: RetentionCohort[];
  generatedAt: string;
}

export const purchaseAnalyticsQuerySchema = z.object(rangeQuery);
export type PurchaseAnalyticsQuery = z.infer<typeof purchaseAnalyticsQuerySchema>;

export interface PurchaseStageBucket {
  stageFrom: number;
  stageTo: number;
  /** 이 구간에서 첫 결제한 회원 */
  firstPayers: number;
  /** 이 구간에서 일어난 결제 금액 합 */
  revenue: number;
  purchases: number;
}
export interface PurchaseReport {
  from: string;
  to: string;
  revenue: number;
  purchases: number;
  payers: number;
  /** 기간 중 접속한 회원 중 결제한 비율 */
  payerRate: number;
  /** 결제 회원 1인당 결제액 */
  arppu: number;
  byStage: PurchaseStageBucket[];
  /** 첫 결제가 가입 후 며칠째였나 */
  firstPurchaseDay: { label: string; payers: number }[];
  byProduct: { code: string; name: string; purchases: number; revenue: number }[];
  generatedAt: string;
}

export const spendingQuerySchema = z.object({
  ...rangeQuery,
  currencyCode: z.string().trim().toUpperCase().default('GOLD'),
});
export type SpendingQuery = z.infer<typeof spendingQuerySchema>;

export interface SpendingReport {
  from: string;
  to: string;
  currencyCode: string;
  total: number;
  byReason: { reason: string; amount: number; count: number; share: number }[];
  /** 소비한 회원의 "현재" 진행 구간 기준 */
  byStage: { stageFrom: number; stageTo: number; amount: number; users: number }[];
  generatedAt: string;
}

/** 내부 게임 API — 결제 기록 (시뮬레이터) */
export const gamePurchaseRequestSchema = z.object({
  publicId: publicIdSchema,
  productCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,40}$/),
});
export type GamePurchaseRequest = z.infer<typeof gamePurchaseRequestSchema>;

export interface ProductInfo {
  code: string;
  name: string;
  priceKrw: number;
  gemAmount: number;
}
