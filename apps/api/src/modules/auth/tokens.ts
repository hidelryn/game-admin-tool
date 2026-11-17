import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { ErrorCode } from '@game-admin/shared';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const ISSUER = 'game-admin';
const AUDIENCE = 'game-admin-web';

export interface AccessClaims {
  adminId: number;
  permVersion: number;
  jti: string;
  exp: number;
}

/**
 * Access Token = JWT(HS256). 서명 알고리즘을 고정해 alg 바꿔치기 공격을 막는다.
 */
export function createTokenService(opts: { secret: string; accessTtlSec: number }) {
  const key = new TextEncoder().encode(opts.secret);

  return {
    accessTtlSec: opts.accessTtlSec,

    async signAccess(c: { adminId: number; roleCode: string; permVersion: number }) {
      const jti = randomUUID();
      const exp = Math.floor(Date.now() / 1000) + opts.accessTtlSec;
      const token = await new SignJWT({ role: c.roleCode, pv: c.permVersion })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(String(c.adminId))
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(key);
      return { token, jti, exp };
    },

    async verifyAccess(token: string): Promise<AccessClaims> {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: ISSUER,
          audience: AUDIENCE,
        }));
      } catch (err) {
        if (err instanceof errors.JWTExpired) {
          throw new UnauthorizedError(ErrorCode.TOKEN_EXPIRED, '토큰이 만료되었습니다.');
        }
        throw new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '유효하지 않은 토큰입니다.');
      }
      const adminId = Number(payload.sub);
      const { pv, jti, exp } = payload;
      if (
        !Number.isSafeInteger(adminId) ||
        typeof pv !== 'number' ||
        typeof jti !== 'string' ||
        typeof exp !== 'number'
      ) {
        throw new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '유효하지 않은 토큰입니다.');
      }
      return { adminId, permVersion: pv, jti, exp };
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

/** Refresh Token: 256bit 랜덤 불투명 토큰 */
export const newRefreshToken = () => randomBytes(32).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * API 토큰 형식: ga_<prefix 12 hex>_<secret 32 base64url>
 * prefix 로 행을 찾고, secret 해시를 상수 시간 비교한다.
 */
const API_TOKEN_PATTERN = /^ga_([0-9a-f]{12})_([A-Za-z0-9_-]{32})$/;

export function generateApiToken() {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { token: `ga_${prefix}_${secret}`, prefix, secretHash: sha256(secret) };
}

export function parseApiToken(token: string): { prefix: string; secret: string } | null {
  const m = API_TOKEN_PATTERN.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}
