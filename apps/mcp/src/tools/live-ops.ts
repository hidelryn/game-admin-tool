import { z } from 'zod';
import {
  NoticeCategory,
  Permission,
  ScheduleKind,
  type GameMaintenanceState,
  type MaintenanceView,
  type NoticeView,
  type ScheduleView,
} from '@game-admin/shared';
import { ToolInputError, allOf, defineTool, idempotencyKey, ok, q, reason } from './define.js';

const DAY = 86_400_000;

export const listSchedules = defineTool({
  name: 'list_schedules',
  title: '스케줄(시즌·이벤트) 조회',
  description:
    '기간과 겹치는 랭킹 시즌·게임 이벤트 일정과 게임 노출(팝업·배너) 설정을 조회합니다. 기본은 오늘부터 30일, 최대 90일. 등록·수정은 웹에서만 합니다.',
  input: {
    from: z.coerce.date().optional().describe('기본 지금'),
    to: z.coerce.date().optional().describe('기본 from + 30일'),
    kind: z.nativeEnum(ScheduleKind).optional(),
    status: z.enum(['SCHEDULED', 'ACTIVE', 'ENDED']).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.SCHEDULE_READ),
  async run(a, { api }) {
    const from = a.from ?? new Date();
    const to = a.to ?? new Date(from.getTime() + 30 * DAY);
    if (to <= from) throw new ToolInputError('VALIDATION_FAILED', 'to 는 from 보다 뒤여야 합니다.');
    if (to.getTime() - from.getTime() > 90 * DAY)
      throw new ToolInputError('VALIDATION_FAILED', '최대 90일까지 조회할 수 있습니다.');
    const { data } = await api.get<ScheduleView[]>('/schedules', { from, to, kind: a.kind });
    // 설명·이미지 URL 은 빼고 (길이·인젝션), 상태 필터는 여기서
    const items = data
      .filter((s) => !a.status || s.status === a.status)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        status: s.status,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        board: s.rankingSeason ? s.rankingSeason.board.code : null,
        popup: { enabled: s.popupEnabled, frequency: s.popupFrequency },
        banner: { enabled: s.bannerEnabled, priority: s.priority },
      }));
    return ok(
      items.length
        ? `일정 ${items.length}개: ${items
            .slice(0, 10)
            .map(
              (s) =>
                `${q(s.title)} ${s.status} ${s.startsAt.slice(0, 10)}~${s.endsAt.slice(0, 10)}`,
            )
            .join(', ')}`
        : '이 기간에 일정이 없습니다.',
      { from: from.toISOString(), to: to.toISOString(), items },
    );
  },
});

export const getMaintenanceStatus = defineTool({
  name: 'get_maintenance_status',
  title: '점검 상태',
  description:
    '지금 게임 점검 중인지(종료 예정 시각), 예정된 점검을 조회합니다. 점검 시작·해제는 웹에서만 할 수 있습니다.',
  input: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: () => true,
  async run(_a, { api, permissions }) {
    const { data: current } = await api.get<GameMaintenanceState>('/maintenances/current');
    const upcoming = permissions.has(Permission.NOTICE_READ)
      ? (await api.get<MaintenanceView[]>('/maintenances', { page: 1, size: 10 })).data
          .filter((m) => m.status === 'SCHEDULED')
          .map((m) => ({
            id: m.id,
            title: m.title,
            startsAt: m.startsAt,
            endsAt: m.endsAt,
            allowedUsers: m.allowPublicIds.length,
          }))
      : null;
    const next = upcoming?.[upcoming.length - 1];
    return ok(
      (current.active
        ? `게임 점검 중: ${q(current.title)} (~${current.endsAt})`
        : '정상 운영 중 (점검 없음)') +
        (next ? ` · 다음 점검 ${q(next.title)} ${next.startsAt}` : ''),
      { current, upcoming },
    );
  },
});

export const listNotices = defineTool({
  name: 'list_notices',
  title: '공지 조회',
  description:
    '게임 공지 목록(분류·게시 기간·상태·고정·로비 한 줄 공지)을 조회합니다. 본문은 includeBody 일 때만 500자까지.',
  input: {
    category: z.nativeEnum(NoticeCategory).optional(),
    includeHidden: z.boolean().default(false),
    includeBody: z.boolean().default(false),
    page: z.number().int().min(1).default(1),
    size: z.number().int().min(1).max(20).default(10),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.NOTICE_READ),
  async run(a, { api }) {
    const res = await api.get<NoticeView[]>('/notices', {
      page: a.page,
      size: a.size,
      category: a.category,
      includeHidden: a.includeHidden ? 'true' : undefined,
    });
    const items = res.data.map((n) => ({
      id: n.id,
      category: n.category,
      title: n.title,
      status: n.status,
      startsAt: n.startsAt,
      endsAt: n.endsAt,
      pinned: n.pinned,
      ticker: n.tickerEnabled ? n.tickerText : null,
      ...(a.includeBody ? { body: n.body.slice(0, 500) } : {}),
    }));
    return ok(
      items.length
        ? `공지 ${items.length}개: ${items.map((n) => `#${n.id} ${q(n.title)} ${n.status}`).join(', ')}`
        : '공지가 없습니다.',
      { items, total: Number(res.meta?.total ?? items.length), page: a.page },
    );
  },
});

export const createNotice = defineTool({
  name: 'create_notice',
  title: '공지 등록',
  description:
    '게임 공지를 등록합니다. 게시 시작 시각이 되면 게임에 바로 보이므로, 호출 전에 제목·본문·기간을 사용자에게 보여 주고 확인을 받으세요. 본문은 평문(HTML 불가). tickerText 를 넣으면 로비 한 줄 공지로도 나갑니다. 수정·내리기는 웹에서.',
  input: {
    category: z.nativeEnum(NoticeCategory),
    title: z.string().trim().min(1).max(60),
    body: z.string().trim().min(1).max(5000),
    startsAt: z.coerce.date().describe('게시 시작 (ISO 시각)'),
    endsAt: z.coerce.date().nullable().default(null).describe('게시 종료 (비우면 내릴 때까지)'),
    pinned: z.boolean().default(false),
    tickerText: z.string().trim().min(1).max(80).optional(),
    reason,
    idempotencyKey,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  visible: allOf(Permission.NOTICE_MANAGE),
  async run(a, { api }) {
    if (a.endsAt && a.endsAt <= a.startsAt)
      throw new ToolInputError('VALIDATION_FAILED', '게시 종료는 시작보다 뒤여야 합니다.');
    const { data } = await api.post<NoticeView>(
      '/notices',
      {
        category: a.category,
        title: a.title,
        body: a.body,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt ? a.endsAt.toISOString() : null,
        pinned: a.pinned,
        tickerEnabled: !!a.tickerText,
        tickerText: a.tickerText ?? null,
        reason: a.reason,
      },
      { idempotencyKey: a.idempotencyKey },
    );
    return ok(
      `공지 #${data.id} ${q(data.title)} 를 등록했습니다 (${data.status}, ${data.startsAt}부터).`,
      {
        status: 'EXECUTED',
        noticeId: data.id,
        noticeStatus: data.status,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
      },
    );
  },
});
