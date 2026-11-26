import { z } from 'zod';

/** 변경 작업 사유 (api-specification.md 1장: 5~200자) */
export const reasonSchema = z.string().trim().min(5, '사유는 5자 이상 입력하세요.').max(200);

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export const idParamSchema = z.coerce.number().int().positive();

/** 대용량 이력용 커서 페이지네이션 (api-specification.md 1장) */
export const cursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

/** 날짜 범위 (ISO 문자열 또는 YYYY-MM-DD) */
export const dateSchema = z.coerce.date();

/** 위험 작업 L2 두 번째 호출에 넣는 확인 토큰 (architecture.md 4.4) */
export const confirmationTokenSchema = z
  .string()
  .regex(/^cf_[A-Za-z0-9_-]{32}$/, '확인 토큰 형식이 아닙니다.');

/** 회원 외부 노출 ID */
export const publicIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,20}$/, '회원 ID 형식이 아닙니다.');

/** 422 CONFIRMATION_REQUIRED 응답의 error.details */
export interface ConfirmationRequiredDetails<TPreview = unknown> {
  preview: TPreview;
  confirmationToken: string;
  expiresAt: string;
}

/**
 * 대규모·되돌리기 어려운 작업 (위험도 L3 — 웹 전용 강한 확인)
 * 확인 토큰 흐름은 L2 와 같고, MCP(API 토큰)로는 미리보기까지만 (실행은 사람이 웹에서)
 */
export const DangerAction = {
  CURRENCY_BULK_GRANT: 'CURRENCY_BULK_GRANT',
  MAIL_SEND_ALL: 'MAIL_SEND_ALL',
  RANKING_RESET: 'RANKING_RESET',
  RANKING_RESTORE: 'RANKING_RESTORE',
  RANKING_REWARD: 'RANKING_REWARD',
  EMAIL_SEND_BULK: 'EMAIL_SEND_BULK',
} as const;
export type DangerAction = (typeof DangerAction)[keyof typeof DangerAction];

/** L3 확인 화면 (빨간 경고) */
export interface DangerPreview {
  action: DangerAction;
  title: string;
  /** 대상 수·금액 등 크게 보여줄 값 */
  facts: { label: string; value: string }[];
  warnings: string[];
}

export function uniqueBy<T>(items: readonly T[], key: (v: T) => unknown = (v) => v): boolean {
  return new Set(items.map(key)).size === items.length;
}
