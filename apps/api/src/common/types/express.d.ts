import type { AuthContext } from '../../modules/auth/auth-context.js';

/**
 * Express Request 확장.
 * - auth: authenticate 미들웨어가 설정
 * - id 는 pino-http 가 IncomingMessage.id 로 이미 선언 (requestId 미들웨어가 항상 문자열로 설정)
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
