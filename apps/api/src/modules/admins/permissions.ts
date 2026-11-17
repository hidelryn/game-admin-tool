import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS, RoleCode, type Permission } from '@game-admin/shared';
import type { Executor } from '../../infra/db/types.js';
import {
  adminPermissionOverrides,
  permissions,
  rolePermissions,
} from '../../infra/db/schema/index.js';

const KNOWN = new Set<string>(ALL_PERMISSIONS);
const isPermission = (v: string): v is Permission => KNOWN.has(v);

/**
 * 실효 권한 = 역할 권한 ∪ 개인 GRANT − 개인 DENY (DENY 우선) — architecture.md 4.3
 * SUPER_ADMIN 은 역할 권한이 '전체'이고, DENY 는 동일하게 적용된다.
 */
export function computeEffectivePermissions(
  roleCode: RoleCode,
  rolePerms: readonly string[],
  overrides: readonly { code: string; effect: 'GRANT' | 'DENY' }[],
): Set<Permission> {
  const result = new Set<Permission>(
    roleCode === RoleCode.SUPER_ADMIN ? ALL_PERMISSIONS : rolePerms.filter(isPermission),
  );
  for (const o of overrides) if (o.effect === 'GRANT' && isPermission(o.code)) result.add(o.code);
  for (const o of overrides) if (o.effect === 'DENY' && isPermission(o.code)) result.delete(o.code);
  return result;
}

export async function loadEffectivePermissions(
  db: Executor,
  admin: { id: number; roleId: number; roleCode: RoleCode },
): Promise<Set<Permission>> {
  const [rolePermRows, overrideRows] = await Promise.all([
    db
      .select({ code: permissions.code })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, admin.roleId)),
    loadOverrides(db, admin.id),
  ]);
  return computeEffectivePermissions(
    admin.roleCode,
    rolePermRows.map((r) => r.code),
    overrideRows,
  );
}

export function loadOverrides(db: Executor, adminId: number) {
  return db
    .select({ code: permissions.code, effect: adminPermissionOverrides.effect })
    .from(adminPermissionOverrides)
    .innerJoin(permissions, eq(permissions.id, adminPermissionOverrides.permissionId))
    .where(and(eq(adminPermissionOverrides.adminId, adminId)));
}

/** 정렬된 배열로 (응답용) */
export const sortedPermissions = (set: ReadonlySet<Permission>): Permission[] =>
  ALL_PERMISSIONS.filter((p) => set.has(p));
