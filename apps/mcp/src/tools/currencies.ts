import { z } from 'zod';
import {
  BULK_GRANT_CONFIRM_THRESHOLD,
  BULK_GRANT_MAX_ENTRIES,
  BULK_GRANT_MAX_USERS,
  Permission,
  bulkGrantRequestSchema,
  type BulkGrantResult,
  type CurrencyBalance,
  type CurrencyChangeResult,
  type CurrencyInfo,
  type CurrencyTransaction,
} from '@game-admin/shared';
import { seg, type ApiClient } from '../api-client.js';
import {
  ToolInputError,
  allOf,
  confirmationToken,
  defineTool,
  idempotencyKey,
  num,
  ok,
  publicId,
  reason,
  webOnly,
} from './define.js';

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,20}$/)
  .describe('재화 코드 (list_currencies 로 확인, 예: GOLD·GEM·FREE_GEM·STAMINA)');

const amount = z.number().int().min(1).describe('수량 (1 이상, 재화별 1회 상한 이하면 바로 실행)');

const currencies = async (api: ApiClient) => (await api.get<CurrencyInfo[]>('/currencies')).data;

export const listCurrencies = defineTool({
  name: 'list_currencies',
  title: '재화 목록',
  description:
    '재화 코드·이름·유료 여부·최대 보유량·1회 지급 상한을 조회합니다. 재화 코드를 추측하지 말고 이 결과를 쓰세요.',
  input: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.CURRENCY_READ),
  async run(_a, { api }) {
    const items = await currencies(api);
    return ok(
      items
        .map(
          (c) =>
            `${c.code}(${c.name}${c.isPaid ? ', 유료' : ''}, 1회 상한 ${num(c.grantLimitPerRequest)})`,
        )
        .join(', '),
      { items },
    );
  },
});

export const getUserCurrency = defineTool({
  name: 'get_user_currency',
  title: '회원 재화',
  description: '회원의 재화 잔액과 (선택) 최근 변동 이력을 조회합니다.',
  input: {
    publicId,
    currencyCode: currencyCode.optional(),
    includeHistory: z.boolean().default(false),
    historyLimit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.CURRENCY_READ),
  async run(a, { api }) {
    const [{ data: balances }, master] = await Promise.all([
      api.get<CurrencyBalance[]>(`/users/${seg(a.publicId)}/currencies`),
      currencies(api),
    ]);
    const paid = new Set(master.filter((c) => c.isPaid).map((c) => c.code));
    const rows = balances
      .filter((b) => !a.currencyCode || b.currencyCode === a.currencyCode)
      .map((b) => ({ ...b, isPaid: paid.has(b.currencyCode) }));
    const history = a.includeHistory
      ? (
          await api.get<CurrencyTransaction[]>(`/users/${seg(a.publicId)}/currency-transactions`, {
            size: a.historyLimit,
            currencyCode: a.currencyCode,
          })
        ).data.map((t) => ({
          currencyCode: t.currencyCode,
          delta: t.delta,
          balanceAfter: t.balanceAfter,
          source: t.source,
          reason: t.reason,
          adminName: t.adminName,
          channel: t.channel,
          createdAt: t.createdAt,
        }))
      : undefined;
    return ok(
      `회원 ${a.publicId} 재화: ${rows.map((b) => `${b.currencyCode} ${num(b.balance)}`).join(', ') || '없음'}`,
      { publicId: a.publicId, balances: rows, ...(history ? { history } : {}) },
    );
  },
});

const changeInput = {
  publicId,
  currencyCode,
  amount,
  reason,
  idempotencyKey,
  confirmationToken,
};

export const grantCurrency = defineTool({
  name: 'grant_currency',
  title: '재화 지급',
  description:
    '회원에게 재화를 지급합니다. 1회 상한을 넘거나 유료 재화(GEM)이면 먼저 CONFIRMATION_REQUIRED 와 미리보기가 옵니다 — 사용자 확인 후 같은 입력에 confirmationToken 을 넣어 다시 호출하세요.',
  input: changeInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.CURRENCY_GRANT),
  async run(a, { api }) {
    const { data } = await api.post<CurrencyChangeResult>(
      `/users/${seg(a.publicId)}/currencies/grant`,
      {
        currencyCode: a.currencyCode,
        amount: a.amount,
        reason: a.reason,
        ...(a.confirmationToken ? { confirmationToken: a.confirmationToken } : {}),
      },
      { idempotencyKey: a.idempotencyKey },
    );
    return ok(
      `${a.publicId} 에게 ${data.currencyCode} ${num(data.delta)}개 지급 (${num(data.balanceBefore)} → ${num(data.balanceAfter)})`,
      { ...data },
    );
  },
});

export const deductCurrency = defineTool({
  name: 'deduct_currency',
  title: '재화 회수',
  description:
    '회원의 재화를 회수합니다. 항상 확인이 필요합니다: 첫 호출은 CONFIRMATION_REQUIRED + 잔액 변화 미리보기, 사용자 확인 후 confirmationToken 으로 다시 호출. 잔액보다 많으면 전체 실패(부분 회수 없음).',
  input: changeInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  visible: allOf(Permission.CURRENCY_DEDUCT),
  async run(a, { api }) {
    const { data } = await api.post<CurrencyChangeResult>(
      `/users/${seg(a.publicId)}/currencies/deduct`,
      {
        currencyCode: a.currencyCode,
        amount: a.amount,
        reason: a.reason,
        ...(a.confirmationToken ? { confirmationToken: a.confirmationToken } : {}),
      },
      { idempotencyKey: a.idempotencyKey },
    );
    return ok(
      `${a.publicId} 의 ${data.currencyCode} ${num(Math.abs(data.delta))}개 회수 (${num(data.balanceBefore)} → ${num(data.balanceAfter)})`,
      { ...data },
    );
  },
});

const BULK_WEB_PATH = '/currencies?tab=bulk';

/** MCP 대량 지급: 99명까지 실행, 100명↑·유료 재화는 웹 안내 (mcp-tools.md 2.13, M3) */
export const bulkGrantCurrency = defineTool({
  name: 'bulk_grant_currency',
  title: '재화 대량 지급',
  description:
    `여러 회원에게 한 번에 지급합니다 (전부 성공 또는 전부 실패). 전원 같은 지급은 publicIds+currencyCode+amount+reason, ` +
    `회원마다 다르면 entries 를 쓰세요. 서로 다른 회원 ${BULK_GRANT_CONFIRM_THRESHOLD - 1}명까지만 MCP 로 실행되고, ` +
    `${BULK_GRANT_CONFIRM_THRESHOLD}명 이상이거나 유료 재화(GEM)가 있으면 WEB_ONLY(실행 안 됨)를 돌려줍니다.`,
  input: {
    publicIds: z.array(publicId).min(1).max(BULK_GRANT_MAX_USERS).optional(),
    currencyCode: currencyCode.optional(),
    amount: amount.optional(),
    entries: z
      .array(
        z.object({
          publicId,
          currencyCode: currencyCode.optional(),
          amount,
          reason: reason.optional(),
        }),
      )
      .min(1)
      .max(BULK_GRANT_MAX_ENTRIES)
      .optional()
      .describe('회원마다 재화·수량·사유가 다를 때'),
    reason: reason.optional().describe('전체 공통 사유 (행마다 다르면 entries[].reason)'),
    idempotencyKey,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.CURRENCY_GRANT),
  webPath: BULK_WEB_PATH,
  async run(a, { api }) {
    const { idempotencyKey: key, ...body } = a;
    const parsed = bulkGrantRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ToolInputError(
        'VALIDATION_FAILED',
        parsed.error.issues[0]?.message ?? '입력이 올바르지 않습니다.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const { entries } = parsed.data;
    const paid = new Set((await currencies(api)).filter((c) => c.isPaid).map((c) => c.code));
    const paidUsed = [...new Set(entries.map((e) => e.currencyCode).filter((c) => paid.has(c)))];
    if (paidUsed.length) {
      return webOnly(
        { paidCurrencies: paidUsed, userCount: new Set(entries.map((e) => e.publicId)).size },
        BULK_WEB_PATH,
        `유료 재화(${paidUsed.join(', ')}) 대량 지급은 MCP 로 할 수 없습니다.`,
      );
    }
    const res = await api.post<BulkGrantResult>('/currencies/bulk-grant', body, {
      idempotencyKey: key,
    });
    const r = res.data;
    return ok(
      `${num(r.userCount)}명에게 ${num(r.count)}건 지급했습니다 (${r.totals.map((t) => `${t.currencyCode} ${num(t.amount)}`).join(', ')}).`,
      { ...r },
    );
  },
});
