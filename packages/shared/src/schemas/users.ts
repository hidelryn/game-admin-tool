import { z } from 'zod';
import {
  confirmationTokenSchema,
  cursorQuerySchema,
  dateSchema,
  pageQuerySchema,
  reasonSchema,
} from './common.js';

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ActivityType = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  STAGE_CLEAR: 'STAGE_CLEAR',
  ITEM_USE: 'ITEM_USE',
  CURRENCY_EARN: 'CURRENCY_EARN',
  CURRENCY_SPEND: 'CURRENCY_SPEND',
  MAIL_CLAIM: 'MAIL_CLAIM',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const listUsersQuerySchema = pageQuerySchema.extend({
  publicId: z.string().trim().min(1).max(20).optional(),
  /** 접두어 검색 (인덱스 사용) */
  nickname: z.string().trim().min(1).max(30).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  registeredFrom: dateSchema.optional(),
  registeredTo: dateSchema.optional(),
  sort: z
    .enum(['registeredAt:desc', 'registeredAt:asc', 'lastLoginAt:desc'])
    .default('registeredAt:desc'),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const activitiesQuerySchema = cursorQuerySchema.extend({
  type: z.nativeEnum(ActivityType).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
export type ActivitiesQuery = z.infer<typeof activitiesQuerySchema>;

export const SUSPEND_MAX_DAYS = 3650;

export const suspendUserRequestSchema = z
  .object({
    durationDays: z.number().int().min(1).max(SUSPEND_MAX_DAYS).optional(),
    permanent: z.literal(true).optional(),
    reason: reasonSchema,
    confirmationToken: confirmationTokenSchema.optional(),
  })
  .refine((v) => (v.durationDays !== undefined) !== (v.permanent === true), {
    message: 'durationDays 와 permanent 중 하나만 지정하세요.',
  });
export type SuspendUserRequest = z.infer<typeof suspendUserRequestSchema>;

export const unsuspendUserRequestSchema = z.object({ reason: reasonSchema });
export type UnsuspendUserRequest = z.infer<typeof unsuspendUserRequestSchema>;

export interface UserSummary {
  publicId: string;
  nickname: string;
  /** 기본 마스킹 (user:read_pii 로 원문 조회) */
  email: string;
  level: number;
  status: UserStatus;
  registeredAt: string;
  lastLoginAt: string | null;
}

export interface UserSuspension {
  id: number;
  reason: string;
  startsAt: string;
  /** null = 영구 */
  endsAt: string | null;
  suspendedBy: number | null;
  releasedAt: string | null;
  releasedBy: number | null;
  releaseReason: string | null;
}

export interface UserActivity {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

export interface UserDetail extends UserSummary {
  balances: { currencyCode: string; balance: number }[];
  activeSuspension: UserSuspension | null;
  recentActivities: UserActivity[];
}
