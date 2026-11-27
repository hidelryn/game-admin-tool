import type { ApiFailure, PageMeta } from '@game-admin/shared';

/** 서버 에러 응답을 그대로 담는 예외 (code 로 분기) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface ApiResult<T> {
  data: T;
  meta?: PageMeta & Record<string, unknown>;
  status: number;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * Access Token 은 메모리에만 둔다 (localStorage 금지 — architecture.md 4.1).
 * 새로고침하면 사라지고, httpOnly refresh 쿠키로 다시 발급받는다.
 */
let accessToken: string | null = null;
const endListeners = new Set<() => void>();

export const session = {
  get token() {
    return accessToken;
  },
  set(token: string | null) {
    accessToken = token;
  },
  /** 세션이 끝났을 때(갱신 실패) 알림 → 로그인 화면으로 */
  onEnd(listener: () => void) {
    endListeners.add(listener);
    return () => endListeners.delete(listener);
  },
  end() {
    accessToken = null;
    endListeners.forEach((l) => l());
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * refresh 는 동시에 여러 요청이 401 을 받아도 한 번만 (single-flight).
 * 다른 탭이 먼저 갱신한 경우(TOKEN_EXPIRED) 새 쿠키로 한 번 더 시도한다.
 */
let refreshing: Promise<boolean> | null = null;
export function refreshAccessToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.ok) {
          accessToken = ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
          return true;
        }
        const body = (await res.json().catch(() => null)) as ApiFailure | null;
        if (body?.error.code !== 'TOKEN_EXPIRED') return false;
        await sleep(300);
      }
      return false;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

function toQueryString(query?: Record<string, unknown>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const NO_REFRESH = ['/auth/login', '/auth/refresh', '/auth/logout'];

export async function apiRequest<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
  retry = true,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  // 쿠키 인증 엔드포인트의 CSRF 방어 헤더
  if (path.startsWith('/auth/')) headers['X-Requested-With'] = 'XMLHttpRequest';

  const res = await fetch(`/api/v1${path}${toQueryString(opts.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return { data: undefined as T, status: 204 };

  const json = (await res.json().catch(() => null)) as
    ({ data: T; meta?: ApiResult<T>['meta'] } & Partial<ApiFailure>) | null;
  if (res.ok && json) return { data: json.data, meta: json.meta, status: res.status };

  if (res.status === 401 && retry && !NO_REFRESH.includes(path)) {
    if (await refreshAccessToken()) return apiRequest<T>(method, path, opts, false);
    session.end();
  }
  const err = json?.error;
  throw new ApiError(
    res.status,
    err?.code ?? `HTTP_${res.status}`,
    err?.message ?? `요청에 실패했습니다 (${res.status})`,
    err?.details,
    err?.requestId,
  );
}

/**
 * 파일 다운로드 (CSV 등) — 인증 헤더를 붙여 받은 뒤 브라우저 저장
 * 토큰 만료면 한 번 갱신 후 재시도, 실패 응답(JSON)은 ApiError 로
 */
export async function downloadFile(
  path: string,
  fallbackName: string,
  retry = true,
): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    credentials: 'include',
  });
  if (res.status === 401 && retry && (await refreshAccessToken()))
    return downloadFile(path, fallbackName, false);
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as Partial<ApiFailure> | null;
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `다운로드에 실패했습니다 (${res.status})`,
      err?.details,
      err?.requestId,
    );
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 파일 업로드 — 본문에 파일 바이트를 그대로 보낸다(멀티파트 아님). 원래 이름은 X-File-Name
 * 토큰 만료면 한 번 갱신 후 재시도
 */
export async function uploadFile<T>(path: string, file: File, retry = true): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    credentials: 'include',
    body: file,
  });
  if (res.status === 401 && retry && (await refreshAccessToken()))
    return uploadFile<T>(path, file, false);
  const json = (await res.json().catch(() => null)) as ({ data: T } & Partial<ApiFailure>) | null;
  if (res.ok && json) return json.data;
  const err = json?.error;
  throw new ApiError(
    res.status,
    err?.code ?? `HTTP_${res.status}`,
    err?.message ??
      (res.status === 413 ? '파일이 너무 큽니다.' : `업로드에 실패했습니다 (${res.status})`),
    err?.details,
    err?.requestId,
  );
}

/**
 * 줄 단위 JSON(NDJSON) 스트리밍 POST — AI 어시스턴트 진행 상황 수신용
 * 스트리밍 시작 전 오류(권한·한도)는 일반 JSON 오류라 ApiError 로 던진다
 */
export async function postStream<E>(
  path: string,
  body: unknown,
  onEvent: (e: E) => void,
  signal?: AbortSignal,
  retry = true,
): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401 && retry && (await refreshAccessToken()))
    return postStream(path, body, onEvent, signal, false);
  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => null)) as Partial<ApiFailure> | null;
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `요청에 실패했습니다 (${res.status})`,
      err?.details,
      err?.requestId,
    );
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as E);
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>) => apiRequest<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) =>
    apiRequest<T>('POST', path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body }),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>('DELETE', path, { body }),
};
