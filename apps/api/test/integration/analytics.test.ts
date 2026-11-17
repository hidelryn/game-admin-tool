import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { currencyTransactions, userActivityLogs, users } from '../../src/infra/db/schema/index.js';
import { recordGameEvents } from '../../src/modules/internal-game/game-actions.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  login,
  type TestContext,
} from './helpers.js';

/** 유저 분석 (docs/analytics.md) */
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let t: TestContext;
let op: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  op = (await login(t.app, ADMIN.operator)).accessToken;
});

const get = (path: string, query: Record<string, string | number> = {}) =>
  request(t.app).get(`/api/v1${path}`).query(query).set(bearer(op));

describe('스테이지 진행', () => {
  it('STAGE_CLEAR 이벤트로 최고 클리어 스테이지가 오르고, 줄어들지 않는다', async () => {
    const u = await createUser(t.ctx.db.db);
    const ev = (stage: number) => ({
      publicId: u.publicId,
      type: 'STAGE_CLEAR' as const,
      payload: { stage },
    });
    await recordGameEvents(t.ctx.db.db, t.services.maintenanceService, [ev(4), ev(5)]);
    await recordGameEvents(t.ctx.db.db, t.services.maintenanceService, [ev(3)]);
    const [row] = await t.ctx.db.db.select().from(users).where(eq(users.id, u.id));
    expect(row!.maxStage).toBe(5);
  });
});

describe('이탈 구간', () => {
  it('구간별 도달·멈춤·이탈, 최근 가입자는 판정에서 제외', async () => {
    const db = t.ctx.db.db;
    // 20 벽에서 멈추고 떠남 / 같은 곳이지만 아직 플레이 중 / 51~60 에서 떠남 / 가입 2일차(제외)
    await createUser(db, { maxStage: 19, registeredAt: ago(20), lastLoginAt: ago(10) });
    await createUser(db, { maxStage: 19, registeredAt: ago(20), lastLoginAt: ago(0) });
    await createUser(db, { maxStage: 55, registeredAt: ago(30), lastLoginAt: ago(9) });
    await createUser(db, { maxStage: 0, registeredAt: ago(2), lastLoginAt: null });

    const res = await get('/analytics/churn', { inactiveDays: 7 });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ inactiveDays: 7, evaluated: 3, churned: 2 });
    const b = (from: number) => d.buckets.find((x: { stageFrom: number }) => x.stageFrom === from);
    expect(b(1)).toMatchObject({ reached: 3, stopped: 0, churned: 0 });
    expect(b(11)).toMatchObject({ reached: 3, stopped: 2, churned: 1 });
    expect(b(11).churnRate).toBeCloseTo(1 / 3, 3);
    expect(b(51)).toMatchObject({ reached: 1, stopped: 1, churned: 1, churnRate: 1 });
    expect(d.buckets).toHaveLength(12);
  });
});

describe('과금', () => {
  it('결제하면 유료 젬이 원장(PURCHASE)에 들어오고, 매출·첫 결제 구간·상품별로 잡힌다', async () => {
    const db = t.ctx.db.db;
    const a = await createUser(db, { maxStage: 19, registeredAt: ago(5), lastLoginAt: ago(0) });
    const b = await createUser(db, { maxStage: 44, registeredAt: ago(1), lastLoginAt: ago(0) });
    await db
      .insert(userActivityLogs)
      .values(
        [a, b].map((u) => ({ userId: u.id, type: 'LOGIN', payload: null, occurredAt: ago(0) })),
      );

    const r = await t.services.purchaseService.record(a.publicId, 'STARTER_PACK');
    expect(r).toMatchObject({ priceKrw: 3_300, gemAmount: 300, stage: 19, gemBalance: 300 });
    await t.services.purchaseService.record(b.publicId, 'GEM_330');
    await t.services.purchaseService.record(b.publicId, 'GEM_60');

    const ledger = await db
      .select()
      .from(currencyTransactions)
      .where(
        and(eq(currencyTransactions.userId, a.id), eq(currencyTransactions.source, 'PURCHASE')),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 300, reason: '상품 구매: 스타터 패키지' });

    const res = await get('/analytics/purchases');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      revenue: 3_300 + 5_900 + 1_200,
      purchases: 3,
      payers: 2,
      payerRate: 1,
    });
    expect(d.arppu).toBe(Math.round(10_400 / 2));
    const stage = (from: number) =>
      d.byStage.find((x: { stageFrom: number }) => x.stageFrom === from);
    expect(stage(11)).toMatchObject({ firstPayers: 1, purchases: 1, revenue: 3_300 });
    expect(stage(41)).toMatchObject({ firstPayers: 1, purchases: 2, revenue: 7_100 });
    expect(d.byProduct[0]).toMatchObject({ code: 'GEM_330', purchases: 1, revenue: 5_900 });
    const firstDays = Object.fromEntries(
      d.firstPurchaseDay.map((x: { label: string; payers: number }) => [x.label, x.payers]),
    );
    expect(firstDays['1~3일']).toBe(1);
    expect(firstDays['4~7일']).toBe(1);
  });

  it('없는 상품은 거부', async () => {
    const u = await createUser(t.ctx.db.db);
    await expect(t.services.purchaseService.record(u.publicId, 'NOPE')).rejects.toThrow();
  });
});

describe('재화 소비처', () => {
  it('게임 안 소비만 사유별로 (운영자 회수 제외)', async () => {
    const u = await createUser(t.ctx.db.db, { maxStage: 25 });
    const c = t.services.currencyService;
    await c.gameChange(u.publicId, 'GOLD', 1_000, '스테이지 클리어 보상');
    await c.gameChange(u.publicId, 'GOLD', -300, '장비 강화');
    await c.gameChange(u.publicId, 'GOLD', -200, '장비 강화');
    await c.gameChange(u.publicId, 'GOLD', -100, '스킬 강화');
    const res = await get('/analytics/spending', { currencyCode: 'GOLD' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total).toBe(600);
    expect(d.byReason).toEqual([
      { reason: '장비 강화', amount: 500, count: 2, share: 0.8333 },
      { reason: '스킬 강화', amount: 100, count: 1, share: 0.1667 },
    ]);
    expect(d.byStage.find((x: { stageFrom: number }) => x.stageFrom === 21)).toMatchObject({
      amount: 600,
      users: 1,
    });
    expect((await get('/analytics/spending', { currencyCode: 'NOPE' })).status).toBe(422);
  });
});

describe('리텐션', () => {
  it('가입 후 n일째에 다시 접속한 비율, 아직 안 온 날은 null', async () => {
    const db = t.ctx.db.db;
    const reg = ago(3);
    const u = await createUser(db, { registeredAt: reg });
    await createUser(db, { registeredAt: reg }); // 같은 날 가입, 재접속 없음
    await db.insert(userActivityLogs).values(
      [0, 1, 3].map((d) => ({
        userId: u.id,
        type: 'LOGIN',
        payload: null,
        occurredAt: new Date(reg.getTime() + d * DAY - (d === 3 ? 1_000 : 0)), // D3 은 지금 직전
      })),
    );
    const res = await get('/analytics/retention');
    expect(res.status).toBe(200);
    const kstDate = new Date(reg.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const cohort = res.body.data.cohorts.find((c: { date: string }) => c.date === kstDate);
    expect(cohort.size).toBe(2);
    expect(cohort.rates).toMatchObject({ 1: 0.5, 3: 0.5, 7: null, 14: null, 30: null });
  });

  it('기간은 최대 90일', async () => {
    const res = await get('/analytics/retention', { from: '2026-01-01', to: '2026-06-30' });
    expect(res.status).toBe(422);
  });
});
