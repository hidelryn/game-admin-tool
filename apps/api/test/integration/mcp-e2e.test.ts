import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Permission } from '@game-admin/shared';
import { auditLogs, currencyTransactions, mails } from '../../src/infra/db/schema/index.js';
// MCP 서버 코드를 그대로 가져와 실제 API 에 붙인다 (MCP 는 API 만 호출 — DB 직접 접근 없음)
import { authenticate, McpAuthError } from '../../../mcp/src/auth.js';
import { buildServer } from '../../../mcp/src/server.js';
import {
  ADMIN,
  CURRENCY,
  bearer,
  createTestContext,
  createUser,
  getBalance,
  login,
  type TestContext,
} from './helpers.js';

/**
 * MCP 끝-끝: AI 클라이언트(SDK Client) → MCP 서버 → 실제 API → MySQL·Redis
 * 가짜 API 로 본 apps/mcp 테스트와 달리, 권한·확인 토큰·웹 전용·감사 로그가 실제 서버 규칙대로 동작하는지 본다.
 */
let t: TestContext;
let http: Server;
let baseUrl: string;
let client: Client;
let token: string;

const PERMS = [
  Permission.USER_READ,
  Permission.CURRENCY_READ,
  Permission.CURRENCY_GRANT,
  Permission.CURRENCY_DEDUCT,
  Permission.MAIL_SEND,
  Permission.MAIL_SEND_ALL,
];

beforeAll(async () => {
  t = await createTestContext();
  http = t.app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await client?.close();
  http.close();
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  await client?.close();
  const superToken = (await login(t.app, ADMIN.super)).accessToken;
  const created = await request(t.app)
    .post('/api/v1/me/api-tokens')
    .set(bearer(superToken))
    .send({ name: 'mcp-e2e', permissions: PERMS });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  token = created.body.data.token;

  const ctx = await authenticate({ baseUrl, token, timeoutMs: 5_000 });
  const server = buildServer({ api: ctx.api, permissions: ctx.permissions });
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await Promise.all([server.connect(s), client.connect(c)]);
});

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;

describe('MCP → 실제 API', () => {
  it('토큰 권한에 맞는 Tool 만 보인다', async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('grant_currency');
    expect(names).toContain('send_mail');
    expect(names).not.toContain('get_ranking'); // ranking:read 없음
    expect(names).not.toContain('create_notice');
  });

  it('지급은 바로 실행되고, 운영 로그에 MCP 채널·토큰 id 로 남는다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await call('grant_currency', {
      publicId: u.publicId,
      currencyCode: 'GOLD',
      amount: 300,
      reason: 'MCP 끝-끝 지급',
      idempotencyKey: randomUUID(),
    });
    expect(res.structuredContent).toMatchObject({ status: 'EXECUTED', balanceAfter: 300 });
    const [log] = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'CURRENCY_GRANT'), eq(auditLogs.targetId, u.publicId)));
    expect(log).toMatchObject({ channel: 'MCP', result: 'SUCCESS' });
    expect(log!.apiTokenId).not.toBeNull();
  });

  it('같은 idempotencyKey 로 다시 불러도 한 번만 지급', async () => {
    const u = await createUser(t.ctx.db.db);
    const args = {
      publicId: u.publicId,
      currencyCode: 'GOLD',
      amount: 50,
      reason: 'MCP 재시도 테스트',
      idempotencyKey: randomUUID(),
    };
    await call('grant_currency', args);
    const again = await call('grant_currency', args);
    expect(again.structuredContent).toMatchObject({ status: 'EXECUTED' });
    const ledger = await t.ctx.db.db
      .select()
      .from(currencyTransactions)
      .where(eq(currencyTransactions.userId, u.id));
    expect(ledger).toHaveLength(1);
  });

  it('유료 재화(GEM)는 MCP 에서 항상 확인 → 토큰으로 다시 부르면 실행', async () => {
    const u = await createUser(t.ctx.db.db);
    const args = {
      publicId: u.publicId,
      currencyCode: 'GEM',
      amount: 10,
      reason: 'MCP 유료 재화 지급',
      idempotencyKey: randomUUID(),
    };
    const first = await call('grant_currency', args);
    expect(first.structuredContent).toMatchObject({ status: 'CONFIRMATION_REQUIRED' });
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(0);

    const second = await call('grant_currency', {
      ...args,
      confirmationToken: first.structuredContent!.confirmationToken,
    });
    expect(second.structuredContent).toMatchObject({ status: 'EXECUTED' });
    expect(await getBalance(t.ctx.db.db, u.id, CURRENCY.GEM)).toBe(10);
  });

  it('100명 대량 지급은 WEB_ONLY — 아무도 지급되지 않는다', async () => {
    const list = await Promise.all(Array.from({ length: 100 }, () => createUser(t.ctx.db.db)));
    const res = await call('bulk_grant_currency', {
      publicIds: list.map((u) => u.publicId),
      currencyCode: 'GOLD',
      amount: 10,
      reason: 'MCP 대량 지급 시도',
      idempotencyKey: randomUUID(),
    });
    expect(res.structuredContent).toMatchObject({
      status: 'WEB_ONLY',
      preview: { action: 'CURRENCY_BULK_GRANT' },
    });
    expect(await t.ctx.db.db.select().from(currencyTransactions)).toHaveLength(0);
  });

  it('전체 우편은 WEB_ONLY — 우편이 만들어지지 않는다', async () => {
    const res = await call('send_mail', {
      target: { type: 'ALL' },
      title: '보상',
      body: '감사합니다',
      reason: 'MCP 전체 우편 시도',
      idempotencyKey: randomUUID(),
    });
    expect(res.structuredContent).toMatchObject({ status: 'WEB_ONLY', webPath: '/mails/new' });
    expect(await t.ctx.db.db.select().from(mails)).toHaveLength(0);
  });

  it('없는 회원은 API 에러 코드 그대로', async () => {
    const res = await call('get_user_currency', { publicId: 'U_GHOST' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('MCP 토큰 확인 (실제 API)', () => {
  it('웹 로그인 토큰(JWT)은 MCP 에서 거부', async () => {
    const jwt = (await login(t.app, ADMIN.operator)).accessToken;
    await expect(authenticate({ baseUrl, token: jwt, timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      McpAuthError,
    );
  });

  it('폐기한 토큰은 다음 요청부터 거부', async () => {
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const list = await request(t.app).get('/api/v1/me/api-tokens').set(bearer(superToken));
    const id = list.body.data[0].id;
    await request(t.app).delete(`/api/v1/me/api-tokens/${id}`).set(bearer(superToken)).expect(204);
    await expect(authenticate({ baseUrl, token, timeoutMs: 5_000 })).rejects.toMatchObject({
      status: 401,
    });
  });
});
