import { asc } from 'drizzle-orm';
import {
  DASHBOARD_MAX_DAYS,
  ErrorCode,
  type CurrencyFlow,
  type CurrencyFlowsQuery,
  type DailyKpi,
  type DashboardSummary,
  type TrendPoint,
  type TrendsQuery,
} from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import { AppError, BusinessRuleError } from '../../common/errors/app-error.js';
import { addDays, dateList, statDateOf } from '../../common/time.js';
import type { Executor } from '../../infra/db/types.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import { currencies } from '../../infra/db/schema/index.js';
import { aggregateDay, computeDay, storedCurrencyFlows, storedKpis } from '../../jobs/kpi.js';

const CACHE_TTL_SEC = 60;

/**
 * 대시보드 (FR-DSH)
 * - 지난 날짜: daily_kpis 집계 테이블 (Worker 가 매일 채움). 비어 있으면 즉석 계산 후 저장(자가 복구)
 * - 오늘: 실시간 계산
 * - 결과는 Redis 에 60초 캐시 (Redis 장애 시 캐시 없이 계산)
 */
export function createDashboardService(deps: {
  db: Executor;
  redis: RedisHandle;
  logger: Logger;
  tzOffsetMin: number;
}) {
  const { db, redis, logger, tzOffsetMin } = deps;

  async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    try {
      const hit = await redis.redis.get(`dash:${key}`);
      if (hit) return JSON.parse(hit) as T;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'dashboard cache read skipped');
    }
    const value = await fn();
    await redis.redis
      .set(`dash:${key}`, JSON.stringify(value), 'EX', CACHE_TTL_SEC)
      .catch(() => undefined);
    return value;
  }

  function range(from: string | undefined, to: string | undefined) {
    const today = statDateOf(new Date(), tzOffsetMin);
    const end = to && to < today ? to : today;
    const start = from ?? addDays(end, -29);
    if (start > end)
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'from 이 to 보다 늦습니다.');
    if (dateList(start, end).length > DASHBOARD_MAX_DAYS) {
      throw new BusinessRuleError(
        ErrorCode.VALIDATION_FAILED,
        `조회 기간은 최대 ${DASHBOARD_MAX_DAYS}일입니다.`,
      );
    }
    return { start, end, today };
  }

  /** 기간의 일별 KPI — 저장된 값 + (없는 과거 날짜는 계산·저장) + 오늘은 실시간 */
  async function kpiSeries(start: string, end: string, today: string): Promise<DailyKpi[]> {
    const dates = dateList(start, end);
    const stored = new Map((await storedKpis(db, dates)).map((r) => [r.statDate, r]));
    const out: DailyKpi[] = [];
    for (const d of dates) {
      if (d === today) {
        out.push((await computeDay(db, d, tzOffsetMin)).kpi);
        continue;
      }
      const s = stored.get(d);
      out.push(
        s
          ? { date: d, dau: s.dau, nru: s.nru, suspendedTotal: s.suspendedTotal }
          : (await aggregateDay(db, d, tzOffsetMin)).kpi,
      );
    }
    return out;
  }

  return {
    summary(): Promise<DashboardSummary> {
      const today = statDateOf(new Date(), tzOffsetMin);
      return cached(`summary:${today}`, async () => {
        const [now, yesterdaySeries] = await Promise.all([
          computeDay(db, today, tzOffsetMin),
          kpiSeries(addDays(today, -1), addDays(today, -1), today),
        ]);
        return {
          today: {
            ...now.kpi,
            currencies: now.currencyFlows.map(({ currencyCode, issued, consumed }) => ({
              currencyCode,
              issued,
              consumed,
            })),
          },
          yesterday: yesterdaySeries[0] ?? null,
          generatedAt: new Date().toISOString(),
        };
      });
    },

    trends(q: TrendsQuery): Promise<TrendPoint[]> {
      const { start, end, today } = range(q.from, q.to);
      return cached(`trends:${q.metric}:${start}:${end}`, async () =>
        (await kpiSeries(start, end, today)).map((k) => ({ date: k.date, value: k[q.metric] })),
      );
    },

    currencyFlows(q: CurrencyFlowsQuery): Promise<CurrencyFlow[]> {
      const { start, end, today } = range(q.from, q.to);
      return cached(`flows:${q.currencyCode ?? 'ALL'}:${start}:${end}`, async () => {
        const cs = await db
          .select({ id: currencies.id, code: currencies.code })
          .from(currencies)
          .orderBy(asc(currencies.id));
        if (q.currencyCode && !cs.some((c) => c.code === q.currencyCode)) {
          throw new BusinessRuleError(
            ErrorCode.INVALID_CURRENCY,
            `존재하지 않는 재화입니다: ${q.currencyCode}`,
          );
        }
        // 지난 날짜 집계가 빠져 있으면 먼저 채운다
        await kpiSeries(start, end < today ? end : addDays(today, -1), today).catch(
          () => undefined,
        );
        const stored = await storedCurrencyFlows(db, start, end);
        const live = end === today ? (await computeDay(db, today, tzOffsetMin)).currencyFlows : [];
        const out: CurrencyFlow[] = [];
        for (const d of dateList(start, end)) {
          for (const c of cs) {
            if (q.currencyCode && c.code !== q.currencyCode) continue;
            const row =
              d === today
                ? live.find((l) => l.currencyId === c.id)
                : stored.find((s) => s.date === d && s.currencyId === c.id);
            out.push({
              date: d,
              currencyCode: c.code,
              issued: row?.issued ?? 0,
              consumed: row?.consumed ?? 0,
            });
          }
        }
        return out;
      });
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
