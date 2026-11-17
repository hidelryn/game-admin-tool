import { z } from 'zod';
import {
  confirmationTokenSchema,
  cursorQuerySchema,
  dateSchema,
  publicIdSchema,
  reasonSchema,
  uniqueBy,
} from './common.js';

export const CurrencySource = {
  ADMIN: 'ADMIN',
  MAIL: 'MAIL',
  GAME: 'GAME',
} as const;
export type CurrencySource = (typeof CurrencySource)[keyof typeof CurrencySource];

export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z_]{2,20}$/, '재화 코드 형식이 아닙니다.');

/** 1회 변경 수량 상한(안전장치). 실제 상한은 재화별 grantLimitPerRequest */
export const CURRENCY_AMOUNT_MAX = 1_000_000_000;

export const changeCurrencyRequestSchema = z.object({
  currencyCode: currencyCodeSchema,
  amount: z.number().int().min(1).max(CURRENCY_AMOUNT_MAX),
  reason: reasonSchema,
  confirmationToken: confirmationTokenSchema.optional(),
});
export type ChangeCurrencyRequest = z.infer<typeof changeCurrencyRequestSchema>;

export const BULK_GRANT_MAX_USERS = 1000;
/** 회원 × 재화 행 수 상한 (한 회원에게 여러 재화를 줄 수 있으므로 인원 상한과 별도) */
export const BULK_GRANT_MAX_ENTRIES = 3000;
/** 이 인원(서로 다른 회원 수) 이상이면 웹에서 빨간 경고 확인 후 실행 (L3, MCP 불가) */
export const BULK_GRANT_CONFIRM_THRESHOLD = 100;

const bulkAmountSchema = z.number().int().min(1).max(CURRENCY_AMOUNT_MAX);

export const bulkGrantEntrySchema = z.object({
  publicId: publicIdSchema,
  /** 비우면 요청의 currencyCode 를 쓴다 */
  currencyCode: currencyCodeSchema.optional(),
  amount: bulkAmountSchema,
  /** 비우면 요청의 reason 을 쓴다. 원장·감사 로그에 행마다 기록 */
  reason: reasonSchema.optional(),
});

/**
 * 대량 지급 요청 — 두 가지 형태를 받아 `entries` 로 정규화한다
 * - 행별 지급: `{ entries: [{ publicId, currencyCode?, amount, reason? }], currencyCode?, reason? }`
 *   (웹의 CSV·엑셀 업로드. 같은 회원에게 여러 재화 가능, 회원+재화 조합은 중복 불가.
 *    행에 비운 재화·사유는 요청의 값으로 채움)
 * - 전원 같은 지급: `{ publicIds, currencyCode, amount, reason }` (MCP·간단 입력)
 */
export const bulkGrantRequestSchema = z
  .object({
    currencyCode: currencyCodeSchema.optional(),
    reason: reasonSchema.optional(),
    entries: z.array(bulkGrantEntrySchema).min(1).max(BULK_GRANT_MAX_ENTRIES).optional(),
    publicIds: z.array(publicIdSchema).min(1).max(BULK_GRANT_MAX_USERS).optional(),
    amount: bulkAmountSchema.optional(),
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const perRow = v.entries !== undefined;
    const uniform = v.publicIds !== undefined || v.amount !== undefined;
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (perRow === uniform)
      return issue(['entries'], 'entries 또는 publicIds+amount 중 하나만 보내세요.');

    if (uniform) {
      if (v.publicIds === undefined || v.amount === undefined)
        return issue(['amount'], 'publicIds 와 amount 를 함께 보내세요.');
      if (!v.currencyCode) issue(['currencyCode'], '재화를 지정하세요.');
      if (!v.reason) issue(['reason'], '사유를 입력하세요.');
      if (!uniqueBy(v.publicIds)) issue(['publicIds'], '중복된 회원 ID 가 있습니다.');
      return;
    }
    v.entries!.forEach((e, i) => {
      if (!e.currencyCode && !v.currencyCode)
        issue(['entries', i, 'currencyCode'], '재화를 지정하세요.');
      if (!e.reason && !v.reason) issue(['entries', i, 'reason'], '사유를 입력하세요.');
    });
    if (!uniqueBy(v.entries!, (e) => `${e.publicId}|${e.currencyCode ?? v.currencyCode}`)) {
      issue(['entries'], '같은 회원·재화 조합이 중복되었습니다.');
    }
    if (new Set(v.entries!.map((e) => e.publicId)).size > BULK_GRANT_MAX_USERS) {
      issue(['entries'], `한 번에 ${BULK_GRANT_MAX_USERS}명까지 지급할 수 있습니다.`);
    }
  })
  .transform((v) => ({
    entries: v.entries
      ? v.entries.map((e) => ({
          publicId: e.publicId,
          currencyCode: (e.currencyCode ?? v.currencyCode)!,
          amount: e.amount,
          reason: (e.reason ?? v.reason)!,
        }))
      : v.publicIds!.map((publicId) => ({
          publicId,
          currencyCode: v.currencyCode!,
          amount: v.amount!,
          reason: v.reason!,
        })),
    confirmationToken: v.confirmationToken,
  }));
/** 클라이언트가 보내는 형태 */
export type BulkGrantRequest = z.input<typeof bulkGrantRequestSchema>;
/** 서버가 다루는 정규화된 형태 (모든 행에 재화·사유가 채워짐) */
export type BulkGrant = Omit<z.output<typeof bulkGrantRequestSchema>, 'confirmationToken'> & {
  confirmationToken?: string;
};
export type BulkGrantEntry = BulkGrant['entries'][number];

export const currencyTransactionsQuerySchema = cursorQuerySchema.extend({
  currencyCode: currencyCodeSchema.optional(),
  source: z.nativeEnum(CurrencySource).optional(),
  adminId: z.coerce.number().int().positive().optional(),
  publicId: publicIdSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export type CurrencyTransactionsQuery = z.infer<typeof currencyTransactionsQuerySchema>;

export interface CurrencyInfo {
  code: string;
  name: string;
  isPaid: boolean;
  maxBalance: number;
  grantLimitPerRequest: number;
}

export interface CurrencyBalance {
  currencyCode: string;
  name: string;
  balance: number;
  maxBalance: number;
}

export interface CurrencyTransaction {
  id: number;
  publicId: string | null;
  currencyCode: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  source: CurrencySource;
  reason: string | null;
  adminId: number | null;
  adminName: string | null;
  channel: string | null;
  createdAt: string;
}

export interface CurrencyChangeResult {
  status: 'EXECUTED';
  transactionId: number;
  publicId: string;
  currencyCode: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface CurrencyChangePreview {
  publicId: string;
  currencyCode: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface BulkGrantResult {
  status: 'EXECUTED';
  /** 지급 건수 (회원 × 재화) */
  count: number;
  userCount: number;
  totals: { currencyCode: string; amount: number }[];
}
