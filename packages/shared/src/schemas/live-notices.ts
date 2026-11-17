import { z } from 'zod';
import {
  confirmationTokenSchema,
  dateSchema,
  pageQuerySchema,
  publicIdSchema,
  reasonSchema,
  uniqueBy,
} from './common.js';

/** 점검 · 공지 (docs/maintenance-notice.md) */

// ───────────────────────── 점검 ─────────────────────────

export const MaintenanceStatus = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  CANCELED: 'CANCELED',
} as const;
export type MaintenanceStatus = (typeof MaintenanceStatus)[keyof typeof MaintenanceStatus];

/** 상태는 시각으로 계산. "지금 열기"로 앞당겨 끝내면 ended_at 이 종료 */
export function maintenanceStatusOf(
  m: {
    startsAt: Date | string;
    endsAt: Date | string;
    endedAt: Date | string | null;
    canceledAt: Date | string | null;
  },
  now = new Date(),
): MaintenanceStatus {
  if (m.canceledAt) return MaintenanceStatus.CANCELED;
  if (now < new Date(m.startsAt)) return MaintenanceStatus.SCHEDULED;
  if (now < new Date(m.endedAt ?? m.endsAt)) return MaintenanceStatus.ACTIVE;
  return MaintenanceStatus.ENDED;
}

export const MAINTENANCE_ALLOW_MAX = 100;

const allowListSchema = z
  .array(publicIdSchema)
  .max(MAINTENANCE_ALLOW_MAX)
  .refine((v) => uniqueBy(v), '같은 회원 ID 가 중복되었습니다.')
  .default([]);

/** 예약(startsAt) 또는 긴급(startNow — 확인 토큰 필요, L2) */
export const createMaintenanceRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(50),
    /** 유저에게 보이는 안내 */
    message: z.string().trim().min(1).max(500),
    startNow: z.boolean().default(false),
    startsAt: dateSchema.optional(),
    endsAt: dateSchema,
    allowPublicIds: allowListSchema,
    /** 점검 공지(목록 + 티커)를 같이 만들지 */
    createNotice: z.boolean().default(true),
    reason: reasonSchema,
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.startNow && !v.startsAt)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startsAt'],
        message: '시작 시각을 정하거나 긴급 점검을 고르세요.',
      });
    if (v.startsAt && v.endsAt <= v.startsAt)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: '종료는 시작보다 뒤여야 합니다.',
      });
  });
export type CreateMaintenanceRequest = z.infer<typeof createMaintenanceRequestSchema>;

/**
 * 수정: 시작 전엔 전부(L1) / 진행 중엔 종료 예정 시각(연장·단축, L2)·문구·예외 회원만
 */
export const updateMaintenanceRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(50),
    message: z.string().trim().min(1).max(500),
    startsAt: dateSchema,
    endsAt: dateSchema,
    allowPublicIds: allowListSchema,
    reason: reasonSchema,
    version: z.number().int().positive(),
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    path: ['endsAt'],
    message: '종료는 시작보다 뒤여야 합니다.',
  });
export type UpdateMaintenanceRequest = z.infer<typeof updateMaintenanceRequestSchema>;

/** 취소(시작 전, L1) / 지금 열기(진행 중, L2) */
export const maintenanceActionRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().positive(),
  confirmationToken: confirmationTokenSchema.optional(),
});
export type MaintenanceActionRequest = z.infer<typeof maintenanceActionRequestSchema>;

export const listMaintenancesQuerySchema = pageQuerySchema;

export interface MaintenanceView {
  id: number;
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  status: MaintenanceStatus;
  startedAt: string | null;
  endedAt: string | null;
  canceledAt: string | null;
  allowPublicIds: string[];
  sessionEpoch: number | null;
  notice: { id: number; title: string } | null;
  createdBy: { id: number; name: string };
  updatedBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** 긴급 시작·연장·지금 열기 확인 화면 (L2) */
export interface MaintenanceChangePreview {
  maintenanceId: number | null;
  title: string;
  action: 'START_NOW' | 'EXTEND' | 'OPEN_NOW';
  startsAt: string;
  endsAt: string;
  /** 최근 30분 안에 접속한 회원 수 (끊길 사람 추정) */
  recentPlayers: number;
  warnings: string[];
}

/** 게임·백오피스 공통: 지금 점검 상태 */
export interface GameMaintenanceState {
  active: boolean;
  maintenanceId: number | null;
  title: string | null;
  message: string | null;
  endsAt: string | null;
  /** 세션 세대 번호 — 게임 서버는 이보다 낮은 세대로 접속한 유저를 끊는다 */
  sessionEpoch: number;
}

// ───────────────────────── 공지 ─────────────────────────

export const NoticeCategory = {
  NOTICE: 'NOTICE',
  UPDATE: 'UPDATE',
  EVENT: 'EVENT',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type NoticeCategory = (typeof NoticeCategory)[keyof typeof NoticeCategory];

export const NoticeStatus = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  HIDDEN: 'HIDDEN',
} as const;
export type NoticeStatus = (typeof NoticeStatus)[keyof typeof NoticeStatus];

export function noticeStatusOf(
  n: { startsAt: Date | string; endsAt: Date | string | null; hiddenAt: Date | string | null },
  now = new Date(),
): NoticeStatus {
  if (n.hiddenAt) return NoticeStatus.HIDDEN;
  if (now < new Date(n.startsAt)) return NoticeStatus.SCHEDULED;
  if (n.endsAt && now >= new Date(n.endsAt)) return NoticeStatus.ENDED;
  return NoticeStatus.ACTIVE;
}

export const NOTICE_TICKER_MAX = 5;

const noticeBody = z.object({
  category: z.nativeEnum(NoticeCategory),
  title: z.string().trim().min(1).max(60),
  /** 평문만 (HTML 은 글자 그대로 보임) */
  body: z.string().trim().min(1).max(5000),
  startsAt: dateSchema,
  endsAt: dateSchema.nullable().default(null),
  pinned: z.boolean().default(false),
  tickerEnabled: z.boolean().default(false),
  tickerText: z.string().trim().max(80).nullable().default(null),
  reason: reasonSchema,
});
const noticeRules = (v: z.infer<typeof noticeBody>, ctx: z.RefinementCtx) => {
  if (v.endsAt && v.endsAt <= v.startsAt)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: '종료는 시작보다 뒤여야 합니다.',
    });
  if (v.tickerEnabled && !v.tickerText)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tickerText'],
      message: '한 줄 공지 문구를 입력하세요.',
    });
};

export const createNoticeRequestSchema = noticeBody.superRefine(noticeRules);
export type CreateNoticeRequest = z.infer<typeof createNoticeRequestSchema>;

export const updateNoticeRequestSchema = noticeBody
  .extend({ version: z.number().int().positive() })
  .superRefine(noticeRules);
export type UpdateNoticeRequest = z.infer<typeof updateNoticeRequestSchema>;

export const hideNoticeRequestSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().positive(),
});
export type HideNoticeRequest = z.infer<typeof hideNoticeRequestSchema>;

export const listNoticesQuerySchema = pageQuerySchema.extend({
  category: z.nativeEnum(NoticeCategory).optional(),
  includeHidden: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListNoticesQuery = z.infer<typeof listNoticesQuerySchema>;

export interface NoticeView {
  id: number;
  category: NoticeCategory;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  status: NoticeStatus;
  pinned: boolean;
  tickerEnabled: boolean;
  tickerText: string | null;
  hiddenAt: string | null;
  maintenanceId: number | null;
  createdBy: { id: number; name: string };
  updatedBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** 게임용 공지 */
export interface GameNotice {
  id: number;
  category: NoticeCategory;
  title: string;
  body: string;
  pinned: boolean;
  startsAt: string;
  endsAt: string | null;
}
