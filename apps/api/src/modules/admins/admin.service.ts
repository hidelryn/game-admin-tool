import { and, count, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import {
  AdminStatus,
  AuditAction,
  AuditTargetType,
  ErrorCode,
  RoleCode,
  type AdminDetail,
  type AdminSummary,
  type CreateAdminRequest,
  type CreatedAdmin,
  type ListAdminsQuery,
  type Permission,
  type PermissionOverridesRequest,
  type ResetPasswordRequest,
  type RoleWithPermissions,
  type UpdateAdminRequest,
} from '@game-admin/shared';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/app-error.js';
import { escapeLike } from '../../common/http/like.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import type { Executor } from '../../infra/db/types.js';
import {
  adminPermissionOverrides,
  admins,
  permissions,
  rolePermissions,
  roles,
} from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  bumpPermVersion,
  findAdminById,
  revokeAllRefreshTokens,
  type AdminRecord,
} from '../auth/admin.repository.js';
import { generateTemporaryPassword, type PasswordHasher } from '../auth/password.js';
import { loadEffectivePermissions, loadOverrides, sortedPermissions } from './permissions.js';

const toSummary = (a: AdminRecord): AdminSummary => ({
  id: a.id,
  email: a.email,
  name: a.name,
  roleCode: a.roleCode,
  status: a.status,
  mustChangePassword: a.mustChangePassword,
  lastLoginAt: isoOrNull(a.lastLoginAt),
  lockedUntil: isoOrNull(a.lockedUntil),
  createdAt: iso(a.createdAt),
});

export function createAdminService(deps: { db: Executor; hasher: PasswordHasher }) {
  const { db, hasher } = deps;

  async function getTarget(id: number): Promise<AdminRecord> {
    const target = await findAdminById(db, id);
    if (!target) throw new NotFoundError(ErrorCode.ADMIN_NOT_FOUND, '운영자를 찾을 수 없습니다.');
    return target;
  }

  /** 자기 자신의 권한·역할·상태·비밀번호 초기화 금지 (자기 권한 상승 방지) */
  function ensureNotSelf(actor: AuthContext, targetId: number) {
    if (actor.adminId === targetId) {
      throw new ForbiddenError(
        ErrorCode.SELF_MODIFICATION_NOT_ALLOWED,
        '자기 자신의 권한·상태는 변경할 수 없습니다.',
      );
    }
  }

  /** SUPER_ADMIN 을 다루거나 만드는 작업은 SUPER_ADMIN 만 */
  function ensureCanTouchSuper(actor: AuthContext, ...roleCodes: (RoleCode | undefined)[]) {
    if (roleCodes.includes(RoleCode.SUPER_ADMIN) && actor.roleCode !== RoleCode.SUPER_ADMIN) {
      throw new ForbiddenError(
        ErrorCode.PERMISSION_DENIED,
        '최고 관리자 계정은 최고 관리자만 관리할 수 있습니다.',
      );
    }
  }

  async function findRoleId(code: RoleCode): Promise<number> {
    const [row] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, code))
      .limit(1);
    if (!row) throw new BusinessRuleError(ErrorCode.ROLE_NOT_FOUND, `역할이 없습니다: ${code}`);
    return row.id;
  }

  /** 마지막 활성 SUPER_ADMIN 을 비활성화하거나 강등하면 아무도 관리할 수 없게 된다 */
  async function ensureNotLastSuperAdmin(target: AdminRecord) {
    if (target.roleCode !== RoleCode.SUPER_ADMIN || target.status !== AdminStatus.ACTIVE) return;
    const [row] = await db
      .select({ n: count() })
      .from(admins)
      .innerJoin(roles, eq(roles.id, admins.roleId))
      .where(and(eq(roles.code, RoleCode.SUPER_ADMIN), eq(admins.status, AdminStatus.ACTIVE)));
    if ((row?.n ?? 0) <= 1) {
      throw new BusinessRuleError(
        ErrorCode.LAST_SUPER_ADMIN,
        '마지막 최고 관리자는 비활성화하거나 강등할 수 없습니다.',
      );
    }
  }

  return {
    async list(q: ListAdminsQuery) {
      const conds: SQL[] = [];
      if (q.q) {
        const term = escapeLike(q.q);
        conds.push(or(like(admins.email, `${term}%`), like(admins.name, `%${term}%`))!);
      }
      if (q.status) conds.push(eq(admins.status, q.status));
      if (q.roleCode) conds.push(eq(roles.code, q.roleCode));
      const where = conds.length ? and(...conds) : undefined;

      const [rows, totals] = await Promise.all([
        db
          .select({
            id: admins.id,
            email: admins.email,
            name: admins.name,
            passwordHash: admins.passwordHash,
            roleId: admins.roleId,
            roleCode: roles.code,
            status: admins.status,
            permVersion: admins.permVersion,
            mustChangePassword: admins.mustChangePassword,
            failedLoginCount: admins.failedLoginCount,
            lockedUntil: admins.lockedUntil,
            lastLoginAt: admins.lastLoginAt,
            createdAt: admins.createdAt,
          })
          .from(admins)
          .innerJoin(roles, eq(roles.id, admins.roleId))
          .where(where)
          .orderBy(desc(admins.id))
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db
          .select({ n: count() })
          .from(admins)
          .innerJoin(roles, eq(roles.id, admins.roleId))
          .where(where),
      ]);
      return {
        items: (rows as AdminRecord[]).map(toSummary),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    async get(id: number): Promise<AdminDetail> {
      const target = await getTarget(id);
      const [overrides, effective] = await Promise.all([
        loadOverrides(db, id),
        loadEffectivePermissions(db, target),
      ]);
      return {
        ...toSummary(target),
        overrides: overrides.map((o) => ({ permission: o.code as Permission, effect: o.effect })),
        effectivePermissions: sortedPermissions(effective),
      };
    },

    async create(
      actor: AuthContext,
      input: CreateAdminRequest,
      audit: AuditContext,
    ): Promise<CreatedAdmin> {
      ensureCanTouchSuper(actor, input.roleCode);
      const roleId = await findRoleId(input.roleCode);
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hasher.hash(temporaryPassword);
      try {
        const id = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(admins)
            .values({
              email: input.email,
              name: input.name,
              roleId,
              passwordHash,
              mustChangePassword: true,
            })
            .$returningId();
          const newId = created!.id;
          await writeAudit(tx, audit, {
            action: AuditAction.ADMIN_CREATE,
            targetType: AuditTargetType.ADMIN,
            targetId: newId,
            after: { email: input.email, name: input.name, roleCode: input.roleCode },
          });
          return newId;
        });
        return { id, temporaryPassword };
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(ErrorCode.ADMIN_EMAIL_EXISTS, '이미 등록된 이메일입니다.');
        throw err;
      }
    },

    async update(actor: AuthContext, id: number, input: UpdateAdminRequest, audit: AuditContext) {
      const target = await getTarget(id);
      const changesRole = input.roleCode !== undefined && input.roleCode !== target.roleCode;
      const changesStatus = input.status !== undefined && input.status !== target.status;
      if (changesRole || changesStatus) ensureNotSelf(actor, id);
      ensureCanTouchSuper(actor, target.roleCode, input.roleCode);
      if (
        (changesRole && target.roleCode === RoleCode.SUPER_ADMIN) ||
        (changesStatus && input.status === AdminStatus.DISABLED)
      ) {
        await ensureNotLastSuperAdmin(target);
      }

      const set: Partial<typeof admins.$inferInsert> = {};
      if (input.name !== undefined && input.name !== target.name) set.name = input.name;
      if (changesRole) set.roleId = await findRoleId(input.roleCode!);
      if (changesStatus) set.status = input.status!;
      if (Object.keys(set).length === 0) return this.get(id);

      await db.transaction(async (tx) => {
        await tx.update(admins).set(set).where(eq(admins.id, id));
        if (changesRole || changesStatus) await bumpPermVersion(tx, id);
        if (changesStatus && input.status === AdminStatus.DISABLED)
          await revokeAllRefreshTokens(tx, id);
        await writeAudit(tx, audit, {
          action: AuditAction.ADMIN_UPDATE,
          targetType: AuditTargetType.ADMIN,
          targetId: id,
          reason: input.reason,
          before: { name: target.name, roleCode: target.roleCode, status: target.status },
          after: {
            name: input.name ?? target.name,
            roleCode: input.roleCode ?? target.roleCode,
            status: input.status ?? target.status,
          },
        });
      });
      return this.get(id);
    },

    async setOverrides(
      actor: AuthContext,
      id: number,
      input: PermissionOverridesRequest,
      audit: AuditContext,
    ) {
      ensureNotSelf(actor, id);
      const target = await getTarget(id);
      ensureCanTouchSuper(actor, target.roleCode);
      const before = await loadOverrides(db, id);

      const permRows = input.overrides.length
        ? await db
            .select({ id: permissions.id, code: permissions.code })
            .from(permissions)
            .where(
              inArray(
                permissions.code,
                input.overrides.map((o) => o.permission),
              ),
            )
        : [];
      const permId = new Map(permRows.map((p) => [p.code, p.id]));

      await db.transaction(async (tx) => {
        await tx.delete(adminPermissionOverrides).where(eq(adminPermissionOverrides.adminId, id));
        if (input.overrides.length) {
          await tx.insert(adminPermissionOverrides).values(
            input.overrides.map((o) => ({
              adminId: id,
              permissionId: permId.get(o.permission)!,
              effect: o.effect,
            })),
          );
        }
        await bumpPermVersion(tx, id);
        await writeAudit(tx, audit, {
          action: AuditAction.ADMIN_PERMISSIONS_UPDATE,
          targetType: AuditTargetType.ADMIN,
          targetId: id,
          reason: input.reason,
          before: before.map((o) => ({ permission: o.code, effect: o.effect })),
          after: input.overrides,
        });
      });
      return this.get(id);
    },

    async resetPassword(
      actor: AuthContext,
      id: number,
      input: ResetPasswordRequest,
      audit: AuditContext,
    ) {
      ensureNotSelf(actor, id);
      const target = await getTarget(id);
      ensureCanTouchSuper(actor, target.roleCode);
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hasher.hash(temporaryPassword);
      await db.transaction(async (tx) => {
        await tx
          .update(admins)
          .set({ passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null })
          .where(eq(admins.id, id));
        await bumpPermVersion(tx, id);
        await revokeAllRefreshTokens(tx, id);
        await writeAudit(tx, audit, {
          action: AuditAction.ADMIN_PASSWORD_RESET,
          targetType: AuditTargetType.ADMIN,
          targetId: id,
          reason: input.reason,
        });
      });
      return { temporaryPassword };
    },

    async listRoles(): Promise<RoleWithPermissions[]> {
      const rows = await db
        .select({ roleCode: roles.code, roleName: roles.name, permission: permissions.code })
        .from(roles)
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .orderBy(roles.id);
      const map = new Map<string, RoleWithPermissions>();
      for (const r of rows) {
        const entry = map.get(r.roleCode) ?? {
          code: r.roleCode as RoleCode,
          name: r.roleName,
          permissions: [],
        };
        if (r.permission) entry.permissions.push(r.permission as Permission);
        map.set(r.roleCode, entry);
      }
      return [...map.values()];
    },

    listPermissions() {
      return db
        .select({ code: permissions.code, description: permissions.description })
        .from(permissions)
        .orderBy(permissions.id);
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
