import { asc, eq } from 'drizzle-orm';
import { CurrencySource, ErrorCode, type ProductInfo } from '@game-admin/shared';
import { BusinessRuleError, NotFoundError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import { withDeadlockRetry } from '../../infra/db/retry.js';
import { currencies, products, purchases } from '../../infra/db/schema/index.js';
import { applyCurrencyChange } from '../currencies/currency.ledger.js';
import { getUserOrThrow, isWithdrawn } from '../users/user.repository.js';

/**
 * 가상 결제 (docs/analytics.md) — 게임 서버(시뮬레이터)·체험 모드 가상 활동만 호출한다
 * 결제 기록 + 유료 젬 지급(원장 source=PURCHASE)을 한 트랜잭션으로. 결제 당시 최고 스테이지를 같이 남긴다
 */
export function createPurchaseService(deps: { db: Executor }) {
  const { db } = deps;

  return {
    async products(): Promise<ProductInfo[]> {
      return db
        .select({
          code: products.code,
          name: products.name,
          priceKrw: products.priceKrw,
          gemAmount: products.gemAmount,
        })
        .from(products)
        .orderBy(asc(products.sortOrder));
    },

    async record(publicId: string, productCode: string, at = new Date()) {
      const user = await getUserOrThrow(db, publicId);
      if (isWithdrawn(user))
        throw new BusinessRuleError(ErrorCode.USER_WITHDRAWN, '탈퇴한 회원입니다.');
      const [product] = await db
        .select()
        .from(products)
        .where(eq(products.code, productCode))
        .limit(1);
      if (!product) throw new NotFoundError(ErrorCode.NOT_FOUND, '없는 상품입니다.');
      const [gem] = await db.select().from(currencies).where(eq(currencies.code, 'GEM')).limit(1);
      if (!gem) throw new NotFoundError(ErrorCode.NOT_FOUND, '유료 젬(GEM) 재화가 없습니다.');

      return withDeadlockRetry(() =>
        db.transaction(async (tx) => {
          const [created] = await tx
            .insert(purchases)
            .values({
              userId: user.id,
              productId: product.id,
              priceKrw: product.priceKrw,
              gemAmount: product.gemAmount,
              stage: user.maxStage,
              purchasedAt: at,
            })
            .$returningId();
          const change = await applyCurrencyChange(tx, {
            userId: user.id,
            currencyId: gem.id,
            maxBalance: gem.maxBalance,
            delta: product.gemAmount,
            source: CurrencySource.PURCHASE,
            reason: `상품 구매: ${product.name}`,
            adminId: null,
            channel: null,
            requestId: null,
          });
          return {
            purchaseId: created!.id,
            productCode: product.code,
            priceKrw: product.priceKrw,
            gemAmount: product.gemAmount,
            stage: user.maxStage,
            gemBalance: change.balanceAfter,
          };
        }),
      );
    },
  };
}

export type PurchaseService = ReturnType<typeof createPurchaseService>;
