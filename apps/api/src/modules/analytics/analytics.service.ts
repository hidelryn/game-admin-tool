import {
  and,
  asc,
  countDistinct,
  eq,
  gte,
  lt,
  ne,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  ActivityType,
  ANALYTICS_MAX_DAYS,
  CurrencySource,
  ErrorCode,
  RETENTION_DAYS,
  STAGE_BUCKET_SIZE,
  STAGE_MAX,
  UserStatus,
  type ChurnQuery,
  type ChurnReport,
  type PurchaseAnalyticsQuery,
  type PurchaseReport,
  type RetentionQuery,
  type RetentionReport,
  type SpendingQuery,
  type SpendingReport,
} from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import { AppError, BusinessRuleError } from '../../common/errors/app-error.js';
import { addDays, dateList, dayRange, statDateOf } from '../../common/time.js';
import type { Executor } from '../../infra/db/types.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import {
  currencies,
  currencyTransactions,
  products,
  purchases,
  userActivityLogs,
  users,
} from '../../infra/db/schema/index.js';

const CACHE_TTL_SEC = 600;
const DAY_MS = 86_400_000;

/** 구간 시작 스테이지 목록: 1, 11, … 111 */
const BUCKETS = Array.from(
  { length: Math.ceil(STAGE_MAX / STAGE_BUCKET_SIZE) },
  (_, i) => i * STAGE_BUCKET_SIZE + 1,
);
const bucketTo = (from: number) => Math.min(from + STAGE_BUCKET_SIZE - 1, STAGE_MAX);

/** 최고 클리어 스테이지 컬럼 → "다음 도전 스테이지" 구간 시작 (shared stageBucketOf 와 같은 식) */
const bucketSql = (stageCol: SQL | AnyColumn) =>
  sql<number>`floor((least(${stageCol} + 1, ${STAGE_MAX}) - 1) / ${STAGE_BUCKET_SIZE}) * ${STAGE_BUCKET_SIZE} + 1`.mapWith(
    Number,
  );

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);

/**
 * 유저 분석 (docs/analytics.md) — 조회 전용, 결과는 Redis 에 10분 캐시
 * - 이탈: 탈퇴 제외, 가입 후 N일 이상 지난 회원 중 마지막 접속이 N일 이상 지난 회원. 구간 = 최고 클리어 스테이지
 * - 리텐션: 가입일 코호트별 D+n 일에 접속한 비율 (KST 날짜 기준)
 * - 과금: 결제 금액·결제자·ARPPU·결제율, 첫 결제 구간·가입 후 경과일, 상품별
 * - 소비처: 게임 안 소비(source=GAME, 음수)만 — 운영자 회수는 제외
 */
export function createAnalyticsService(deps: {
  db: Executor;
  redis: RedisHandle;
  logger: Logger;
  tzOffsetMin: number;
}) {
  const { db, redis, logger, tzOffsetMin } = deps;
  const kstDate = (col: SQL | AnyColumn) =>
    sql`date(date_add(${col}, interval ${tzOffsetMin} minute))`;

  async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    try {
      const hit = await redis.redis.get(`analytics:${key}`);
      if (hit) return JSON.parse(hit) as T;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'analytics cache read skipped');
    }
    const value = await fn();
    await redis.redis
      .set(`analytics:${key}`, JSON.stringify(value), 'EX', CACHE_TTL_SEC)
      .catch(() => undefined);
    return value;
  }

  function range(from: string | undefined, to: string | undefined) {
    const today = statDateOf(new Date(), tzOffsetMin);
    const end = to && to < today ? to : today;
    const start = from ?? addDays(end, -29);
    if (start > end)
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'from 이 to 보다 늦습니다.');
    if (dateList(start, end).length > ANALYTICS_MAX_DAYS)
      throw new BusinessRuleError(
        ErrorCode.VALIDATION_FAILED,
        `조회 기간은 최대 ${ANALYTICS_MAX_DAYS}일입니다.`,
      );
    return {
      from: start,
      to: end,
      today,
      startAt: dayRange(start, tzOffsetMin).start,
      endAt: dayRange(end, tzOffsetMin).end,
    };
  }

  return {
    churn(q: ChurnQuery): Promise<ChurnReport> {
      return cached(`churn:${q.inactiveDays}`, async () => {
        const cutoff = new Date(Date.now() - q.inactiveDays * DAY_MS);
        const bucket = bucketSql(users.maxStage);
        const rows = await db
          .select({
            bucket,
            stopped: sql<number>`count(*)`.mapWith(Number),
            churned:
              sql<number>`sum(case when coalesce(${users.lastLoginAt}, ${users.registeredAt}) < ${cutoff} then 1 else 0 end)`.mapWith(
                Number,
              ),
          })
          .from(users)
          .where(and(ne(users.status, UserStatus.WITHDRAWN), lt(users.registeredAt, cutoff)))
          .groupBy(sql`1`);
        const by = new Map(rows.map((r) => [r.bucket, r]));
        let reached = rows.reduce((s, r) => s + r.stopped, 0);
        const evaluated = reached;
        const buckets = BUCKETS.map((from) => {
          const r = by.get(from) ?? { stopped: 0, churned: 0 };
          const out = {
            stageFrom: from,
            stageTo: bucketTo(from),
            reached,
            stopped: r.stopped,
            churned: r.churned,
            churnRate: ratio(r.churned, reached),
          };
          reached -= r.stopped;
          return out;
        });
        return {
          inactiveDays: q.inactiveDays,
          evaluated,
          churned: rows.reduce((s, r) => s + r.churned, 0),
          buckets,
          generatedAt: new Date().toISOString(),
        };
      });
    },

    retention(q: RetentionQuery): Promise<RetentionReport> {
      const { from, to, today, startAt, endAt } = range(q.from, q.to);
      return cached(`retention:${from}:${to}`, async () => {
        const cohort = kstDate(users.registeredAt);
        const dayN = sql`datediff(${kstDate(userActivityLogs.occurredAt)}, ${cohort})`;
        const [sizes, returns] = await Promise.all([
          db
            .select({
              date: sql<string>`date_format(${cohort}, '%Y-%m-%d')`,
              size: sql<number>`count(*)`.mapWith(Number),
            })
            .from(users)
            .where(and(gte(users.registeredAt, startAt), lt(users.registeredAt, endAt)))
            .groupBy(sql`1`),
          db
            .select({
              date: sql<string>`date_format(${cohort}, '%Y-%m-%d')`,
              day: sql<number>`${dayN}`.mapWith(Number),
              users: countDistinct(users.id),
            })
            .from(users)
            .innerJoin(
              userActivityLogs,
              and(
                eq(userActivityLogs.userId, users.id),
                eq(userActivityLogs.type, ActivityType.LOGIN),
                gte(userActivityLogs.occurredAt, users.registeredAt),
                lt(
                  userActivityLogs.occurredAt,
                  sql`date_add(${users.registeredAt}, interval ${Math.max(...RETENTION_DAYS) + 1} day)`,
                ),
              ),
            )
            .where(
              and(
                gte(users.registeredAt, startAt),
                lt(users.registeredAt, endAt),
                sql`${dayN} in (${sql.join(
                  RETENTION_DAYS.map((d) => sql`${d}`),
                  sql`, `,
                )})`,
              ),
            )
            .groupBy(sql`1`, sql`2`),
        ]);
        const sizeBy = new Map(sizes.map((s) => [s.date, s.size]));
        const back = new Map(returns.map((r) => [`${r.date}:${r.day}`, r.users]));
        const cohorts = dateList(from, to).map((date) => {
          const size = sizeBy.get(date) ?? 0;
          const rates: Record<string, number | null> = {};
          for (const d of RETENTION_DAYS)
            rates[d] = addDays(date, d) > today ? null : ratio(back.get(`${date}:${d}`) ?? 0, size);
          return { date, size, rates };
        });
        return { days: RETENTION_DAYS, cohorts, generatedAt: new Date().toISOString() };
      });
    },

    purchases(q: PurchaseAnalyticsQuery): Promise<PurchaseReport> {
      const { from, to, startAt, endAt } = range(q.from, q.to);
      return cached(`purchases:${from}:${to}`, async () => {
        const inRange = and(gte(purchases.purchasedAt, startAt), lt(purchases.purchasedAt, endAt));
        const firsts = db
          .select({
            userId: purchases.userId,
            firstAt: sql<Date>`min(${purchases.purchasedAt})`.as('first_at'),
          })
          .from(purchases)
          .groupBy(purchases.userId)
          .as('firsts');
        const [totals, active, byStage, firstRows, byProduct] = await Promise.all([
          db
            .select({
              revenue: sql<number>`coalesce(sum(${purchases.priceKrw}), 0)`.mapWith(Number),
              purchases: sql<number>`count(*)`.mapWith(Number),
              payers: countDistinct(purchases.userId),
            })
            .from(purchases)
            .where(inRange),
          db
            .select({ n: countDistinct(userActivityLogs.userId) })
            .from(userActivityLogs)
            .where(
              and(
                eq(userActivityLogs.type, ActivityType.LOGIN),
                gte(userActivityLogs.occurredAt, startAt),
                lt(userActivityLogs.occurredAt, endAt),
              ),
            ),
          db
            .select({
              bucket: bucketSql(purchases.stage),
              revenue: sql<number>`sum(${purchases.priceKrw})`.mapWith(Number),
              purchases: sql<number>`count(*)`.mapWith(Number),
            })
            .from(purchases)
            .where(inRange)
            .groupBy(sql`1`),
          // 첫 결제가 기간 안인 회원: 첫 결제 구간 + 가입 후 경과일
          db
            .select({
              userId: purchases.userId,
              bucket: bucketSql(purchases.stage),
              days: sql<number>`datediff(${kstDate(purchases.purchasedAt)}, ${kstDate(users.registeredAt)})`.mapWith(
                Number,
              ),
            })
            .from(purchases)
            .innerJoin(
              firsts,
              and(eq(firsts.userId, purchases.userId), eq(firsts.firstAt, purchases.purchasedAt)),
            )
            .innerJoin(users, eq(users.id, purchases.userId))
            .where(inRange),
          db
            .select({
              code: products.code,
              name: products.name,
              purchases: sql<number>`count(*)`.mapWith(Number),
              revenue: sql<number>`sum(${purchases.priceKrw})`.mapWith(Number),
            })
            .from(purchases)
            .innerJoin(products, eq(products.id, purchases.productId))
            .where(inRange)
            .groupBy(products.id, products.code, products.name)
            .orderBy(sql`4 desc`),
        ]);

        // 같은 시각에 두 번 결제한 경우 한 번만
        const first = new Map(firstRows.map((r) => [r.userId, r]));
        const firstByBucket = new Map<number, number>();
        const dayBins = [
          { label: '가입 당일', max: 0 },
          { label: '1~3일', max: 3 },
          { label: '4~7일', max: 7 },
          { label: '8~14일', max: 14 },
          { label: '15~30일', max: 30 },
          { label: '31일 이후', max: Infinity },
        ].map((b) => ({ ...b, payers: 0 }));
        for (const r of first.values()) {
          firstByBucket.set(r.bucket, (firstByBucket.get(r.bucket) ?? 0) + 1);
          dayBins.find((b) => r.days <= b.max)!.payers++;
        }
        const stageBy = new Map(byStage.map((r) => [r.bucket, r]));
        const t = totals[0] ?? { revenue: 0, purchases: 0, payers: 0 };
        return {
          from,
          to,
          revenue: t.revenue,
          purchases: t.purchases,
          payers: t.payers,
          payerRate: ratio(t.payers, active[0]?.n ?? 0),
          arppu: t.payers ? Math.round(t.revenue / t.payers) : 0,
          byStage: BUCKETS.map((b) => ({
            stageFrom: b,
            stageTo: bucketTo(b),
            firstPayers: firstByBucket.get(b) ?? 0,
            revenue: stageBy.get(b)?.revenue ?? 0,
            purchases: stageBy.get(b)?.purchases ?? 0,
          })),
          firstPurchaseDay: dayBins.map(({ label, payers }) => ({ label, payers })),
          byProduct,
          generatedAt: new Date().toISOString(),
        };
      });
    },

    async spending(q: SpendingQuery): Promise<SpendingReport> {
      const { from, to, startAt, endAt } = range(q.from, q.to);
      const [currency] = await db
        .select({ id: currencies.id, code: currencies.code })
        .from(currencies)
        .where(eq(currencies.code, q.currencyCode))
        .limit(1);
      if (!currency)
        throw new BusinessRuleError(ErrorCode.INVALID_CURRENCY, '없는 재화 코드입니다.');
      return cached(`spending:${currency.code}:${from}:${to}`, async () => {
        const where = and(
          eq(currencyTransactions.currencyId, currency.id),
          eq(currencyTransactions.source, CurrencySource.GAME),
          lt(currencyTransactions.delta, 0),
          gte(currencyTransactions.createdAt, startAt),
          lt(currencyTransactions.createdAt, endAt),
        );
        const [byReason, byStage] = await Promise.all([
          db
            .select({
              reason: sql<string>`coalesce(${currencyTransactions.reason}, '(사유 없음)')`,
              amount: sql<number>`sum(-${currencyTransactions.delta})`.mapWith(Number),
              count: sql<number>`count(*)`.mapWith(Number),
            })
            .from(currencyTransactions)
            .where(where)
            .groupBy(sql`1`)
            .orderBy(sql`2 desc`),
          db
            .select({
              bucket: bucketSql(users.maxStage),
              amount: sql<number>`sum(-${currencyTransactions.delta})`.mapWith(Number),
              users: countDistinct(currencyTransactions.userId),
            })
            .from(currencyTransactions)
            .innerJoin(users, eq(users.id, currencyTransactions.userId))
            .where(where)
            .groupBy(sql`1`)
            .orderBy(asc(sql`1`)),
        ]);
        const total = byReason.reduce((s, r) => s + r.amount, 0);
        const stageBy = new Map(byStage.map((r) => [r.bucket, r]));
        return {
          from,
          to,
          currencyCode: currency.code,
          total,
          byReason: byReason.map((r) => ({ ...r, share: ratio(r.amount, total) })),
          byStage: BUCKETS.map((b) => ({
            stageFrom: b,
            stageTo: bucketTo(b),
            amount: stageBy.get(b)?.amount ?? 0,
            users: stageBy.get(b)?.users ?? 0,
          })),
          generatedAt: new Date().toISOString(),
        };
      });
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
