import { describe, expect, it } from 'vitest';
import { sniffImage } from '../../src/modules/assets/image-sniff.js';

/** Pillow 로 만든 아주 작은 실제 이미지 (base64) */
const FIXTURES = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4XmNgwAQAABQAAQG0wHIAAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==',
  jpegProgressive:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAYDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfg//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQA//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Qf//Z',
  webpLossless: 'UklGRhoAAABXRUJQVlA4TA4AAAAvBgABAAcQEf0PRET/Aw==',
  webpLossy: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoJAAgAAsBMJaQAA3AA/vgfgAA=',
  webpAlpha:
    'UklGRkgAAABXRUJQVlA4WAoAAAAQAAAAAwAAAgAAQUxQSAoAAAABB1CFiAhERP8DVlA4IBgAAAAwAQCdASoEAAMAAUAmJaQAA3AA/v02aAA=',
};
const buf = (k: keyof typeof FIXTURES) => Buffer.from(FIXTURES[k], 'base64');

describe('이미지 판별 (매직 바이트)', () => {
  it.each([
    ['png', 'image/png', 3, 2],
    ['jpeg', 'image/jpeg', 5, 4],
    ['jpegProgressive', 'image/jpeg', 6, 3],
    ['webpLossless', 'image/webp', 7, 5],
    ['webpLossy', 'image/webp', 9, 8],
    ['webpAlpha', 'image/webp', 4, 3],
  ] as const)('%s → 형식과 가로·세로', (k, mime, width, height) => {
    expect(sniffImage(buf(k))).toMatchObject({ mime, width, height });
  });

  it.each([
    [
      'SVG (스크립트 가능)',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
    ['확장자만 PNG 인 HTML', '<html><script>alert(1)</script></html>'],
    ['빈 파일', ''],
    ['GIF', 'GIF89a\x01\x00\x01\x00'],
  ])('거부: %s', (_, text) => {
    expect(sniffImage(Buffer.from(text, 'latin1'))).toBeNull();
  });

  it('PNG 시그니처만 있고 뒤가 잘린 파일은 거부', () => {
    expect(sniffImage(buf('png').subarray(0, 20))).toBeNull();
  });

  it('앞부분은 JPEG 인데 가로·세로 정보(SOF) 전에 끝나면 거부', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
