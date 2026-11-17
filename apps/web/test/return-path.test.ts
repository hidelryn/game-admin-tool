import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../src/shared/auth/return-path';

describe('로그인 후 돌아갈 경로', () => {
  it.each([
    ['/users/U1?tab=mail', '/users/U1?tab=mail'],
    ['/dashboard', '/dashboard'],
  ])('앱 내부 경로 %s 는 그대로', (from, to) => {
    expect(safeReturnPath(from)).toBe(to);
  });

  it.each([
    [undefined],
    [''],
    ['https://evil.example'],
    ['//evil.example/path'],
    ['/\\evil.example'],
    ['javascript:alert(1)'],
  ])('외부 주소·이상한 값 %s 은 / 로 (오픈 리다이렉트 방지)', (from) => {
    expect(safeReturnPath(from)).toBe('/');
  });

  it.each([['/login'], ['/login?x=1'], ['/change-password']])('%s 로는 돌아가지 않는다', (from) => {
    expect(safeReturnPath(from)).toBe('/');
  });
});
