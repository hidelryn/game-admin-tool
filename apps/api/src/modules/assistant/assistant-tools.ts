import { z } from 'zod';
import {
  churnQuerySchema,
  currencyFlowsQuerySchema,
  listAuditLogsQuerySchema,
  listUsersQuerySchema,
  Permission,
  publicIdSchema,
  purchaseAnalyticsQuerySchema,
  retentionQuerySchema,
  spendingQuerySchema,
  trendsQuerySchema,
  type UserSummary,
} from '@game-admin/shared';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { DashboardService } from '../dashboard/dashboard.service.js';
import type { UserService } from '../users/user.service.js';

/**
 * AI 어시스턴트가 쓸 수 있는 도구 (docs/ai-assistant.md 3장)
 * - 전부 조회 전용. 기존 서비스 함수를 그대로 부르고, 입력은 기존 API 와 같은 zod 스키마로 검증
 * - 도구마다 필요한 권한이 있고, 질문한 운영자에게 그 권한이 없으면 AI 에게 보여 주지도 않는다
 * - 결과에서 개인정보(이메일·IP)는 빼고 넘긴다
 */
export interface ToolDeps {
  dashboardService: DashboardService;
  analyticsService: AnalyticsService;
  userService: UserService;
  auditService: AuditService;
}

export interface AssistantTool {
  name: string;
  /** 진행 표시 ("…조회 중") */
  label: string;
  permission: Permission;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown, ctx: { deps: ToolDeps; actor: AuthContext }): Promise<unknown>;
}

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const range = {
  from: { ...date, description: '시작일 YYYY-MM-DD (KST). 생략하면 to 의 29일 전' },
  to: { ...date, description: '종료일 YYYY-MM-DD (KST). 생략하면 오늘' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const currencyCode = {
  type: 'string',
  enum: ['GOLD', 'GEM', 'STAMINA'],
  description: 'GOLD=골드(무료), GEM=유료 젬, STAMINA=행동력',
};

/** 회원 정보에서 이메일을 빼고 넘긴다 (가상 데이터라도 AI 에게 개인정보는 넘기지 않는 원칙) */
const withoutEmail = ({ email: _email, ...rest }: UserSummary) => rest;

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: 'get_dashboard_summary',
    label: '오늘 지표 조회',
    permission: Permission.DASHBOARD_READ,
    description:
      '오늘(KST 0시~지금)과 어제의 DAU·신규 가입(NRU)·정지 회원 수, 오늘 재화별 발행·소비량을 조회합니다.',
    inputSchema: obj({}),
    run: (_i, { deps }) => deps.dashboardService.summary(),
  },
  {
    name: 'get_kpi_trend',
    label: '지표 추이 조회',
    permission: Permission.DASHBOARD_READ,
    description:
      '일별 지표 추이를 조회합니다. metric: dau(일일 접속자), nru(신규 가입), suspendedTotal(정지 중인 회원 수). 최대 90일.',
    inputSchema: obj(
      { metric: { type: 'string', enum: ['dau', 'nru', 'suspendedTotal'] }, ...range },
      ['metric'],
    ),
    run: (i, { deps }) => deps.dashboardService.trends(trendsQuerySchema.parse(i)),
  },
  {
    name: 'get_currency_flows',
    label: '재화 흐름 조회',
    permission: Permission.DASHBOARD_READ,
    description: '재화의 일별 발행(issued)·소비(consumed)량을 조회합니다. 최대 90일.',
    inputSchema: obj({ currencyCode, ...range }),
    run: (i, { deps }) => deps.dashboardService.currencyFlows(currencyFlowsQuerySchema.parse(i)),
  },
  {
    name: 'analyze_churn',
    label: '이탈 구간 분석',
    permission: Permission.ANALYTICS_READ,
    description:
      '스테이지 10단위 구간별 이탈을 조회합니다. 이탈 = inactiveDays 이상 미접속. churnRate = 그 구간까지 온 회원(reached) 중 그 구간에서 멈춘 채 이탈한(churned) 비율(0~1).',
    inputSchema: obj({
      inactiveDays: { type: 'integer', minimum: 1, maximum: 60, description: '기본 7' },
    }),
    run: (i, { deps }) => deps.analyticsService.churn(churnQuerySchema.parse(i)),
  },
  {
    name: 'analyze_retention',
    label: '리텐션 분석',
    permission: Permission.ANALYTICS_READ,
    description:
      '가입일별 코호트가 가입 후 1·3·7·14·30일째 다시 접속한 비율(0~1)을 조회합니다. 아직 그날이 안 왔으면 null.',
    inputSchema: obj(range),
    run: (i, { deps }) => deps.analyticsService.retention(retentionQuerySchema.parse(i)),
  },
  {
    name: 'analyze_purchases',
    label: '결제 분석',
    permission: Permission.ANALYTICS_READ,
    description:
      '기간 매출(원)·결제 건수·결제 회원·결제율(payerRate 0~1)·ARPPU, 스테이지 구간별 첫 결제·매출, 첫 결제가 가입 며칠째였는지, 상품별 판매를 조회합니다.',
    inputSchema: obj(range),
    run: (i, { deps }) => deps.analyticsService.purchases(purchaseAnalyticsQuerySchema.parse(i)),
  },
  {
    name: 'analyze_spending',
    label: '재화 소비처 분석',
    permission: Permission.ANALYTICS_READ,
    description:
      '재화를 어디에(소비 사유별, share 0~1) 그리고 어느 진행 구간 회원이 많이 썼는지 조회합니다.',
    inputSchema: obj({ currencyCode, ...range }),
    run: (i, { deps }) => deps.analyticsService.spending(spendingQuerySchema.parse(i)),
  },
  {
    name: 'search_users',
    label: '회원 검색',
    permission: Permission.USER_READ,
    description:
      '회원 목록을 조회합니다. publicId(정확히) 또는 nickname(앞부분 일치), 상태, 가입일 범위로 거를 수 있습니다. 최대 20명.',
    inputSchema: obj({
      publicId: { type: 'string', description: '예: U1000001' },
      nickname: { type: 'string', description: '닉네임 앞부분' },
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'WITHDRAWN'] },
      registeredFrom: date,
      registeredTo: date,
      sort: { type: 'string', enum: ['registeredAt:desc', 'registeredAt:asc', 'lastLoginAt:desc'] },
    }),
    async run(i, { deps }) {
      const q = listUsersQuerySchema.parse({ ...(i as object), page: 1, size: 20 });
      const { items, meta } = await deps.userService.list(q);
      return { items: items.map(withoutEmail), meta };
    },
  },
  {
    name: 'get_user',
    label: '회원 상세 조회',
    permission: Permission.USER_READ,
    description: '회원 한 명의 레벨·상태·재화 잔액·진행 중인 정지·최근 활동을 조회합니다.',
    inputSchema: obj({ publicId: { type: 'string', description: '예: U1000001' } }, ['publicId']),
    async run(i, { deps }) {
      const { publicId } = z.object({ publicId: publicIdSchema }).parse(i);
      const d = await deps.userService.detail(publicId);
      const { email: _email, ...rest } = d;
      return rest;
    },
  },
  {
    name: 'list_audit_logs',
    label: '운영 로그 조회',
    permission: Permission.AUDIT_READ,
    description:
      '운영자가 한 작업 기록(누가·언제·무엇을·왜)을 최근 순으로 최대 30건 조회합니다. action 예: CURRENCY_GRANT, MAIL_SEND, USER_SUSPEND, EMAIL_SEND. targetType=USER 이면 targetId 는 회원 publicId.',
    inputSchema: obj({
      action: { type: 'string' },
      targetType: { type: 'string' },
      targetId: { type: 'string' },
      result: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
      from: { ...date, description: '시작일 (UTC 0시 기준)' },
      to: { ...date, description: '종료일 (UTC 0시 기준)' },
    }),
    async run(i, { deps, actor }) {
      const q = listAuditLogsQuerySchema.parse({ ...(i as object), size: 30 });
      const { items } = await deps.auditService.list(actor, q);
      // IP·변경 전후 원본은 빼고 (개인정보·긴 자유 텍스트)
      return items.map(({ ip: _ip, before: _b, after: _a, requestId: _r, ...rest }) => rest);
    },
  },
];

/** 질문한 운영자가 쓸 수 있는 도구만 */
export const toolsFor = (actor: AuthContext) =>
  ASSISTANT_TOOLS.filter((t) => actor.permissions.has(t.permission));
