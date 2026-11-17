import type { z } from 'zod';
import { ErrorCode } from '@game-admin/shared';
import { AppError } from '../errors/app-error.js';

/**
 * 불투명 커서 (base64url JSON). 클라이언트는 내용을 해석하지 않고 그대로 돌려준다.
 */
export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new AppError(400, ErrorCode.INVALID_CURSOR, '잘못된 커서입니다.');
  }
}

/** size+1 개를 조회해 다음 페이지 존재 여부를 판단 */
export function pageOf<T>(rows: T[], size: number, toCursor: (last: T) => unknown) {
  const hasMore = rows.length > size;
  const items = hasMore ? rows.slice(0, size) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(toCursor(last)) : null };
}
