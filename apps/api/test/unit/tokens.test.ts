import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  createTokenService,
  generateApiToken,
  parseApiToken,
  safeEqualHex,
  sha256,
} from '../../src/modules/auth/tokens.js';
import { AppError } from '../../src/common/errors/app-error.js';

const secret = 's'.repeat(48);

describe('access token', () => {
  const svc = createTokenService({ secret, accessTtlSec: 900 });

  it('발급한 토큰을 검증하면 클레임이 돌아온다', async () => {
    const { token, jti } = await svc.signAccess({
      adminId: 7,
      roleCode: 'OPERATOR',
      permVersion: 3,
    });
    const claims = await svc.verifyAccess(token);
    expect(claims).toMatchObject({ adminId: 7, permVersion: 3, jti });
  });

  it('만료된 토큰은 TOKEN_EXPIRED', async () => {
    const expired = createTokenService({ secret, accessTtlSec: -10 });
    const { token } = await expired.signAccess({ adminId: 1, roleCode: 'VIEWER', permVersion: 1 });
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
  });

  it('다른 키로 서명된 토큰은 거부', async () => {
    const other = createTokenService({ secret: 'o'.repeat(48), accessTtlSec: 900 });
    const { token } = await other.signAccess({ adminId: 1, roleCode: 'VIEWER', permVersion: 1 });
    await expect(svc.verifyAccess(token)).rejects.toBeInstanceOf(AppError);
  });

  it('alg=none 토큰은 거부 (알고리즘 고정)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '1', pv: 1, jti: 'x', exp: 9999999999 }),
    ).toString('base64url');
    await expect(svc.verifyAccess(`${header}.${payload}.`)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('필수 클레임이 없으면 거부', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('game-admin')
      .setAudience('game-admin-web')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    await expect(svc.verifyAccess(token)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});

describe('api token', () => {
  it('생성한 토큰을 파싱하면 prefix 와 secret 해시가 일치한다', () => {
    for (let i = 0; i < 50; i++) {
      const { token, prefix, secretHash } = generateApiToken();
      const parsed = parseApiToken(token);
      expect(parsed?.prefix).toBe(prefix);
      expect(sha256(parsed!.secret)).toBe(secretHash);
    }
  });

  it('형식이 다르면 null', () => {
    expect(parseApiToken('ga_xyz_abc')).toBeNull();
    expect(parseApiToken('eyJhbGciOi.payload.sig')).toBeNull();
  });

  it('safeEqualHex', () => {
    expect(safeEqualHex(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqualHex(sha256('a'), sha256('b'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
