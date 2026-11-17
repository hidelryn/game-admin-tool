/**
 * 대량 지급 파일(CSV·엑셀) 읽기와 검증 — 전부 브라우저에서 처리, 파일은 서버로 올리지 않는다
 *
 * 열: 회원ID · 재화 · 수량 · 사유 (4개 모두 필수)
 * - 첫 줄이 머리글이면 열 이름으로 위치를 찾고(순서 무관), 없으면 위 순서로 읽는다
 * - 재화는 코드(GOLD, 대소문자 무시) 또는 이름(골드)
 * - 한 회원에게 여러 재화를 줄 수 있고, 같은 회원·재화 조합은 중복 불가
 * - 사유는 행마다 원장·감사 로그에 기록
 */
import {
  BULK_GRANT_MAX_ENTRIES,
  BULK_GRANT_MAX_USERS,
  type CurrencyInfo,
} from '@game-admin/shared';
import { cellText as str, type Cell } from '../../shared/file/table-file';

const REASON_MIN = 5;
const REASON_MAX = 200;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,20}$/;
const fmt = (n: number) => n.toLocaleString('ko-KR');

export interface ParsedRow {
  /** 파일 기준 행 번호 (1부터, 머리글 포함) */
  row: number;
  publicId: string;
  /** 확인된 재화 코드, 확인 못 하면 입력값 그대로 */
  currencyCode: string;
  amount: number | null;
  reason: string;
  error?: string;
}

export interface ValidEntry {
  publicId: string;
  currencyCode: string;
  amount: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  entries: ValidEntry[];
  userCount: number;
  errorCount: number;
  /** 재화별 합계 (파일에 처음 나온 순서) */
  totals: { currencyCode: string; amount: number }[];
  hasHeader: boolean;
  /** 행 단위가 아닌 전체 오류 (인원·행 수 초과) */
  fatal?: string;
}

function toAmount(c: Cell): number | null | 'invalid' {
  if (c === null || c === undefined || str(c) === '') return null;
  if (typeof c === 'number') return c;
  const n = Number(str(c).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 'invalid';
}

const HEAD = {
  id: /^(회원|public|user|id$|uid)/i,
  currency: /^(재화|currency|화폐)/i,
  amount: /^(수량|amount|qty|개수)/i,
  reason: /^(사유|reason|비고|메모)/i,
};

interface Columns {
  id: number;
  currency: number;
  amount: number;
  reason: number;
}

const DEFAULT_COLUMNS: Columns = { id: 0, currency: 1, amount: 2, reason: 3 };

/** 첫 줄이 머리글이면 열 위치 (회원 ID 열 이름이 있어야 머리글로 인정, 못 찾은 열은 기본 순서) */
function headerColumns(cells: Cell[]): Columns | null {
  const names = cells.map(str);
  const find = (re: RegExp, fallback: number) => {
    const i = names.findIndex((n) => re.test(n));
    return i === -1 ? fallback : i;
  };
  if (!names.some((n) => HEAD.id.test(n))) return null;
  return {
    id: find(HEAD.id, DEFAULT_COLUMNS.id),
    currency: find(HEAD.currency, DEFAULT_COLUMNS.currency),
    amount: find(HEAD.amount, DEFAULT_COLUMNS.amount),
    reason: find(HEAD.reason, DEFAULT_COLUMNS.reason),
  };
}

/** 코드(대소문자 무시) 또는 이름으로 재화 찾기 */
function resolveCurrency(raw: string, currencies: CurrencyInfo[]): CurrencyInfo | undefined {
  const up = raw.toUpperCase();
  return currencies.find((c) => c.code === up || c.name === raw);
}

export function validateRows(cells: Cell[][], currencies: CurrencyInfo[]): ParseResult {
  const indexed = cells
    .map((c, i) => ({ cells: c, row: i + 1 }))
    .filter((r) => r.cells.some((c) => str(c) !== ''));
  const header = indexed.length > 0 ? headerColumns(indexed[0]!.cells) : null;
  const col = header ?? DEFAULT_COLUMNS;
  const data = header ? indexed.slice(1) : indexed;

  const firstRowOf = new Map<string, number>();
  const rows: ParsedRow[] = data.map(({ cells: c, row }) => {
    const publicId = str(c[col.id]);
    const currencyRaw = str(c[col.currency]);
    const currency = currencyRaw ? resolveCurrency(currencyRaw, currencies) : undefined;
    const rawAmount = toAmount(c[col.amount]);
    const amount = typeof rawAmount === 'number' ? rawAmount : null;
    const reason = str(c[col.reason]).replace(/\s+/g, ' ');
    const currencyCode = currency?.code ?? currencyRaw.toUpperCase();

    let error: string | undefined;
    if (!publicId) error = '회원 ID 없음';
    else if (!PUBLIC_ID.test(publicId)) error = '회원 ID 형식 오류';
    else if (!currencyRaw) error = '재화 없음';
    else if (!currency) error = `알 수 없는 재화: ${currencyRaw}`;
    else if (rawAmount === null) error = '수량 없음';
    else if (rawAmount === 'invalid') error = '수량이 숫자가 아님';
    else if (!Number.isInteger(rawAmount) || rawAmount < 1) error = '수량은 1 이상 정수';
    else if (rawAmount > currency.grantLimitPerRequest)
      error = `${currency.name} 1인당 상한(${fmt(currency.grantLimitPerRequest)}) 초과`;
    else if (!reason) error = '사유 없음';
    else if (reason.length < REASON_MIN) error = `사유는 ${REASON_MIN}자 이상`;
    else if (reason.length > REASON_MAX) error = `사유는 ${REASON_MAX}자 이하`;

    if (!error) {
      const key = `${publicId}|${currencyCode}`;
      const prev = firstRowOf.get(key);
      if (prev !== undefined) error = `중복 (${prev}행과 같은 회원·재화)`;
      else firstRowOf.set(key, row);
    }
    return { row, publicId, currencyCode, amount, reason, error };
  });

  const entries: ValidEntry[] = rows
    .filter((r) => !r.error)
    .map((r) => ({
      publicId: r.publicId,
      currencyCode: r.currencyCode,
      amount: r.amount!,
      reason: r.reason,
    }));
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.currencyCode, (totals.get(e.currencyCode) ?? 0) + e.amount);
  const allUsers = new Set(rows.filter((r) => r.publicId).map((r) => r.publicId)).size;

  let fatal: string | undefined;
  if (rows.length > BULK_GRANT_MAX_ENTRIES)
    fatal = `한 번에 ${fmt(BULK_GRANT_MAX_ENTRIES)}행까지 지급할 수 있습니다. (현재 ${fmt(rows.length)}행)`;
  else if (allUsers > BULK_GRANT_MAX_USERS)
    fatal = `한 번에 ${fmt(BULK_GRANT_MAX_USERS)}명까지 지급할 수 있습니다. (현재 ${fmt(allUsers)}명)`;

  return {
    rows,
    entries,
    userCount: new Set(entries.map((e) => e.publicId)).size,
    errorCount: rows.length - entries.length,
    totals: [...totals].map(([currencyCode, amount]) => ({ currencyCode, amount })),
    hasHeader: header !== null,
    fatal,
  };
}

/** 양식 파일 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM) */
export function downloadTemplate() {
  const csv =
    '\uFEFF회원ID,재화,수량,사유\r\n' +
    'U1000001,GOLD,10000,시즌 1위 보상\r\n' +
    'U1000001,GEM,50,시즌 1위 보상\r\n' +
    'U1000002,FREE_GEM,100,"버그 제보 보상 (문의 #1234, 서버 점검)"\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = '대량지급_양식.csv';
  a.click();
  URL.revokeObjectURL(url);
}
