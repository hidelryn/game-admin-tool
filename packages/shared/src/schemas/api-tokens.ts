import { z } from 'zod';
import type { Permission } from '../permissions.js';
import { permissionSchema } from './admins.js';
import { uniqueBy } from './common.js';

export const API_TOKEN_MAX_ACTIVE = 5;
export const API_TOKEN_MAX_DAYS = 90;

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
