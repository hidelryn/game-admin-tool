import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { currencyTransactions, mails, userItems } from '../../src/infra/db/schema/index.js';
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

const rewards = [
  { type: 'CURRENCY', code: 'GEM', quantity: 50 },
  { type: 'ITEM', code: 'ENHANCE_STONE', quantity: 3 },
];

async function send(publicIds: string[], extra: Record<string, unknown> = {}) {
  return request(t.app)
    .post('/api/v1/mails')
    .set(bearer(op))
    .set(idem())
    .send({
      publicIds,
      title: '점검 보상',
      body: '불편을 드려 죄송합니다.',
      rewards,
      reason: '정기 점검 보상 지급',
      ...extra,
    });
}

describe('개별 우편 발송', () => {
  it('발송 후 회원 우편함에 보이고, 이력에 수신자 수가 집계된다', async () => {
    const [a, b] = await Promise.all([createUser(t.ctx.db.db), createUser(t.ctx.db.db)]);
    const res = await send([a.publicId, b.publicId]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'SENT', recipientCount: 2 });

    const box = await request(t.app).get(`/api/v1/users/${a.publicId}/mails`).set(bearer(op));
    expect(box.body.data[0]).toMatchObject({ title: '점검 보상', claimedAt: null });
    expect(box.body.data[0].rewards.map((r: { code: string }) => r.code)).toEqual([
      'GEM',
      'ENHANCE_STONE',
    ]);

    const list = await request(t.app).get('/api/v1/mails').set(bearer(op));
    expect(list.body.data[0]).toMatchObject({
      recipientCount: 2,
      claimedCount: 0,
      createdBy: { name: '운영자' },
    });
  });

  it('없는 보상 코드·상한 초과 보상은 거부', async () => {
    const u = await createUser(t.ctx.db.db);
    const bad = await send([u.publicId], {
      rewards: [{ type: 'ITEM', code: 'NOT_EXIST', quantity: 1 }],
    });
    expect(bad.body.error.code).toBe('INVALID_REWARD');
    const over = await send([u.publicId], {
      rewards: [{ type: 'CURRENCY', code: 'GEM', quantity: 10_001 }],
    });
    expect(over.body.error.code).toBe('REWARD_LIMIT_EXCEEDED');
  });

  it('MCP 채널은 수신자 100명까지', async () => {
    const created = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp', permissions: ['mail:send'] });
    const token = created.body.data.token;
    const ids = Array.from({ length: 101 }, (_, i) => `X${i}`);
    const res = await request(t.app)
      .post('/api/v1/mails')
      .set(bearer(token))
      .set(idem())
      .send({ publicIds: ids, title: 't', body: 'b', reason: 'MCP 대량 발송 시도' });
    expect(res.body.error.code).toBe('RECIPIENT_LIMIT_EXCEEDED');
  });
});

describe('우편 수령', () => {
  it('보상이 지급되고(원장 source=MAIL), 두 번 받을 수 없다', async () => {
    const u = await createUser(t.ctx.db.db);
    const { mailId } = (await send([u.publicId])).body.data;

    const claimed = await t.services.mailService.claim(u.publicId, mailId);
    expect(claimed.rewards).toHaveLength(2);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(50);
    const [item] = await t.ctx.db.db.select().from(userItems).where(eq(userItems.userId, u.id));
    expect(item!.quantity).toBe(3);
    const [ledger] = await t.ctx.db.db
      .select()
      .from(currencyTransactions)
      .where(eq(currencyTransactions.userId, u.id));
    expect(ledger).toMatchObject({ source: 'MAIL', mailId });

    await expect(t.services.mailService.claim(u.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_ALREADY_CLAIMED',
    });
  });

  it('동시에 5번 수령해도 보상은 한 번만', async () => {
    const u = await createUser(t.ctx.db.db);
    const { mailId } = (await send([u.publicId])).body.data;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => t.services.mailService.claim(u.publicId, mailId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(50);
  });

  it('최대 보유량을 넘으면 수령 전체가 취소된다 (아이템도 지급 안 됨)', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 9_999_990);
    const { mailId } = (await send([u.publicId])).body.data;
    await expect(t.services.mailService.claim(u.publicId, mailId)).rejects.toMatchObject({
      code: 'EXCEEDS_MAX_BALANCE',
    });
    expect(
      await t.ctx.db.db.select().from(userItems).where(eq(userItems.userId, u.id)),
    ).toHaveLength(0);
    // 수령 표시도 롤백되어 공간을 비우면 다시 받을 수 있다
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 0);
    await expect(t.services.mailService.claim(u.publicId, mailId)).resolves.toMatchObject({
      mailId,
    });
  });

  it('만료된 우편은 받을 수 없다', async () => {
    const u = await createUser(t.ctx.db.db);
    const { mailId } = (await send([u.publicId])).body.data;
    await t.ctx.db.db
      .update(mails)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mails.id, mailId));
    await expect(t.services.mailService.claim(u.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_NOT_CLAIMABLE',
    });
  });

  it('다른 회원에게 간 우편은 받을 수 없다', async () => {
    const [a, b] = await Promise.all([createUser(t.ctx.db.db), createUser(t.ctx.db.db)]);
    const { mailId } = (await send([a.publicId])).body.data;
    await expect(t.services.mailService.claim(b.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_NOT_FOUND',
    });
  });
});

describe('발송 취소 (확인 토큰)', () => {
  it('취소하면 미수령분은 받을 수 없고, 이미 받은 보상은 유지', async () => {
    const [a, b] = await Promise.all([createUser(t.ctx.db.db), createUser(t.ctx.db.db)]);
    const { mailId } = (await send([a.publicId, b.publicId])).body.data;
    await t.services.mailService.claim(a.publicId, mailId);

    const first = await request(t.app)
      .post(`/api/v1/mails/${mailId}/cancel`)
      .set(bearer(op))
      .send({ reason: '보상 내용 오기재' });
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(first.body.error.details.preview).toMatchObject({ recipientCount: 2, claimedCount: 1 });
    const ok = await request(t.app).post(`/api/v1/mails/${mailId}/cancel`).set(bearer(op)).send({
      reason: '보상 내용 오기재',
      confirmationToken: first.body.error.details.confirmationToken,
    });
    expect(ok.body.data.status).toBe('CANCELED');

    await expect(t.services.mailService.claim(b.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_NOT_CLAIMABLE',
    });
    expect(await getBalance(t.ctx.db.db, a.id, CURRENCY.GEM)).toBe(50);
  });
});

describe('전체 우편 (L3 확인)', () => {
  it('빨간 경고 확인 후 생성되고, 대상 조건(가입일)에 맞는 회원만 받을 수 있다', async () => {
    const cutoff = new Date();
    const oldUser = await createUser(t.ctx.db.db, {
      registeredAt: new Date(cutoff.getTime() - 86_400_000),
    });
    const newUser = await createUser(t.ctx.db.db, {
      registeredAt: new Date(cutoff.getTime() + 60_000),
    });

    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    // 운영자는 전체 발송 권한이 없다
    const denied = await request(t.app)
      .post('/api/v1/mails/global')
      .set(bearer(op))
      .set(idem())
      .send({ title: 't', body: 'b', reason: '권한 없는 전체 발송' });
    expect(denied.status).toBe(403);

    const key = idem();
    const body = {
      title: '1주년 기념',
      body: '감사합니다',
      rewards: [{ type: 'CURRENCY', code: 'GOLD', quantity: 1000 }],
      targetFilter: { registeredBefore: cutoff.toISOString() },
      reason: '1주년 기념 전체 보상',
    };
    // L3: 빨간 경고 확인 전엔 만들지 않는다 (대상 인원은 가입일 조건으로 계산)
    const first = await request(t.app)
      .post('/api/v1/mails/global')
      .set(bearer(superToken))
      .set(key)
      .send(body);
    expect(first.status).toBe(422);
    expect(first.body.error.details.preview).toMatchObject({ action: 'MAIL_SEND_ALL' });
    expect(first.body.error.details.preview.facts).toContainEqual({
      label: '대상 회원 (현재)',
      value: '약 1명',
    });
    expect(await t.ctx.db.db.select().from(mails)).toHaveLength(0);

    const sent = await request(t.app)
      .post('/api/v1/mails/global')
      .set(bearer(superToken))
      .set(key)
      .send({ ...body, confirmationToken: first.body.error.details.confirmationToken });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const mailId = sent.body.data.mailId;

    await t.services.mailService.claim(oldUser.publicId, mailId);
    expect(await getBalance(t.ctx.db.db, oldUser.id, CURRENCY.GOLD)).toBe(1000);
    await expect(t.services.mailService.claim(newUser.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_NOT_CLAIMABLE',
    });
    await expect(t.services.mailService.claim(oldUser.publicId, mailId)).rejects.toMatchObject({
      code: 'MAIL_ALREADY_CLAIMED',
    });

    const detail = await request(t.app).get(`/api/v1/mails/${mailId}`).set(bearer(superToken));
    expect(detail.body.data).toMatchObject({
      type: 'GLOBAL',
      recipientCount: null,
      claimedCount: 1,
    });
    const ledger = await t.ctx.db.db
      .select()
      .from(currencyTransactions)
      .where(
        and(eq(currencyTransactions.userId, oldUser.id), eq(currencyTransactions.mailId, mailId)),
      );
    expect(ledger).toHaveLength(1);
  });
});
