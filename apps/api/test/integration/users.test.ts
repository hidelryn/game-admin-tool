import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  userActivityLogs,
  userSuspensions,
  users,
} from '../../src/infra/db/schema/index.js';
import { releaseExpiredSuspensions } from '../../src/modules/users/user.service.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  login,
  type TestContext,
} from './helpers.js';

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

describe('회원 조회', () => {
  it('닉네임 접두어·상태로 검색하고 이메일은 마스킹', async () => {
    await createUser(t.ctx.db.db, { nickname: '용감한기사1', email: 'brave@example.com' });
    await createUser(t.ctx.db.db, { nickname: '용감한궁수2' });
    await createUser(t.ctx.db.db, { nickname: '조용한기사3', status: 'SUSPENDED' });

    const res = await request(t.app).get('/api/v1/users?nickname=용감한').set(bearer(op));
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    const brave = res.body.data.find((u: { nickname: string }) => u.nickname === '용감한기사1');
    expect(brave.email).toBe('br***@example.com');

    const suspended = await request(t.app).get('/api/v1/users?status=SUSPENDED').set(bearer(op));
    expect(suspended.body.data.map((u: { nickname: string }) => u.nickname)).toEqual([
      '조용한기사3',
    ]);
  });

  it('LIKE 와일드카드는 문자 그대로 검색', async () => {
    await createUser(t.ctx.db.db, { nickname: 'abc' });
    const res = await request(t.app).get('/api/v1/users?nickname=%25').set(bearer(op));
    expect(res.body.meta.total).toBe(0);
  });

  it('상세에는 모든 재화 잔액(없으면 0)이 포함된다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app).get(`/api/v1/users/${u.publicId}`).set(bearer(op));
    expect(res.status).toBe(200);
    expect(res.body.data.balances.map((b: { currencyCode: string }) => b.currencyCode)).toEqual([
      'GOLD',
      'GEM',
      'STAMINA',
      'FREE_GEM',
    ]);
    expect(res.body.data.activeSuspension).toBeNull();
  });

  it('없는 회원은 404 USER_NOT_FOUND', async () => {
    const res = await request(t.app).get('/api/v1/users/NOPE123').set(bearer(op));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('개인정보 원문은 권한이 필요하고, 열람이 감사 로그에 남는다', async () => {
    const u = await createUser(t.ctx.db.db, { email: 'secret@example.com' });
    expect(
      (await request(t.app).get(`/api/v1/users/${u.publicId}/pii`).set(bearer(op))).status,
    ).toBe(403);

    const res = await request(t.app).get(`/api/v1/users/${u.publicId}/pii`).set(bearer(superToken));
    expect(res.body.data.email).toBe('secret@example.com');
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'USER_PII_VIEW'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.targetId).toBe(u.publicId);
  });

  it('활동 이력 커서 페이지네이션 — 중복·누락 없음', async () => {
    const u = await createUser(t.ctx.db.db);
    const base = Date.now() - 3_600_000;
    await t.ctx.db.db.insert(userActivityLogs).values(
      Array.from({ length: 5 }, (_, i) => ({
        userId: u.id,
        type: 'LOGIN',
        occurredAt: new Date(base + (i % 2) * 1000),
      })),
    );
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const res = await request(t.app)
        .get(`/api/v1/users/${u.publicId}/activities?size=2${qs}`)
        .set(bearer(op));
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((a: { id: number }) => a.id));
      cursor = res.body.meta.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('회원 정지', () => {
  it('기간 정지 → 중복 정지 409 → 해제 → 재해제 409', async () => {
    const u = await createUser(t.ctx.db.db);
    const url = `/api/v1/users/${u.publicId}`;

    const s1 = await request(t.app)
      .post(`${url}/suspend`)
      .set(bearer(op))
      .send({ durationDays: 7, reason: '비매너 채팅 신고' });
    expect(s1.status).toBe(201);
    expect(s1.body.data.endsAt).toBeTruthy();
    expect((await request(t.app).get(url).set(bearer(op))).body.data.status).toBe('SUSPENDED');

    const s2 = await request(t.app)
      .post(`${url}/suspend`)
      .set(bearer(op))
      .send({ durationDays: 1, reason: '중복 정지 시도' });
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe('ALREADY_SUSPENDED');

    expect(
      (
        await request(t.app)
          .post(`${url}/unsuspend`)
          .set(bearer(op))
          .send({ reason: '이의 신청 수용' })
      ).status,
    ).toBe(204);
    const again = await request(t.app)
      .post(`${url}/unsuspend`)
      .set(bearer(op))
      .send({ reason: '이의 신청 수용' });
    expect(again.body.error.code).toBe('NOT_SUSPENDED');

    const actions = (
      await t.ctx.db.db.select().from(auditLogs).where(eq(auditLogs.targetId, u.publicId))
    ).map((r) => r.action);
    expect(actions).toEqual(['USER_SUSPEND', 'USER_UNSUSPEND']);
  });

  it('영구 정지는 확인 토큰이 필요하다', async () => {
    const u = await createUser(t.ctx.db.db);
    const body = { permanent: true, reason: '계정 거래 적발' };
    const first = await request(t.app)
      .post(`/api/v1/users/${u.publicId}/suspend`)
      .set(bearer(op))
      .send(body);
    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const token = first.body.error.details.confirmationToken;

    const second = await request(t.app)
      .post(`/api/v1/users/${u.publicId}/suspend`)
      .set(bearer(op))
      .send({ ...body, confirmationToken: token });
    expect(second.status).toBe(201);
    expect(second.body.data.endsAt).toBeNull();
  });

  it('조회 전용 운영자는 정지할 수 없다', async () => {
    const u = await createUser(t.ctx.db.db);
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const res = await request(t.app)
      .post(`/api/v1/users/${u.publicId}/suspend`)
      .set(bearer(viewer))
      .send({ durationDays: 1, reason: '권한 없는 시도' });
    expect(res.status).toBe(403);
  });

  it('기간이 끝난 정지는 자동 해제된다 (Worker 작업)', async () => {
    const u = await createUser(t.ctx.db.db, { status: 'SUSPENDED' });
    await t.ctx.db.db.insert(userSuspensions).values({
      userId: u.id,
      reason: '테스트 정지',
      startsAt: new Date(Date.now() - 2 * 86_400_000),
      endsAt: new Date(Date.now() - 60_000),
    });
    expect(await releaseExpiredSuspensions(t.ctx.db.db)).toBe(1);
    const [row] = await t.ctx.db.db.select().from(users).where(eq(users.id, u.id));
    expect(row!.status).toBe('ACTIVE');
    expect(await releaseExpiredSuspensions(t.ctx.db.db)).toBe(0);
  });
});
