import dayjs from 'dayjs';

export const fmtNumber = (n: number | null | undefined) =>
  n === null || n === undefined ? '-' : n.toLocaleString('ko-KR');
export const fmtDateTime = (v: string | null | undefined) =>
  v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-';
export const fmtDate = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : '-');
export const fmtSigned = (n: number) => (n > 0 ? `+${fmtNumber(n)}` : fmtNumber(n));
