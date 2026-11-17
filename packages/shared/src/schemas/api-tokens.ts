import { z } from 'zod';
import { Permission } from '../permissions.js';
import { permissionSchema } from './admins.js';
import { uniqueBy } from './common.js';

export const API_TOKEN_MAX_ACTIVE = 5;
export const API_TOKEN_MAX_DAYS = 90;

/**
 * 공개 체험 계정 토큰 제한 (docs/demo-mode.md)
 * - 권한은 조회만, 만료는 다음 초기화(04:00 KST)까지, 체험 계정 전체 합쳐 동시 20개, 발급은 IP 당 시간당 3회
 */
export const DEMO_TOKEN_PERMISSIONS: readonly Permission[] = [
  Permission.DASHBOARD_READ,
  Permission.USER_READ,
  Permission.CURRENCY_READ,
  Permission.MAIL_READ,
  Permission.RANKING_READ,
  Permission.AUDIT_READ,
  Permission.SCHEDULE_READ,
  Permission.NOTICE_READ,
  Permission.ANALYTICS_READ,
];
export const DEMO_TOKEN_MAX_ACTIVE = 20;
export const DEMO_TOKEN_ISSUE_PER_HOUR = 3;

export const createApiTokenRequestSchema = z.object({
  name: z.string().trim().min(2).max(50),
  permissions: z
    .array(permissionSchema)
    .min(1)
    .refine((list) => uniqueBy(list), '같은 권한이 중복되었습니다.'),
  expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS).default(30),
});
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

export interface ApiTokenSummary {
  id: number;
  name: string;
  /** 토큰 식별용 앞부분 (ga_<prefix>_...) */
  prefix: string;
  permissions: Permission[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiToken extends ApiTokenSummary {
  /** 최초 1회만 표시되는 토큰 원문 */
  token: string;
}
