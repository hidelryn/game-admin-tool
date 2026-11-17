import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  idem,
  login,
  type TestContext,
} from './helpers.js';

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

describe('운영 로그 조회', () => {
  it('작업 유형·대상으로 필터하고 커서로 넘긴다', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const u = await createUser(t.ctx.db.db);
    for (let i = 0; i < 3; i++) {
      await request(t.app)
        .post(`/api/v1/users/${u.publicId}/currencies/grant`)
        .set(bearer(op))
        .set(idem())
        .send({ currencyCode: 'GOLD', amount: 10, reason: `보상 지급 ${i + 1}회차` });
    }
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const page1 = await request(t.app)
      .get(`/api/v1/audit-logs?action=CURRENCY_GRANT&targetId=${u.publicId}&size=2`)
      .set(bearer(viewer));
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0].admin.name).toBe('운영자');
    expect(page1.body.data[0].reason).toBe('보상 지급 3회차');

    const page2 = await request(t.app)
      .get(
        `/api/v1/audit-logs?action=CURRENCY_GRANT&targetId=${u.publicId}&size=2&cursor=${page1.body.meta.nextCursor}`,
      )
      .set(bearer(viewer));
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.nextCursor).toBeNull();
  });

  it('CS 역할은 본인 작업만 보인다', async () => {
    await login(t.app, ADMIN.operator);
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    const res = await request(t.app).get('/api/v1/audit-logs?size=100').set(bearer(cs));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(
      res.body.data.every((r: { admin: { name: string } | null }) => r.admin?.name === '고객지원'),
    ).toBe(true);
  });

  it('수정·삭제 API 는 없다', async () => {
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const list = await request(t.app).get('/api/v1/audit-logs').set(bearer(superToken));
    const id = list.body.data[0].id;
    expect(
      (await request(t.app).delete(`/api/v1/audit-logs/${id}`).set(bearer(superToken))).status,
    ).toBe(404);
    expect(
      (await request(t.app).patch(`/api/v1/audit-logs/${id}`).set(bearer(superToken)).send({}))
        .status,
    ).toBe(404);
  });
});
