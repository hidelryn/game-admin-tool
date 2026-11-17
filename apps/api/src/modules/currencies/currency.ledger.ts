import { and, eq, sql } from 'drizzle-orm';
import { ErrorCode, type CurrencySource } from '@game-admin/shared';
import { BusinessRuleError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import { currencyTransactions, userCurrencies } from '../../infra/db/schema/index.js';

export interface CurrencyChange {
  userId: number;
  currencyId: number;
  maxBalance: number;
  /** 양수 = 지급, 음수 = 회수 */
  delta: number;
  source: CurrencySource;
  reason: string | null;
  adminId: number | null;
  channel: string | null;
  requestId: string | null;
  mailId?: number | null;
}

/**
 * 재화 변경의 유일한 진입점 — 반드시 트랜잭션(tx) 안에서 호출 (database.md 4.1)
 *
 * 1. 잔액 행을 INSERT ... ON DUPLICATE KEY UPDATE 로 확보 (이미 있으면 X 잠금 획득)
 *    ※ INSERT IGNORE 는 공유 잠금(S)을 잡아 동시 요청끼리 데드락이 나므로 쓰지 않는다
 * 2. SELECT ... FOR UPDATE 로 현재 잔액 확인 → 동시 지급·회수가 직렬화된다
 * 3. 음수 잔액·최대 보유량 검증
 * 4. 잔액 갱신 + 원장 기록 (변경 전/후 잔액)
 */
export async function applyCurrencyChange(tx: Executor, c: CurrencyChange) {
  const key = and(eq(userCurrencies.userId, c.userId), eq(userCurrencies.currencyId, c.currencyId));

  await tx
    .insert(userCurrencies)
    .values({ userId: c.userId, currencyId: c.currencyId, balance: 0, version: 0 })
    .onDuplicateKeyUpdate({ set: { balance: sql`${userCurrencies.balance}` } });

  const [row] = await tx
    .select({ balance: userCurrencies.balance })
    .from(userCurrencies)
    .where(key)
    .for('update');
  const balanceBefore = row!.balance;
  const balanceAfter = balanceBefore + c.delta;

  if (balanceAfter < 0) {
    throw new BusinessRuleError(ErrorCode.INSUFFICIENT_BALANCE, '보유 재화가 부족합니다.', {
      balance: balanceBefore,
      requested: -c.delta,
    });
  }
  if (balanceAfter > c.maxBalance) {
    throw new BusinessRuleError(ErrorCode.EXCEEDS_MAX_BALANCE, '최대 보유량을 초과합니다.', {
      balance: balanceBefore,
      requested: c.delta,
      maxBalance: c.maxBalance,
    });
  }

  await tx
    .update(userCurrencies)
    .set({ balance: balanceAfter, version: sql`${userCurrencies.version} + 1` })
    .where(key);

  const [created] = await tx
    .insert(currencyTransactions)
    .values({
      userId: c.userId,
      currencyId: c.currencyId,
      delta: c.delta,
      balanceBefore,
      balanceAfter,
      source: c.source,
      reason: c.reason,
      adminId: c.adminId,
      channel: c.channel,
      mailId: c.mailId ?? null,
      requestId: c.requestId,
    })
    .$returningId();

  return { transactionId: created!.id, balanceBefore, balanceAfter };
}
