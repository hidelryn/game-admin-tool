import { eq, max } from 'drizzle-orm';
import { ActivityType, CurrencySource, UserStatus } from '@game-admin/shared';
import type { Executor } from '../types.js';
import {
  currencyTransactions,
  purchases,
  rankingScores,
  rankingSeasons,
  userActivityLogs,
  userCurrencies,
  userSuspensions,
  users,
} from '../schema/index.js';
import { SEED_CURRENCIES, SEED_PRODUCTS } from './core.js';
import { planSession, type PlayerState } from '../../../modules/analytics/game-model.js';
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
  purchases: number;
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
  let purchaseCount = 0;
  const currencyByCode = new Map(SEED_CURRENCIES.map((c) => [c.code as string, c]));
  const productByCode = new Map(SEED_PRODUCTS.map((p) => [p.code as string, p]));

  for (let start = 0; start < userCount; start += BATCH) {
    const userRows: (typeof users.$inferInsert)[] = [];
    const balanceRows: (typeof userCurrencies.$inferInsert)[] = [];
    const txRows: (typeof currencyTransactions.$inferInsert)[] = [];
    const activityRows: (typeof userActivityLogs.$inferInsert)[] = [];
    const suspensionRows: (typeof userSuspensions.$inferInsert)[] = [];
    const scoreRows: (typeof rankingScores.$inferInsert)[] = [];
    const purchaseRows: (typeof purchases.$inferInsert)[] = [];

    for (let i = start; i < Math.min(start + BATCH, userCount); i++) {
      const id = baseId + i;
      const n = id;
      // 가입일: 최근 days 일에 70%, 그 이전 1년에 30%
      const registeredAt = new Date(
        now.getTime() - (rand() < 0.7 ? rand() * days : days + rand() * 365) * DAY,
      );
      const engagement = 0.25 + rand() * 0.75; // 접속하는 날의 비율
      const roll = rand();
      const status =
        roll < 0.005
          ? UserStatus.WITHDRAWN
          : roll < 0.01
            ? UserStatus.SUSPENDED
            : UserStatus.ACTIVE;

      // 플레이 시뮬레이션 (docs/analytics.md 4장): 가입일부터 하루씩, 접속한 날마다 한 번 플레이
      // 기간(days) 이전은 상태(진행도·결제·잔액)만 계산하고, 기간 안은 활동·원장까지 남긴다
      const state: PlayerState = { maxStage: 0, payCount: 0 };
      const balance: Record<string, number> = { GOLD: 1_000, GEM: 0, FREE_GEM: 100, STAMINA: 100 };
      const windowStart = now.getTime() - days * DAY;
      let carried = registeredAt.getTime() >= windowStart; // 이월 잔액 기록 여부
      let lastLoginAt: Date | null = null;
      const addTx = (code: string, delta: number, reason: string, at: Date, source: string) => {
        const c = currencyByCode.get(code)!;
        const before = balance[code] ?? 0;
        balance[code] = before + delta;
        txRows.push({
          userId: id,
          currencyId: c.id,
          delta,
          balanceBefore: before,
          balanceAfter: before + delta,
          source,
          reason,
          createdAt: at,
        });
      };
      if (carried) {
        for (const [code, v] of Object.entries(balance))
          if (v > 0) {
            balance[code] = 0;
            addTx(code, v, '가입 보상', registeredAt, CurrencySource.GAME);
          }
      }

      const totalDays = Math.floor((now.getTime() - registeredAt.getTime()) / DAY);
      for (let d = 0; d <= totalDays && status !== UserStatus.WITHDRAWN; d++) {
        const dayStart = registeredAt.getTime() + d * DAY;
        // 첫날은 반드시 접속, 이후엔 engagement 확률
        if (d > 0 && rand() > engagement) continue;
        const loginAt = new Date(d === 0 ? dayStart + 60_000 : dayStart + rand() * DAY * 0.9);
        if (loginAt > now) break;
        const inWindow = loginAt.getTime() >= windowStart;
        if (inWindow && !carried) {
          // 기간 시작 시점 잔액을 한 번에 이월 (원장 합계 = 잔액 유지)
          for (const [code, v] of Object.entries(balance))
            if (v > 0) {
              balance[code] = 0;
              addTx(code, v, '이전 기록 이월', new Date(windowStart), CurrencySource.GAME);
            }
          carried = true;
        }

        const plan = planSession(rand, state);
        lastLoginAt = loginAt;
        if (inWindow) {
          activityRows.push({
            userId: id,
            type: ActivityType.LOGIN,
            payload: null,
            occurredAt: loginAt,
          });
          plan.clears.forEach((stage, c) =>
            activityRows.push({
              userId: id,
              type: ActivityType.STAGE_CLEAR,
              payload: { stage, stars: int(1, 3) },
              occurredAt: new Date(loginAt.getTime() + (c + 1) * 180_000),
            }),
          );
        }
        if (plan.purchase) {
          const p = productByCode.get(plan.purchase)!;
          const at = new Date(loginAt.getTime() + (plan.clears.length + 1) * 180_000);
          purchaseRows.push({
            userId: id,
            productId: p.id,
            priceKrw: p.priceKrw,
            gemAmount: p.gemAmount,
            stage: state.maxStage,
            purchasedAt: at,
          });
          if (inWindow)
            addTx('GEM', p.gemAmount, `상품 구매: ${p.name}`, at, CurrencySource.PURCHASE);
          else balance.GEM = (balance.GEM ?? 0) + p.gemAmount;
          state.payCount++;
        }
        for (const step of plan.ledger) {
          if ((balance[step.currencyCode] ?? 0) + step.delta < 0) continue; // 잔액 부족 → 그 행동은 안 함
          const at = new Date(loginAt.getTime() + (plan.clears.length + 2) * 180_000);
          if (inWindow) addTx(step.currencyCode, step.delta, step.reason, at, CurrencySource.GAME);
          else balance[step.currencyCode] = (balance[step.currencyCode] ?? 0) + step.delta;
        }
        if (plan.clears.length) state.maxStage = plan.clears[plan.clears.length - 1]!;
        if (plan.quit) break;
      }

      if (!carried) {
        // 기간 안에 한 번도 접속하지 않은 오래된 회원: 잔액만 이월
        for (const [code, v] of Object.entries(balance))
          if (v > 0) {
            balance[code] = 0;
            addTx(code, v, '이전 기록 이월', new Date(windowStart), CurrencySource.GAME);
          }
        carried = true;
      }

      userRows.push({
        id,
        publicId: `U${String(1_000_000 + n)}`,
        nickname: `${pick(ADJ)}${pick(NOUN)}${int(1, 9999)}`,
        email: `player${n}@example.com`,
        level: Math.max(1, Math.round(state.maxStage * 0.6) + int(0, 4)),
        maxStage: state.maxStage,
        // 광고 메일 수신 동의 약 55%, 그중 야간 동의 약 20%
        ...(() => {
          const ad = rand() < 0.55;
          return { adEmailOptIn: ad, nightOptIn: ad && rand() < 0.2 };
        })(),
        status,
        registeredAt,
        lastLoginAt,
      });
      for (const [code, v] of Object.entries(balance)) {
        if (v <= 0) continue;
        balanceRows.push({
          userId: id,
          currencyId: currencyByCode.get(code)!.id,
          balance: v,
          version: 1,
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
          score: Math.floor(engagement ** 2 * 30_000 + state.maxStage * 200 + rand() * 1_000),
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
    for (let i = 0; i < purchaseRows.length; i += BATCH)
      await db.insert(purchases).values(purchaseRows.slice(i, i + BATCH));
    purchaseCount += purchaseRows.length;

    activities += activityRows.length;
    transactions += txRows.length;
    log(
      `  users ${Math.min(start + BATCH, userCount).toLocaleString()} / ${userCount.toLocaleString()}`,
    );
  }

  return { users: userCount, activities, transactions, purchases: purchaseCount };
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
  'purchases',
  'email_deliveries',
  'email_campaigns',
  'currency_transactions',
  'user_currencies',
  'user_activity_logs',
  'user_suspensions',
  'users',
  'daily_kpis',
  'daily_currency_stats',
] as const;
