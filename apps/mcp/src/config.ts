import { z } from 'zod';

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );

/**
 * MCP 서버 환경변수 — DB·Redis 접속 정보는 없다 (architecture.md 1.1 A안)
 * 토큰은 원격(HTTP)에서는 요청 헤더로 받고, 로컬(stdio)에서만 환경변수로 받는다.
 */
const envSchema = z.object({
  /** API 서버 주소 (경로 /api/v1 은 자동으로 붙임) */
  GAME_ADMIN_API_URL: z.string().url().default('http://localhost:4000'),
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** 브라우저에서 오는 요청의 허용 Origin (비우면 Origin 헤더가 있는 요청은 모두 거부) */
  MCP_ALLOWED_ORIGINS: list(''),
  /** 허용 Host 헤더 (DNS rebinding 방지). 운영은 실제 도메인으로 */
  MCP_ALLOWED_HOSTS: list('localhost,127.0.0.1'),
  MCP_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** stdio(로컬) 전용 */
  GAME_ADMIN_API_TOKEN: z.string().optional(),
});

export type McpEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): McpEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`MCP 환경변수가 올바르지 않습니다: ${fields}`);
  }
  return parsed.data;
}
