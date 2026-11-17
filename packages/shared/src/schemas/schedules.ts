import { z } from 'zod';
import type { GameMaintenanceState } from './live-notices.js';
import { confirmationTokenSchema, dateSchema, reasonSchema } from './common.js';

/** 스케줄 (docs/schedule.md) — 랭킹 시즌 · 게임 이벤트 */
export const ScheduleKind = { RANKING_SEASON: 'RANKING_SEASON', EVENT: 'EVENT' } as const;
export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

/** 상태는 저장하지 않고 시각으로 계산 (워커가 늦어도 정확) */
export const ScheduleStatus = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  CANCELED: 'CANCELED',
} as const;
export type ScheduleStatus = (typeof ScheduleStatus)[keyof typeof ScheduleStatus];

/** 팝업 노출 빈도: 한 번만 / 하루 한 번 / 접속할 때마다 */
export const PopupFrequency = { ONCE: 'ONCE', DAILY: 'DAILY', EVERY_LOGIN: 'EVERY_LOGIN' } as const;
export type PopupFrequency = (typeof PopupFrequency)[keyof typeof PopupFrequency];

export function scheduleStatusOf(
  s: { startsAt: Date | string; endsAt: Date | string; canceledAt: Date | string | null },
  now = new Date(),
): ScheduleStatus {
  if (s.canceledAt) return ScheduleStatus.CANCELED;
  if (now < new Date(s.startsAt)) return ScheduleStatus.SCHEDULED;
  if (now < new Date(s.endsAt)) return ScheduleStatus.ACTIVE;
  return ScheduleStatus.ENDED;
}

/** 이동 링크: 게임 내 이동(game://) 또는 https 만 — javascript: 등 차단 */
export const scheduleLinkSchema = z
  .string()
  .trim()
  .max(300)
  .regex(
    /^(game:\/\/[A-Za-z0-9._~\-/?=&%#]+|https:\/\/[^\s<>"']+)$/,
    '링크는 game:// 또는 https:// 로 시작해야 합니다.',
  );

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 2048;
export const SCHEDULE_PRIORITY_MAX = 1000;

const scheduleBody = z.object({
  title: z.string().trim().min(1).max(50),
  description: z.string().trim().max(1000).default(''),
  startsAt: dateSchema,
  endsAt: dateSchema,
  popupEnabled: z.boolean().default(false),
  popupFrequency: z.nativeEnum(PopupFrequency).default(PopupFrequency.DAILY),
  bannerEnabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(SCHEDULE_PRIORITY_MAX).default(0),
  imageAssetId: z.number().int().positive().nullable().default(null),
  link: scheduleLinkSchema.nullable().default(null),
  reason: reasonSchema,
});

type BodyShape = z.infer<typeof scheduleBody>;
const bodyRules = (
  v: Pick<BodyShape, 'startsAt' | 'endsAt' | 'bannerEnabled' | 'imageAssetId'>,
  ctx: z.RefinementCtx,
) => {
  if (v.endsAt <= v.startsAt)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: '종료 시각은 시작 시각보다 뒤여야 합니다.',
    });
  if (v.bannerEnabled && !v.imageAssetId)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageAssetId'],
      message: '배너에는 이미지가 필요합니다.',
    });
};

export const createScheduleRequestSchema = scheduleBody
  .extend({
    kind: z.nativeEnum(ScheduleKind),
    /** 랭킹 시즌이면 필수 — 어느 랭킹(아레나·월드아레나 …)의 시즌인지 */
    rankingBoardId: z.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    bodyRules(v, ctx);
    if (v.kind === ScheduleKind.RANKING_SEASON && !v.rankingBoardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rankingBoardId'],
        message: '랭킹 종류를 고르세요.',
      });
    }
  });
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

/** 수정: 전체 값 + 내가 본 버전(동시 수정 방지). 진행 중 일정은 확인 토큰 필요(L2) */
export const updateScheduleRequestSchema = scheduleBody
  .extend({
    version: z.number().int().positive(),
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .superRefine(bodyRules);
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

/** 취소(시작 전) / 내리기(진행 중 이벤트, L2) / 조기 종료(진행 중 시즌, L2) */
export const scheduleActionRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().positive(),
  confirmationToken: confirmationTokenSchema.optional(),
});
export type ScheduleActionRequest = z.infer<typeof scheduleActionRequestSchema>;

export const listSchedulesQuerySchema = z.object({
  /** 이 기간과 겹치는 일정 */
  from: dateSchema,
  to: dateSchema,
  kind: z.nativeEnum(ScheduleKind).optional(),
  includeCanceled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>;

export interface AssetView {
  id: number;
  url: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}

export interface ScheduleView {
  id: number;
  kind: ScheduleKind;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  status: ScheduleStatus;
  popupEnabled: boolean;
  popupFrequency: PopupFrequency;
  bannerEnabled: boolean;
  priority: number;
  image: AssetView | null;
  link: string | null;
  rankingSeason: {
    id: number;
    name: string;
    status: string;
    board: { id: number; code: string; name: string };
  } | null;
  canceledAt: string | null;
  createdBy: { id: number; name: string };
  updatedBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** 진행 중 일정 수정·내리기·조기 종료 전 확인 화면 (L2) */
export interface ScheduleChangePreview {
  scheduleId: number;
  kind: ScheduleKind;
  title: string;
  action: 'UPDATE' | 'CANCEL' | 'END_NOW';
  before: { startsAt: string; endsAt: string };
  after: { startsAt: string; endsAt: string } | null;
  /** 사람이 읽을 영향 설명 */
  warnings: string[];
}

/** 게임 서버용: 지금 보여줄 것 */
export interface LiveOpsView {
  now: string;
  /** 보드마다 진행 중 시즌 (아레나·월드아레나가 동시에 열릴 수 있음) */
  seasons: {
    id: number;
    boardCode: string;
    boardName: string;
    name: string;
    startsAt: string;
    endsAt: string;
  }[];
  events: { id: number; title: string; description: string; startsAt: string; endsAt: string }[];
  popups: {
    id: number;
    title: string;
    imageUrl: string | null;
    link: string | null;
    frequency: PopupFrequency;
    priority: number;
  }[];
  banners: {
    id: number;
    title: string;
    imageUrl: string;
    link: string | null;
    priority: number;
    endsAt: string;
  }[];
  /** 점검 상태 — 진행 중이면 게임 서버는 로그인 화면에 안내 */
  maintenance: GameMaintenanceState;
  /** 세션 세대 번호 — 접속 중 유저의 세대가 이보다 낮으면 연결을 끊는다 */
  sessionEpoch: number;
  /** 로비 한 줄 공지 (최대 5개, 고정 → 최신) */
  tickers: { noticeId: number; text: string }[];
}

export const liveOpsQuerySchema = z.object({ at: dateSchema.optional() });
