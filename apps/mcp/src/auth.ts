import { Channel, type MeResponse } from '@game-admin/shared';
import { ApiCallError, createApiClient, type ApiClient } from './api-client.js';

/** API 토큰 형식 (apps/api auth/tokens.ts: ga_<prefix 12 hex>_<secret 32 base64url>) */
const API_TOKEN = /^ga_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/;

export class McpAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 502,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 토큰 확인 + 권한 조회
 * - API 토큰(ga_...)만 받는다. 웹 로그인 토큰(JWT)은 거부 — WEB 채널로 인식되면 웹 전용 작업까지 열리기 때문
 * - API 가 토큰을 MCP 채널로 인식했는지 한 번 더 확인
 */
export async function authenticate(opts: {
  baseUrl: string;
  token: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Promise<{ api: ApiClient; permissions: ReadonlySet<string>; me: MeResponse }> {
  if (!opts.token) throw new McpAuthError(401, 'Authorization: Bearer <API 토큰> 이 필요합니다.');
  if (!API_TOKEN.test(opts.token)) {
    throw new McpAuthError(
      401,
      'API 토큰(ga_…)만 쓸 수 있습니다. 웹 백오피스 → API 토큰에서 발급하세요.',
    );
  }
  const api = createApiClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
  });
  let me: MeResponse;
  try {
    me = (await api.get<MeResponse>('/auth/me')).data;
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      throw new McpAuthError(401, '토큰이 없거나 만료·폐기되었습니다.');
    }
    throw new McpAuthError(502, 'API 서버에 연결할 수 없습니다.');
  }
  if (me.channel !== Channel.MCP) throw new McpAuthError(403, 'MCP 용 API 토큰이 아닙니다.');
  return { api, permissions: new Set(me.permissions), me };
}
