import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../../src/config/env.js';
import { admins, auditLogs, notices, users } from '../../src/infra/db/schema/index.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import {
  ensureDemoAccount,
  nextResetAt,
  resetDemoData,
} from '../../src/modules/demo/demo.service.js';
import {
  ADMIN,
  CSRF,
  bearer,
  createTestContext,
  createUser,
  idem,
  login,
  type TestContext,
} from './helpers.js';

/** 체험 모드 (docs/demo-mode.md) */
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demoVisitor2026';
const hasher = createPasswordHasher({ memoryCost: 4096, timeCost: 2 });

let t: TestContext;
let plain: TestContext;

beforeAll(async () => {
  [t, plain] = await Promise.all([
    createTestContext({
      DEMO_MODE: 'true',
      DEMO_ACCOUNT_PASSWORD: DEMO_PASSWORD,
      DEMO_DAILY_RESET: 'true',
    }),
    createTestContext(),
  ]);
});
afterAll(async () => {
  await Promise.all([t.close(), plain.close()]);
});
beforeEach(async () => {
  await t.reset();
  await ensureDemoAccount({ db: t.ctx.db.db, env: t.ctx.env, hasher });
});

const demoLogin = () => login(t.app, DEMO_EMAIL, DEMO_PASSWORD);

describe('설정', () => {
  it('DEMO_MODE 인데 체험 비밀번호가 없거나 약하면 기동 실패', () => {
    const base = {
      MYSQL_HOST: 'x',
      MYSQL_DATABASE: 'x',
      MYSQL_USER: 'x',
      MYSQL_PASSWORD: 'x',
      REDIS_URL: 'redis://x:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
    };
    expect(() => loadEnv({ ...base, DEMO_MODE: 'true' })).toThrow();
    expect(() => loadEnv({ ...base, DEMO_MODE: 'true', DEMO_ACCOUNT_PASSWORD: 'short' })).toThrow();
    // 매일 초기화만 켜고 체험 모드는 끈 실수 → 기동 실패 (데이터 삭제 사고 방지)
    expect(() => loadEnv({ ...base, DEMO_DAILY_RESET: 'true' })).toThrow();
    expect(loadEnv(base).DEMO_MODE).toBe(false);
  });

  it('다음 초기화는 다음 04:00 KST', () => {
    expect(nextResetAt(new Date('2026-11-17T12:00:00Z')).toISOString()).toBe(
      '2026-11-17T19:00:00.000Z',
    );
    expect(nextResetAt(new Date('2026-11-17T18:59:00Z')).toISOString()).toBe(
      '2026-11-17T19:00:00.000Z',
    );
    expect(nextResetAt(new Date('2026-11-17T19:00:00Z')).toISOString()).toBe(
      '2026-11-18T19:00:00.000Z',
    );
  });
});

describe('로그인 화면 안내', () => {
  it('체험 모드면 계정·비밀번호·다음 초기화 시각을 공개', async () => {
    const res = await request(t.app).get('/api/v1/public/demo');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      enabled: true,
      accounts: [{ email: DEMO_EMAIL, password: DEMO_PASSWORD }],
    });
    expect(res.body.data.nextResetAt).toBeTruthy();
  });

  it('체험 모드가 꺼져 있으면 아무것도 공개하지 않는다', async () => {
    const res = await request(plain.app).get('/api/v1/public/demo');
    expect(res.body.data).toEqual({ enabled: false, accounts: [], nextResetAt: null });
  });
});

describe('체험 계정', () => {
  it('운영자 권한으로 로그인되고 isDemo 표시, 지급 같은 운영 작업은 된다', async () => {
    const { accessToken, body } = await demoLogin();
    expect(body.data.admin).toMatchObject({ roleCode: 'OPERATOR', isDemo: true });
    const u = await createUser(t.ctx.db.db);
    const res = await request(t.app)
      .post(`/api/v1/users/${u.publicId}/currencies/grant`)
      .set(bearer(accessToken))
      .set(idem())
      .send({ currencyCode: 'GOLD', amount: 100, reason: '체험 계정 지급 테스트' });
    expect(res.status).toBe(200);
  });

  it('다른 운영자는 isDemo=false', async () => {
    const { body } = await login(t.app, ADMIN.operator);
    expect(body.data.admin.isDemo).toBe(false);
  });

  it('비밀번호 변경·API 토큰 발급은 막힌다', async () => {
    const { accessToken } = await demoLogin();
    const pw = await request(t.app)
      .patch('/api/v1/auth/me/password')
      .set(bearer(accessToken))
      .set(CSRF)
      .send({ currentPassword: DEMO_PASSWORD, newPassword: 'hijacked12345' });
    expect(pw.status).toBe(403);
    expect(pw.body.error.code).toBe('DEMO_RESTRICTED');
    const tok = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(accessToken))
      .send({ name: 'demo-token', permissions: ['user:read'] });
    expect(tok.status).toBe(403);
    expect(tok.body.error.code).toBe('DEMO_RESTRICTED');
    // 여전히 원래 비밀번호로 로그인된다
    await demoLogin();
  });

  it('비밀번호를 여러 번 틀려도 잠기지 않는다 (다른 방문자 차단 방지)', async () => {
    for (let i = 0; i < 6; i++) {
      const bad = await request(t.app)
        .post('/api/v1/auth/login')
        .send({ email: DEMO_EMAIL, password: `wrongPassword${i}` });
      expect(bad.status).toBe(401);
    }
    await demoLogin();
    const [row] = await t.ctx.db.db.select().from(admins).where(eq(admins.email, DEMO_EMAIL));
    expect(row!.lockedUntil).toBeNull();
  });

  it('체험 모드가 꺼진 서버에서는 같은 이메일이라도 일반 계정처럼 취급', async () => {
    await plain.reset();
    await ensureDemoAccount({ db: plain.ctx.db.db, env: plain.ctx.env, hasher });
    const [row] = await plain.ctx.db.db.select().from(admins).where(eq(admins.email, DEMO_EMAIL));
    expect(row).toBeUndefined(); // DEMO_MODE 가 꺼져 있으면 만들지도 않는다
  });
});

describe('매일 초기화', () => {
  it('운영 데이터·Redis·업로드는 지우고 기준·가상 데이터는 다시, 운영자 계정은 유지', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    await request(t.app)
      .post('/api/v1/notices')
      .set(bearer(op))
      .set(idem())
      .send({
        category: 'NOTICE',
        title: '방문자가 올린 공지',
        body: '지워져야 함',
        startsAt: new Date().toISOString(),
        endsAt: null,
        pinned: false,
        tickerEnabled: false,
        tickerText: null,
        reason: '초기화 테스트 공지',
      })
      .expect(201);
    await t.ctx.assetStorage!.put('00000000-0000-4000-8000-000000000001.png', Buffer.from('x'));
    await t.ctx.redis.redis.set('demo-test-key', '1');
    const [opBefore] = await t.ctx.db.db
      .select({ id: admins.id, hash: admins.passwordHash })
      .from(admins)
      .where(eq(admins.email, ADMIN.operator));

    const r = await resetDemoData({
      db: t.ctx.db,
      redis: t.ctx.redis,
      env: t.ctx.env,
      logger: t.ctx.logger,
      storage: t.ctx.assetStorage!,
      hasher,
      scale: 'small',
    });
    expect(r.files).toBe(1);

    expect(await t.ctx.db.db.select().from(notices)).toHaveLength(0);
    expect((await t.ctx.db.db.select({ id: users.id }).from(users)).length).toBeGreaterThan(0);
    expect(await t.ctx.redis.redis.get('demo-test-key')).toBeNull();
    const [opAfter] = await t.ctx.db.db
      .select({ id: admins.id, hash: admins.passwordHash })
      .from(admins)
      .where(eq(admins.email, ADMIN.operator));
    expect(opAfter).toEqual(opBefore); // 운영자 계정·비밀번호 그대로
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'DEMO_RESET'), eq(auditLogs.channel, 'SYSTEM')));
    expect(logs).toHaveLength(1);
    // 기존 로그인 세션도 계속 동작, 체험 계정도 그대로
    expect((await request(t.app).get('/api/v1/users?status=ACTIVE').set(bearer(op))).status).toBe(
      200,
    );
    await demoLogin();
  }, 120_000);

  it('매일 초기화가 꺼진 서버에서는 실행을 거부한다', async () => {
    await expect(
      resetDemoData({
        db: plain.ctx.db,
        redis: plain.ctx.redis,
        env: plain.ctx.env,
        logger: plain.ctx.logger,
        storage: plain.ctx.assetStorage!,
        hasher,
      }),
    ).rejects.toThrow();
  });
});
