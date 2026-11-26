import { z } from 'zod';
import {
  confirmationTokenSchema,
  dateSchema,
  pageQuerySchema,
  publicIdSchema,
  reasonSchema,
  uniqueBy,
} from './common.js';

/**
 * 이메일 발송 (docs/email.md)
 * - 대상: 회원 지정(USERS) · 전체 회원(ALL) · 주소 직접 입력 1건(ADDRESS)
 * - 회원 주소는 가상(@example.com)이라 실제 발송은 허용 목록 주소와 직접 입력 주소만, 나머지는 "가상 발송" 기록
 * - 광고성 메일은 제목에 "(광고)", 수신 동의 회원만, 야간(21~08시 KST)엔 야간 동의 회원만
 */
export const EmailTargetType = { USERS: 'USERS', ALL: 'ALL', ADDRESS: 'ADDRESS' } as const;
export type EmailTargetType = (typeof EmailTargetType)[keyof typeof EmailTargetType];

export const EmailCampaignStatus = {
  SCHEDULED: 'SCHEDULED',
  SENDING: 'SENDING',
  DONE: 'DONE',
  CANCELED: 'CANCELED',
} as const;
export type EmailCampaignStatus = (typeof EmailCampaignStatus)[keyof typeof EmailCampaignStatus];

export const EmailDeliveryStatus = {
  /** SMTP 로 실제 발송 */
  SENT: 'SENT',
  /** 가상 발송 (가상 주소·체험 계정 대량 발송·SMTP 미설정) — 기록만 */
  VIRTUAL: 'VIRTUAL',
  /** 광고성인데 수신 동의 안 함 */
  SKIPPED_NO_CONSENT: 'SKIPPED_NO_CONSENT',
  /** 광고성 + 야간인데 야간 수신 동의 안 함 */
  SKIPPED_NIGHT: 'SKIPPED_NIGHT',
  /** 탈퇴·정지 회원 */
  SKIPPED_INACTIVE: 'SKIPPED_INACTIVE',
  FAILED: 'FAILED',
} as const;
export type EmailDeliveryStatus = (typeof EmailDeliveryStatus)[keyof typeof EmailDeliveryStatus];

export const EMAIL_SUBJECT_MAX = 100;
export const EMAIL_BODY_MAX = 5000;
/** 회원 지정 발송 최대 인원. 100명 이상은 L3(웹 전용 빨간 경고) */
export const EMAIL_MAX_USERS = 1000;
export const EMAIL_BULK_CONFIRM_THRESHOLD = 100;
/** 야간 광고 전송 제한 (KST) — 21시 ~ 다음 날 8시 */
export const EMAIL_NIGHT_START_HOUR = 21;
export const EMAIL_NIGHT_END_HOUR = 8;
/** 광고성 제목 머리말 */
export const EMAIL_AD_PREFIX = '(광고) ';

/** 체험 계정의 주소 직접 입력 발송 제한 */
export const DEMO_EMAIL_BODY_MAX = 1000;
export const DEMO_EMAIL_SUBJECT_PREFIX = '[Game Admin 체험] ';

export const emailTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(EmailTargetType.USERS),
    publicIds: z
      .array(publicIdSchema)
      .min(1)
      .max(EMAIL_MAX_USERS)
      .refine((v) => uniqueBy(v), '중복된 회원 ID 가 있습니다.'),
  }),
  z.object({ type: z.literal(EmailTargetType.ALL) }),
  z.object({
    type: z.literal(EmailTargetType.ADDRESS),
    address: z.string().trim().toLowerCase().email('이메일 주소 형식이 아닙니다.').max(191),
  }),
]);
export type EmailTarget = z.infer<typeof emailTargetSchema>;

/** 본문 아래 버튼 (선택) — https 링크만. 체험 계정은 사용 불가 */
export const emailCtaSchema = z.object({
  label: z.string().trim().min(1).max(30),
  url: z
    .string()
    .trim()
    .url('링크 형식이 아닙니다.')
    .max(500)
    .refine((u) => u.startsWith('https://'), 'https:// 로 시작하는 링크만 넣을 수 있습니다.'),
});
export type EmailCta = z.infer<typeof emailCtaSchema>;

const emailContent = {
  subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX),
  /** 평문 (HTML 은 서버가 이스케이프해서 만든다) */
  body: z.string().trim().min(1).max(EMAIL_BODY_MAX),
  /** 광고성 정보 — 제목에 (광고), 수신 동의·야간 제한 적용 */
  isAd: z.boolean().default(false),
  cta: emailCtaSchema.optional(),
};

export const sendEmailRequestSchema = z
  .object({
    target: emailTargetSchema,
    ...emailContent,
    /** 없으면 바로 발송. 주소 직접 입력은 예약 불가 */
    scheduledAt: dateSchema.optional(),
    reason: reasonSchema,
    /** L3(전체·100명 이상): 웹에서 빨간 경고 확인 후 두 번째 요청에 */
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .refine((v) => !(v.target.type === EmailTargetType.ADDRESS && v.isAd), {
    message: '주소 직접 입력 발송은 광고성 메일로 보낼 수 없습니다 (수신 동의를 확인할 수 없음).',
    path: ['isAd'],
  })
  .refine((v) => !(v.target.type === EmailTargetType.ADDRESS && v.scheduledAt), {
    message: '주소 직접 입력 발송은 예약할 수 없습니다.',
    path: ['scheduledAt'],
  });
export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const emailPreviewRequestSchema = z.object({
  target: emailTargetSchema,
  isAd: z.boolean().default(false),
  scheduledAt: dateSchema.optional(),
});
export type EmailPreviewRequest = z.infer<typeof emailPreviewRequestSchema>;

/** 작성 화면 "메일 미리보기" — 실제 보낼 디자인 그대로 (아무것도 보내지 않음) */
export const emailRenderRequestSchema = z.object({
  targetType: z.nativeEnum(EmailTargetType),
  ...emailContent,
});
export type EmailRenderRequest = z.infer<typeof emailRenderRequestSchema>;

export interface EmailRendered {
  subject: string;
  html: string;
}

export const cancelEmailRequestSchema = z.object({ reason: reasonSchema });
export type CancelEmailRequest = z.infer<typeof cancelEmailRequestSchema>;

export const listEmailCampaignsQuerySchema = pageQuerySchema.extend({
  status: z.nativeEnum(EmailCampaignStatus).optional(),
});
export type ListEmailCampaignsQuery = z.infer<typeof listEmailCampaignsQuerySchema>;

export const listEmailDeliveriesQuerySchema = pageQuerySchema.extend({
  status: z.nativeEnum(EmailDeliveryStatus).optional(),
});
export type ListEmailDeliveriesQuery = z.infer<typeof listEmailDeliveriesQuerySchema>;

export interface EmailCounts {
  total: number;
  sent: number;
  virtual: number;
  skipped: number;
  failed: number;
}

export interface EmailCampaignSummary {
  id: number;
  targetType: EmailTargetType;
  /** 회원 지정 인원 / 직접 입력 주소(마스킹) */
  targetLabel: string;
  subject: string;
  isAd: boolean;
  status: EmailCampaignStatus;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: { id: number; name: string } | null;
  channel: string;
  reason: string;
  counts: EmailCounts;
  createdAt: string;
}

export interface EmailCampaignDetail extends EmailCampaignSummary {
  body: string;
  cta: EmailCta | null;
  canceledAt: string | null;
}

export interface EmailDeliveryItem {
  id: number;
  publicId: string | null;
  nickname: string | null;
  /** 마스킹된 주소 */
  address: string;
  status: EmailDeliveryStatus;
  error: string | null;
  processedAt: string;
}

/** 작성 화면 미리보기 — 지금 보낸다면 몇 명이 어떻게 처리되는지 */
export interface EmailPreview {
  total: number;
  /** 실제 SMTP 발송 예정 */
  real: number;
  virtual: number;
  skippedNoConsent: number;
  skippedNight: number;
  skippedInactive: number;
  /** 야간 시간대인지 (광고성일 때만 의미) */
  night: boolean;
  /** 이 요청이 L3(웹 전용 빨간 경고) 대상인지 */
  bulk: boolean;
  notes: string[];
}

export interface EmailSendResult {
  campaignId: number;
  status: EmailCampaignStatus;
  counts: EmailCounts;
}

/** 체험 계정 안내용 공개 한도 */
export interface EmailLimits {
  smtpConfigured: boolean;
  demo: { perIpPerHour: number; perAddressPerDay: number; perDay: number; bodyMax: number } | null;
}
