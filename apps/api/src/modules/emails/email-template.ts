/**
 * 이메일 디자인 틀 (docs/email.md 8장)
 * - 운영자는 평문만 쓰고, 보낼 때 이 틀(상단 배너 · 본문 카드 · 버튼 · 하단 안내)에 넣는다 → HTML 을 직접 다루지 않아 안전
 * - 메일 앱 호환을 위해 표(table) 레이아웃 + 인라인 스타일만 사용 (외부 CSS·스크립트·이미지 없음)
 * - 모든 입력은 이스케이프. 버튼 링크는 https 만 (스키마에서 검증)
 */
export interface EmailTemplateInput {
  /** 최종 제목 ((광고)·체험 머리말 포함) */
  subject: string;
  body: string;
  cta?: { label: string; url: string } | null;
  footers: string[];
  /** 광고성이면 상단에 "광고" 표시 */
  isAd?: boolean;
}

const BRAND = 'GAME ADMIN';
const BRAND_SUB = '게임 운영 알림';
const C = {
  page: '#eef1f8',
  ink: '#1d2340',
  sub: '#52596e',
  muted: '#8a90a2',
  line: '#e3e6ee',
  accent: '#2a5bd7',
  header: '#1d2340',
};

export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 빈 줄로 문단을 나누고, 문단 안 줄바꿈은 <br> */
function paragraphs(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${C.ink}">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

export function renderEmail(i: EmailTemplateInput): { html: string; text: string } {
  const cta = i.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="border-radius:8px;background:${C.accent}">
<a href="${escapeHtml(i.cta.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(i.cta.label)}</a>
</td></tr></table>`
    : '';
  const adBadge = i.isAd
    ? `<span style="display:inline-block;margin-bottom:10px;padding:2px 8px;border-radius:4px;background:#fdecef;color:#b4235a;font-size:12px;font-weight:700">광고</span><br>`
    : '';

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(i.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${C.line}">
<tr><td style="background:${C.header};padding:20px 28px">
<div style="font-size:18px;font-weight:800;letter-spacing:2px;color:#ffffff">${BRAND}</div>
<div style="font-size:12px;color:#aab4d4;margin-top:2px">${BRAND_SUB}</div>
</td></tr>
<tr><td style="padding:28px 28px 12px">
${adBadge}<h1 style="margin:0 0 18px;font-size:20px;line-height:1.4;color:${C.ink}">${escapeHtml(i.subject)}</h1>
${paragraphs(i.body)}
${cta}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.line}">
${i.footers.map((f) => `<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${C.muted}">${escapeHtml(f)}</p>`).join('')}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    i.subject,
    '',
    i.body,
    ...(i.cta ? ['', `${i.cta.label}: ${i.cta.url}`] : []),
    '',
    '—',
    ...i.footers,
  ].join('\n');
  return { html, text };
}
