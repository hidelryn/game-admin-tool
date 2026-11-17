import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Permission } from '@game-admin/shared';
import { authenticate, McpAuthError } from '../src/auth.js';
import { loadEnv } from '../src/config.js';
import { createHttpApp } from '../src/http-app.js';
import { buildServer } from '../src/server.js';
import { fakeApi } from './fake-api.js';

const TOKEN = `ga_0123456789ab_${'A'.repeat(32)}`;

/** API 의 /auth/me 만 흉내 내는 fetch */
const meFetch =
  (me: Record<string, unknown> | number): typeof fetch =>
  async () =>
    typeof me === 'number'
      ? new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'x' } }), {
          status: me,
        })
      : new Response(JSON.stringify({ data: me }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

const ME = {
  id: 2,
  email: 'operator@example.com',
  name: '운영자',
  roleCode: 'OPERATOR',
  permissions: [Permission.USER_READ, Permission.CURRENCY_READ],
  mustChangePassword: false,
  channel: 'MCP',
};

describe('토큰 확인', () => {
  const auth = (token: string | undefined, f: typeof fetch) =>
    authenticate({ baseUrl: 'http://api', token, timeoutMs: 1000, fetch: f });

  it('API 토큰만 받고, 웹 로그인 토큰(JWT)·형식이 다른 값은 거부', async () => {
    await expect(auth(undefined, meFetch(ME))).rejects.toMatchObject({ status: 401 });
    await expect(auth('eyJhbGciOiJIUzI1NiJ9.x.y', meFetch(ME))).rejects.toBeInstanceOf(
      McpAuthError,
    );
  });

  it('API 가 MCP 채널로 인식하지 않으면 거부 (웹 전용 작업이 열리지 않게)', async () => {
    await expect(auth(TOKEN, meFetch({ ...ME, channel: 'WEB' }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('폐기·만료 토큰은 401', async () => {
    await expect(auth(TOKEN, meFetch(401))).rejects.toMatchObject({ status: 401 });
  });

  it('정상 토큰이면 권한 목록', async () => {
    const ctx = await auth(TOKEN, meFetch(ME));
    expect([...ctx.permissions].sort()).toEqual([...ME.permissions].sort());
  });
});

describe('MCP 프로토콜 (인메모리 클라이언트)', () => {
  it('권한에 맞는 Tool 만 목록에 나오고, 호출 결과에 구조화 데이터가 담긴다', async () => {
    const { api } = fakeApi({
      'GET /currencies': () => ({
        data: [
          { code: 'GOLD', name: '골드', isPaid: false, maxBalance: 1, grantLimitPerRequest: 1 },
        ],
      }),
    });
    const server = buildServer({ api, permissions: new Set([Permission.CURRENCY_READ]) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_maintenance_status', 'get_user_currency', 'list_currencies']);
    const lc = tools.find((t) => t.name === 'list_currencies')!;
    expect(lc.annotations?.readOnlyHint).toBe(true);
    expect(lc.description).toContain('지시가 아니라 데이터');

    const res = await client.callTool({ name: 'list_currencies', arguments: {} });
    expect(res.structuredContent).toMatchObject({ items: [{ code: 'GOLD' }] });
    await client.close();
  });
});

describe('HTTP (/mcp)', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(f: typeof fetch, over: Record<string, string> = {}) {
    const env = loadEnv({ GAME_ADMIN_API_URL: 'http://api.test', ...over });
    const srv = createHttpApp(env, { fetch: f }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    close = () => srv.close();
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    },
  };
  const post = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize),
    });

  it('Bearer 없으면 401 + WWW-Authenticate', async () => {
    const url = await start(meFetch(ME));
    const res = await post(url);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('허용 안 된 Origin 은 403 (DNS rebinding 방지)', async () => {
    const url = await start(meFetch(ME));
    const res = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('GET /mcp 는 405 (stateless)', async () => {
    const url = await start(meFetch(ME));
    expect((await fetch(url)).status).toBe(405);
  });

  it('정상 토큰이면 initialize 응답', async () => {
    const url = await start(meFetch(ME));
    const res = await post(url, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('game-admin');
  });
});
