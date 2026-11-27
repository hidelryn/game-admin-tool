import type { AssistantChart } from '@game-admin/shared';

/**
 * 차트 숫자 검증 (docs/ai-assistant.md 4장)
 * AI 가 차트 값을 지어내지 못하도록, 차트의 모든 숫자가 이번 질문에서 조회한 결과 안에 있는지 확인한다.
 * - 비율은 0~1 로 오지만 AI 가 % 로 바꿔 그릴 수 있으므로 ×100(소수 1자리 반올림)도 인정
 * - 반올림 오차는 0.5% 또는 0.01 까지 인정
 */
export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.01);

export function isGrounded(v: number, known: readonly number[]): boolean {
  return known.some((n) => close(v, n) || close(v, n * 100));
}

/** 근거 없는 숫자 목록 (없으면 빈 배열) */
export function ungroundedValues(chart: AssistantChart, known: readonly number[]): number[] {
  const keys = new Set(chart.series.map((s) => s.key));
  const bad: number[] = [];
  for (const row of chart.data) {
    for (const [k, v] of Object.entries(row)) {
      if (!keys.has(k) || typeof v !== 'number') continue;
      if (!isGrounded(v, known)) bad.push(v);
    }
  }
  return bad;
}
