import { eq, max } from 'drizzle-orm';
import { ActivityType, CurrencySource, UserStatus } from '@game-admin/shared';
import type { Executor } from '../types.js';
import {
  currencyTransactions,
  rankingScores,
  rankingSeasons,
  userActivityLogs,
  userCurrencies,
  userSuspensions,
  users,
} from '../schema/index.js';
import { SEED_CURRENCIES } from './core.js';
import { seqFromTime } from '../../../modules/rankings/seq-generator.js';

/**
 * 가상 게임 데이터 시드 (requirements.md 1.1, database.md 6장)
 * - 실제 개인정보 없음: 닉네임은 조합 생성, 이메일은 @example.com
 * - 같은 seed 값이면 항상 같은 데이터 (재현 가능)
 */
export const SEED_SCALES = {
  small: { users: 1_000, days: 30 },
  medium: { users: 10_000, days: 60 },
  large: { users: 100_000, days: 60 },
} as const;
export type SeedScale = keyof typeof SEED_SCALES;

const BATCH = 2_000;

/** mulberry32 — 결정적 난수 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = [
  '용감한',
  '날쌘',
  '조용한',
  '빛나는',
  '푸른',
  '붉은',
  '전설의',
  '졸린',
  '행복한',
  '거친',
  '은빛',
  '작은',
];
const NOUN = [
  '기사',
  '궁수',
  '마법사',
  '도적',
  '드래곤',
  '고양이',
  '여우',
  '늑대',
  '용사',
  '현자',
  '해적',
  '닌자',
];

export interface SeedGameResult {
  users: number;
  activities: number;
  transactions: number;
}

export async function seedGame(
  db: Executor,
  opts: { scale: SeedScale; seed?: number; now?: Date; log?: (msg: string) => void },
): Promise<SeedGameResult> {
  const { users: userCount, days } = SEED_SCALES[opts.scale];
  const rand = rng(opts.seed ?? 20261110);
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const DAY = 86_400_000;
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
  const int = (min: number, maxV: number) => min + Math.floor(rand() * (maxV - min + 1));

  const [{ maxId } = { maxId: 0 }] = await db.select({ maxId: max(users.id) }).from(users);
  const baseId = (maxId ?? 0) + 1;

  const [season] = await db
    .select({ id: rankingSeasons.id })
    .from(rankingSeasons)
    .where(eq(rankingSeasons.status, 'ACTIVE'))
    .limit(1);

  let activities = 0;
  let transactions = 0;

  for (let start = 0; start < userCount; start += BATCH) {
    const userRows: (typeof users.$inferInsert)[] = [];
    const balanceRows: (typeof userCurrencies.$inferInsert)[] = [];
    const txRows: (typeof currencyTransactions.$inferInsert)[] = [];
    const activityRows: (typeof userActivityLogs.$inferInsert)[] = [];
    const suspensionRows: (typeof userSuspensions.$inferInsert)[] = [];
    const scoreRows: (typeof rankingScores.$inferInsert)[] = [];

    for (let i = start; i < Math.min(start + BATCH, userCount); i++) {
      const id = baseId + i;
      const n = id;
      // 가입일: 최근 days 일에 70%, 그 이전 1년에 30%
      const registeredAt = new Date(
        now.getTime() - (rand() < 0.7 ? rand() * days : days + rand() * 365) * DAY,
      );
      const engagement = rand(); // 0~1, 높을수록 자주 접속
      const churnDaysAgo = rand() < 0.3 ? int(0, days) : 0; // 30% 는 언젠가부터 접속 중단
      const roll = rand();
      const status =
        roll < 0.005
          ? UserStatus.WITHDRAWN
          : roll < 0.01
            ? UserStatus.SUSPENDED
            : UserStatus.ACTIVE;

      // 활동 로그: 가입 후 ~ 이탈 전까지, 날마다 engagement 확률로 접속
      let lastLoginAt: Date | null = null;
      const firstDay = Math.min(days, Math.floor((now.getTime() - registeredAt.getTime()) / DAY));
      for (let d = firstDay; d >= churnDaysAgo; d--) {
        if (status === UserStatus.WITHDRAWN || rand() > engagement * 0.8) continue;
        const dayStart = now.getTime() - d * DAY;
        const loginAt = new Date(dayStart - rand() * DAY * 0.9);
        if (loginAt < registeredAt || loginAt > now) continue;
        activityRows.push({
          userId: id,
          type: ActivityType.LOGIN,
          payload: null,
          occurredAt: loginAt,
        });
        const clears = int(0, 3);
        for (let c = 0; c < clears; c++) {
          activityRows.push({
            userId: id,
            type: ActivityType.STAGE_CLEAR,
            payload: { stage: int(1, 120), stars: int(1, 3) },
            occurredAt: new Date(loginAt.getTime() + (c + 1) * 300_000),
          });
        }
        if (!lastLoginAt || loginAt > lastLoginAt) lastLoginAt = loginAt;
      }

      userRows.push({
        id,
        publicId: `U${String(1_000_000 + n)}`,
        nickname: `${pick(ADJ)}${pick(NOUN)}${int(1, 9999)}`,
        email: `player${n}@example.com`,
        level: Math.max(1, Math.round(engagement * 80 + int(0, 20))),
        status,
        registeredAt,
        lastLoginAt,
      });

      // 초기 잔액 + 원장 (source=GAME) — 잔액과 원장 합계가 항상 일치하도록
      for (const c of SEED_CURRENCIES) {
        const cap =
          ({ GOLD: 500_000, GEM: 5_000, FREE_GEM: 3_000, STAMINA: 200 } as Record<string, number>)[
            c.code
          ] ?? 200;
        const balance = Math.floor(rand() * cap * engagement);
        if (balance === 0) continue;
        balanceRows.push({ userId: id, currencyId: c.id, balance, version: 1 });
        txRows.push({
          userId: id,
          currencyId: c.id,
          delta: balance,
          balanceBefore: 0,
          balanceAfter: balance,
          source: CurrencySource.GAME,
          reason: '시드 초기 잔액',
          createdAt: registeredAt,
        });
      }

      if (status === UserStatus.SUSPENDED) {
        suspensionRows.push({
          userId: id,
          reason: '비정상 플레이 의심 (시드 데이터)',
          startsAt: new Date(now.getTime() - int(1, 5) * DAY),
          endsAt: rand() < 0.5 ? null : new Date(now.getTime() + int(1, 30) * DAY),
          suspendedBy: null,
        });
      }

      if (season && lastLoginAt && status !== UserStatus.WITHDRAWN) {
        // 실제 발급 규칙과 같은 시간 기반 번호 (같은 ms 충돌은 userId 하위 3자리로 구분)
        const achievedSeq = seqFromTime(lastLoginAt.getTime()) + (id % 1000);
        scoreRows.push({
          seasonId: season.id,
          userId: id,
          score: Math.floor(engagement ** 2 * 50_000 + rand() * 1_000),
          achievedAt: lastLoginAt,
          achievedSeq,
        });
      }
    }

    await db.insert(users).values(userRows);
    if (balanceRows.length) await db.insert(userCurrencies).values(balanceRows);
    for (let i = 0; i < txRows.length; i += BATCH)
      await db.insert(currencyTransactions).values(txRows.slice(i, i + BATCH));
    for (let i = 0; i < activityRows.length; i += BATCH)
      await db.insert(userActivityLogs).values(activityRows.slice(i, i + BATCH));
    if (suspensionRows.length) await db.insert(userSuspensions).values(suspensionRows);
    if (scoreRows.length) await db.insert(rankingScores).values(scoreRows);

    activities += activityRows.length;
    transactions += txRows.length;
    log(
      `  users ${Math.min(start + BATCH, userCount).toLocaleString()} / ${userCount.toLocaleString()}`,
    );
  }

  return { users: userCount, activities, transactions };
}

/** --reset 시 비우는 게임 데이터 테이블 (운영자·권한·마스터는 유지) */
export const GAME_TABLES = [
  'ranking_snapshots',
  'ranking_scores',
  'global_mail_claims',
  'mail_recipients',
  'mail_rewards',
  'mails',
  'user_items',
  'currency_transactions',
  'user_currencies',
  'user_activity_logs',
  'user_suspensions',
  'users',
  'daily_kpis',
  'daily_currency_stats',
] as const;
