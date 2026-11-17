import { and, asc, count, countDistinct, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { ActivityType, type CurrencyFlow, type DailyKpi } from '@game-admin/shared';
import { dayRange, statDateOf, addDays } from '../common/time.js';
import type { Executor } from '../infra/db/types.js';
import {
  currencies,
  currencyTransactions,
  dailyCurrencyStats,
  dailyKpis,
  userActivityLogs,
  userSuspensions,
  users,
} from '../infra/db/schema/index.js';

/**
 * 일별 KPI 계산 (FR-DSH-05)
 * - DAU: 그날 LOGIN 이벤트가 있는 회원 수 (중복 제거)
 * - NRU: 그날 가입한 회원 수
 * - 정지 회원 수: 그날 끝 시점에 정지가 유효했던 회원 수 (과거 날짜도 정지 이력으로 재현)
 * - 재화: 그날 원장 기준 발행(+)·소모(−) 합계, 재화별
 */
export async function computeDay(db: Executor, statDate: string, offsetMin: number) {
  const { start, end } = dayRange(statDate, offsetMin);
  const [dau, nru, suspended, flows, cs] = await Promise.all([
    db
      .select({ n: countDistinct(userActivityLogs.userId) })
      .from(userActivityLogs)
      .where(
        and(
          eq(userActivityLogs.type, ActivityType.LOGIN),
          gte(userActivityLogs.occurredAt, start),
          lt(userActivityLogs.occurredAt, end),
        ),
      ),
    db
      .select({ n: count() })
      .from(users)
      .where(and(gte(users.registeredAt, start), lt(users.registeredAt, end))),
    db
      .select({ n: countDistinct(userSuspensions.userId) })
      .from(userSuspensions)
      .where(
        and(
          lt(userSuspensions.startsAt, end),
          or(isNull(userSuspensions.releasedAt), gte(userSuspensions.releasedAt, end)),
          or(isNull(userSuspensions.endsAt), gte(userSuspensions.endsAt, end)),
        ),
      ),
    db
      .select({
        currencyId: currencyTransactions.currencyId,
        issued: sql<string>`coalesce(sum(case when ${currencyTransactions.delta} > 0 then ${currencyTransactions.delta} else 0 end), 0)`,
        consumed: sql<string>`coalesce(sum(case when ${currencyTransactions.delta} < 0 then -${currencyTransactions.delta} else 0 end), 0)`,
      })
      .from(currencyTransactions)
      .where(
        and(gte(currencyTransactions.createdAt, start), lt(currencyTransactions.createdAt, end)),
      )
      .groupBy(currencyTransactions.currencyId),
    db
      .select({ id: currencies.id, code: currencies.code })
      .from(currencies)
      .orderBy(asc(currencies.id)),
  ]);

  const kpi: DailyKpi = {
    date: statDate,
    dau: dau[0]?.n ?? 0,
    nru: nru[0]?.n ?? 0,
    suspendedTotal: suspended[0]?.n ?? 0,
  };
  const currencyFlows: (CurrencyFlow & { currencyId: number })[] = cs.map((c) => {
    const f = flows.find((x) => x.currencyId === c.id);
    return {
      date: statDate,
      currencyId: c.id,
      currencyCode: c.code,
      issued: Number(f?.issued ?? 0),
      consumed: Number(f?.consumed ?? 0),
    };
  });
  return { kpi, currencyFlows };
}

/** 계산 + 저장 (같은 날짜를 다시 집계하면 덮어쓴다) */
export async function aggregateDay(db: Executor, statDate: string, offsetMin: number) {
  const r = await computeDay(db, statDate, offsetMin);
  await db
    .insert(dailyKpis)
    .values({ statDate, dau: r.kpi.dau, nru: r.kpi.nru, suspendedTotal: r.kpi.suspendedTotal })
    .onDuplicateKeyUpdate({
      set: {
        dau: sql`values(${dailyKpis.dau})`,
        nru: sql`values(${dailyKpis.nru})`,
        suspendedTotal: sql`values(${dailyKpis.suspendedTotal})`,
        updatedAt: new Date(),
      },
    });
  if (r.currencyFlows.length) {
    await db
      .insert(dailyCurrencyStats)
      .values(
        r.currencyFlows.map((c) => ({
          statDate,
          currencyId: c.currencyId,
          issued: c.issued,
          consumed: c.consumed,
        })),
      )
      .onDuplicateKeyUpdate({
        set: {
          issued: sql`values(${dailyCurrencyStats.issued})`,
          consumed: sql`values(${dailyCurrencyStats.consumed})`,
        },
      });
  }
  return r;
}

/**
 * 최근 N일 중 집계가 없는 날을 채우고, 어제는 항상 다시 집계 (자정 직후 늦게 들어온 데이터 반영)
 * @returns 집계한 날짜 목록
 */
export async function backfill(
  db: Executor,
  offsetMin: number,
  days = 60,
  now = new Date(),
): Promise<string[]> {
  const today = statDateOf(now, offsetMin);
  const from = addDays(today, -days);
  const yesterday = addDays(today, -1);
  const existing = await db
    .select({ d: dailyKpis.statDate })
    .from(dailyKpis)
    .where(and(gte(dailyKpis.statDate, from), lt(dailyKpis.statDate, today)));
  const have = new Set(existing.map((e) => e.d));
  const targets: string[] = [];
  for (let d = from; d < today; d = addDays(d, 1))
    if (!have.has(d) || d === yesterday) targets.push(d);
  for (const d of targets) await aggregateDay(db, d, offsetMin);
  return targets;
}

/** 저장된 일별 KPI */
export function storedKpis(db: Executor, dates: string[]) {
  return dates.length
    ? db.select().from(dailyKpis).where(inArray(dailyKpis.statDate, dates))
    : Promise.resolve([]);
}

export function storedCurrencyFlows(db: Executor, from: string, to: string) {
  return db
    .select({
      date: dailyCurrencyStats.statDate,
      currencyId: dailyCurrencyStats.currencyId,
      issued: dailyCurrencyStats.issued,
      consumed: dailyCurrencyStats.consumed,
    })
    .from(dailyCurrencyStats)
    .where(
      and(gte(dailyCurrencyStats.statDate, from), lt(dailyCurrencyStats.statDate, addDays(to, 1))),
    );
}
