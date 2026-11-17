import { z } from 'zod';
import {
  dateSchema,
  pageQuerySchema,
  publicIdSchema,
  reasonSchema,
  uniqueBy,
  confirmationTokenSchema,
} from './common.js';

export const MailType = { USER: 'USER', GLOBAL: 'GLOBAL' } as const;
export type MailType = (typeof MailType)[keyof typeof MailType];

/** SCHEDULED 는 예약 발송 확장용 (requirements FR-MAIL-09) */
export const MailStatus = { SCHEDULED: 'SCHEDULED', SENT: 'SENT', CANCELED: 'CANCELED' } as const;
export type MailStatus = (typeof MailStatus)[keyof typeof MailStatus];

export const RewardType = { CURRENCY: 'CURRENCY', ITEM: 'ITEM' } as const;
export type RewardType = (typeof RewardType)[keyof typeof RewardType];

export const MAIL_MAX_RECIPIENTS = 1000;
/** MCP 채널은 대상 100명까지 (mcp-tools.md 2.6) */
export const MAIL_MAX_RECIPIENTS_MCP = 100;
export const MAIL_MAX_REWARDS = 10;
export const ITEM_REWARD_MAX = 1000;

export const rewardSchema = z.object({
  type: z.nativeEnum(RewardType),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,40}$/, '보상 코드 형식이 아닙니다.'),
  quantity: z.number().int().min(1),
});
export type Reward = z.infer<typeof rewardSchema>;

const rewardsSchema = z
  .array(rewardSchema)
  .max(MAIL_MAX_REWARDS)
  .refine((v) => uniqueBy(v, (r) => `${r.type}:${r.code}`), '같은 보상이 중복되었습니다.')
  .default([]);

const mailContent = {
  title: z.string().trim().min(1).max(50),
  body: z.string().trim().min(1).max(500),
  rewards: rewardsSchema,
  expiresInDays: z.number().int().min(1).max(30).default(7),
  reason: reasonSchema,
};

export const sendMailRequestSchema = z.object({
  publicIds: z
    .array(publicIdSchema)
    .min(1)
    .max(MAIL_MAX_RECIPIENTS)
    .refine((v) => uniqueBy(v), '중복된 회원 ID 가 있습니다.'),
  ...mailContent,
});
export type SendMailRequest = z.infer<typeof sendMailRequestSchema>;

export const sendGlobalMailRequestSchema = z.object({
  ...mailContent,
  /** 대상 조건 — 지정 시 그 시각 이전 가입자만 수령 가능 */
  targetFilter: z.object({ registeredBefore: dateSchema.optional() }).optional(),
  /** L3: 웹에서 빨간 경고 확인 후 두 번째 요청에 */
  confirmationToken: confirmationTokenSchema.optional(),
});
export type SendGlobalMailRequest = z.infer<typeof sendGlobalMailRequestSchema>;

export const cancelMailRequestSchema = z.object({
  reason: reasonSchema,
  confirmationToken: confirmationTokenSchema.optional(),
});
export type CancelMailRequest = z.infer<typeof cancelMailRequestSchema>;

export const listMailsQuerySchema = pageQuerySchema.extend({
  type: z.nativeEnum(MailType).optional(),
  status: z.nativeEnum(MailStatus).optional(),
  createdBy: z.coerce.number().int().positive().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export type ListMailsQuery = z.infer<typeof listMailsQuerySchema>;

export interface MailRewardView {
  type: RewardType;
  code: string;
  name: string;
  quantity: number;
}

export interface MailSummary {
  id: number;
  type: MailType;
  title: string;
  status: MailStatus;
  rewards: MailRewardView[];
  /** 개별 발송 수신자 수 (전체 발송은 null) */
  recipientCount: number | null;
  claimedCount: number;
  expiresAt: string;
  sentAt: string | null;
  canceledAt: string | null;
  createdBy: { id: number; name: string };
  reason: string;
  createdAt: string;
}

export interface MailDetail extends MailSummary {
  body: string;
  targetFilter: Record<string, unknown> | null;
}

export interface MailRecipientView {
  publicId: string;
  nickname: string;
  readAt: string | null;
  claimedAt: string | null;
}

export interface UserMailboxItem {
  mailId: number;
  type: MailType;
  title: string;
  rewards: MailRewardView[];
  status: MailStatus;
  expiresAt: string;
  claimedAt: string | null;
}

export interface MailSent {
  status: 'SENT';
  mailId: number;
  recipientCount: number;
}

export interface MailClaimResult {
  mailId: number;
  publicId: string;
  rewards: MailRewardView[];
  claimedAt: string;
}
