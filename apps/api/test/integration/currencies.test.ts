import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, currencyTransactions } from '../../src/infra/db/schema/index.js';
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

const grantUrl = (p: string) => `/api/v1/users/${p}/currencies/grant`;
const deductUrl = (p: string) => `/api/v1/users/${p}/currencies/deduct`;
const ledger = (userId: number) =>
  t.ctx.db.db
    .select()
    .from(currencyTransactions)
    .where(eq(currencyTransactions.userId, userId))
    .orderBy(currencyTransactions.id);

describe('재화 지급', () => {
  it('잔액·원장·감사 로그가 함께 기록된다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .set(idem())
      .send({ currencyCode: 'gold', amount: 1000, reason: '서버 점검 보상' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currencyCode: 'GOLD',
      delta: 1000,
      balanceBefore: 0,
      balanceAfter: 1000,
    });

    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(1000);
    const rows = await ledger(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'ADMIN', channel: 'WEB', reason: '서버 점검 보상' });
    const audit = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'CURRENCY_GRANT'));
    expect(audit[0]!.targetId).toBe(u.publicId);
  });

  it('Idempotency-Key 가 없으면 400', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .send({ currencyCode: 'GOLD', amount: 1, reason: '키 없는 요청' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('권한이 없으면 403 (CS 는 지급 불가)', async () => {
    const u = await createUser(t.ctx.db.db);
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(cs))
      .set(idem())
      .send({ currencyCode: 'GOLD', amount: 1, reason: '권한 없는 지급' });
    expect(res.status).toBe(403);
  });

  it('최대 보유량을 넘으면 거부', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.STAMINA, 9_900);
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .set(idem())
      .send({ currencyCode: 'STAMINA', amount: 200, reason: '보유량 초과 지급' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXCEEDS_MAX_BALANCE');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.STAMINA)).toBe(9_900);
  });

  it('1회 상한 초과는 확인 토큰 필요 (STAMINA 상한 500)', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .set(idem())
      .send({ currencyCode: 'STAMINA', amount: 600, reason: '상한 초과 지급' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(res.body.error.details.preview).toMatchObject({ balanceBefore: 0, balanceAfter: 600 });
  });
});

describe('중복 실행 방지 (Idempotency)', () => {
  it('같은 키·같은 요청은 한 번만 실행되고 같은 응답을 재전송', async () => {
    const u = await createUser(t.ctx.db.db);
    const key = idem();
    const body = { currencyCode: 'GOLD', amount: 500, reason: '이벤트 보상 지급' };
    const a = await request(t.app).post(grantUrl(u.publicId)).set(bearer(op)).set(key).send(body);
    const b = await request(t.app).post(grantUrl(u.publicId)).set(bearer(op)).set(key).send(body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    expect(await ledger(u.id)).toHaveLength(1);
  });

  it('같은 키로 다른 요청을 보내면 422', async () => {
    const u = await createUser(t.ctx.db.db);
    const key = idem();
    await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .set(key)
      .send({ currencyCode: 'GOLD', amount: 500, reason: '이벤트 보상 지급' });
    const res = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(op))
      .set(key)
      .send({ currencyCode: 'GOLD', amount: 999, reason: '이벤트 보상 지급' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('같은 키로 동시에 10번 보내도 원장은 1건', async () => {
    const u = await createUser(t.ctx.db.db);
    const key = idem();
    const body = { currencyCode: 'GOLD', amount: 100, reason: '동시 요청 테스트' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(t.app).post(grantUrl(u.publicId)).set(bearer(op)).set(key).send(body),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(200);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(await ledger(u.id)).toHaveLength(1);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(100);
  });

  it('다른 키로 동시에 10번 지급하면 잔액 손실 없이 모두 반영 (행 잠금)', async () => {
    const u = await createUser(t.ctx.db.db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(t.app)
          .post(grantUrl(u.publicId))
          .set(bearer(op))
          .set(idem())
          .send({ currencyCode: 'GOLD', amount: 100, reason: '동시 지급 테스트' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(1000);
    // 원장은 0→100→…→1000 으로 끊김 없이 이어져야 한다
    const rows = await ledger(u.id);
    rows.forEach((r, i) => {
      expect(r.balanceBefore).toBe(i * 100);
      expect(r.balanceAfter).toBe((i + 1) * 100);
    });
  });
});

describe('재화 회수 (확인 토큰)', () => {
  async function preview(publicId: string, amount: number, key = idem()) {
    const res = await request(t.app)
      .post(deductUrl(publicId))
      .set(bearer(op))
      .set(key)
      .send({ currencyCode: 'GEM', amount, reason: '오지급 회수 처리' });
    return { res, key, token: res.body.error?.details?.confirmationToken as string };
  }

  it('1차 호출은 실행 없이 미리보기, 2차 호출(같은 키 + 토큰)로 실행', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 300);
    const { res, key, token } = await preview(u.publicId, 100);
    expect(res.status).toBe(422);
    expect(res.body.error.details.preview).toMatchObject({
      delta: -100,
      balanceBefore: 300,
      balanceAfter: 200,
    });
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(300);

    const ok = await request(t.app).post(deductUrl(u.publicId)).set(bearer(op)).set(key).send({
      currencyCode: 'GEM',
      amount: 100,
      reason: '오지급 회수 처리',
      confirmationToken: token,
    });
    expect(ok.status).toBe(200);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(200);
  });

  it('확인 후 수량을 바꾸면 거부 (바꿔치기 방지)', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 300);
    const { token } = await preview(u.publicId, 100);
    const res = await request(t.app).post(deductUrl(u.publicId)).set(bearer(op)).set(idem()).send({
      currencyCode: 'GEM',
      amount: 300,
      reason: '오지급 회수 처리',
      confirmationToken: token,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(300);
  });

  it('확인 토큰은 1회용', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 300);
    const { token } = await preview(u.publicId, 50);
    const send = () =>
      request(t.app).post(deductUrl(u.publicId)).set(bearer(op)).set(idem()).send({
        currencyCode: 'GEM',
        amount: 50,
        reason: '오지급 회수 처리',
        confirmationToken: token,
      });
    expect((await send()).status).toBe(200);
    expect((await send()).body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(250);
  });

  it('잔액이 부족하면 미리보기 단계에서 거부', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 10);
    const { res } = await preview(u.publicId, 100);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('동시에 회수해도 잔액은 음수가 되지 않는다 (500에서 100씩 10건 → 5건만 성공)', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GEM, 500);
    const prepared = await Promise.all(Array.from({ length: 10 }, () => preview(u.publicId, 100)));
    const results = await Promise.all(
      prepared.map(({ key, token }) =>
        request(t.app).post(deductUrl(u.publicId)).set(bearer(op)).set(key).send({
          currencyCode: 'GEM',
          amount: 100,
          reason: '오지급 회수 처리',
          confirmationToken: token,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const insufficient = results.filter(
      (r) => r.body.error?.code === 'INSUFFICIENT_BALANCE',
    ).length;
    expect(ok).toBe(5);
    expect(insufficient).toBe(5);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(0);
  });
});

describe('MCP 채널', () => {
  it('유료 재화(GEM)는 소량이어도 확인이 필요, 무료 재화는 바로 실행', async () => {
    const u = await createUser(t.ctx.db.db);
    const created = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp', permissions: ['currency:grant'] });
    const token = created.body.data.token as string;

    const gem = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(token))
      .set(idem())
      .send({ currencyCode: 'GEM', amount: 1, reason: 'MCP 유료 재화 지급' });
    expect(gem.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const gold = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(token))
      .set(idem())
      .send({ currencyCode: 'GOLD', amount: 1, reason: 'MCP 무료 재화 지급' });
    expect(gold.status).toBe(200);
    const [row] = await ledger(u.id);
    expect(row!.channel).toBe('MCP');

    // 같은 젬이라도 무료 젬은 무료 재화 → 바로 실행
    const freeGem = await request(t.app)
      .post(grantUrl(u.publicId))
      .set(bearer(token))
      .set(idem())
      .send({ currencyCode: 'FREE_GEM', amount: 1, reason: 'MCP 무료 젬 지급' });
    expect(freeGem.status).toBe(200);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.FREE_GEM)).toBe(1);
  });
});

describe('대량 지급', () => {
  it('100명 미만은 즉시 전원 지급', async () => {
    const list = await Promise.all(Array.from({ length: 3 }, () => createUser(t.ctx.db.db)));
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        publicIds: list.map((u) => u.publicId),
        currencyCode: 'GOLD',
        amount: 50,
        reason: '접속 이벤트 보상',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    for (const u of list) expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(50);
  });

  it('행마다 재화·수량을 다르게 지급 (같은 회원에게 여러 재화)', async () => {
    const [a, b] = await Promise.all(Array.from({ length: 2 }, () => createUser(t.ctx.db.db)));
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        reason: '랭킹 보상 지급',
        currencyCode: 'GOLD', // 재화를 비운 행의 기본값
        entries: [
          { publicId: a!.publicId, amount: 1000 },
          { publicId: a!.publicId, currencyCode: 'GEM', amount: 5 },
          { publicId: b!.publicId, currencyCode: 'free_gem', amount: 30 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      count: 3,
      userCount: 2,
      totals: [
        { currencyCode: 'GOLD', amount: 1000 },
        { currencyCode: 'GEM', amount: 5 },
        { currencyCode: 'FREE_GEM', amount: 30 },
      ],
    });
    expect(await getBalance(t.ctx.db.db, a!.id, CURRENCY.GOLD)).toBe(1000);
    expect(await getBalance(t.ctx.db.db, a!.id, CURRENCY.GEM)).toBe(5);
    expect(await getBalance(t.ctx.db.db, b!.id, CURRENCY.FREE_GEM)).toBe(30);

    // 감사 로그도 행마다
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'CURRENCY_GRANT'), eq(auditLogs.targetId, a!.publicId)));
    expect(
      logs
        .map((l) => l.afterData as { currencyCode: string; delta: number })
        .sort((x, y) => x.delta - y.delta),
    ).toMatchObject([
      { currencyCode: 'GEM', delta: 5 },
      { currencyCode: 'GOLD', delta: 1000 },
    ]);
  });

  it('행마다 다른 사유가 원장과 감사 로그에 그대로 남는다', async () => {
    const [a, b] = await Promise.all(Array.from({ length: 2 }, () => createUser(t.ctx.db.db)));
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        entries: [
          { publicId: a!.publicId, currencyCode: 'GOLD', amount: 100, reason: '시즌 1위 보상' },
          { publicId: b!.publicId, currencyCode: 'GOLD', amount: 50, reason: '버그 제보 보상' },
        ],
      });
    expect(res.status).toBe(200);
    expect((await ledger(a!.id))[0]!.reason).toBe('시즌 1위 보상');
    expect((await ledger(b!.id))[0]!.reason).toBe('버그 제보 보상');
    const [log] = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'CURRENCY_GRANT'), eq(auditLogs.targetId, b!.publicId)));
    expect(log!.reason).toBe('버그 제보 보상');
  });

  it('한 행이라도 그 재화의 1인당 상한을 넘으면 아무도 지급되지 않고 초과 행을 알려준다', async () => {
    const [a, b] = await Promise.all(Array.from({ length: 2 }, () => createUser(t.ctx.db.db)));
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        reason: '행동력 보상 지급',
        entries: [
          { publicId: a!.publicId, currencyCode: 'GOLD', amount: 600 }, // GOLD 상한 1,000,000 → 정상
          { publicId: b!.publicId, currencyCode: 'STAMINA', amount: 501 }, // STAMINA 상한 500 → 초과
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXCEEDS_GRANT_LIMIT');
    expect(res.body.error.details.overLimit).toEqual([
      { publicId: b!.publicId, currencyCode: 'STAMINA', amount: 501, limit: 500 },
    ]);
    expect(await getBalance(t.ctx.db.db, a!.id, CURRENCY.GOLD)).toBe(0);
  });

  it('없는 재화가 섞이면 422 와 함께 재화 코드를 알려준다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        reason: '잘못된 재화 지급',
        entries: [
          { publicId: u.publicId, currencyCode: 'GOLD', amount: 1 },
          { publicId: u.publicId, currencyCode: 'RUBY', amount: 1 },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_CURRENCY');
    expect(res.body.error.details.invalidCurrencies).toEqual(['RUBY']);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(0);
  });

  it('entries 와 publicIds 를 함께 보내면 400', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        currencyCode: 'GOLD',
        reason: '잘못된 요청 형태',
        entries: [{ publicId: u.publicId, amount: 1 }],
        publicIds: [u.publicId],
        amount: 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('존재하지 않는 회원이 섞이면 아무도 지급되지 않는다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        publicIds: [u.publicId, 'GHOST001'],
        currencyCode: 'GOLD',
        amount: 50,
        reason: '접속 이벤트 보상',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toEqual(['GHOST001']);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(0);
  });

  /** L3: 첫 호출 → 422 + 빨간 경고 미리보기, 같은 본문 + 토큰 → 실행 */
  async function bulkConfirmed(body: Record<string, unknown>, token = op) {
    const key = idem();
    const first = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(token))
      .set(key)
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(422);
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const second = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(token))
      .set(key)
      .send({ ...body, confirmationToken: first.body.error.details.confirmationToken });
    return { preview: first.body.error.details.preview, res: second };
  }

  it('100명 이상은 빨간 경고 확인 후 실행 (확인 전엔 지급 안 됨)', async () => {
    const list = await Promise.all(Array.from({ length: 100 }, () => createUser(t.ctx.db.db)));
    const body = {
      publicIds: list.map((u) => u.publicId),
      currencyCode: 'GEM',
      amount: 10,
      reason: '대규모 보상 지급',
    };
    const { preview, res } = await bulkConfirmed(body);
    expect(preview).toMatchObject({
      action: 'CURRENCY_BULK_GRANT',
      title: 'GEM 10개 × 100명 지급',
    });
    expect(preview.facts).toContainEqual({ label: '대상 회원', value: '100명' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'EXECUTED', userCount: 100, count: 100 });
    expect(await getBalance(t.ctx.db.db, list[99]!.id, CURRENCY.GEM)).toBe(10);

    // 실행 감사 로그는 요청한 운영자 + WEB 채널
    const exec = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'CURRENCY_GRANT'), eq(auditLogs.targetId, list[0]!.publicId)),
      );
    expect(exec[0]!.channel).toBe('WEB');
  });

  it('확인 후 수량을 바꿔 보내면 거부 (토큰은 처음 내용에 묶임)', async () => {
    const list = await Promise.all(Array.from({ length: 100 }, () => createUser(t.ctx.db.db)));
    const body = {
      publicIds: list.map((u) => u.publicId),
      currencyCode: 'GOLD',
      amount: 10,
      reason: '대규모 보상 지급',
    };
    const first = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send(body);
    const swapped = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(op))
      .set(idem())
      .send({
        ...body,
        amount: 10_000,
        confirmationToken: first.body.error.details.confirmationToken,
      });
    expect(swapped.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, list[0]!.id, CURRENCY.GOLD)).toBe(0);
  });

  it('행별 지급도 서로 다른 회원 100명 이상이면 확인 후 각자 수량대로 실행', async () => {
    const list = await Promise.all(Array.from({ length: 100 }, () => createUser(t.ctx.db.db)));
    const { preview, res } = await bulkConfirmed({
      reason: '랭킹 구간별 보상',
      entries: list.map((u, i) => ({
        publicId: u.publicId,
        currencyCode: 'GOLD',
        amount: i + 1,
      })),
    });
    expect(preview.title).toBe('GOLD 총 5,050개 · 100명 지급 (1인 1~100개)');
    expect(res.status).toBe(200);
    expect(await getBalance(t.ctx.db.db, list[0]!.id, CURRENCY.GOLD)).toBe(1);
    expect(await getBalance(t.ctx.db.db, list[99]!.id, CURRENCY.GOLD)).toBe(100);
  });

  it('MCP(API 토큰)는 100명 이상 지급을 실행할 수 없다 — 미리보기만 받고 403', async () => {
    const list = await Promise.all(Array.from({ length: 100 }, () => createUser(t.ctx.db.db)));
    const created = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp', permissions: ['currency:grant'] });
    const res = await request(t.app)
      .post('/api/v1/currencies/bulk-grant')
      .set(bearer(created.body.data.token))
      .set(idem())
      .send({
        publicIds: list.map((u) => u.publicId),
        currencyCode: 'GOLD',
        amount: 10,
        reason: 'MCP 대량 지급 시도',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHANNEL_NOT_ALLOWED');
    expect(res.body.error.details.preview.action).toBe('CURRENCY_BULK_GRANT');
    expect(res.body.error.details.confirmationToken).toBeUndefined();
    expect(await getBalance(t.ctx.db.db, list[0]!.id, CURRENCY.GOLD)).toBe(0);
  });
});
