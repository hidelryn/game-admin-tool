import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AdminStatus, RoleCode } from '@game-admin/shared';
import type { Executor } from '../../infra/db/types.js';
import { admins, refreshTokens, roles } from '../../infra/db/schema/index.js';

/** 인증·권한 판단에 필요한 운영자 정보 */
export interface AdminRecord {
  id: number;
  email: string;
  name: string;
  passwordHash: string;
  roleId: number;
  roleCode: RoleCode;
  status: AdminStatus;
  permVersion: number;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const adminColumns = {
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
};

async function findOne(db: Executor, where: ReturnType<typeof eq>): Promise<AdminRecord | null> {
  const [row] = await db
    .select(adminColumns)
    .from(admins)
    .innerJoin(roles, eq(roles.id, admins.roleId))
    .where(where)
    .limit(1);
  return (row as AdminRecord | undefined) ?? null;
}

export const findAdminByEmail = (db: Executor, email: string) =>
  findOne(db, eq(admins.email, email));
export const findAdminById = (db: Executor, id: number) => findOne(db, eq(admins.id, id));

/** 권한/역할/비밀번호/상태 변경 시 호출 → 발급된 access token 즉시 무효화 */
export async function bumpPermVersion(db: Executor, adminId: number) {
  await db
    .update(admins)
    .set({ permVersion: sql`${admins.permVersion} + 1` })
    .where(eq(admins.id, adminId));
}

export async function revokeAllRefreshTokens(db: Executor, adminId: number) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.adminId, adminId), isNull(refreshTokens.revokedAt)));
}

export async function revokeRefreshFamily(db: Executor, familyId: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}
