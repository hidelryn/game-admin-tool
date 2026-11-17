import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  currencyTransactions,
  dailyKpis,
  userActivityLogs,
  userSuspensions,
} from '../../src/infra/db/schema/index.js';
import { aggregateDay, backfill, computeDay } from '../../src/jobs/kpi.js';
import { addDays, statDateOf } from '../../src/common/time.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  CURRENCY,
  login,
  type TestContext,
} from './helpers.js';

const KST = 540;
let t: TestContext;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

/** KST 날짜 + 시각 → Date */
const kst = (date: string, hh: number, mm = 0) =>
  new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);

describe('일별 KPI 계산', () => {
  it('KST 기준으로 하루를 나눈다 (00:30 KST 접속은 그날 DAU)', async () => {
    const day = '2026-11-05';
    const a = await createUser(t.ctx.db.db, { registeredAt: kst(day, 0, 30) });
    const b = await createUser(t.ctx.db.db, { registeredAt: kst(addDays(day, -10), 12) });
    await t.ctx.db.db.insert(userActivityLogs).values([
      { userId: a.id, type: 'LOGIN', occurredAt: kst(day, 0, 30) },
      { userId: a.id, type: 'LOGIN', occurredAt: kst(day, 20) }, // 같은 회원 두 번 → 1명
      { userId: b.id, type: 'LOGIN', occurredAt: kst(day, 23, 59) },
      { userId: b.id, type: 'LOGIN', occurredAt: kst(addDays(day, 1), 0, 1) }, // 다음 날
      { userId: b.id, type: 'STAGE_CLEAR', occurredAt: kst(day, 12) }, // LOGIN 아님
    ]);
    const { kpi } = await computeDay(t.ctx.db.db, day, KST);
    expect(kpi).toEqual({ date: day, dau: 2, nru: 1, suspendedTotal: 0 });
  });

  it('재화 발행·소모를 재화별로 합산', async () => {
    const day = '2026-11-05';
    const u = await createUser(t.ctx.db.db);
    const row = (delta: number, currencyId: number) => ({
      userId: u.id,
      currencyId,
      delta,
      balanceBefore: 0,
      balanceAfter: 0,
      source: 'GAME',
      createdAt: kst(day, 10),
    });
    await t.ctx.db.db
      .insert(currencyTransactions)
      .values([
        row(100, CURRENCY.GOLD),
        row(50, CURRENCY.GOLD),
        row(-30, CURRENCY.GOLD),
        row(-5, CURRENCY.GEM),
      ]);
    const { currencyFlows } = await computeDay(t.ctx.db.db, day, KST);
    expect(currencyFlows.find((c) => c.currencyCode === 'GOLD')).toMatchObject({
      issued: 150,
      consumed: 30,
    });
    expect(currencyFlows.find((c) => c.currencyCode === 'GEM')).toMatchObject({
      issued: 0,
      consumed: 5,
    });
  });

  it('과거 날짜의 정지 회원 수를 정지 이력으로 재현', async () => {
    const u = await createUser(t.ctx.db.db);
    await t.ctx.db.db.insert(userSuspensions).values({
      userId: u.id,
      reason: '테스트',
      startsAt: kst('2026-11-03', 12),
      endsAt: kst('2026-11-06', 12),
    });
    expect((await computeDay(t.ctx.db.db, '2026-11-02', KST)).kpi.suspendedTotal).toBe(0);
    expect((await computeDay(t.ctx.db.db, '2026-11-04', KST)).kpi.suspendedTotal).toBe(1);
    expect((await computeDay(t.ctx.db.db, '2026-11-06', KST)).kpi.suspendedTotal).toBe(0); // 그날 끝에는 만료
  });

  it('backfill: 빠진 날만 채우고 어제는 항상 다시 집계', async () => {
    const now = new Date();
    const today = statDateOf(now, KST);
    await aggregateDay(t.ctx.db.db, addDays(today, -3), KST);
    const done = await backfill(t.ctx.db.db, KST, 5, now);
    expect(done).toEqual([
      addDays(today, -5),
      addDays(today, -4),
      addDays(today, -2),
      addDays(today, -1),
    ]);
    expect(await t.ctx.db.db.select().from(dailyKpis)).toHaveLength(5);
  });
});

describe('대시보드 API', () => {
  it('요약: 오늘은 실시간, 대기 승인 수 포함', async () => {
    const u = await createUser(t.ctx.db.db, { registeredAt: new Date() });
    await t.ctx.db.db
      .insert(userActivityLogs)
      .values({ userId: u.id, type: 'LOGIN', occurredAt: new Date() });
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const res = await request(t.app).get('/api/v1/dashboard/summary').set(bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.today).toMatchObject({ dau: 1, nru: 1 });
    expect(
      res.body.data.today.currencies.map((c: { currencyCode: string }) => c.currencyCode),
    ).toEqual(['GOLD', 'GEM', 'STAMINA', 'FREE_GEM']);
  });

  it('추이: 기간의 모든 날짜를 채워 돌려준다', async () => {
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const today = statDateOf(new Date(), KST);
    const res = await request(t.app)
      .get(`/api/v1/dashboard/trends?metric=dau&from=${addDays(today, -6)}`)
      .set(bearer(viewer));
    expect(res.body.data).toHaveLength(7);
    expect(res.body.data[6].date).toBe(today);
    // 비어 있던 과거 날짜는 계산 후 저장(자가 복구)
    expect(await t.ctx.db.db.select().from(dailyKpis)).toHaveLength(6);
  });

  it('기간이 90일을 넘으면 거부', async () => {
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const res = await request(t.app)
      .get('/api/v1/dashboard/trends?from=2026-01-01&to=2026-06-01')
      .set(bearer(viewer));
    expect(res.status).toBe(422);
  });

  it('재화 흐름: 재화 코드 필터', async () => {
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const today = statDateOf(new Date(), KST);
    const res = await request(t.app)
      .get(`/api/v1/dashboard/currency-flows?currencyCode=gem&from=${addDays(today, -2)}`)
      .set(bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(new Set(res.body.data.map((r: { currencyCode: string }) => r.currencyCode))).toEqual(
      new Set(['GEM']),
    );
  });
});
