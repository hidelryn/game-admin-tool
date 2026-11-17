import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './config.js';
import { authenticate } from './auth.js';
import { buildServer } from './server.js';

/**
 * 로컬 MCP (stdio) — MCP Inspector·Claude Desktop 로컬 연결용
 * 토큰은 환경변수 GAME_ADMIN_API_TOKEN. stdout 은 MCP 메시지 전용이라 로그는 stderr 로만.
 */
const env = loadEnv();
try {
  const ctx = await authenticate({
    baseUrl: env.GAME_ADMIN_API_URL,
    token: env.GAME_ADMIN_API_TOKEN,
    timeoutMs: env.MCP_API_TIMEOUT_MS,
  });
  const server = buildServer({ api: ctx.api, permissions: ctx.permissions });
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] stdio 시작 — 운영자 ${ctx.me.name}, 권한 ${ctx.permissions.size}개`);
} catch (err) {
  console.error(`[mcp] 시작 실패: ${(err as Error).message}`);
  process.exit(1);
}
