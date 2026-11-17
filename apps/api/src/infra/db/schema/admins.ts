import {
  boolean,
  char,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk, updatedAt } from './columns.js';

export const roles = mysqlTable('roles', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  code: varchar('code', { length: 30 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  createdAt: createdAt(),
});

export const permissions = mysqlTable('permissions', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  description: varchar('description', { length: 200 }).notNull(),
});

export const rolePermissions = mysqlTable(
  'role_permissions',
  {
    roleId: int('role_id', { unsigned: true })
      .notNull()
      .references(() => roles.id),
    permissionId: int('permission_id', { unsigned: true })
      .notNull()
      .references(() => permissions.id),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const admins = mysqlTable(
  'admins',
  {
    id: pk(),
    email: varchar('email', { length: 191 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    roleId: int('role_id', { unsigned: true })
      .notNull()
      .references(() => roles.id),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    /** 권한·역할·비밀번호 변경 시 증가 → 이전 access token 즉시 무효화 */
    permVersion: int('perm_version', { unsigned: true }).notNull().default(1),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /** 로그인 잠금 (architecture.md 4.1) */
    failedLoginCount: int('failed_login_count', { unsigned: true }).notNull().default(0),
    lockedUntil: dt('locked_until'),
    lastLoginAt: dt('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_admins_role').on(t.roleId)],
);

export const adminPermissionOverrides = mysqlTable(
  'admin_permission_overrides',
  {
    adminId: fk('admin_id')
      .notNull()
      .references(() => admins.id),
    permissionId: int('permission_id', { unsigned: true })
      .notNull()
      .references(() => permissions.id),
    effect: varchar('effect', { length: 10 }).notNull().$type<'GRANT' | 'DENY'>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.permissionId] })],
);

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: pk(),
    adminId: fk('admin_id')
      .notNull()
      .references(() => admins.id),
    /** SHA-256(hex). 원문은 저장하지 않는다 */
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    /** 회전으로 이어진 토큰 묶음. 재사용 감지 시 family 전체 폐기 */
    familyId: char('family_id', { length: 36 }).notNull(),
    expiresAt: dt('expires_at').notNull(),
    usedAt: dt('used_at'),
    revokedAt: dt('revoked_at'),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [index('idx_refresh_family').on(t.familyId), index('idx_refresh_admin').on(t.adminId)],
);

export const apiTokens = mysqlTable(
  'api_tokens',
  {
    id: pk(),
    adminId: fk('admin_id')
      .notNull()
      .references(() => admins.id),
    name: varchar('name', { length: 50 }).notNull(),
    prefix: varchar('prefix', { length: 16 }).notNull().unique(),
    secretHash: char('secret_hash', { length: 64 }).notNull(),
    permissions: json('permissions').$type<string[]>().notNull(),
    expiresAt: dt('expires_at').notNull(),
    lastUsedAt: dt('last_used_at'),
    lastUsedIp: varchar('last_used_ip', { length: 45 }),
    revokedAt: dt('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_api_tokens_admin').on(t.adminId)],
);
