import type { AuditAction, AuditTargetType } from '@game-admin/shared';

/** 감사 로그 작업 이름 */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  LOGIN: '로그인',
  LOGIN_FAILED: '로그인 실패',
  LOGOUT: '로그아웃',
  TOKEN_REUSE_DETECTED: '토큰 재사용 감지',
  PASSWORD_CHANGE: '비밀번호 변경',
  ADMIN_CREATE: '운영자 생성',
  ADMIN_UPDATE: '운영자 수정',
  ADMIN_PERMISSIONS_UPDATE: '운영자 권한 변경',
  ADMIN_PASSWORD_RESET: '운영자 비밀번호 초기화',
  API_TOKEN_CREATE: 'API 토큰 발급',
  API_TOKEN_REVOKE: 'API 토큰 폐기',
  USER_PII_VIEW: '개인정보 열람',
  USER_SUSPEND: '회원 정지',
  USER_UNSUSPEND: '회원 정지 해제',
  CURRENCY_GRANT: '재화 지급',
  CURRENCY_DEDUCT: '재화 회수',
  // 승인 기능 제거(2026-11-16) 전 기록
  APPROVAL_REQUEST: '승인 요청 (이전 기록)',
  APPROVAL_APPROVE: '승인 (이전 기록)',
  APPROVAL_REJECT: '반려 (이전 기록)',
  APPROVAL_CANCEL: '승인 요청 취소 (이전 기록)',
  APPROVAL_EXECUTE: '승인 건 실행 (이전 기록)',
  MAIL_SEND: '우편 발송',
  MAIL_SEND_ALL: '전체 우편 발송',
  MAIL_CANCEL: '우편 취소',
  RANKING_REBUILD: '랭킹 재구성',
  RANKING_RESET: '랭킹 초기화',
  RANKING_RESTORE: '랭킹 스냅샷 복원',
  RANKING_REWARD: '랭킹 순위 보상',
  RANKING_SNAPSHOT_EXPORT: '랭킹 스냅샷 내보내기',
  RANKING_SEASON_START: '랭킹 시즌 시작',
  RANKING_SEASON_END: '랭킹 시즌 종료',
  SCHEDULE_CREATE: '스케줄 등록',
  SCHEDULE_UPDATE: '스케줄 수정',
  SCHEDULE_CANCEL: '스케줄 취소·내리기',
  ASSET_UPLOAD: '이미지 업로드',
  MAINTENANCE_CREATE: '점검 등록',
  MAINTENANCE_UPDATE: '점검 수정·연장',
  MAINTENANCE_CANCEL: '점검 취소',
  MAINTENANCE_START: '점검 시작',
  MAINTENANCE_END: '점검 해제',
  NOTICE_CREATE: '공지 등록',
  NOTICE_UPDATE: '공지 수정',
  NOTICE_HIDE: '공지 내리기',
  DEMO_RESET: '체험 데이터 초기화',
};

/** 필터 드롭다운용 묶음 */
export const AUDIT_ACTION_GROUPS: { label: string; actions: AuditAction[] }[] = [
  {
    label: '인증',
    actions: ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'TOKEN_REUSE_DETECTED', 'PASSWORD_CHANGE'],
  },
  { label: '회원', actions: ['USER_PII_VIEW', 'USER_SUSPEND', 'USER_UNSUSPEND'] },
  { label: '재화', actions: ['CURRENCY_GRANT', 'CURRENCY_DEDUCT'] },
  { label: '우편', actions: ['MAIL_SEND', 'MAIL_SEND_ALL', 'MAIL_CANCEL'] },
  {
    label: '랭킹',
    actions: [
      'RANKING_REBUILD',
      'RANKING_RESET',
      'RANKING_RESTORE',
      'RANKING_REWARD',
      'RANKING_SNAPSHOT_EXPORT',
      'RANKING_SEASON_START',
      'RANKING_SEASON_END',
    ],
  },
  {
    label: '스케줄',
    actions: ['SCHEDULE_CREATE', 'SCHEDULE_UPDATE', 'SCHEDULE_CANCEL', 'ASSET_UPLOAD'],
  },
  {
    label: '점검·공지',
    actions: [
      'MAINTENANCE_CREATE',
      'MAINTENANCE_UPDATE',
      'MAINTENANCE_CANCEL',
      'MAINTENANCE_START',
      'MAINTENANCE_END',
      'NOTICE_CREATE',
      'NOTICE_UPDATE',
      'NOTICE_HIDE',
    ],
  },
  { label: '시스템', actions: ['DEMO_RESET'] },
  {
    label: '승인 (이전 기록)',
    actions: [
      'APPROVAL_REQUEST',
      'APPROVAL_APPROVE',
      'APPROVAL_REJECT',
      'APPROVAL_CANCEL',
      'APPROVAL_EXECUTE',
    ],
  },
  {
    label: '운영자·토큰',
    actions: [
      'ADMIN_CREATE',
      'ADMIN_UPDATE',
      'ADMIN_PERMISSIONS_UPDATE',
      'ADMIN_PASSWORD_RESET',
      'API_TOKEN_CREATE',
      'API_TOKEN_REVOKE',
    ],
  },
];

export const AUDIT_TARGET_LABEL: Record<AuditTargetType, string> = {
  ADMIN: '운영자',
  API_TOKEN: 'API 토큰',
  USER: '회원',
  MAIL: '우편',
  RANKING_SEASON: '랭킹 시즌',
  APPROVAL_REQUEST: '승인 요청 (이전 기록)',
  SCHEDULE: '스케줄',
  ASSET: '이미지',
  MAINTENANCE: '점검',
  NOTICE: '공지',
};

/** 대상 → 화면 경로 (없으면 링크 없음) */
export function auditTargetPath(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'USER':
      return `/users/${encodeURIComponent(id)}`;
    case 'MAIL':
      return `/mails/${id}`;
    case 'RANKING_SEASON':
      return `/rankings?season=${id}`;
    case 'ADMIN':
      return `/admins/${id}`;
    case 'SCHEDULE':
      return `/schedules?focus=${id}`;
    case 'MAINTENANCE':
      return `/live-notices?tab=maintenance&focus=${id}`;
    case 'NOTICE':
      return `/live-notices?tab=notice&focus=${id}`;
    default:
      return null;
  }
}
