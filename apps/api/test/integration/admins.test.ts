import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { admins, auditLogs } from '../../src/infra/db/schema/index.js';
import { ADMIN, bearer, createTestContext, login, type TestContext } from './helpers.js';

let t: TestContext;
let superToken: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  superToken = (await login(t.app, ADMIN.super)).accessToken;
});

const idOf = async (email: string) =>
  (await t.ctx.db.db.select({ id: admins.id }).from(admins).where(eq(admins.email, email)))[0]!.id;

describe('권한 검사', () => {
  it('admin:manage 가 없으면 403', async () => {
    const { accessToken } = await login(t.app, ADMIN.operator);
    const res = await request(t.app).get('/api/v1/admins').set(bearer(accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('SUPER_ADMIN 은 목록 조회 가능', async () => {
    const res = await request(t.app).get('/api/v1/admins?size=2').set(bearer(superToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(4);
  });
});

describe('운영자 생성', () => {
  it('임시 비밀번호로 로그인되고, 변경 전에는 기능 사용이 막힌다', async () => {
    const res = await request(t.app)
      .post('/api/v1/admins')
      .set(bearer(superToken))
      .send({ email: 'new@example.com', name: '신규운영자', roleCode: 'OPERATOR' });
    expect(res.status).toBe(201);
    const { temporaryPassword } = res.body.data;

    const { accessToken, body } = await login(t.app, 'new@example.com', temporaryPassword);
    expect(body.data.admin.mustChangePassword).toBe(true);

    const blocked = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(accessToken))
      .send({ name: 'x', permissions: ['user:read'] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ADMIN_CREATE'));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0]!.afterData)).not.toContain(temporaryPassword);
  });

  it('중복 이메일은 409', async () => {
    const res = await request(t.app)
      .post('/api/v1/admins')
      .set(bearer(superToken))
      .send({ email: ADMIN.cs, name: '중복', roleCode: 'CS' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ADMIN_EMAIL_EXISTS');
  });
});

describe('자기 권한 상승 방지', () => {
  it('자기 역할은 바꿀 수 없다', async () => {
    const res = await request(t.app)
      .patch(`/api/v1/admins/${await idOf(ADMIN.super)}`)
      .set(bearer(superToken))
      .send({ roleCode: 'VIEWER', reason: '테스트 변경' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_MODIFICATION_NOT_ALLOWED');
  });

  it('admin:manage 를 GRANT 받은 운영자도 SUPER_ADMIN 은 만들 수 없다', async () => {
    const opId = await idOf(ADMIN.operator);
    await request(t.app)
      .put(`/api/v1/admins/${opId}/permission-overrides`)
      .set(bearer(superToken))
      .send({
        overrides: [{ permission: 'admin:manage', effect: 'GRANT' }],
        reason: '운영자 관리 위임',
      })
      .expect(200);

    const { accessToken } = await login(t.app, ADMIN.operator);
    const res = await request(t.app)
      .patch(`/api/v1/admins/${await idOf(ADMIN.viewer)}`)
      .set(bearer(accessToken))
      .send({ roleCode: 'SUPER_ADMIN', reason: '권한 상승 시도' });
    expect(res.status).toBe(403);
  });
});

describe('권한 변경 즉시 반영', () => {
  it('역할을 바꾸면 기존 access token 은 TOKEN_EXPIRED', async () => {
    const { accessToken } = await login(t.app, ADMIN.viewer);
    await request(t.app)
      .patch(`/api/v1/admins/${await idOf(ADMIN.viewer)}`)
      .set(bearer(superToken))
      .send({ roleCode: 'OPERATOR', reason: '역할 변경 테스트' })
      .expect(200);
    const res = await request(t.app).get('/api/v1/auth/me').set(bearer(accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('DENY 오버라이드는 역할 권한을 제거한다', async () => {
    const viewerId = await idOf(ADMIN.viewer);
    const res = await request(t.app)
      .put(`/api/v1/admins/${viewerId}/permission-overrides`)
      .set(bearer(superToken))
      .send({ overrides: [{ permission: 'user:read', effect: 'DENY' }], reason: '조회 권한 회수' });
    expect(res.status).toBe(200);
    expect(res.body.data.effectivePermissions).not.toContain('user:read');
  });

  it('비활성화된 운영자는 즉시 차단된다', async () => {
    const { accessToken } = await login(t.app, ADMIN.cs);
    await request(t.app)
      .patch(`/api/v1/admins/${await idOf(ADMIN.cs)}`)
      .set(bearer(superToken))
      .send({ status: 'DISABLED', reason: '퇴사 처리' })
      .expect(200);
    expect((await request(t.app).get('/api/v1/auth/me').set(bearer(accessToken))).status).toBe(401);
    const relogin = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.cs, password: 'Test-password-1234' });
    expect(relogin.status).toBe(401);
  });
});

describe('입력 검증', () => {
  it('사유가 짧으면 400', async () => {
    const res = await request(t.app)
      .patch(`/api/v1/admins/${await idOf(ADMIN.viewer)}`)
      .set(bearer(superToken))
      .send({ name: '새이름', reason: '짧음' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
