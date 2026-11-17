import { loadEnv } from './config.js';
import { createHttpApp } from './http-app.js';

/** 원격 MCP 서버 진입점: POST /mcp (Bearer API 토큰) */
const env = loadEnv();
const app = createHttpApp(env);
const server = app.listen(env.MCP_PORT, env.MCP_HOST, () => {
  console.error(
    `[mcp] http://${env.MCP_HOST}:${env.MCP_PORT}/mcp → API ${env.GAME_ADMIN_API_URL} (허용 Host: ${env.MCP_ALLOWED_HOSTS.join(', ') || '제한 없음'})`,
  );
});

function shutdown(signal: string) {
  console.error(`[mcp] ${signal} — 종료`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
