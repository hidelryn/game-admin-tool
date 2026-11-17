import type { Pool } from 'mysql2/promise';
import { ConflictError } from '../../common/errors/app-error.js';
import { ErrorCode } from '@game-admin/shared';

/**
 * MySQL 이름 잠금(GET_LOCK)으로 구간을 직렬화
 * - 잠금은 전용 연결에서 잡고, fn(보통 트랜잭션)이 **커밋까지 끝난 뒤** 같은 연결에서 해제
 *   → 다음 요청은 앞 요청이 커밋한 데이터를 보고 검사한다
 *   (트랜잭션 안에서 잡고 커밋 전에 풀면, 다음 요청이 아직 커밋 안 된 데이터를 못 보고 통과하는 틈이 생김)
 * - API 서버가 여러 대여도 같은 DB 를 쓰므로 동작
 */
export type NamedLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export function createNamedLock(pool: Pool, timeoutSec = 5): NamedLock {
  return async (name, fn) => {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [name, timeoutSec]);
      if ((rows as { ok: number | null }[])[0]?.ok !== 1) {
        throw new ConflictError(
          ErrorCode.REQUEST_IN_PROGRESS,
          '같은 종류의 변경이 진행 중입니다. 잠시 후 다시 시도하세요.',
        );
      }
      try {
        return await fn();
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => undefined);
      }
    } finally {
      conn.release();
    }
  };
}
