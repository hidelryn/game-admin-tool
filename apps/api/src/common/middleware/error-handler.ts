import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ErrorCode, type ApiFailure } from '@game-admin/shared';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors/app-error.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError(ErrorCode.NOT_FOUND, '요청한 경로가 없습니다.'));
};

/**
 * 에러를 응답으로 바꾸는 유일한 지점 (architecture.md 7.2)
 * - 예상된 오류(AppError): warn, 메시지 노출
 * - 예상 못한 오류: error + stack 로그, 메시지 숨김
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const normalized = normalize(err);
  const log = req.log;

  if (normalized instanceof AppError && normalized.status < 500) {
    log?.warn({ err: { code: normalized.code, message: normalized.message } }, 'request failed');
  } else {
    log?.error({ err }, 'unhandled error');
  }

  if (res.headersSent) return;

  const body: ApiFailure = {
    error: {
      code: normalized.code,
      message: normalized.expose ? normalized.message : '서버 오류가 발생했습니다.',
      ...(normalized.expose && normalized.details !== undefined
        ? { details: normalized.details }
        : {}),
      requestId: String(req.id),
    },
  };
  res.status(normalized.status).json(body);
};

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new ValidationError(err.flatten());
  // 서비스에서 처리하지 못한 유니크 제약 위반 (동시 요청 경합 등)
  if (isDuplicateKeyError(err))
    return new ConflictError(ErrorCode.DUPLICATE_RESOURCE, '이미 존재하는 데이터입니다.');
  // express.json() 파싱 실패
  if (isBodyParseError(err))
    return new ValidationError(undefined, 'JSON 형식이 올바르지 않습니다.');
  // 본문 크기 초과 (업로드 등)
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, '요청 본문이 너무 큽니다.');
  }
  return new AppError(500, ErrorCode.INTERNAL_ERROR, 'Internal Server Error', undefined, false);
}

function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.parse.failed'
  );
}
