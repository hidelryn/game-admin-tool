/**
 * 통계 날짜 유틸 — 운영 기준 시간대(기본 KST, 고정 오프셋)로 하루를 나눈다.
 * 한국은 서머타임이 없어 고정 오프셋으로 충분하다.
 */
const DAY_MS = 86_400_000;

/** Date → 기준 시간대의 'YYYY-MM-DD' */
export function statDateOf(date: Date, offsetMin: number): string {
  return new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 그날 0시~다음날 0시 (UTC 시각) */
export function dayRange(statDate: string, offsetMin: number): { start: Date; end: Date } {
  const [y, m, d] = statDate.split('-').map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, m - 1, d) - offsetMin * 60_000);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function addDays(statDate: string, days: number): string {
  const [y, m, d] = statDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** from ~ to (포함) 날짜 목록 */
export function dateList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * DB(DATETIME, 초 단위)에 쓸 시각은 초 단위로 내림
 * MySQL 은 밀리초를 버리지 않고 **반올림**해서 저장하므로, 그대로 넣으면 최대 0.5초 미래가 된다
 * → "지금 시작/종료" 를 넣고 바로 비교하면 아직 시작 전·종료 전으로 판정되는 문제가 생김
 */
export const floorToSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
