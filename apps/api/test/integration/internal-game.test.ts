import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { currencyTransactions, users } from '../../src/infra/db/schema/index.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  CURRENCY,
  getBalance,
  idem,
  login,
  setBalance,
  type TestContext,
} from './helpers.js';

const KEY = 'internal-test-key-'.padEnd(40, 'k');
const H = { 'X-Internal-Key': KEY };
let t: TestContext;
let off: TestContext;

beforeAll(async () => {
  t = await createTestContext({ INTERNAL_API_KEY: KEY });
  off = await createTestContext();
});
afterAll(async () => {
  await Promise.all([t.close(), off.close()]);
});
beforeEach(async () => {
  await t.reset();
});

describe('내부 게임 API 보호', () => {
  it('키가 설정되지 않으면 라우트 자체가 없다 (404)', async () => {
    const res = await request(off.app).get('/api/v1/internal/game/users/sample').set(H);
    expect(res.status).toBe(404);
  });

  it('키가 틀리면 401', async () => {
    const res = await request(t.app)
      .get('/api/v1/internal/game/users/sample')
      .set({ 'X-Internal-Key': 'wrong' });
    expect(res.status).toBe(401);
  });

  it('운영자 토큰으로는 접근할 수 없다', async () => {
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const res = await request(t.app)
      .get('/api/v1/internal/game/users/sample')
      .set(bearer(superToken));
    expect(res.status).toBe(401);
  });
});

describe('게임 이벤트', () => {
  it('정지 회원의 이벤트는 거부하고, 로그인은 최근 접속일을 갱신', async () => {
    const active = await createUser(t.ctx.db.db);
    const suspended = await createUser(t.ctx.db.db, { status: 'SUSPENDED' });
    const at = new Date('2026-11-10T01:00:00Z');
    const res = await request(t.app)
      .post('/api/v1/internal/game/events')
      .set(H)
      .send({
        events: [
          { publicId: active.publicId, type: 'LOGIN', occurredAt: at.toISOString() },
          { publicId: suspended.publicId, type: 'LOGIN' },
          { publicId: 'NOBODY', type: 'LOGIN' },
        ],
      });
    expect(res.body.data.accepted).toBe(1);
    expect(res.body.data.rejected).toEqual([
      { publicId: suspended.publicId, reason: 'USER_SUSPENDED' },
      { publicId: 'NOBODY', reason: 'USER_NOT_FOUND' },
    ]);
    const [row] = await t.ctx.db.db.select().from(users).where(eq(users.id, active.id));
    expect(row!.lastLoginAt?.toISOString()).toBe(at.toISOString());
  });

  it('게임 재화 획득·소비는 source=GAME 원장, 잔액 부족은 422', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GOLD, 100);
    const earn = await request(t.app)
      .post('/api/v1/internal/game/currencies')
      .set(H)
      .send({ publicId: u.publicId, currencyCode: 'GOLD', delta: 50, reason: '퀘스트 보상' });
    expect(earn.status).toBe(200);
    const spend = await request(t.app)
      .post('/api/v1/internal/game/currencies')
      .set(H)
      .send({ publicId: u.publicId, currencyCode: 'GOLD', delta: -500, reason: '장비 강화' });
    expect(spend.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(150);
    const [ledger] = await t.ctx.db.db
      .select()
      .from(currencyTransactions)
      .where(eq(currencyTransactions.userId, u.id));
    expect(ledger).toMatchObject({ source: 'GAME', adminId: null });
  });

  it('점수는 진행 중 시즌에 기록되고, 우편은 내부 API 로 수령', async () => {
    const u = await createUser(t.ctx.db.db);
    const score = await request(t.app)
      .post('/api/v1/internal/game/scores')
      .set(H)
      .send({ publicId: u.publicId, score: 1234 });
    expect(score.body.data).toMatchObject({ updated: true, score: 1234 });

    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const sent = await request(t.app)
      .post('/api/v1/mails')
      .set(bearer(op))
      .set(idem())
      .send({
        publicIds: [u.publicId],
        title: '보상',
        body: '본문',
        rewards: [{ type: 'CURRENCY', code: 'GOLD', quantity: 10 }],
        reason: '내부 API 수령 테스트',
      });
    const claim = await request(t.app)
      .post(`/api/v1/internal/game/mails/${sent.body.data.mailId}/claim`)
      .set(H)
      .send({ publicId: u.publicId });
    expect(claim.status).toBe(200);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(10);
  });

  it('샘플은 활동 중인 회원만', async () => {
    await createUser(t.ctx.db.db);
    await createUser(t.ctx.db.db, { status: 'WITHDRAWN' });
    const res = await request(t.app).get('/api/v1/internal/game/users/sample?size=10').set(H);
    expect(res.body.data).toHaveLength(1);
  });
});
