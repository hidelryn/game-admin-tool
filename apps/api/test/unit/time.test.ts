import { describe, expect, it } from 'vitest';
import { addDays, dateList, dayRange, statDateOf, floorToSecond } from '../../src/common/time.js';

const KST = 540;

describe('통계 날짜 (KST)', () => {
  it('UTC 15시 이후는 KST 다음 날', () => {
    expect(statDateOf(new Date('2026-11-09T14:59:59Z'), KST)).toBe('2026-11-09');
    expect(statDateOf(new Date('2026-11-09T15:00:00Z'), KST)).toBe('2026-11-10');
  });

  it('KST 하루 범위 = 전날 15:00Z ~ 당일 15:00Z', () => {
    const { start, end } = dayRange('2026-11-10', KST);
    expect(start.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-10T15:00:00.000Z');
  });

  it('월말·연말 넘김', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dateList('2026-11-29', '2026-12-02')).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
  });
});

describe('floorToSecond — DATETIME 반올림 대비', () => {
  it('밀리초를 버린다 (반올림 아님 → 미래 시각이 되지 않음)', () => {
    expect(floorToSecond(new Date('2026-11-15T09:49:22.700Z')).toISOString()).toBe(
      '2026-11-15T09:49:22.000Z',
    );
    expect(floorToSecond(new Date('2026-11-15T09:49:22.000Z')).toISOString()).toBe(
      '2026-11-15T09:49:22.000Z',
    );
  });
});
