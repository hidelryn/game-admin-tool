import { ApiCallError, type ApiClient, type ApiResult, type Query } from '../src/api-client.js';

export interface Call {
  method: 'GET' | 'POST';
  path: string;
  query?: Query;
  body?: unknown;
  idempotencyKey?: string;
}

type Handler = (call: Call) => Partial<ApiResult<unknown>> | Promise<Partial<ApiResult<unknown>>>;

/**
 * 가짜 API: "METHOD /path" → 응답. 없는 경로는 404.
 * ApiCallError 를 던지면 그대로 에러 응답처럼 동작
 */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const handle = async <T>(call: Call): Promise<ApiResult<T>> => {
    calls.push(call);
    const h = routes[`${call.method} ${call.path}`];
    if (!h) throw new ApiCallError(404, 'NOT_FOUND', `no route: ${call.method} ${call.path}`);
    const r = await h(call);
    return { status: r.status ?? 200, data: r.data as T, meta: r.meta };
  };
  const api: ApiClient = {
    get: (path, query) => handle({ method: 'GET', path, query }),
    post: (path, body, opts = {}) =>
      handle({ method: 'POST', path, body, idempotencyKey: opts.idempotencyKey }),
  };
  return { api, calls };
}

export const apiError = (status: number, code: string, details?: unknown) => () => {
  throw new ApiCallError(status, code, `${code} 테스트`, details);
};

export const KEY = '7b0c6a52-3c1e-4d43-9d0e-2f6a1f7b9a11';

export const CURRENCIES = [
  {
    code: 'GOLD',
    name: '골드',
    isPaid: false,
    maxBalance: 999_999_999,
    grantLimitPerRequest: 1_000_000,
  },
  {
    code: 'GEM',
    name: '유료 젬',
    isPaid: true,
    maxBalance: 9_999_999,
    grantLimitPerRequest: 10_000,
  },
  {
    code: 'FREE_GEM',
    name: '무료 젬',
    isPaid: false,
    maxBalance: 9_999_999,
    grantLimitPerRequest: 10_000,
  },
];
