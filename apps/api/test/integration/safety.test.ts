import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  currencyTransactions,
  maintenances,
  mails,
  notices,
  schedules,
} from '../../src/infra/db/schema/index.js';
import {
  ADMIN,
  CURRENCY,
  bearer,
  createTestContext,
  createUser,
  getBalance,
  idem,
  login,
  setBalance,
  type TestContext,
} from './helpers.js';

/**
 * 안전장치 공통 검증 (architecture.md 4.4, 6장)
 * - 중복 실행 방지: 멱등 키가 필요한 모든 생성·지급 API
 * - 확인 토큰: 1회용, 다른 운영자·다른 내용·만료 거부
 * - Redis 장애: 위험 작업은 중단(fail-closed), 일반 변경은 DB 로 보호, 랭킹 조회만 503
 * - 에러 응답 형식
 */
let t: TestContext;
let op: string;
let superToken: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  op = (await login(t.app, ADMIN.operator)).accessToken;
  superToken = (await login(t.app, ADMIN.super)).accessToken;
});

const H = 3_600_000;
const later = (h: number) => new Date(Date.now() + h * H).toISOString();
const api = (path: string) => `/api/v1${path}`;

/** 멱등 키가 필요한 생성 API: [이름, 경로, 본문 만들기, 생성된 행 수 세기, 토큰] */
type Case = {
  name: string;
  path: string;
  body: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  count: () => Promise<number>;
  token: () => string;
};

const rows = async (
  table: Parameters<TestContext['ctx']['db']['db']['select']>[0] extends never ? never : unknown,
) => table;

const CASES: Case[] = [
  {
    name: '우편 발송',
    path: '/mails',
    body: async () => ({
      publicIds: [(await createUser(t.ctx.db.db)).publicId],
      title: '보상',
      body: '감사합니다',
      reason: '중복 방지 테스트 우편',
    }),
    count: async () => (await t.ctx.db.db.select().from(mails)).length,
    token: () => op,
  },
  {
    name: '공지 등록',
    path: '/notices',
    body: () => ({
      category: 'NOTICE',
      title: '안내',
      body: '본문',
      startsAt: later(1),
      endsAt: null,
      pinned: false,
      tickerEnabled: false,
      tickerText: null,
      reason: '중복 방지 테스트 공지',
    }),
    count: async () => (await t.ctx.db.db.select().from(notices)).length,
    token: () => op,
  },
  {
    name: '스케줄 등록',
    path: '/schedules',
    body: () => ({
      kind: 'EVENT',
      title: '이벤트',
      description: '',
      startsAt: later(24),
      endsAt: later(48),
      reason: '중복 방지 테스트 일정',
    }),
    count: async () =>
      (await t.ctx.db.db.select().from(schedules).where(eq(schedules.kind, 'EVENT'))).length,
    token: () => op,
  },
  {
    name: '점검 예약',
    path: '/maintenances',
    body: () => ({
      title: '정기 점검',
      message: '점검합니다',
      startsAt: later(24),
      endsAt: later(26),
      createNotice: false,
      reason: '중복 방지 테스트 점검',
    }),
    count: async () => (await t.ctx.db.db.select().from(maintenances)).length,
    token: () => op,
  },
];
void rows;

describe('중복 실행 방지 (멱등 키)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s: 키가 없으면 400', async (_, c) => {
    const res = await request(t.app)
      .post(api(c.path))
      .set(bearer(c.token()))
      .send(await c.body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await c.count()).toBe(0);
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: 같은 키로 동시에 8번 → 1건만 생기고 응답은 성공 또는 처리 중(409)',
    async (_, c) => {
      const key = idem();
      const body = await c.body();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(t.app).post(api(c.path)).set(bearer(c.token())).set(key).send(body),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(
        statuses.every((s) => s === 201 || s === 409),
        JSON.stringify(statuses),
      ).toBe(true);
      expect(await c.count()).toBe(1);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: 끝난 요청을 같은 키로 다시 보내면 같은 결과, 내용을 바꾸면 422',
    async (_, c) => {
      const key = idem();
      const body = await c.body();
      const first = await request(t.app)
        .post(api(c.path))
        .set(bearer(c.token()))
        .set(key)
        .send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const again = await request(t.app)
        .post(api(c.path))
        .set(bearer(c.token()))
        .set(key)
        .send(body);
      expect(again.status).toBe(201);
      expect(again.body.data.id ?? again.body.data.mailId).toBe(
        first.body.data.id ?? first.body.data.mailId,
      );
      const changed = await request(t.app)
        .post(api(c.path))
        .set(bearer(c.token()))
        .set(key)
        .send({ ...body, reason: '내용을 바꾼 재전송 시도' });
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await c.count()).toBe(1);
    },
  );

  it('키는 운영자별 — 다른 운영자가 같은 키를 써도 서로 영향 없음', async () => {
    const key = idem();
    const body = await CASES[1]!.body();
    const a = await request(t.app).post(api('/notices')).set(bearer(op)).set(key).send(body);
    const b = await request(t.app)
      .post(api('/notices'))
      .set(bearer(superToken))
      .set(key)
      .send(body);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });
});

describe('확인 토큰 (L2·L3)', () => {
  const deduct = async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GOLD, 1000);
    const url = api(`/users/${u.publicId}/currencies/deduct`);
    const body = { currencyCode: 'GOLD', amount: 100, reason: '확인 토큰 테스트 회수' };
    const first = await request(t.app).post(url).set(bearer(op)).set(idem()).send(body);
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    return { u, url, body, token: first.body.error.details.confirmationToken as string };
  };

  it('한 번 쓴 토큰은 다시 쓸 수 없다 (1회용)', async () => {
    const { u, url, body, token } = await deduct();
    const ok = await request(t.app)
      .post(url)
      .set(bearer(op))
      .set(idem())
      .send({ ...body, confirmationToken: token });
    expect(ok.status).toBe(200);
    const reuse = await request(t.app)
      .post(url)
      .set(bearer(op))
      .set(idem())
      .send({ ...body, confirmationToken: token });
    expect(reuse.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(900);
  });

  it('다른 운영자는 내 확인 토큰을 쓸 수 없다', async () => {
    const { u, url, body, token } = await deduct();
    const other = await request(t.app)
      .post(url)
      .set(bearer(superToken))
      .set(idem())
      .send({ ...body, confirmationToken: token });
    expect(other.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(1000);
  });

  it('만료된 토큰은 거부', async () => {
    const { u, url, body, token } = await deduct();
    await t.ctx.redis.redis.del(`confirm:${token}`); // TTL 5분이 지난 것과 같음
    const res = await request(t.app)
      .post(url)
      .set(bearer(op))
      .set(idem())
      .send({ ...body, confirmationToken: token });
    expect(res.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(1000);
  });

  it('L3(전체 우편): 확인 후 제목을 바꿔 보내면 거부', async () => {
    const body = { title: '보상', body: '감사', reason: '전체 우편 바꿔치기 시도' };
    const first = await request(t.app)
      .post(api('/mails/global'))
      .set(bearer(superToken))
      .set(idem())
      .send(body);
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const swapped = await request(t.app)
      .post(api('/mails/global'))
      .set(bearer(superToken))
      .set(idem())
      .send({
        ...body,
        title: '바뀐 제목',
        confirmationToken: first.body.error.details.confirmationToken,
      });
    expect(swapped.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await t.ctx.db.db.select().from(mails)).toHaveLength(0);
  });
});

describe('Redis 장애', () => {
  /** ioredis 의 모든 명령이 실패하게 (연결 끊김과 같은 효과) */
  const redisDown = () =>
    vi
      .spyOn(t.ctx.redis.redis, 'sendCommand')
      .mockImplementation(() => Promise.reject(new Error('redis down')) as never);

  it('위험 작업(L2)은 실행하지 않고 503 (fail-closed)', async () => {
    const u = await createUser(t.ctx.db.db);
    await setBalance(t.ctx.db.db, u.id, CURRENCY.GOLD, 1000);
    const spy = redisDown();
    try {
      const res = await request(t.app)
        .post(api(`/users/${u.publicId}/currencies/deduct`))
        .set(bearer(op))
        .set(idem())
        .send({ currencyCode: 'GOLD', amount: 100, reason: 'Redis 장애 중 회수' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(1000);
  });

  it('일반 지급은 계속되고, 중복 방지는 DB 로 지킨다', async () => {
    const u = await createUser(t.ctx.db.db);
    const key = idem();
    const body = { currencyCode: 'GOLD', amount: 100, reason: 'Redis 장애 중 지급' };
    const spy = redisDown();
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(t.app)
            .post(api(`/users/${u.publicId}/currencies/grant`))
            .set(bearer(op))
            .set(key)
            .send(body),
        ),
      );
      expect(results.some((r) => r.status === 200)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const ledger = await t.ctx.db.db
      .select()
      .from(currencyTransactions)
      .where(eq(currencyTransactions.userId, u.id));
    expect(ledger).toHaveLength(1);
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GOLD)).toBe(100);
  });

  it('랭킹 조회만 503 RANKING_UNAVAILABLE, 다른 조회는 정상', async () => {
    const spy = redisDown();
    try {
      const ranking = await request(t.app).get(api('/ranking-seasons/1/rankings')).set(bearer(op));
      expect(ranking.status).toBe(503);
      expect(ranking.body.error.code).toBe('RANKING_UNAVAILABLE');
      expect((await request(t.app).get(api('/users?status=ACTIVE')).set(bearer(op))).status).toBe(
        200,
      );
      expect((await request(t.app).get(api('/currencies')).set(bearer(op))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('에러 응답 형식', () => {
  it('없는 경로는 404 + 공통 에러 형식 + requestId', async () => {
    const res = await request(t.app).get(api('/nope')).set(bearer(op));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('깨진 JSON 은 400', async () => {
    const res = await request(t.app)
      .post(api('/notices'))
      .set(bearer(op))
      .set(idem())
      .set('Content-Type', 'application/json')
      .send('{"title":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeTruthy();
  });

  it('입력 검증 실패는 400 VALIDATION_FAILED + 필드 정보, 감사 로그에 성공 기록 없음', async () => {
    const res = await request(t.app)
      .post(api('/notices'))
      .set(bearer(op))
      .set(idem())
      .send({ category: 'NOPE', title: '', reason: '짧' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toBeTruthy();
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'NOTICE_CREATE'), eq(auditLogs.result, 'SUCCESS')));
    expect(logs).toHaveLength(0);
  });

  it('없는 회원은 404 USER_NOT_FOUND', async () => {
    const res = await request(t.app)
      .post(api('/users/U_GHOST/currencies/grant'))
      .set(bearer(op))
      .set(idem())
      .send({ currencyCode: 'GOLD', amount: 1, reason: '없는 회원 지급 시도' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});
