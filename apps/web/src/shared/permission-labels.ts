import type { Permission, RoleCode } from '@game-admin/shared';

export const ROLE_LABEL: Record<RoleCode, string> = {
  SUPER_ADMIN: '최고 관리자',
  OPERATOR: '운영자',
  CS: '고객지원',
  VIEWER: '조회 전용',
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  'dashboard:read': '대시보드 조회',
  'user:read': '회원 조회',
  'user:read_pii': '개인정보 원문 열람',
  'user:suspend': '회원 정지·해제',
  'currency:read': '재화 조회',
  'currency:grant': '재화 지급',
  'currency:deduct': '재화 회수',
  'mail:read': '우편 조회',
  'mail:send': '우편 발송',
  'mail:send_all': '전체 우편 발송',
  'ranking:read': '랭킹 조회',
  'ranking:manage': '랭킹 관리',
  'audit:read': '운영 로그 조회',
  'admin:manage': '운영자 관리',
  'token:manage_own': '내 API 토큰 관리',
  'schedule:read': '스케줄 조회',
  'schedule:manage': '스케줄 관리',
  'maintenance:manage': '점검 관리',
  'notice:read': '공지 조회',
  'notice:manage': '공지 관리',
  'analytics:read': '유저 분석 조회',
};

export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: '대시보드·분석', permissions: ['dashboard:read', 'analytics:read'] },
  { label: '회원', permissions: ['user:read', 'user:read_pii', 'user:suspend'] },
  { label: '재화', permissions: ['currency:read', 'currency:grant', 'currency:deduct'] },
  { label: '우편', permissions: ['mail:read', 'mail:send', 'mail:send_all'] },
  { label: '랭킹', permissions: ['ranking:read', 'ranking:manage'] },
  { label: '스케줄', permissions: ['schedule:read', 'schedule:manage'] },
  { label: '점검·공지', permissions: ['maintenance:manage', 'notice:read', 'notice:manage'] },
  {
    label: '운영',
    permissions: ['audit:read', 'admin:manage', 'token:manage_own'],
  },
];
