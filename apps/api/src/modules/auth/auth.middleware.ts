import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import {
  AdminStatus,
  Channel,
  ErrorCode,
  TOKEN_ASSIGNABLE_PERMISSIONS,
  type Permission,
} from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/app-error.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import type { Executor } from '../../infra/db/types.js';
import { apiTokens } from '../../infra/db/schema/index.js';
import { loadEffectivePermissions } from '../admins/permissions.js';
import { findAdminById } from './admin.repository.js';
import type { AuthContext } from './auth-context.js';
import { blacklistKey } from './auth.service.js';
import { parseApiToken, safeEqualHex, sha256, type TokenService } from './tokens.js';

export interface AuthenticateDeps {
  db: Executor;
  redis: RedisHandle;
  tokens: TokenService;
  logger: Logger;
}

const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Authorization: Bearer <JWT | ga_ API 토큰>
 * 매 요청마다 운영자 상태·권한을 DB 에서 다시 읽는다 → 비활성화/권한 회수가 즉시 반영된다.
 */
export function createAuthenticate(deps: AuthenticateDeps): RequestHandler {
  const { db, redis, tokens, logger } = deps;

  async function viaJwt(raw: string): Promise<AuthContext> {
    const claims = await tokens.verifyAccess(raw);
    if (await isBlacklisted(claims.jti)) {
      throw new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '로그아웃된 토큰입니다.');
    }
    const admin = await findAdminById(db, claims.adminId);
    if (!admin || admin.status !== AdminStatus.ACTIVE) throw new UnauthorizedError();
    if (admin.permVersion !== claims.permVersion) {
      // 권한·비밀번호가 바뀐 뒤 발급 전 토큰 → refresh 로 재발급 받도록 유도
      throw new UnauthorizedError(
        ErrorCode.TOKEN_EXPIRED,
        '권한 정보가 변경되었습니다. 토큰을 갱신하세요.',
      );
    }
    return {
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      roleCode: admin.roleCode,
      permissions: await loadEffectivePermissions(db, admin),
      channel: Channel.WEB,
      mustChangePassword: admin.mustChangePassword,
      apiTokenId: null,
      jti: claims.jti,
      tokenExp: claims.exp,
    };
  }

  async function viaApiToken(raw: string, ip: string | null): Promise<AuthContext> {
    const invalid = () =>
      new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '유효하지 않은 API 토큰입니다.');
    const parsed = parseApiToken(raw);
    if (!parsed) throw invalid();
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.prefix, parsed.prefix))
      .limit(1);
    if (!row || !safeEqualHex(row.secretHash, sha256(parsed.secret))) throw invalid();
    if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) throw invalid();

    const admin = await findAdminById(db, row.adminId);
    if (!admin || admin.status !== AdminStatus.ACTIVE) throw invalid();

    // 실효 권한 = 운영자 현재 권한 ∩ 토큰 권한 ∩ 토큰 허용 권한 → 운영자 권한이 줄면 토큰 권한도 즉시 줄어든다
    const adminPerms = await loadEffectivePermissions(db, admin);
    const tokenPerms = new Set(row.permissions);
    const permissions = new Set<Permission>(
      TOKEN_ASSIGNABLE_PERMISSIONS.filter((p) => adminPerms.has(p) && tokenPerms.has(p)),
    );

    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      void db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(), lastUsedIp: ip })
        .where(eq(apiTokens.id, row.id))
        .catch((err: Error) =>
          logger.warn({ err: err.message }, 'api token lastUsedAt update failed'),
        );
    }

    return {
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      roleCode: admin.roleCode,
      permissions,
      channel: Channel.MCP,
      mustChangePassword: admin.mustChangePassword,
      apiTokenId: row.id,
      jti: null,
      tokenExp: null,
    };
  }

  /** Redis 장애 시 fail-open: 로그아웃 토큰은 최대 access TTL 동안 유효할 수 있음 (경고 로그) */
  async function isBlacklisted(jti: string): Promise<boolean> {
    try {
      return (await redis.redis.exists(blacklistKey(jti))) === 1;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'blacklist check skipped (redis unavailable)');
      return false;
    }
  }

  return async (req, _res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
    if (!match) throw new UnauthorizedError();
    const raw = match[1]!;
    req.auth = raw.startsWith('ga_') ? await viaApiToken(raw, req.ip ?? null) : await viaJwt(raw);
    next();
  };
}

/** 모든 권한을 가져야 통과. 비밀번호 변경이 필요한 계정은 차단 */
export function requirePermission(...required: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) throw new UnauthorizedError();
    if (auth.mustChangePassword) {
      throw new ForbiddenError(
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
        '비밀번호를 변경한 뒤 이용할 수 있습니다.',
      );
    }
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (missing.length > 0)
      throw new ForbiddenError(
        ErrorCode.PERMISSION_DENIED,
        `권한이 없습니다: ${missing.join(', ')}`,
      );
    next();
  };
}

/** 특정 채널에서만 허용 (예: 토큰 발급은 WEB 에서만) */
export function requireChannel(channel: AuthContext['channel']): RequestHandler {
  return (req, _res, next) => {
    if (req.auth?.channel !== channel) {
      throw new ForbiddenError(
        ErrorCode.CHANNEL_NOT_ALLOWED,
        `${channel} 에서만 사용할 수 있는 기능입니다.`,
      );
    }
    next();
  };
}

/** 쿠키로 인증하는 엔드포인트(refresh/logout)의 CSRF 방어: 브라우저 폼으로는 붙일 수 없는 헤더 요구 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.header('x-requested-with') !== 'XMLHttpRequest') {
    throw new ForbiddenError(ErrorCode.CSRF_CHECK_FAILED, 'X-Requested-With 헤더가 필요합니다.');
  }
  next();
};
