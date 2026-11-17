import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN, createTestContext, TEST_PASSWORD, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ LOGIN_RATE_LIMIT_PER_MIN: '3' });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('로그인 Rate Limit', () => {
  it('분당 한도를 넘으면 맞는 비밀번호도 429 + Retry-After', async () => {
    const attempt = (password: string) =>
      request(t.app).post('/api/v1/auth/login').send({ email: ADMIN.viewer, password });
    for (let i = 0; i < 3; i++) expect((await attempt('wrong')).status).toBe(401);
    const blocked = await attempt(TEST_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});
