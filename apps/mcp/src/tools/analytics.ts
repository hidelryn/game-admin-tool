import { z } from 'zod';
import {
  Permission,
  type ChurnReport,
  type PurchaseReport,
  type RetentionReport,
  type SpendingReport,
} from '@game-admin/shared';
import { allOf, defineTool, num, ok, q } from './define.js';

/**
 * 유저 분석 조회 Tool (docs/analytics.md) — 모두 읽기 전용
 * 구간 = 다음 도전 스테이지 10 단위 (예: 11~20 = 최고 클리어 10~19)
 */
const statDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD (KST)');
const range = {
  from: statDate.optional().describe('시작일 (기본: to 의 29일 전)'),
  to: statDate.optional().describe('종료일 (기본: 오늘)'),
};
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const visible = allOf(Permission.ANALYTICS_READ);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const analyzeChurn = defineTool({
  name: 'analyze_churn',
  title: '이탈 구간 분석',
  description:
    '스테이지 구간별로 몇 명이 멈춰서 이탈했는지 조회합니다. 이탈 = inactiveDays 이상 미접속(탈퇴 제외, 가입 후 그 기간이 지난 회원만). 이탈률 = 그 구간까지 온 회원 중 그 구간에서 멈춘 채 이탈한 비율.',
  input: {
    inactiveDays: z.number().int().min(1).max(60).default(7).describe('이탈 기준 미접속 일수'),
  },
  annotations: readOnly,
  visible,
  async run(a, { api }) {
    const { data } = await api.get<ChurnReport>('/analytics/churn', {
      inactiveDays: a.inactiveDays,
    });
    const top = [...data.buckets].sort((x, y) => y.churnRate - x.churnRate).slice(0, 3);
    return ok(
      `${a.inactiveDays}일 기준 이탈 ${num(data.churned)}명 / 판정 ${num(data.evaluated)}명. ` +
        `이탈률 높은 구간: ${top
          .map((b) => `${b.stageFrom}~${b.stageTo} ${pct(b.churnRate)}(${num(b.churned)}명)`)
          .join(', ')}`,
      { ...data },
    );
  },
});

export const analyzeRetention = defineTool({
  name: 'analyze_retention',
  title: '가입 코호트 리텐션',
  description:
    '가입일별 코호트가 가입 후 1·3·7·14·30일째에 다시 접속한 비율을 조회합니다. 아직 그날이 오지 않았으면 null.',
  input: range,
  annotations: readOnly,
  visible,
  async run(a, { api }) {
    const { data } = await api.get<RetentionReport>('/analytics/retention', { ...a });
    const avg = (d: number) => {
      const vals = data.cohorts
        .filter((c) => c.size > 0 && c.rates[d] !== null)
        .map((c) => c.rates[d]!);
      return vals.length ? pct(vals.reduce((s, v) => s + v, 0) / vals.length) : '-';
    };
    return ok(
      `코호트 ${data.cohorts.length}개 평균 리텐션 — ${data.days.map((d) => `D${d} ${avg(d)}`).join(', ')}`,
      { ...data },
    );
  },
});

export const analyzePurchases = defineTool({
  name: 'analyze_purchases',
  title: '과금 분석',
  description:
    '기간 매출·결제자·ARPPU·결제율, 첫 결제가 일어난 스테이지 구간과 가입 후 경과일, 상품별 매출을 조회합니다 (가상 결제 데이터, 원 단위).',
  input: range,
  annotations: readOnly,
  visible,
  async run(a, { api }) {
    const { data } = await api.get<PurchaseReport>('/analytics/purchases', { ...a });
    const topStage = [...data.byStage].sort((x, y) => y.firstPayers - x.firstPayers).slice(0, 3);
    return ok(
      `${data.from}~${data.to} 매출 ${num(data.revenue)}원, 결제자 ${num(data.payers)}명(결제율 ${pct(data.payerRate)}), ARPPU ${num(data.arppu)}원. ` +
        `첫 결제 많은 구간: ${topStage.map((b) => `${b.stageFrom}~${b.stageTo} ${num(b.firstPayers)}명`).join(', ')}`,
      { ...data },
    );
  },
});

export const analyzeSpending = defineTool({
  name: 'analyze_spending',
  title: '재화 소비처 분석',
  description:
    '게임 안에서 재화를 어디(사유)에 얼마나 썼는지, 회원 현재 진행 구간별로 얼마나 썼는지 조회합니다. 운영자 회수는 포함하지 않습니다.',
  input: {
    ...range,
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_]{2,20}$/)
      .default('GOLD')
      .describe('재화 코드 (list_currencies 로 확인)'),
  },
  annotations: readOnly,
  visible,
  async run(a, { api }) {
    const { data } = await api.get<SpendingReport>('/analytics/spending', { ...a });
    return ok(
      `${data.currencyCode} ${data.from}~${data.to} 소비 ${num(data.total)}. ` +
        `사유별: ${data.byReason
          .slice(0, 5)
          .map((r) => `${q(r.reason, 20)} ${pct(r.share)}`)
          .join(', ')}`,
      { ...data },
    );
  },
});
