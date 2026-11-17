import { z } from 'zod';
import {
  Channel,
  MAIL_MAX_RECIPIENTS_MCP,
  MAIL_MAX_REWARDS,
  Permission,
  RewardType,
  type AuditLogItem,
  type MailSent,
} from '@game-admin/shared';
import {
  ToolInputError,
  allOf,
  anyOf,
  defineTool,
  idempotencyKey,
  num,
  ok,
  publicId,
  reason,
} from './define.js';

const DAY = 86_400_000;

export const sendMail = defineTool({
  name: 'send_mail',
  title: '우편 발송',
  description:
    `회원 우편함으로 우편(보상 포함 가능)을 보냅니다. target.type=USERS 는 최대 ${MAIL_MAX_RECIPIENTS_MCP}명까지 바로 발송. ` +
    'target.type=ALL(전체 우편)은 MCP 로 실행할 수 없어 미리보기와 함께 WEB_ONLY 를 돌려줍니다.',
  input: {
    target: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('USERS'),
        publicIds: z.array(publicId).min(1).max(MAIL_MAX_RECIPIENTS_MCP),
      }),
      z.object({
        type: z.literal('ALL'),
        registeredBefore: z.coerce.date().optional().describe('이 시각 이전 가입자만'),
      }),
    ]),
    title: z.string().trim().min(1).max(50),
    body: z.string().trim().min(1).max(500).describe('평문'),
    rewards: z
      .array(
        z.object({
          type: z.nativeEnum(RewardType),
          code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9_]{2,40}$/),
          quantity: z.number().int().min(1),
        }),
      )
      .max(MAIL_MAX_REWARDS)
      .default([]),
    expiresInDays: z.number().int().min(1).max(30).default(7),
    reason,
    idempotencyKey,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: anyOf(Permission.MAIL_SEND, Permission.MAIL_SEND_ALL),
  webPath: '/mails/new',
  async run(a, { api }) {
    const content = {
      title: a.title,
      body: a.body,
      rewards: a.rewards,
      expiresInDays: a.expiresInDays,
      reason: a.reason,
    };
    if (a.target.type === 'ALL') {
      // API 가 웹 전용(L3)으로 막고 미리보기를 돌려준다 → runTool 이 WEB_ONLY 로 변환
      await api.post(
        '/mails/global',
        {
          ...content,
          ...(a.target.registeredBefore
            ? { targetFilter: { registeredBefore: a.target.registeredBefore.toISOString() } }
            : {}),
        },
        { idempotencyKey: a.idempotencyKey },
      );
      throw new ToolInputError(
        'UNEXPECTED',
        '전체 우편이 MCP 로 처리되었습니다. 운영자에게 알리세요.',
      );
    }
    const { data } = await api.post<MailSent>(
      '/mails',
      { ...content, publicIds: a.target.publicIds },
      { idempotencyKey: a.idempotencyKey },
    );
    return ok(`우편 #${data.mailId} 를 ${num(data.recipientCount)}명에게 보냈습니다.`, {
      status: 'EXECUTED',
      mailId: data.mailId,
      recipientCount: data.recipientCount,
    });
  },
});

export const getOperationLogs = defineTool({
  name: 'get_operation_logs',
  title: '운영 이력',
  description:
    '누가 언제 무엇을 했는지(운영 로그)를 조회합니다. 기간은 최대 90일. 변경 전후 상세는 웹에서 확인하세요.',
  input: {
    adminId: z.number().int().positive().optional(),
    action: z.string().trim().max(50).optional().describe('예: CURRENCY_GRANT, MAIL_SEND'),
    targetType: z.string().trim().max(30).optional().describe('예: USER, MAIL, RANKING_SEASON'),
    targetId: z.string().trim().max(64).optional().describe('회원이면 회원 ID'),
    channel: z.nativeEnum(Channel).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.AUDIT_READ),
  async run(a, { api }) {
    if (a.from && a.to && a.to.getTime() - a.from.getTime() > 90 * DAY)
      throw new ToolInputError('VALIDATION_FAILED', '기간은 최대 90일까지 조회할 수 있습니다.');
    const { limit, ...rest } = a;
    const res = await api.get<AuditLogItem[]>('/audit-logs', { ...rest, size: limit });
    const items = res.data.map((l) => ({
      id: l.id,
      adminName: l.admin?.name ?? null,
      channel: l.channel,
      action: l.action,
      targetType: l.targetType,
      targetId: l.targetId,
      reason: l.reason,
      result: l.result,
      createdAt: l.createdAt,
    }));
    return ok(
      items.length
        ? `운영 로그 ${items.length}건 (최근: ${items
            .slice(0, 5)
            .map((l) => `${l.createdAt.slice(0, 16)} ${l.adminName ?? 'SYSTEM'} ${l.action}`)
            .join(', ')})`
        : '조건에 맞는 운영 로그가 없습니다.',
      { items, nextCursor: (res.meta?.nextCursor as string | null | undefined) ?? null },
    );
  },
});
