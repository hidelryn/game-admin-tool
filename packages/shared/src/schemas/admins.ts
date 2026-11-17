import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  ALL_ROLE_CODES,
  AdminStatus,
  type Permission,
  type RoleCode,
} from '../permissions.js';
import { emailSchema } from './auth.js';
import { pageQuerySchema, reasonSchema, uniqueBy } from './common.js';

export const permissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);
export const roleCodeSchema = z.enum(ALL_ROLE_CODES as [RoleCode, ...RoleCode[]]);
export const adminStatusSchema = z.nativeEnum(AdminStatus);

const adminNameSchema = z.string().trim().min(2).max(50);

export const listAdminsQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(50).optional(),
  status: adminStatusSchema.optional(),
  roleCode: roleCodeSchema.optional(),
});
export type ListAdminsQuery = z.infer<typeof listAdminsQuerySchema>;

export const createAdminRequestSchema = z.object({
  email: emailSchema,
  name: adminNameSchema,
  roleCode: roleCodeSchema,
});
export type CreateAdminRequest = z.infer<typeof createAdminRequestSchema>;

export const updateAdminRequestSchema = z
  .object({
    name: adminNameSchema.optional(),
    roleCode: roleCodeSchema.optional(),
    status: adminStatusSchema.optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.name !== undefined || v.roleCode !== undefined || v.status !== undefined, {
    message: '변경할 항목이 없습니다.',
  });
export type UpdateAdminRequest = z.infer<typeof updateAdminRequestSchema>;

export const permissionEffectSchema = z.enum(['GRANT', 'DENY']);
export type PermissionEffect = z.infer<typeof permissionEffectSchema>;

export const permissionOverridesRequestSchema = z.object({
  overrides: z
    .array(z.object({ permission: permissionSchema, effect: permissionEffectSchema }))
    .max(ALL_PERMISSIONS.length)
    .refine((list) => uniqueBy(list, (o) => o.permission), '같은 권한이 중복되었습니다.'),
  reason: reasonSchema,
});
export type PermissionOverridesRequest = z.infer<typeof permissionOverridesRequestSchema>;

export const resetPasswordRequestSchema = z.object({ reason: reasonSchema });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export interface AdminSummary {
  id: number;
  email: string;
  name: string;
  roleCode: RoleCode;
  status: AdminStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

export interface AdminDetail extends AdminSummary {
  overrides: { permission: Permission; effect: PermissionEffect }[];
  effectivePermissions: Permission[];
}

export interface CreatedAdmin {
  id: number;
  /** 최초 1회만 표시되는 임시 비밀번호 */
  temporaryPassword: string;
}

export interface RoleWithPermissions {
  code: RoleCode;
  name: string;
  permissions: Permission[];
}
