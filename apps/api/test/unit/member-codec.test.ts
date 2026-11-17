import { describe, expect, it } from 'vitest';
import { decodeMember, encodeMember } from '../../src/modules/rankings/member-codec.js';

/** Redis 는 같은 점수의 멤버를 바이트 순서로 비교하고, ZREVRANGE 는 큰 멤버를 먼저 준다 */
const byteDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

describe('랭킹 멤버 인코딩', () => {
  it('기록 순서가 빠를수록 ZREVRANGE 에서 먼저 나온다', () => {
    const members = [encodeMember(30, 1), encodeMember(2, 999), encodeMember(10, 5)];
    expect(members.sort(byteDesc).map((m) => decodeMember(m).seq)).toEqual([2, 10, 30]);
  });

  it('자릿수가 달라도(9 vs 10) 순서가 뒤집히지 않는다', () => {
    expect(
      [encodeMember(10, 1), encodeMember(9, 2)].sort(byteDesc).map((m) => decodeMember(m).seq),
    ).toEqual([9, 10]);
  });

  it('userId 체계와 무관 (큰 ID·작은 ID 섞여도 seq 만으로 결정)', () => {
    const a = encodeMember(1, 9_000_000_000);
    const b = encodeMember(2, 1);
    expect([b, a].sort(byteDesc)[0]).toBe(a);
  });

  it('왕복', () => {
    expect(decodeMember(encodeMember(123_456_789_012, 42))).toEqual({
      seq: 123_456_789_012,
      userId: 42,
    });
  });

  it('범위를 벗어난 seq 는 거부', () => {
    expect(() => encodeMember(-1, 1)).toThrow(RangeError);
    expect(() => encodeMember(1e15, 1)).toThrow(RangeError);
  });
});
