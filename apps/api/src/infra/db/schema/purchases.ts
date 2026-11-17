import { index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, dt, fk, pk } from './columns.js';

/** 결제 상품 마스터 (가상) — id 고정 */
export const products = mysqlTable('products', {
  id: int('id', { unsigned: true }).primaryKey(),
  code: varchar('code', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  priceKrw: int('price_krw', { unsigned: true }).notNull(),
  gemAmount: int('gem_amount', { unsigned: true }).notNull(),
  sortOrder: int('sort_order', { unsigned: true }).notNull().default(0),
});

/**
 * 결제 기록 (가상 데이터, docs/analytics.md) — append only, FK 없음
 * 결제 시점의 상품 가격·젬 수량·최고 클리어 스테이지를 그대로 남긴다 (상품이 바뀌어도 과거 매출 유지)
 */
export const purchases = mysqlTable(
  'purchases',
  {
    id: pk(),
    userId: fk('user_id').notNull(),
    productId: int('product_id', { unsigned: true }).notNull(),
    priceKrw: int('price_krw', { unsigned: true }).notNull(),
    gemAmount: int('gem_amount', { unsigned: true }).notNull(),
    /** 결제 당시 최고 클리어 스테이지 */
    stage: int('stage', { unsigned: true }).notNull(),
    purchasedAt: dt('purchased_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_purchases_at').on(t.purchasedAt),
    index('idx_purchases_user').on(t.userId, t.purchasedAt),
  ],
);
