import type { ErrorCode } from './error-codes.js';

/** 성공 응답 (api-specification.md 1.1) */
export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}

export interface PageMeta {
  page?: number;
  size?: number;
  total?: number;
  nextCursor?: string | null;
}

/** 실패 응답 */
export interface ApiFailure {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
