import { z } from 'zod';
import type { Channel, Permission, RoleCode } from '../permissions.js';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('이메일 형식이 아닙니다.')
  .max(191);

/** 운영자 비밀번호 정책: 10~72자, 영문·숫자 포함 */
export const passwordPolicySchema = z
  .string()
  .min(10, '비밀번호는 10자 이상이어야 합니다.')
  .max(72, '비밀번호는 72자 이하여야 합니다.')
  .regex(/[A-Za-z]/, '영문을 포함해야 합니다.')
  .regex(/[0-9]/, '숫자를 포함해야 합니다.');

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordPolicySchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: '현재 비밀번호와 다른 비밀번호를 사용하세요.',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export interface MeResponse {
  id: number;
  email: string;
  name: string;
  roleCode: RoleCode;
  permissions: Permission[];
  mustChangePassword: boolean;
  channel: Channel;
  /** 공개 체험 계정 (비밀번호 변경·토큰 발급 불가, 매일 초기화) — docs/demo-mode.md */
  isDemo: boolean;
}

/** 로그인 화면용 공개 안내 (GET /public/demo). 체험 모드가 꺼져 있으면 enabled=false 만 */
export interface DemoInfo {
  enabled: boolean;
  accounts: { label: string; email: string; password: string; roleName: string }[];
  /** 다음 초기화 시각 (매일 초기화를 켰을 때) */
  nextResetAt: string | null;
}

export interface LoginResponse {
  accessToken: string;
  /** access token 수명(초) */
  expiresIn: number;
  admin: MeResponse;
}

export type RefreshResponse = Omit<LoginResponse, 'admin'>;
