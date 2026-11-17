import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, inArray } from 'drizzle-orm';
import { loadEnv } from '../../src/config/env.js';
import { DEMO_TOKEN_ISSUE_PER_HOUR, DEMO_TOKEN_MAX_ACTIVE } from '@game-admin/shared';
import {
  admins,
  apiTokens,
  auditLogs,
  currencyTransactions,
  notices,
  users,
} from '../../src/infra/db/schema/index.js';
import { runDemoActivity } from '../../src/modules/demo/demo-activity.js';
import { generateApiToken } from '../../src/modules/auth/tokens.js';
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

  it('비밀번호 변경은 막힌다', async () => {
    const { accessToken } = await demoLogin();
    const pw = await request(t.app)
      .patch('/api/v1/auth/me/password')
      .set(bearer(accessToken))
      .set(CSRF)
      .send({ currentPassword: DEMO_PASSWORD, newPassword: 'hijacked12345' });
    expect(pw.status).toBe(403);
    expect(pw.body.error.code).toBe('DEMO_RESTRICTED');
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

describe('체험 계정 API 토큰 (MCP 체험)', () => {
  const issue = (accessToken: string, permissions: string[], name = 'visitor-mcp') =>
    request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(accessToken))
      .send({ name, permissions, expiresInDays: 30 });

  it('조회 권한만, 만료는 다음 초기화까지, 발급한 토큰으로 조회가 된다', async () => {
    const { accessToken } = await demoLogin();
    const write = await issue(accessToken, ['user:read', 'currency:grant']);
    expect(write.status).toBe(422);
    expect(write.body.error.code).toBe('TOKEN_PERMISSION_NOT_ALLOWED');

    const ok = await issue(accessToken, ['user:read']);
    expect(ok.status).toBe(201);
    expect(new Date(ok.body.data.expiresAt).getTime()).toBeLessThanOrEqual(nextResetAt().getTime());
    const list = await request(t.app).get('/api/v1/users').set(bearer(ok.body.data.token));
    expect(list.status).toBe(200);
  });

  it('발급은 IP 당 시간당 3회', async () => {
    const { accessToken } = await demoLogin();
    for (let i = 0; i < DEMO_TOKEN_ISSUE_PER_HOUR; i++) {
      expect((await issue(accessToken, ['user:read'], `v${i}-mcp`)).status).toBe(201);
    }
    const over = await issue(accessToken, ['user:read']);
    expect(over.status).toBe(429);
    // 다른 운영자는 이 제한을 받지 않는다
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    expect((await issue(op, ['user:read'])).status).toBe(201);
  });

  it('체험 계정 토큰은 동시에 20개까지', async () => {
    const [demo] = await t.ctx.db.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, DEMO_EMAIL));
    const future = new Date(Date.now() + 3_600_000);
    await t.ctx.db.db.insert(apiTokens).values(
      Array.from({ length: DEMO_TOKEN_MAX_ACTIVE }, (_, i) => {
        const { prefix, secretHash } = generateApiToken();
        return {
          adminId: demo!.id,
          name: `seeded-${i}`,
          prefix,
          secretHash,
          permissions: ['user:read'],
          expiresAt: future,
        };
      }),
    );
    const { accessToken } = await demoLogin();
    const res = await issue(accessToken, ['user:read']);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOKEN_LIMIT_EXCEEDED');
  });
});

describe('가상 활동 (worker demo-activity)', () => {
  it('활동 회원이 접속하고 재화를 얻어 대시보드 오늘 재화 흐름에 잡힌다', async () => {
    const created = await Promise.all(Array.from({ length: 5 }, () => createUser(t.ctx.db.db)));
    const r = await runDemoActivity({ db: t.ctx.db.db, ...t.services }, { users: 5 });
    expect(r.skipped).toBeUndefined();
    expect(r.users).toBe(5);
    expect(r.logins).toBe(5);
    expect(r.earned).toBeGreaterThanOrEqual(5); // 골드 획득은 매번
    expect(r.errors).toBe(0);

    const ids = created.map((u) => u.id);
    const ledger = await t.ctx.db.db
      .select({ userId: currencyTransactions.userId, source: currencyTransactions.source })
      .from(currencyTransactions)
      .where(inArray(currencyTransactions.userId, ids));
    expect(ledger.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ledger.map((l) => l.source))).toEqual(new Set(['GAME']));

    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const summary = await request(t.app).get('/api/v1/dashboard/summary').set(bearer(op));
    expect(summary.status).toBe(200);
    const gold = summary.body.data.today.currencies.find(
      (c: { currencyCode: string }) => c.currencyCode === 'GOLD',
    );
    expect(gold.issued).toBeGreaterThan(0);
    expect(summary.body.data.today.dau).toBeGreaterThanOrEqual(5);
  });

  it('점검 중이면 쉰다', async () => {
    const r = await runDemoActivity(
      {
        ...t.services,
        db: t.ctx.db.db,
        maintenanceService: {
          ...t.services.maintenanceService,
          state: async () => ({ ...(await t.services.maintenanceService.state()), active: true }),
        },
      },
      { users: 5 },
    );
    expect(r.skipped).toBe('maintenance');
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

    const demoAccess = (await demoLogin()).accessToken;
    await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(demoAccess))
      .send({ name: 'visitor-mcp', permissions: ['user:read'] })
      .expect(201);

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
    expect(r.demoTokens).toBe(1);
    expect(await t.ctx.db.db.select().from(apiTokens)).toHaveLength(0);

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
