import { z } from 'zod';
import {
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  EmailCampaignStatus,
  Permission,
  type EmailCampaignSummary,
  type EmailSendResult,
} from '@game-admin/shared';
import {
  ToolInputError,
  allOf,
  defineTool,
  idempotencyKey,
  num,
  ok,
  publicId,
  q,
  reason,
} from './define.js';

/**
 * 이메일 (docs/email.md)
 * - 회원 지정 99명까지는 실행, 전체·100명 이상은 WEB_ONLY(미리보기만)
 * - 주소 직접 입력은 MCP 로 불가 — AI 가 임의 외부 주소로 데이터를 내보내는 통로가 되지 않게 (API 도 403)
 */
export const sendEmail = defineTool({
  name: 'send_email',
  title: '이메일 발송',
  description:
    '회원에게 이메일을 보냅니다 (회원 지정 99명까지 바로 처리, 전체 회원·100명 이상은 미리보기와 WEB_ONLY). ' +
    '회원 주소는 가상이라 대부분 "가상 발송"으로 기록됩니다. 광고성이면 isAd=true — 제목에 (광고)가 붙고 수신 동의 회원만, 야간(21~08시)엔 야간 동의 회원만 받습니다. ' +
    '외부 주소로 직접 보내기는 지원하지 않습니다.',
  input: {
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('USERS'), publicIds: z.array(publicId).min(1).max(1000) }),
      z.object({ type: z.literal('ALL') }),
    ]),
    subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX),
    body: z.string().trim().min(1).max(EMAIL_BODY_MAX).describe('평문'),
    isAd: z.boolean().default(false),
    cta: z
      .object({
        label: z.string().trim().min(1).max(30),
        url: z.string().trim().url().startsWith('https://').max(500),
      })
      .optional()
      .describe('본문 아래 버튼 (선택, https 링크만)'),
    scheduledAt: z.coerce.date().optional().describe('예약 시각 (없으면 바로)'),
    reason,
    idempotencyKey,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.EMAIL_SEND),
  webPath: '/emails/new',
  async run(a, { api }) {
    const { idempotencyKey: key, scheduledAt, ...rest } = a;
    const { data } = await api.post<EmailSendResult>(
      '/emails',
      { ...rest, ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}) },
      { idempotencyKey: key },
    );
    if (a.target.type === 'ALL') {
      // 전체 발송은 API 가 웹 전용으로 막는다 → runTool 이 WEB_ONLY 로 바꿈. 여기 오면 이상한 상황
      throw new ToolInputError(
        'UNEXPECTED',
        '전체 이메일이 MCP 로 처리되었습니다. 운영자에게 알리세요.',
      );
    }
    return ok(
      data.status === EmailCampaignStatus.SCHEDULED && scheduledAt
        ? `이메일 #${data.campaignId} 를 ${scheduledAt.toISOString().slice(0, 16)} (UTC) 에 보내도록 예약했습니다.`
        : `이메일 #${data.campaignId} 발송을 시작했습니다 (회원 ${num(a.target.publicIds.length)}명). 결과는 1분 안에 list_email_campaigns 로 확인하세요.`,
      { status: 'EXECUTED', campaignId: data.campaignId, campaignStatus: data.status },
    );
  },
});

export const listEmailCampaigns = defineTool({
  name: 'list_email_campaigns',
  title: '이메일 발송 기록',
  description:
    '최근 이메일 발송 기록과 결과(실제 발송·가상 발송·수신 동의/야간 제외·실패 수)를 조회합니다.',
  input: {
    status: z.nativeEnum(EmailCampaignStatus).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.EMAIL_READ),
  async run(a, { api }) {
    const res = await api.get<EmailCampaignSummary[]>('/emails', {
      status: a.status,
      size: a.limit,
    });
    const items = res.data.map((c) => ({
      id: c.id,
      target: c.targetLabel,
      subject: c.subject,
      isAd: c.isAd,
      status: c.status,
      scheduledAt: c.scheduledAt,
      counts: c.counts,
      createdBy: c.createdBy?.name ?? null,
      channel: c.channel,
    }));
    return ok(
      items.length
        ? `이메일 ${items.length}건: ${items
            .slice(0, 5)
            .map(
              (c) =>
                `#${c.id} ${q(c.subject, 20)} ${c.status} (실제 ${c.counts.sent}·가상 ${c.counts.virtual}·제외 ${c.counts.skipped})`,
            )
            .join(', ')}`
        : '이메일 발송 기록이 없습니다.',
      { items },
    );
  },
});
