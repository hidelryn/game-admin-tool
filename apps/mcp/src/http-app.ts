import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpEnv } from './config.js';
import { authenticate, McpAuthError } from './auth.js';
import { buildServer } from './server.js';

const rpcError = (res: Response, status: number, message: string, code = -32001) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/** 서버 로그: 토큰·요청 본문은 남기지 않는다 */
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg, ...extra }));

/**
 * 원격 MCP (Streamable HTTP, stateless) — docs/mcp-tools.md 1.1
 * 요청마다: 토큰 확인 → 권한으로 Tool 을 거른 서버 생성 → 처리 → 정리
 */
export function createHttpApp(env: McpEnv, deps: { fetch?: typeof fetch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // DNS rebinding 방지: 허용한 Host 만, 브라우저 Origin 은 허용 목록만
  const hostGuard = (req: Request, res: Response, next: () => void) => {
    if (env.MCP_ALLOWED_HOSTS.length && !env.MCP_ALLOWED_HOSTS.includes(req.hostname)) {
      return rpcError(res, 403, '허용되지 않은 Host 입니다.');
    }
    const origin = req.header('origin');
    if (origin && !env.MCP_ALLOWED_ORIGINS.includes(origin)) {
      return rpcError(res, 403, '허용되지 않은 Origin 입니다.');
    }
    next();
  };

  app.post('/mcp', hostGuard, express.json({ limit: '1mb' }), async (req, res) => {
    const header = req.header('authorization');
    const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
    let ctx;
    try {
      ctx = await authenticate({
        baseUrl: env.GAME_ADMIN_API_URL,
        token,
        timeoutMs: env.MCP_API_TIMEOUT_MS,
        fetch: deps.fetch,
      });
    } catch (err) {
      if (err instanceof McpAuthError) {
        if (err.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        return rpcError(res, err.status, err.message);
      }
      log('auth failed', { err: (err as Error).message });
      return rpcError(res, 500, '내부 오류', -32603);
    }

    const server = buildServer({ api: ctx.api, permissions: ctx.permissions });
    // stateless: 세션 없음, SSE 대신 JSON 응답
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('mcp request failed', { err: (err as Error).message, adminId: ctx.me.id });
      if (!res.headersSent) rpcError(res, 500, '내부 오류', -32603);
    }
  });

  // stateless 라 서버 → 클라이언트 스트림(GET)·세션 종료(DELETE)는 없다
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, 'POST 만 지원합니다.', -32000);
  });

  return app;
}
