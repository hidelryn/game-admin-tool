import type { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE = 'ga_rt';
const COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(
  res: Response,
  token: string,
  opts: { secure: boolean; maxAgeDays: number },
) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(opts.secure, opts.maxAgeDays * 86_400_000));
}

export function clearRefreshCookie(res: Response, secure: boolean) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(secure));
}

function cookieOptions(secure: boolean, maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

/** refresh 쿠키 하나만 필요하므로 cookie-parser 없이 직접 읽는다 */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === REFRESH_COOKIE) {
      const value = part.slice(idx + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
    }
  }
  return null;
}
