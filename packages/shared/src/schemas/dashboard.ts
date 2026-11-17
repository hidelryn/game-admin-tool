import { z } from 'zod';

/** 통계 날짜(YYYY-MM-DD, 운영 기준 시간대 = KST) */
export const statDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.');

export const DASHBOARD_MAX_DAYS = 90;

export const trendsQuerySchema = z.object({
  metric: z.enum(['dau', 'nru', 'suspendedTotal']).default('dau'),
  from: statDateSchema.optional(),
  to: statDateSchema.optional(),
});
export type TrendsQuery = z.infer<typeof trendsQuerySchema>;

export const currencyFlowsQuerySchema = z.object({
  currencyCode: z.string().trim().toUpperCase().optional(),
  from: statDateSchema.optional(),
  to: statDateSchema.optional(),
});
export type CurrencyFlowsQuery = z.infer<typeof currencyFlowsQuerySchema>;

export interface DailyKpi {
  date: string;
  dau: number;
  nru: number;
  suspendedTotal: number;
}

export interface CurrencyFlow {
  date: string;
  currencyCode: string;
  issued: number;
  consumed: number;
}

export interface DashboardSummary {
  /** 오늘(KST) 0시부터 지금까지 */
  today: DailyKpi & { currencies: Omit<CurrencyFlow, 'date'>[] };
  yesterday: DailyKpi | null;
  generatedAt: string;
}

export interface TrendPoint {
  date: string;
  value: number;
}
