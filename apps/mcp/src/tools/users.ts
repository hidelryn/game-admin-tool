import { z } from 'zod';
import {
  Permission,
  UserStatus,
  type UserActivity,
  type UserDetail,
  type UserSummary,
} from '@game-admin/shared';
import { seg } from '../api-client.js';
import {
  ToolInputError,
  allOf,
  confirmationToken,
  defineTool,
  num,
  ok,
  publicId,
  q,
  reason,
} from './define.js';

const YEAR_MS = 366 * 86_400_000;

/** MCP 로는 이메일(마스킹 포함)도 내보내지 않는다 */
const slim = (u: UserSummary) => ({
  publicId: u.publicId,
  nickname: u.nickname,
  level: u.level,
  status: u.status,
  registeredAt: u.registeredAt,
  lastLoginAt: u.lastLoginAt,
});

export const searchUser = defineTool({
  name: 'search_user',
  title: '회원 검색',
  description:
    '회원 ID·닉네임(앞부분)·상태·가입 기간으로 회원을 찾습니다. 조건을 하나 이상 넣어야 합니다. 이메일 등 개인정보는 돌려주지 않습니다.',
  input: {
    publicId: publicId.optional(),
    nickname: z.string().trim().min(2).max(30).optional().describe('닉네임 앞부분 (2자 이상)'),
    status: z.nativeEnum(UserStatus).optional(),
    registeredFrom: z.coerce.date().optional().describe('가입일 시작 (ISO 날짜)'),
    registeredTo: z.coerce.date().optional().describe('가입일 끝 (최대 1년 범위)'),
    page: z.number().int().min(1).default(1),
    size: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.USER_READ),
  async run(a, { api }) {
    if (!a.publicId && !a.nickname && !a.status && !a.registeredFrom && !a.registeredTo) {
      throw new ToolInputError('VALIDATION_FAILED', '검색 조건을 하나 이상 넣으세요.');
    }
    if (a.registeredFrom && a.registeredTo) {
      if (a.registeredTo < a.registeredFrom)
        throw new ToolInputError('VALIDATION_FAILED', '가입일 끝이 시작보다 앞입니다.');
      if (a.registeredTo.getTime() - a.registeredFrom.getTime() > YEAR_MS)
        throw new ToolInputError(
          'VALIDATION_FAILED',
          '가입 기간은 최대 1년까지 검색할 수 있습니다.',
        );
    }
    const res = await api.get<UserSummary[]>('/users', a);
    const items = res.data.map(slim);
    const total = Number(res.meta?.total ?? items.length);
    const head = items
      .slice(0, 10)
      .map((u) => `${u.publicId}(${q(u.nickname)}, ${u.status})`)
      .join(', ');
    return ok(
      total ? `회원 ${num(total)}명 중 ${items.length}명: ${head}` : '조건에 맞는 회원이 없습니다.',
      { items, total, page: a.page, size: a.size },
    );
  },
});

export const getUserDetail = defineTool({
  name: 'get_user_detail',
  title: '회원 상세',
  description:
    '회원 기본 정보, 재화 요약, 진행 중 정지(사유·기간), 최근 활동을 조회합니다. 개인정보 원문은 제공하지 않습니다.',
  input: {
    publicId,
    includeActivities: z.boolean().default(false),
    activityLimit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.USER_READ),
  async run(a, { api }) {
    const { data: u } = await api.get<UserDetail>(`/users/${seg(a.publicId)}`);
    const activities = a.includeActivities
      ? (
          await api.get<UserActivity[]>(`/users/${seg(a.publicId)}/activities`, {
            size: a.activityLimit,
          })
        ).data
      : undefined;
    const s = u.activeSuspension;
    const text =
      `회원 ${u.publicId}(${q(u.nickname)}) · Lv.${u.level} · ${u.status}` +
      (s ? ` · 정지 중(${s.endsAt ? `~${s.endsAt.slice(0, 10)}` : '영구'})` : '') +
      ` · 재화 ${u.balances.map((b) => `${b.currencyCode} ${num(b.balance)}`).join(', ') || '없음'}`;
    return ok(text, {
      ...slim(u),
      balances: u.balances,
      activeSuspension: s,
      ...(activities ? { activities } : {}),
    });
  },
});

export const suspendUser = defineTool({
  name: 'suspend_user',
  title: '회원 정지',
  description:
    '회원을 기간(일) 또는 영구 정지합니다. 기간 정지는 바로 실행되고, 영구 정지는 CONFIRMATION_REQUIRED 를 받은 뒤 사용자 확인을 거쳐 confirmationToken 으로 다시 호출해야 실행됩니다.',
  input: {
    publicId,
    durationDays: z.number().int().min(1).max(3650).optional().describe('정지 일수 (영구면 비움)'),
    permanent: z.boolean().default(false).describe('영구 정지 (항상 확인 필요)'),
    reason,
    confirmationToken,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  visible: allOf(Permission.USER_SUSPEND),
  async run(a, { api }) {
    if (a.permanent === (a.durationDays !== undefined)) {
      throw new ToolInputError(
        'VALIDATION_FAILED',
        'durationDays 와 permanent 중 하나만 지정하세요.',
      );
    }
    const { data } = await api.post<{ endsAt?: string | null }>(
      `/users/${seg(a.publicId)}/suspend`,
      {
        ...(a.permanent ? { permanent: true } : { durationDays: a.durationDays }),
        reason: a.reason,
        ...(a.confirmationToken ? { confirmationToken: a.confirmationToken } : {}),
      },
    );
    return ok(
      `회원 ${a.publicId} 을(를) ${a.permanent ? '영구' : `${a.durationDays}일`} 정지했습니다.`,
      { status: 'EXECUTED', publicId: a.publicId, suspension: data ?? null },
    );
  },
});

export const unsuspendUser = defineTool({
  name: 'unsuspend_user',
  title: '회원 정지 해제',
  description: '진행 중인 정지를 해제합니다.',
  input: { publicId, reason },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.USER_SUSPEND),
  async run(a, { api }) {
    await api.post(`/users/${seg(a.publicId)}/unsuspend`, { reason: a.reason });
    return ok(`회원 ${a.publicId} 의 정지를 해제했습니다.`, {
      status: 'EXECUTED',
      publicId: a.publicId,
    });
  },
});
