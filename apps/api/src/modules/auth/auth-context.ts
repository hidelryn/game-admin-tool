import type { Channel, Permission, RoleCode } from '@game-admin/shared';

/** 인증된 요청의 주체 정보 */
export interface AuthContext {
  adminId: number;
  email: string;
  name: string;
  roleCode: RoleCode;
  /** 실효 권한 (역할 ∪ GRANT − DENY, API 토큰이면 토큰 권한과 교집합) */
  permissions: ReadonlySet<Permission>;
  channel: Channel;
  mustChangePassword: boolean;
  /** API 토큰 인증일 때만 */
  apiTokenId: number | null;
  /** JWT 인증일 때만 — 로그아웃 시 블랙리스트 등록용 */
  jti: string | null;
  /** JWT 만료 시각(epoch 초) */
  tokenExp: number | null;
}
