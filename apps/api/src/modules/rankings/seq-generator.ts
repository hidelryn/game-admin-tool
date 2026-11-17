/**
 * 랭킹 기록 순서 번호 — 시간 기반 (스노플레이크 방식, database.md 4.4)
 *
 *   seq = (2020-01-01 부터 경과 ms) × 1000 + 서버번호(0~9) × 100 + 순번(0~99)
 *
 * - 중앙 카운터(DB 행·Redis)가 없어 잠금 경합이 없다 → 처리량이 서버 수에 비례
 * - 같은 서버에서는 항상 증가 (시계가 뒤로 가도 마지막 값 이후로 발급)
 * - 서버 간에는 ms 단위로 비교되고, 같은 ms 면 서버번호 순 (시계 오차만큼의 오차는 허용)
 * - 2^53 미만, member-codec 의 SEQ_LIMIT(10^15) 미만 → 2051년까지 사용 가능
 */
export const SEQ_EPOCH_MS = Date.UTC(2020, 0, 1);
const PER_MS = 1000;
const PER_NODE = 100;

export function seqFromTime(ms: number, nodeId = 0, counter = 0): number {
  return (ms - SEQ_EPOCH_MS) * PER_MS + nodeId * PER_NODE + counter;
}

export function createSeqGenerator(nodeId: number, now: () => number = Date.now) {
  if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > 9)
    throw new RangeError(`nodeId must be 0~9: ${nodeId}`);
  let lastMs = 0;
  let counter = 0;
  return {
    next(): number {
      let ms = Math.max(now(), lastMs);
      if (ms === lastMs) {
        counter += 1;
        // 같은 ms 에 100개를 넘으면 논리적으로 다음 ms 로 넘어간다 (단조 증가 유지)
        if (counter >= PER_NODE) {
          ms = lastMs + 1;
          counter = 0;
        }
      } else {
        counter = 0;
      }
      lastMs = ms;
      return seqFromTime(ms, nodeId, counter);
    },
  };
}

export type SeqGenerator = ReturnType<typeof createSeqGenerator>;
