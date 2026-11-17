import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { auditLogs } from '../../src/infra/db/schema/index.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  CSRF,
  login,
  TEST_PASSWORD,
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

describe('로그인', () => {
  it('성공 시 access token 과 httpOnly refresh 쿠키를 준다', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.operator, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.admin).toMatchObject({
      email: ADMIN.operator,
      roleCode: 'OPERATOR',
      channel: 'WEB',
    });
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/ga_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('이메일 대소문자·공백은 정규화된다', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: '  OPERATOR@Example.com ', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('없는 계정과 틀린 비밀번호는 같은 응답', async () => {
    const a = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'x' });
    const b = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.operator, password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('5회 연속 실패하면 잠기고, 맞는 비밀번호도 거부된다', async () => {
    for (let i = 0; i < 5; i++) {
      await request(t.app)
        .post('/api/v1/auth/login')
        .send({ email: ADMIN.operator, password: 'wrong' });
    }
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.operator, password: TEST_PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('성공·실패가 감사 로그에 남는다', async () => {
    await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.operator, password: 'wrong' });
    await login(t.app, ADMIN.operator);
    const rows = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetType, 'ADMIN'))
      .orderBy(auditLogs.id);
    expect(rows.map((r) => r.action)).toEqual(['LOGIN_FAILED', 'LOGIN']);
    expect(rows.every((r) => r.adminId !== null && r.channel === 'WEB')).toBe(true);
  });
});

describe('인증 미들웨어', () => {
  it('토큰 없이 /auth/me 는 401', async () => {
    const res = await request(t.app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('/auth/me 는 실효 권한을 돌려준다', async () => {
    const { accessToken } = await login(t.app, ADMIN.viewer);
    const res = await request(t.app).get('/api/v1/auth/me').set(bearer(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toContain('user:read');
    expect(res.body.data.permissions).not.toContain('currency:grant');
  });
});

describe('refresh 토큰 회전', () => {
  it('CSRF 헤더가 없으면 거부', async () => {
    const { cookie } = await login(t.app, ADMIN.operator);
    const res = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('갱신하면 새 refresh 쿠키가 발급된다', async () => {
    const { cookie } = await login(t.app, ADMIN.operator);
    const res = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    const next = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0];
    expect(next).not.toBe(cookie);
  });

  it('이미 쓴 refresh 토큰을 다시 쓰면 family 전체가 폐기된다 (탈취 감지)', async () => {
    const { cookie: first } = await login(t.app, ADMIN.operator);
    const r1 = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF);
    const second = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    const reuse = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF);
    expect(reuse.status).toBe(401);

    // 정상 사용자의 최신 토큰도 함께 폐기됨
    const r2 = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', second).set(CSRF);
    expect(r2.status).toBe(401);

    const actions = (await t.ctx.db.db.select().from(auditLogs)).map((r) => r.action);
    expect(actions).toContain('TOKEN_REUSE_DETECTED');
  });
});

describe('로그아웃', () => {
  it('access token 은 즉시 무효, refresh 도 폐기된다', async () => {
    const { accessToken, cookie } = await login(t.app, ADMIN.operator);
    const out = await request(t.app)
      .post('/api/v1/auth/logout')
      .set(bearer(accessToken))
      .set('Cookie', cookie)
      .set(CSRF);
    expect(out.status).toBe(204);

    expect((await request(t.app).get('/api/v1/auth/me').set(bearer(accessToken))).status).toBe(401);
    expect(
      (await request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF)).status,
    ).toBe(401);
  });

  it('만료·잘못된 access token 이어도 쿠키로 로그아웃된다', async () => {
    const { cookie } = await login(t.app, ADMIN.operator);
    const out = await request(t.app)
      .post('/api/v1/auth/logout')
      .set(bearer('broken.token.value'))
      .set('Cookie', cookie)
      .set(CSRF);
    expect(out.status).toBe(204);
    expect(
      (await request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF)).status,
    ).toBe(401);
  });
});

describe('비밀번호 변경', () => {
  it('변경 후 기존 토큰은 모두 무효, 새 비밀번호로 로그인된다', async () => {
    const { accessToken, cookie } = await login(t.app, ADMIN.operator);
    const res = await request(t.app)
      .patch('/api/v1/auth/me/password')
      .set(bearer(accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'New-password-5678' });
    expect(res.status).toBe(204);

    expect((await request(t.app).get('/api/v1/auth/me').set(bearer(accessToken))).status).toBe(401);
    expect(
      (await request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF)).status,
    ).toBe(401);
    await login(t.app, ADMIN.operator, 'New-password-5678');
  });

  it('현재 비밀번호가 틀리면 422', async () => {
    const { accessToken } = await login(t.app, ADMIN.operator);
    const res = await request(t.app)
      .patch('/api/v1/auth/me/password')
      .set(bearer(accessToken))
      .send({ currentPassword: 'wrong', newPassword: 'New-password-5678' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });
});
