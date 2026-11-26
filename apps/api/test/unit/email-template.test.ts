import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEmail } from '../../src/modules/emails/email-template.js';

const base = { subject: '시즌 2 오픈', body: '안녕하세요', footers: ['자동 발송 메일입니다.'] };

describe('이메일 디자인 틀', () => {
  it('HTML 특수문자는 모두 이스케이프', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('빈 줄은 문단, 한 줄 바꿈은 <br>', () => {
    const { html } = renderEmail({ ...base, body: '첫째\n둘째\n\n\n셋째' });
    expect(html).toContain('첫째<br>둘째');
    // 본문 문단(15px) 2개 — 하단 안내 문단은 제외
    expect(html.match(/<p style="margin:0 0 16px/g)).toHaveLength(2);
  });

  it('제목·본문·안내 문구에 든 태그는 글자로만 보인다', () => {
    const { html } = renderEmail({
      subject: '<img src=x onerror=alert(1)>',
      body: '<script>alert(1)</script>',
      footers: ['<b>안내</b>'],
    });
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('버튼은 있을 때만, 링크도 이스케이프', () => {
    expect(renderEmail(base).html).not.toContain('href=');
    const { html, text } = renderEmail({
      ...base,
      cta: { label: '접속', url: 'https://example.com/?a=1&b="2"' },
    });
    expect(html).toContain('href="https://example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(text).toContain('접속: https://example.com/?a=1&b="2"');
  });

  it('광고 표시는 광고 메일에만', () => {
    expect(renderEmail(base).html).not.toContain('광고</span>');
    expect(renderEmail({ ...base, isAd: true }).html).toContain('광고</span>');
  });

  it('평문 버전에 제목·본문·안내가 다 들어간다', () => {
    const { text } = renderEmail(base);
    expect(text).toContain('시즌 2 오픈');
    expect(text).toContain('안녕하세요');
    expect(text).toContain('자동 발송 메일입니다.');
  });
});
