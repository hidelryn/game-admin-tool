import type { Env } from '../../config/env.js';

/** 공개 체험 계정인지 (DEMO_MODE 가 꺼져 있으면 항상 false) — docs/demo-mode.md */
export const isDemoEmail = (env: Pick<Env, 'DEMO_MODE' | 'DEMO_ACCOUNT_EMAIL'>, email: string) =>
  env.DEMO_MODE && email.trim().toLowerCase() === env.DEMO_ACCOUNT_EMAIL;
