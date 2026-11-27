import { describe, expect, it } from 'vitest';
import type { AssistantChart } from '@game-admin/shared';
import {
  collectNumbers,
  isGrounded,
  ungroundedValues,
} from '../../src/modules/assistant/chart-check.js';
import { compactResult } from '../../src/modules/assistant/assistant.service.js';

describe('차트 숫자 검증', () => {
  const known = collectNumbers({ a: 1234, rows: [{ rate: 0.1234 }, { n: 7 }], s: 'x' });

  it('조회 결과의 숫자를 모은다 (문자열 제외)', () => {
    expect(known).toEqual([1234, 0.1234, 7]);
  });

  it('같은 값, 반올림, ×100(%)은 인정', () => {
    expect(isGrounded(1234, known)).toBe(true);
    expect(isGrounded(1235, known)).toBe(true); // 0.5% 안
    expect(isGrounded(12.3, known)).toBe(true); // 0.1234 → 12.3%
    expect(isGrounded(0.12, known)).toBe(true);
  });

  it('없는 값은 거부', () => {
    expect(isGrounded(1300, known)).toBe(false);
    expect(isGrounded(50, known)).toBe(false);
  });

  it('series 값만 검사 (가로축 값은 검사 안 함)', () => {
    const chart: AssistantChart = {
      type: 'bar',
      title: 't',
      xKey: 'stage',
      series: [{ key: 'v', label: 'v' }],
      data: [
        { stage: 999, v: 7 },
        { stage: 998, v: 4321 },
      ],
    };
    expect(ungroundedValues(chart, known)).toEqual([4321]);
  });
});

describe('도구 결과 길이 제한', () => {
  it('짧으면 그대로', () => {
    expect(compactResult({ a: 1 })).toBe('{"a":1}');
  });

  it('길면 배열 앞쪽만 남기고 생략 표시', () => {
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `row-${i}` })) };
    const s = compactResult(big);
    expect(s.length).toBeLessThanOrEqual(12_000);
    expect(s).toContain('생략');
    expect(s).toContain('row-0');
  });
});
