import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { admins, auditLogs } from '../../src/infra/db/schema/index.js';
import { ADMIN, bearer, createTestContext, login, type TestContext } from './helpers.js';

let t: TestContext;
let opToken: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  opToken = (await login(t.app, ADMIN.operator)).accessToken;
});

async function issue(permissions: string[]) {
  const res = await request(t.app)
    .post('/api/v1/me/api-tokens')
    .set(bearer(opToken))
    .send({ name: 'claude-desktop', permissions, expiresInDays: 7 });
  return res;
}

describe('API 토큰 발급', () => {
  it('원문은 발급 응답에만 있고, 목록·감사 로그에는 없다', async () => {
    const res = await issue(['user:read', 'currency:read']);
    expect(res.status).toBe(201);
    const token: string = res.body.data.token;
    expect(token).toMatch(/^ga_[0-9a-f]{12}_/);

    const list = await request(t.app).get('/api/v1/me/api-tokens').set(bearer(opToken));
    expect(JSON.stringify(list.body)).not.toContain(token);
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'API_TOKEN_CREATE'));
    expect(JSON.stringify(logs)).not.toContain(token.split('_')[2]!);
  });

  it('본인에게 없는 권한이나 토큰 금지 권한은 부여할 수 없다', async () => {
    const res = await issue(['user:read', 'mail:send_all', 'admin:manage']);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOKEN_PERMISSION_NOT_ALLOWED');
    expect(res.body.error.details.notAllowed.sort()).toEqual(['admin:manage', 'mail:send_all']);
  });
});

describe('API 토큰 인증', () => {
  it('채널은 MCP, 권한은 토큰에 지정한 것만', async () => {
    const { token } = (await issue(['user:read'])).body.data;
    const me = await request(t.app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.data.channel).toBe('MCP');
    expect(me.body.data.permissions).toEqual(['user:read']);
  });

  it('API 토큰으로는 새 토큰을 발급할 수 없다', async () => {
    const { token } = (await issue(['user:read'])).body.data;
    const res = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(token))
      .send({ name: 'x', permissions: ['user:read'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHANNEL_NOT_ALLOWED');
  });

  it('운영자 권한이 줄면 토큰 권한도 즉시 줄어든다', async () => {
    const { token } = (await issue(['user:read', 'currency:read'])).body.data;
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const [op] = await t.ctx.db.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, ADMIN.operator));
    await request(t.app)
      .put(`/api/v1/admins/${op!.id}/permission-overrides`)
      .set(bearer(superToken))
      .send({
        overrides: [{ permission: 'currency:read', effect: 'DENY' }],
        reason: '재화 조회 권한 회수',
      })
      .expect(200);

    const me = await request(t.app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.data.permissions).toEqual(['user:read']);
  });

  it('폐기한 토큰은 401', async () => {
    const { token, id } = (await issue(['user:read'])).body.data;
    await request(t.app).delete(`/api/v1/me/api-tokens/${id}`).set(bearer(opToken)).expect(204);
    expect((await request(t.app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('secret 을 바꾼 위조 토큰은 401', async () => {
    const { token } = (await issue(['user:read'])).body.data;
    const forged = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await request(t.app).get('/api/v1/auth/me').set(bearer(forged))).status).toBe(401);
  });
});
