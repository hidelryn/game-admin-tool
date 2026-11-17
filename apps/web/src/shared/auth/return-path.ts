/**
 * 로그인 후 돌아갈 경로
 * - 앱 내부 경로만 허용 ('//' 로 시작하는 외부 주소 차단 — 오픈 리다이렉트 방지)
 * - 로그인·비밀번호 변경 화면으로는 돌아가지 않음 (비밀번호 변경 직후 다시 변경 화면이 뜨던 문제)
 */
export function safeReturnPath(from: string | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/';
  if (from.startsWith('/login') || from.startsWith('/change-password')) return '/';
  return from;
}
