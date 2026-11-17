import { ErrorCode } from '@game-admin/shared';

/**
 * 애플리케이션 예외의 기반 클래스 (architecture.md 7.1)
 * - expose=true 인 메시지만 클라이언트에 그대로 전달된다.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly expose = true,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown, message = '요청 값이 올바르지 않습니다.') {
    super(400, ErrorCode.VALIDATION_FAILED, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code: ErrorCode = ErrorCode.AUTH_REQUIRED, message = '인증이 필요합니다.') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code: ErrorCode = ErrorCode.PERMISSION_DENIED, message = '권한이 없습니다.') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(code: ErrorCode = ErrorCode.NOT_FOUND, message = '대상을 찾을 수 없습니다.') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

export class BusinessRuleError extends AppError {
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    code: ErrorCode = ErrorCode.SERVICE_UNAVAILABLE,
    message = '일시적으로 사용할 수 없습니다.',
  ) {
    super(503, code, message);
  }
}
