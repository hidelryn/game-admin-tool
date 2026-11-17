/**
 * 표 형식 파일(CSV·엑셀) 읽기 — 브라우저에서만 처리, 서버로 올리지 않는다
 * 대량 지급·우편 대상 업로드가 같이 쓴다
 */
export type Cell = string | number | boolean | Date | null | undefined;

export const TABLE_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** 파일 → 셀 2차원 배열 */
export async function readTableFile(file: File): Promise<Cell[][]> {
  if (file.size > TABLE_FILE_MAX_BYTES) throw new Error('파일은 2MB 까지 올릴 수 있습니다.');
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    // 엑셀 파서는 필요할 때만 불러온다 (첫 화면 번들 크기 유지)
    const { default: readXlsxFile } = await import('read-excel-file');
    return (await readXlsxFile(file)) as Cell[][];
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return parseDelimited(decodeText(await file.arrayBuffer()));
  }
  throw new Error(
    'CSV(.csv) 또는 엑셀(.xlsx) 파일만 올릴 수 있습니다. 예전 엑셀(.xls)은 .xlsx 로 다시 저장하세요.',
  );
}

/** UTF-8 이 아니면 EUC-KR(한글 엑셀의 "CSV로 저장" 기본값)로 읽는다 */
function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

/**
 * CSV·TSV 파서 (따옴표 안의 구분자·줄바꿈, "" 이스케이프 지원)
 * 엑셀에서 복사해 붙여넣으면 탭 구분이므로 첫 줄에 탭이 있으면 탭으로 나눈다
 */
export function parseDelimited(input: string): Cell[][] {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = firstLine.includes('\t')
    ? '\t'
    : firstLine.includes(';') && !firstLine.includes(',')
      ? ';'
      : ',';

  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const cellText = (c: Cell) =>
  (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString() : String(c)).trim();
