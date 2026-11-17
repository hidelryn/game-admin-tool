import type { DemoInfo } from '@game-admin/shared';
import type { Env } from '../../config/env.js';

/** 매일 초기화 시각 (KST) — worker 의 cron 과 같아야 한다 */
export const DEMO_RESET_HOUR_KST = 4;

/** 다음 04:00 KST */
export function nextResetAt(now = new Date()): Date {
  const KST = 9 * 3_600_000;
  const local = new Date(now.getTime() + KST);
  const target = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    DEMO_RESET_HOUR_KST,
  );
  const next = target <= local.getTime() ? target + 86_400_000 : target;
  return new Date(next - KST);
}

/** 로그인 화면용 공개 안내 — 체험 계정은 공개하려고 만든 계정이라 비밀번호를 그대로 돌려준다 */
export function demoInfo(env: Env, now = new Date()): DemoInfo {
  if (!env.DEMO_MODE || !env.DEMO_ACCOUNT_PASSWORD) {
    return { enabled: false, accounts: [], nextResetAt: null };
  }
  return {
    enabled: true,
    accounts: [
      {
        label: '체험용 운영자',
        email: env.DEMO_ACCOUNT_EMAIL,
        password: env.DEMO_ACCOUNT_PASSWORD,
        roleName: '운영자',
      },
    ],
    nextResetAt: env.DEMO_DAILY_RESET ? nextResetAt(now).toISOString() : null,
  };
}
