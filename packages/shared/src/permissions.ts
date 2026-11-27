/**
 * 권한 목록 (architecture.md 4.3) — `리소스:행위`
 */
export const Permission = {
  DASHBOARD_READ: 'dashboard:read',
  USER_READ: 'user:read',
  USER_READ_PII: 'user:read_pii',
  USER_SUSPEND: 'user:suspend',
  CURRENCY_READ: 'currency:read',
  CURRENCY_GRANT: 'currency:grant',
  CURRENCY_DEDUCT: 'currency:deduct',
  MAIL_READ: 'mail:read',
  MAIL_SEND: 'mail:send',
  MAIL_SEND_ALL: 'mail:send_all',
  RANKING_READ: 'ranking:read',
  RANKING_MANAGE: 'ranking:manage',
  AUDIT_READ: 'audit:read',
  ADMIN_MANAGE: 'admin:manage',
  TOKEN_MANAGE_OWN: 'token:manage_own',
  SCHEDULE_READ: 'schedule:read',
  SCHEDULE_MANAGE: 'schedule:manage',
  MAINTENANCE_MANAGE: 'maintenance:manage',
  NOTICE_READ: 'notice:read',
  NOTICE_MANAGE: 'notice:manage',
  ANALYTICS_READ: 'analytics:read',
  EMAIL_READ: 'email:read',
  EMAIL_SEND: 'email:send',
  EMAIL_SEND_ALL: 'email:send_all',
  /** AI 어시스턴트 (조회 전용, 웹 전용) */
  ASSISTANT_USE: 'assistant:use',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export const RoleCode = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  OPERATOR: 'OPERATOR',
  CS: 'CS',
  VIEWER: 'VIEWER',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export const ALL_ROLE_CODES: readonly RoleCode[] = Object.values(RoleCode);

/**
 * API 토큰(MCP)에 부여할 수 없는 권한 (architecture.md 4.2, mcp-tools.md)
 * - 개인정보 원문, 운영자/권한 관리, 토큰 관리는 웹에서 사람만 수행
 */
export const TOKEN_FORBIDDEN_PERMISSIONS: readonly Permission[] = [
  Permission.USER_READ_PII,
  Permission.ADMIN_MANAGE,
  Permission.TOKEN_MANAGE_OWN,
  // AI 가 AI 를 부르는 경로(비용·통제) 차단 — 웹에서 사람만
  Permission.ASSISTANT_USE,
];

export const TOKEN_ASSIGNABLE_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !TOKEN_FORBIDDEN_PERMISSIONS.includes(p),
);

/** 요청이 들어온 경로 */
export const Channel = {
  WEB: 'WEB',
  MCP: 'MCP',
  SYSTEM: 'SYSTEM',
} as const;

export type Channel = (typeof Channel)[keyof typeof Channel];

export const AdminStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;

export type AdminStatus = (typeof AdminStatus)[keyof typeof AdminStatus];
