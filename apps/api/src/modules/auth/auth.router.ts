import { Router, type Request, type RequestHandler } from 'express';
import {
  changePasswordRequestSchema,
  ErrorCode,
  loginRequestSchema,
  type LoginResponse,
} from '@game-admin/shared';
import type { Env } from '../../config/env.js';
import { auditContextOf } from '../audit/audit.writer.js';
import type { AuthService, ClientMeta } from './auth.service.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookies.js';
import { requireCsrfHeader } from './auth.middleware.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const metaOf = (req: Request): ClientMeta => ({
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

export function authRouter(deps: {
  authService: AuthService;
  authenticate: RequestHandler;
  env: Env;
  loginRateLimit: RequestHandler;
}): Router {
  const { authService, authenticate, env, loginRateLimit } = deps;
  const router = Router();
  const cookie = { secure: env.COOKIE_SECURE, maxAgeDays: env.REFRESH_TOKEN_TTL_DAYS };

  router.post('/login', loginRateLimit, async (req, res) => {
    const input = loginRequestSchema.parse(req.body);
    const { refreshToken, ...result } = await authService.login(
      input,
      metaOf(req),
      auditContextOf(req),
    );
    setRefreshCookie(res, refreshToken, cookie);
    const body: { data: LoginResponse } = { data: result };
    res.json(body);
  });

  router.post('/refresh', requireCsrfHeader, async (req, res) => {
    const raw = readRefreshCookie(req);
    if (!raw) throw new UnauthorizedError();
    try {
      const { refreshToken, ...result } = await authService.refresh(
        raw,
        metaOf(req),
        auditContextOf(req),
      );
      setRefreshCookie(res, refreshToken, cookie);
      res.json({ data: result });
    } catch (err) {
      // 세션 자체가 끝난 경우에만 쿠키 제거 (동시 갱신으로 인한 일시 거절은 쿠키 유지)
      if (err instanceof UnauthorizedError && err.code === ErrorCode.AUTH_REQUIRED)
        clearRefreshCookie(res, cookie.secure);
      throw err;
    }
  });

  /** access token 이 만료됐어도 로그아웃할 수 있도록 인증은 선택 */
  router.post('/logout', requireCsrfHeader, async (req, res) => {
    if (req.header('authorization')) {
      try {
        await authenticate(req, res, () => undefined);
      } catch {
        // 만료·무효 access token 이면 refresh 쿠키만으로 로그아웃 처리 (의도된 무시)
        req.auth = undefined;
      }
    }
    await authService.logout(req.auth, readRefreshCookie(req), auditContextOf(req));
    clearRefreshCookie(res, cookie.secure);
    res.status(204).end();
  });

  router.get('/me', authenticate, async (req, res) => {
    res.json({ data: await authService.me(req.auth!) });
  });

  router.patch('/me/password', authenticate, async (req, res) => {
    const input = changePasswordRequestSchema.parse(req.body);
    await authService.changePassword(req.auth!, input, auditContextOf(req));
    clearRefreshCookie(res, cookie.secure);
    res.status(204).end();
  });

  return router;
}
