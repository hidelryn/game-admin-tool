/**
 * MySQL 에러 판별. drizzle 0.44 부터 드라이버 에러가 DrizzleQueryError.cause 로 감싸진다.
 */
function mysqlCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ER_')) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isDuplicateKeyError = (err: unknown) => mysqlCode(err) === 'ER_DUP_ENTRY';
export const isDeadlockError = (err: unknown) => mysqlCode(err) === 'ER_LOCK_DEADLOCK';
