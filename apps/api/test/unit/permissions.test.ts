import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, RoleCode } from '@game-admin/shared';
import { computeEffectivePermissions } from '../../src/modules/admins/permissions.js';

describe('computeEffectivePermissions', () => {
  it('역할 권한에 GRANT 를 더한다', () => {
    const r = computeEffectivePermissions(
      RoleCode.VIEWER,
      ['user:read'],
      [{ code: 'mail:send', effect: 'GRANT' }],
    );
    expect([...r].sort()).toEqual(['mail:send', 'user:read']);
  });

  it('DENY 는 역할 권한과 GRANT 보다 우선한다', () => {
    const r = computeEffectivePermissions(
      RoleCode.OPERATOR,
      ['user:read', 'currency:grant'],
      [
        { code: 'currency:grant', effect: 'DENY' },
        { code: 'mail:send', effect: 'GRANT' },
        { code: 'mail:send', effect: 'DENY' },
      ],
    );
    expect([...r]).toEqual(['user:read']);
  });

  it('SUPER_ADMIN 은 전체 권한, 단 DENY 는 적용된다', () => {
    const r = computeEffectivePermissions(
      RoleCode.SUPER_ADMIN,
      [],
      [{ code: 'admin:manage', effect: 'DENY' }],
    );
    expect(r.size).toBe(ALL_PERMISSIONS.length - 1);
    expect(r.has('admin:manage')).toBe(false);
  });

  it('알 수 없는 권한 코드는 무시한다', () => {
    const r = computeEffectivePermissions(
      RoleCode.VIEWER,
      ['user:read', 'unknown:perm'],
      [{ code: 'hack:all', effect: 'GRANT' }],
    );
    expect([...r]).toEqual(['user:read']);
  });
});
