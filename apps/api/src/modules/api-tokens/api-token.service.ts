import { and, desc, eq, gt, isNull, count } from 'drizzle-orm';
import {
  API_TOKEN_MAX_ACTIVE,
  AuditAction,
  AuditTargetType,
  Channel,
  DEMO_TOKEN_MAX_ACTIVE,
  DEMO_TOKEN_PERMISSIONS,
  ErrorCode,
  TOKEN_ASSIGNABLE_PERMISSIONS,
  type ApiTokenSummary,
  type CreateApiTokenRequest,
  type CreatedApiToken,
  type Permission,
} from '@game-admin/shared';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { apiTokens } from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import { generateApiToken } from '../auth/tokens.js';

type Row = typeof apiTokens.$inferSelect;

const toSummary = (r: Row): ApiTokenSummary => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  permissions: r.permissions as Permission[],
  expiresAt: iso(r.expiresAt),
  lastUsedAt: isoOrNull(r.lastUsedAt),
  revokedAt: isoOrNull(r.revokedAt),
  createdAt: iso(r.createdAt),
});

/**
 * MCP 용 개인 API 토큰 (architecture.md 4.2)
 * - 발급은 WEB 에서만, 원문은 발급 응답에서 1회만 노출
 * - 부여 가능 권한 = 본인 현재 권한 ∩ TOKEN_ASSIGNABLE_PERMISSIONS
 */
export function createApiTokenService(deps: {
  db: Executor;
  /** 공개 체험 계정 판별 — 체험 계정 토큰은 조회 권한만·다음 초기화까지·동시 개수 제한 */
  isDemo?: (email: string) => boolean;
  /** 체험 계정 토큰의 만료 상한 (다음 초기화 시각). null 이면 상한 없음 */
  demoExpiresBy?: (now: Date) => Date | null;
}) {
  const { db, isDemo = () => false, demoExpiresBy = () => null } = deps;

  return {
    async listFor(adminId: number): Promise<ApiTokenSummary[]> {
      const rows = await db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.adminId, adminId))
        .orderBy(desc(apiTokens.id));
      return rows.map(toSummary);
    },

    async create(
      actor: AuthContext,
      input: CreateApiTokenRequest,
      audit: AuditContext,
    ): Promise<CreatedApiToken> {
      if (actor.channel !== Channel.WEB) {
        throw new ForbiddenError(
          ErrorCode.CHANNEL_NOT_ALLOWED,
          'API 토큰은 웹 백오피스에서만 발급할 수 있습니다.',
        );
      }
      const demo = isDemo(actor.email);
      const notAllowed = input.permissions.filter(
        (p) =>
          !actor.permissions.has(p) ||
          !TOKEN_ASSIGNABLE_PERMISSIONS.includes(p) ||
          (demo && !DEMO_TOKEN_PERMISSIONS.includes(p)),
      );
      if (notAllowed.length) {
        throw new BusinessRuleError(
          ErrorCode.TOKEN_PERMISSION_NOT_ALLOWED,
          demo
            ? '체험 계정 토큰에는 조회 권한만 줄 수 있습니다.'
            : '토큰에 부여할 수 없는 권한이 포함되어 있습니다.',
          {
            notAllowed,
          },
        );
      }

      const now = new Date();
      const [active] = await db
        .select({ n: count() })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.adminId, actor.adminId),
            isNull(apiTokens.revokedAt),
            gt(apiTokens.expiresAt, now),
          ),
        );
      const maxActive = demo ? DEMO_TOKEN_MAX_ACTIVE : API_TOKEN_MAX_ACTIVE;
      if ((active?.n ?? 0) >= maxActive) {
        throw new BusinessRuleError(
          ErrorCode.TOKEN_LIMIT_EXCEEDED,
          demo
            ? `체험 계정 토큰이 이미 ${maxActive}개 사용 중입니다. 다음 초기화 후 다시 시도하세요.`
            : `활성 토큰은 최대 ${maxActive}개까지입니다.`,
        );
      }

      const { token, prefix, secretHash } = generateApiToken();
      let expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
      const cap = demo ? demoExpiresBy(now) : null;
      if (cap && cap < expiresAt) expiresAt = cap;

      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(apiTokens)
          .values({
            adminId: actor.adminId,
            name: input.name,
            prefix,
            secretHash,
            permissions: input.permissions,
            expiresAt,
          })
          .$returningId();
        const id = created!.id;
        await writeAudit(tx, audit, {
          action: AuditAction.API_TOKEN_CREATE,
          targetType: AuditTargetType.API_TOKEN,
          targetId: id,
          // 토큰 원문·해시는 절대 기록하지 않는다
          after: {
            name: input.name,
            prefix,
            permissions: input.permissions,
            expiresAt: expiresAt.toISOString(),
          },
        });
        const [saved] = await tx.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
        return saved!;
      });

      return { ...toSummary(row), token };
    },

    /** 이미 폐기된 토큰을 다시 폐기해도 성공 (멱등) */
    async revoke(ownerId: number, tokenId: number, audit: AuditContext, reason?: string) {
      const [row] = await db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.adminId, ownerId)))
        .limit(1);
      if (!row)
        throw new NotFoundError(ErrorCode.API_TOKEN_NOT_FOUND, 'API 토큰을 찾을 수 없습니다.');
      if (row.revokedAt) return;
      await db.transaction(async (tx) => {
        await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
        await writeAudit(tx, audit, {
          action: AuditAction.API_TOKEN_REVOKE,
          targetType: AuditTargetType.API_TOKEN,
          targetId: tokenId,
          reason: reason ?? null,
          before: { ownerId, prefix: row.prefix },
        });
      });
    },
  };
}

export type ApiTokenService = ReturnType<typeof createApiTokenService>;
