/** 이메일 마스킹: ab****@example.com (FR-USR-07) */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}${email.slice(at)}`;
}
