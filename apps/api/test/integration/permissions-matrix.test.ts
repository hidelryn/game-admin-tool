import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Permission, TOKEN_FORBIDDEN_PERMISSIONS, type RoleCode } from '@game-admin/shared';
import { DEFAULT_ROLE_PERMISSIONS } from '../../src/infra/db/seed/core.js';
import { ADMIN, bearer, createTestContext, idem, login, type TestContext } from './helpers.js';

/**
 * 권한 매트릭스 (architecture.md 4.3)
 * 모든 보호된 API 를 역할 4개로 호출해서, 권한이 있으면 403 이 아니고 없으면 403 PERMISSION_DENIED 인지 확인한다.
 * - 권한 검사는 입력 검증보다 앞이므로, 빈 본문·없는 id 로 불러도 판정할 수 있다 (실제 변경은 일어나지 않음)
 * - 기대값은 시드의 역할-권한 표(DEFAULT_ROLE_PERMISSIONS)에서 계산 → 표나 라우터가 바뀌면 여기서 걸린다
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const UUID = '00000000-0000-4000-8000-000000000000';

/** [메서드, 경로, 필요한 권한] — null = 로그인만 필요 */
const ROUTES: [Method, string, Permission | null][] = [
  // 운영자·역할
  ['get', '/admins', Permission.ADMIN_MANAGE],
  ['post', '/admins', Permission.ADMIN_MANAGE],
  ['get', '/admins/999999', Permission.ADMIN_MANAGE],
  ['patch', '/admins/999999', Permission.ADMIN_MANAGE],
  ['put', '/admins/999999/permission-overrides', Permission.ADMIN_MANAGE],
  ['post', '/admins/999999/reset-password', Permission.ADMIN_MANAGE],
  ['get', '/admins/999999/api-tokens', Permission.ADMIN_MANAGE],
  ['delete', '/admins/999999/api-tokens/999999', Permission.ADMIN_MANAGE],
  ['get', '/roles', Permission.ADMIN_MANAGE],
  ['get', '/permissions', Permission.ADMIN_MANAGE],
  // 내 API 토큰
  ['get', '/me/api-tokens', Permission.TOKEN_MANAGE_OWN],
  ['post', '/me/api-tokens', Permission.TOKEN_MANAGE_OWN],
  ['delete', '/me/api-tokens/999999', Permission.TOKEN_MANAGE_OWN],
  // 회원
  ['get', '/users', Permission.USER_READ],
  ['get', '/users/U_NONE', Permission.USER_READ],
  ['get', '/users/U_NONE/pii', Permission.USER_READ_PII],
  ['get', '/users/U_NONE/activities', Permission.USER_READ],
  ['get', '/users/U_NONE/suspensions', Permission.USER_READ],
  ['post', '/users/U_NONE/suspend', Permission.USER_SUSPEND],
  ['post', '/users/U_NONE/unsuspend', Permission.USER_SUSPEND],
  // 재화
  ['get', '/currencies', Permission.CURRENCY_READ],
  ['get', '/users/U_NONE/currencies', Permission.CURRENCY_READ],
  ['get', '/users/U_NONE/currency-transactions', Permission.CURRENCY_READ],
  ['get', '/currency-transactions', Permission.CURRENCY_READ],
  ['post', '/users/U_NONE/currencies/grant', Permission.CURRENCY_GRANT],
  ['post', '/users/U_NONE/currencies/deduct', Permission.CURRENCY_DEDUCT],
  ['post', '/currencies/bulk-grant', Permission.CURRENCY_GRANT],
  // 우편
  ['get', '/items', Permission.MAIL_READ],
  ['get', '/mails', Permission.MAIL_READ],
  ['get', '/mails/999999', Permission.MAIL_READ],
  ['get', '/mails/999999/recipients', Permission.MAIL_READ],
  ['get', '/users/U_NONE/mails', Permission.MAIL_READ],
  ['post', '/mails', Permission.MAIL_SEND],
  ['post', '/mails/global', Permission.MAIL_SEND_ALL],
  ['post', '/mails/999999/cancel', Permission.MAIL_SEND],
  // 랭킹
  ['get', '/ranking-boards', null],
  ['get', '/ranking-seasons', Permission.RANKING_READ],
  ['get', '/ranking-seasons/1/rankings', Permission.RANKING_READ],
  ['get', '/ranking-seasons/1/rankings/users/U_NONE', Permission.RANKING_READ],
  ['get', '/ranking-seasons/1/snapshots', Permission.RANKING_READ],
  ['get', `/ranking-seasons/1/snapshots/${UUID}`, Permission.RANKING_READ],
  ['get', `/ranking-seasons/1/snapshots/${UUID}/export`, Permission.RANKING_READ],
  ['post', '/ranking-seasons/1/rebuild', Permission.RANKING_MANAGE],
  ['post', '/ranking-seasons/1/reset', Permission.RANKING_MANAGE],
  ['post', '/ranking-seasons/1/restore', Permission.RANKING_MANAGE],
  ['post', '/ranking-seasons/1/rewards', Permission.RANKING_MANAGE],
  // 이메일
  ['get', '/emails', Permission.EMAIL_READ],
  ['get', '/emails/limits', Permission.EMAIL_READ],
  ['get', '/emails/999999', Permission.EMAIL_READ],
  ['get', '/emails/999999/deliveries', Permission.EMAIL_READ],
  ['post', '/emails/preview', Permission.EMAIL_SEND],
  ['post', '/emails/render', Permission.EMAIL_SEND],
  ['post', '/emails', Permission.EMAIL_SEND],
  ['post', '/emails/999999/cancel', Permission.EMAIL_SEND],
  // 유저 분석
  ['get', '/analytics/churn', Permission.ANALYTICS_READ],
  ['get', '/analytics/retention', Permission.ANALYTICS_READ],
  ['get', '/analytics/purchases', Permission.ANALYTICS_READ],
  ['get', '/analytics/spending', Permission.ANALYTICS_READ],
  // 스케줄·이미지
  ['get', '/schedules', Permission.SCHEDULE_READ],
  ['get', '/schedules/999999', Permission.SCHEDULE_READ],
  ['post', '/schedules', Permission.SCHEDULE_MANAGE],
  ['put', '/schedules/999999', Permission.SCHEDULE_MANAGE],
  ['post', '/schedules/999999/cancel', Permission.SCHEDULE_MANAGE],
  ['post', '/schedules/999999/end-now', Permission.SCHEDULE_MANAGE],
  ['post', '/assets', Permission.SCHEDULE_MANAGE],
  ['get', '/assets/999999', Permission.SCHEDULE_READ],
  // 점검·공지
  ['get', '/maintenances/current', null],
  ['get', '/maintenances', Permission.NOTICE_READ],
  ['get', '/maintenances/999999', Permission.NOTICE_READ],
  ['post', '/maintenances', Permission.MAINTENANCE_MANAGE],
  ['put', '/maintenances/999999', Permission.MAINTENANCE_MANAGE],
  ['post', '/maintenances/999999/cancel', Permission.MAINTENANCE_MANAGE],
  ['post', '/maintenances/999999/open-now', Permission.MAINTENANCE_MANAGE],
  ['get', '/notices', Permission.NOTICE_READ],
  ['get', '/notices/999999', Permission.NOTICE_READ],
  ['post', '/notices', Permission.NOTICE_MANAGE],
  ['put', '/notices/999999', Permission.NOTICE_MANAGE],
  ['post', '/notices/999999/hide', Permission.NOTICE_MANAGE],
  // 운영 로그·대시보드
  ['get', '/audit-logs', Permission.AUDIT_READ],
  ['get', '/audit-logs/999999', Permission.AUDIT_READ],
  ['get', '/dashboard/summary', Permission.DASHBOARD_READ],
  ['get', '/dashboard/trends', Permission.DASHBOARD_READ],
  ['get', '/dashboard/currency-flows', Permission.DASHBOARD_READ],
];

const ROLE_EMAIL: Record<RoleCode, string> = {
  SUPER_ADMIN: ADMIN.super,
  OPERATOR: ADMIN.operator,
  CS: ADMIN.cs,
  VIEWER: ADMIN.viewer,
};

let t: TestContext;
const tokens = {} as Record<RoleCode, string>;

beforeAll(async () => {
  t = await createTestContext();
  await t.reset();
  for (const role of Object.keys(ROLE_EMAIL) as RoleCode[]) {
    tokens[role] = (await login(t.app, ROLE_EMAIL[role])).accessToken;
  }
});
afterAll(async () => {
  await t.close();
});

const call = (method: Method, path: string, token: string) => {
  const r = request(t.app)[method](`/api/v1${path}`).set(bearer(token));
  return method === 'get' || method === 'delete' ? r : r.set(idem()).send({});
};

describe('권한 매트릭스: 역할 × API', () => {
  const cases = ROUTES.flatMap(([method, path, perm]) =>
    (Object.keys(ROLE_EMAIL) as RoleCode[]).map((role) => ({
      role,
      method,
      path,
      perm,
      allowed: perm === null || DEFAULT_ROLE_PERMISSIONS[role].includes(perm),
    })),
  );

  it.each(cases)('$role $method $path → 허용=$allowed', async ({ role, method, path, allowed }) => {
    const res = await call(method, path, tokens[role]);
    if (allowed) {
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('인증 없이는 모두 401', async () => {
    for (const [method, path] of ROUTES) {
      const r = request(t.app)[method](`/api/v1${path}`);
      const res = await (method === 'get' || method === 'delete' ? r : r.send({}));
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('최고 관리자는 모든 권한을 가진다', () => {
    expect([...DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual(
      [...Object.values(Permission)].sort(),
    );
  });
});

describe('API 토큰(MCP) 권한 범위', () => {
  it('토큰에 준 권한만 통하고, 토큰 관리는 웹에서만', async () => {
    const created = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ name: 'matrix', permissions: [Permission.USER_READ] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const token = created.body.data.token as string;

    expect((await call('get', '/users', token)).status).toBe(200);
    expect((await call('get', '/currencies', token)).status).toBe(403); // 역할엔 있지만 토큰엔 없음
    const tokenMgmt = await call('get', '/me/api-tokens', token);
    expect(tokenMgmt.status).toBe(403);
    expect(tokenMgmt.body.error.code).toBe('CHANNEL_NOT_ALLOWED');
  });

  it.each(TOKEN_FORBIDDEN_PERMISSIONS.map((p) => [p]))(
    '토큰 금지 권한 %s 은 발급 단계에서 거부',
    async (perm) => {
      const res = await request(t.app)
        .post('/api/v1/me/api-tokens')
        .set(bearer(tokens.SUPER_ADMIN))
        .send({ name: 'forbidden', permissions: [perm] });
      expect(res.status).not.toBe(201);
    },
  );
});
