/**
 * API 서버 호출기 — MCP 서버가 가진 유일한 백엔드 접근 수단
 * - 운영자 API 토큰을 Bearer 로 그대로 전달 (MCP 는 토큰을 저장·로그하지 않음)
 * - 에러 응답은 { code, message, details } 그대로 ApiCallError 로
 */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface ApiResult<T> {
  status: number;
  data: T;
  meta?: Record<string, unknown>;
}

export type Query = Record<string, string | number | boolean | Date | undefined | null>;

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<ApiResult<T>>;
  post<T>(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<ApiResult<T>>;
}

function queryString(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ApiClient {
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1`;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { query?: Query; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

    let res: Response;
    try {
      res = await doFetch(`${base}${path}${queryString(init.query)}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError';
      throw new ApiCallError(
        503,
        'API_UNAVAILABLE',
        timeout ? 'API 서버 응답이 늦어 중단했습니다.' : 'API 서버에 연결할 수 없습니다.',
      );
    }

    if (res.status === 204) return { status: 204, data: undefined as T };
    const json = (await res.json().catch(() => null)) as {
      data?: T;
      meta?: Record<string, unknown>;
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    if (!res.ok) {
      throw new ApiCallError(
        res.status,
        json?.error?.code ?? 'UPSTREAM_ERROR',
        json?.error?.message ?? `API 오류 (${res.status})`,
        json?.error?.details,
      );
    }
    return { status: res.status, data: json?.data as T, meta: json?.meta };
  }

  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body, o = {}) => call('POST', path, { body, idempotencyKey: o.idempotencyKey }),
  };
}

/** 경로 조각 인코딩 (회원 ID 등) */
export const seg = (v: string | number) => encodeURIComponent(String(v));
