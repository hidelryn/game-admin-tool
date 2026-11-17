/**
 * Redis ZSET 멤버 인코딩 (database.md 4.4)
 *
 * ZSET 점수 = 원점수. 점수가 같으면 Redis 는 멤버를 **바이트 순서**로 정렬하고,
 * ZREVRANGE(높은 순)는 멤버도 역순으로 돌려준다. 그래서 멤버 앞부분에
 * (상한 − 기록순서) 를 고정 길이로 넣어 "먼저 기록한 회원 = 더 큰 문자열 = 상위" 가 되게 한다.
 *
 *   member = <16자리 (10^15 − seq)>:<userId>
 *
 * - seq 는 시즌 내 유일 → 3순위 기준이 필요 없다 (ID 체계·샤딩과 무관)
 * - MySQL 스냅샷은 ORDER BY score DESC, achieved_seq ASC → Redis 와 완전히 같은 순서
 */
const SEQ_LIMIT = 1_000_000_000_000_000; // 10^15 (2^53 미만)
const WIDTH = 16;

export function encodeMember(seq: number, userId: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= SEQ_LIMIT)
    throw new RangeError(`seq out of range: ${seq}`);
  return `${String(SEQ_LIMIT - seq).padStart(WIDTH, '0')}:${userId}`;
}

export function decodeMember(member: string): { seq: number; userId: number } {
  const idx = member.indexOf(':');
  return { seq: SEQ_LIMIT - Number(member.slice(0, idx)), userId: Number(member.slice(idx + 1)) };
}
