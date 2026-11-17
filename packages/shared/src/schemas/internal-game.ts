import { z } from 'zod';
import { ActivityType } from './users.js';
import { publicIdSchema } from './common.js';
import { RANKING_SCORE_MAX } from './rankings.js';

/**
 * 게임 서버(시뮬레이터) → 백오피스 내부 API (api-specification.md 2.12)
 * 운영 환경에서는 비활성화된다.
 */
export const gameEventsRequestSchema = z.object({
  events: z
    .array(
      z.object({
        publicId: publicIdSchema,
        type: z.nativeEnum(ActivityType),
        payload: z.record(z.unknown()).optional(),
        occurredAt: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type GameEventsRequest = z.infer<typeof gameEventsRequestSchema>;

export const gameScoreRequestSchema = z.object({
  seasonId: z.number().int().positive().optional(),
  /** 시즌 대신 보드로 지정하면 그 보드의 진행 중 시즌에 기록 (예: ARENA, WORLD_ARENA) */
  boardCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,20}$/)
    .optional(),
  publicId: publicIdSchema,
  score: z.number().int().min(0).max(RANKING_SCORE_MAX),
});

export const gameCurrencyRequestSchema = z.object({
  publicId: publicIdSchema,
  currencyCode: z.string().trim().toUpperCase(),
  /** 양수 = 게임 내 획득, 음수 = 소비 */
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, '0 은 허용되지 않습니다.'),
  reason: z.string().trim().min(1).max(200),
});

export const gameClaimRequestSchema = z.object({ publicId: publicIdSchema });

export const sampleUsersQuerySchema = z.object({
  size: z.coerce.number().int().min(1).max(500).default(50),
});

export interface GameEventsResult {
  accepted: number;
  /** 정지·탈퇴·없는 회원의 이벤트는 거부 */
  rejected: { publicId: string; reason: string }[];
}
