import { describe, expect, it } from 'vitest';
import {
  createSeqGenerator,
  SEQ_EPOCH_MS,
  seqFromTime,
} from '../../src/modules/rankings/seq-generator.js';

describe('시간 기반 순서 번호', () => {
  it('같은 ms 에 대량 발급해도 유일하고 계속 증가', () => {
    const gen = createSeqGenerator(3, () => SEQ_EPOCH_MS + 1_000);
    const list = Array.from({ length: 10_000 }, () => gen.next());
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((v, i) => i === 0 || v > list[i - 1]!)).toBe(true);
  });

  it('시계가 뒤로 가도 번호는 줄지 않는다', () => {
    let now = SEQ_EPOCH_MS + 5_000;
    const gen = createSeqGenerator(0, () => now);
    const a = gen.next();
    now -= 2_000; // NTP 보정 등으로 시계가 2초 뒤로
    const b = gen.next();
    expect(b).toBeGreaterThan(a);
  });

  it('늦게 발급된 번호가 항상 크다 (다른 서버도 ms 가 다르면)', () => {
    const early = createSeqGenerator(9, () => SEQ_EPOCH_MS + 1_000).next();
    const late = createSeqGenerator(0, () => SEQ_EPOCH_MS + 1_001).next();
    expect(late).toBeGreaterThan(early);
  });

  it('서버 번호가 번호에 들어가 서버 간 충돌이 없다', () => {
    const t = () => SEQ_EPOCH_MS + 42;
    expect(createSeqGenerator(1, t).next()).not.toBe(createSeqGenerator(2, t).next());
  });

  it('2051년에도 member-codec 범위(10^15) 안', () => {
    expect(seqFromTime(Date.UTC(2051, 0, 1), 9, 99)).toBeLessThan(1e15);
  });

  it('서버 번호는 0~9', () => {
    expect(() => createSeqGenerator(10)).toThrow(RangeError);
  });
});
