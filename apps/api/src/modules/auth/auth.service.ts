import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AdminStatus,
  AuditAction,
  AuditTargetType,
  ErrorCode,
  type ChangePasswordRequest,
  type LoginRequest,
  type MeResponse,
} from '@game-admin/shared';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../common/logger.js';
import { AppError, BusinessRuleError, UnauthorizedError } from '../../common/errors/app-error.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import { admins, refreshTokens } from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import { loadEffectivePermissions, sortedPermissions } from '../admins/permissions.js';
import {
  bumpPermVersion,
  findAdminByEmail,
  findAdminById,
  revokeAllRefreshTokens,
  revokeRefreshFamily,
  type AdminRecord,
} from './admin.repository.js';
import type { AuthContext } from './auth-context.js';
import type { PasswordHasher } from './password.js';
import { newRefreshToken, sha256, type TokenService } from './tokens.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface AuthServiceDeps {
  db: Executor;
  redis: RedisHandle;
  env: Env;
  logger: Logger;
  hasher: PasswordHasher;
  tokens: TokenService;
}

export const blacklistKey = (jti: string) => `auth:jti:${jti}`;

export function createAuthService(deps: AuthServiceDeps) {
  const { db, redis, env, logger, hasher, tokens } = deps;

  const invalidCredentials = () =>
    new UnauthorizedError(
      ErrorCode.INVALID_CREDENTIALS,
      '이메일 또는 비밀번호가 올바르지 않습니다.',
    );

  async function issueTokens(
    exec: Executor,
    admin: Pick<AdminRecord, 'id' | 'roleCode' | 'permVersion'>,
    familyId: string,
    meta: ClientMeta,
  ): Promise<IssuedTokens> {
    const { token: accessToken } = await tokens.signAccess({
      adminId: admin.id,
      roleCode: admin.roleCode,
      permVersion: admin.permVersion,
    });
    const refreshToken = newRefreshToken();
    await exec.insert(refreshTokens).values({
      adminId: admin.id,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    });
    return { accessToken, expiresIn: tokens.accessTtlSec, refreshToken };
  }

  async function toMe(admin: AdminRecord, channel: MeResponse['channel']): Promise<MeResponse> {
    const perms = await loadEffectivePermissions(db, admin);
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      roleCode: admin.roleCode,
      permissions: sortedPermissions(perms),
      mustChangePassword: admin.mustChangePassword,
      channel,
    };
  }

  return {
    async login(input: LoginRequest, meta: ClientMeta, audit: AuditContext) {
      const admin = await findAdminByEmail(db, input.email);

      if (!admin) {
        await hasher.burn(input.password);
        await writeAudit(db, audit, {
          action: AuditAction.LOGIN_FAILED,
          targetType: AuditTargetType.ADMIN,
          targetId: input.email,
          result: 'FAILURE',
          errorCode: ErrorCode.INVALID_CREDENTIALS,
        });
        throw invalidCredentials();
      }

      const now = new Date();
      if (admin.lockedUntil && admin.lockedUntil > now) {
        await hasher.burn(input.password);
        throw new AppError(
          423,
          ErrorCode.ACCOUNT_LOCKED,
          '로그인 시도가 많아 계정이 잠겼습니다. 잠시 후 다시 시도하세요.',
          {
            lockedUntil: admin.lockedUntil.toISOString(),
          },
        );
      }

      const ok = await hasher.verify(admin.passwordHash, input.password);
      const failAudit = (errorCode: string) =>
        writeAudit(db, audit, {
          action: AuditAction.LOGIN_FAILED,
          adminIdOverride: admin.id,
          targetType: AuditTargetType.ADMIN,
          targetId: admin.id,
          result: 'FAILURE',
          errorCode,
        });

      if (!ok) {
        const failed = admin.failedLoginCount + 1;
        const lock = failed >= MAX_FAILED_LOGINS;
        await db
          .update(admins)
          .set(
            lock
              ? {
                  failedLoginCount: 0,
                  lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000),
                }
              : { failedLoginCount: sql`${admins.failedLoginCount} + 1` },
          )
          .where(eq(admins.id, admin.id));
        await failAudit(lock ? ErrorCode.ACCOUNT_LOCKED : ErrorCode.INVALID_CREDENTIALS);
        throw invalidCredentials();
      }

      // 비활성 계정은 비밀번호가 맞아도 존재 여부를 드러내지 않는다
      if (admin.status !== AdminStatus.ACTIVE) {
        await failAudit('ADMIN_DISABLED');
        throw invalidCredentials();
      }

      const result = await db.transaction(async (tx) => {
        await tx
          .update(admins)
          .set({
            failedLoginCount: 0,
            lockedUntil: null,
            lastLoginAt: now,
            // 해시 파라미터가 바뀌었으면 로그인 성공 시점에 새 파라미터로 재해시
            ...(hasher.needsRehash(admin.passwordHash)
              ? { passwordHash: await hasher.hash(input.password) }
              : {}),
          })
          .where(eq(admins.id, admin.id));
        const issued = await issueTokens(tx, admin, randomUUID(), meta);
        await writeAudit(tx, audit, {
          action: AuditAction.LOGIN,
          adminIdOverride: admin.id,
          targetType: AuditTargetType.ADMIN,
          targetId: admin.id,
        });
        return issued;
      });

      return { ...result, admin: await toMe(admin, 'WEB') };
    },

    async refresh(rawToken: string, meta: ClientMeta, audit: AuditContext): Promise<IssuedTokens> {
      const sessionExpired = () =>
        new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '세션이 만료되었습니다. 다시 로그인하세요.');
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256(rawToken)))
        .limit(1);
      const now = Date.now();
      if (!row || row.revokedAt || row.expiresAt.getTime() <= now) throw sessionExpired();

      if (row.usedAt) {
        // 짧은 시간 안의 재사용은 여러 탭의 동시 갱신 → 폐기하지 않고 거절만 (클라이언트가 새 쿠키로 재시도)
        // DATETIME 은 초 단위로 '반올림' 저장되어 used_at 이 최대 0.5초 미래일 수 있다 → 유예 0 이면 판단 자체를 생략
        const grace = env.REFRESH_REUSE_GRACE_SEC * 1000;
        if (grace > 0 && now - row.usedAt.getTime() < grace) {
          throw new UnauthorizedError(
            ErrorCode.TOKEN_EXPIRED,
            '이미 갱신된 토큰입니다. 다시 시도하세요.',
          );
        }
        // 그 외 재사용 = 탈취 의심 → 같은 family 전체 폐기
        await db.transaction(async (tx) => {
          await revokeRefreshFamily(tx, row.familyId);
          await writeAudit(tx, audit, {
            action: AuditAction.TOKEN_REUSE_DETECTED,
            adminIdOverride: row.adminId,
            targetType: AuditTargetType.ADMIN,
            targetId: row.adminId,
            result: 'FAILURE',
            errorCode: ErrorCode.AUTH_REQUIRED,
          });
        });
        logger.warn(
          { adminId: row.adminId, familyId: row.familyId },
          'refresh token reuse detected',
        );
        throw sessionExpired();
      }

      const admin = await findAdminById(db, row.adminId);
      if (!admin || admin.status !== AdminStatus.ACTIVE) {
        await revokeRefreshFamily(db, row.familyId);
        throw sessionExpired();
      }

      return db.transaction(async (tx) => {
        // 조건부 UPDATE 로 '한 번만 사용' 보장 (동시 요청 중 하나만 성공)
        const res = await tx
          .update(refreshTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(refreshTokens.id, row.id),
              isNull(refreshTokens.usedAt),
              isNull(refreshTokens.revokedAt),
            ),
          );
        if (affectedRows(res) !== 1) {
          throw new UnauthorizedError(
            ErrorCode.TOKEN_EXPIRED,
            '이미 갱신된 토큰입니다. 다시 시도하세요.',
          );
        }
        return issueTokens(tx, admin, row.familyId, meta);
      });
    },

    async logout(auth: AuthContext | undefined, rawRefresh: string | null, audit: AuditContext) {
      let adminId = auth?.adminId ?? null;
      if (rawRefresh) {
        const [row] = await db
          .select({ familyId: refreshTokens.familyId, adminId: refreshTokens.adminId })
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, sha256(rawRefresh)))
          .limit(1);
        if (row) {
          await revokeRefreshFamily(db, row.familyId);
          adminId ??= row.adminId;
        }
      }
      if (auth?.jti && auth.tokenExp) await blacklistAccessToken(auth.jti, auth.tokenExp);
      if (adminId !== null) {
        await writeAudit(db, audit, {
          action: AuditAction.LOGOUT,
          adminIdOverride: adminId,
          targetType: AuditTargetType.ADMIN,
          targetId: adminId,
        });
      }
    },

    async me(auth: AuthContext): Promise<MeResponse> {
      return {
        id: auth.adminId,
        email: auth.email,
        name: auth.name,
        roleCode: auth.roleCode,
        permissions: sortedPermissions(auth.permissions),
        mustChangePassword: auth.mustChangePassword,
        channel: auth.channel,
      };
    },

    /** 변경 후 모든 세션 종료 → 클라이언트는 다시 로그인 */
    async changePassword(auth: AuthContext, input: ChangePasswordRequest, audit: AuditContext) {
      const admin = await findAdminById(db, auth.adminId);
      if (!admin) throw new UnauthorizedError();
      if (!(await hasher.verify(admin.passwordHash, input.currentPassword))) {
        throw new BusinessRuleError(
          ErrorCode.INVALID_CURRENT_PASSWORD,
          '현재 비밀번호가 올바르지 않습니다.',
        );
      }
      const newHash = await hasher.hash(input.newPassword);
      await db.transaction(async (tx) => {
        await tx
          .update(admins)
          .set({ passwordHash: newHash, mustChangePassword: false })
          .where(eq(admins.id, admin.id));
        await bumpPermVersion(tx, admin.id);
        await revokeAllRefreshTokens(tx, admin.id);
        await writeAudit(tx, audit, {
          action: AuditAction.PASSWORD_CHANGE,
          targetType: AuditTargetType.ADMIN,
          targetId: admin.id,
        });
      });
    },
  };

  /** Redis 장애 시: 로그아웃은 성공 처리하되 경고. access token 은 최대 TTL(15분) 후 만료 */
  async function blacklistAccessToken(jti: string, exp: number) {
    const ttl = exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    try {
      await redis.redis.set(blacklistKey(jti), '1', 'EX', ttl);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'access token blacklist failed (redis unavailable)',
      );
    }
  }
}

export type AuthService = ReturnType<typeof createAuthService>;
