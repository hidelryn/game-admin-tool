import { isDeadlockError } from './errors.js';

/**
 * 데드락은 InnoDB 가 한쪽 트랜잭션을 롤백시킨 것 → 같은 작업을 다시 시도하면 대부분 성공 (architecture.md 7.2)
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isDeadlockError(err)) throw err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
    }
  }
}
