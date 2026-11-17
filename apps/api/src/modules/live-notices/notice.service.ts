import { and, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  ErrorCode,
  NOTICE_TICKER_MAX,
  NoticeStatus,
  noticeStatusOf,
  type CreateNoticeRequest,
  type GameNotice,
  type HideNoticeRequest,
  type ListNoticesQuery,
  type NoticeCategory,
  type NoticeView,
  type UpdateNoticeRequest,
} from '@game-admin/shared';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import { floorToSecond } from '../../common/time.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import { admins, notices } from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';

type NoticeRow = typeof notices.$inferSelect;

const EDITABLE = [
  'category',
  'title',
  'body',
  'startsAt',
  'endsAt',
  'pinned',
  'tickerEnabled',
  'tickerText',
] as const;

export const noticeSnapshot = (r: Pick<NoticeRow, (typeof EDITABLE)[number]>) =>
  Object.fromEntries(
    EDITABLE.map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]]),
  );

/** 게시 중: 숨기지 않았고 시작했고 끝나지 않음 */
const publishedAt = (at: Date): SQL =>
  and(
    isNull(notices.hiddenAt),
    sql`${notices.startsAt} <= ${at}`,
    or(isNull(notices.endsAt), gt(notices.endsAt, at)),
  )!;

/** 본문: 평문 그대로 저장 (HTML 을 지우거나 바꾸지 않음 — 게임은 글자로만 그린다). 줄바꿈만 통일 */
const normalizeBody = (s: string) => s.replace(/\r\n?/g, '\n');

/**
 * 공지 (docs/maintenance-notice.md 5장)
 * - 등록·수정·내리기 모두 L1 (사유 필수, 감사 로그)
 * - 점검과 연결된 공지도 직접 고칠 수 있다. 점검 시간을 바꾸면 기간·문구가 다시 맞춰진다
 */
export function createNoticeService(deps: { db: Executor }) {
  const { db } = deps;

  async function load(id: number): Promise<NoticeRow> {
    const [row] = await db.select().from(notices).where(eq(notices.id, id)).limit(1);
    if (!row) throw new NotFoundError(ErrorCode.NOTICE_NOT_FOUND, '공지를 찾을 수 없습니다.');
    return row;
  }

  async function toViews(rows: NoticeRow[]): Promise<NoticeView[]> {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]))];
    const names = await db
      .select({ id: admins.id, name: admins.name })
      .from(admins)
      .where(inArray(admins.id, ids));
    const nameOf = new Map(names.map((a) => [a.id, a.name]));
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      category: r.category as NoticeCategory,
      title: r.title,
      body: r.body,
      startsAt: iso(r.startsAt),
      endsAt: isoOrNull(r.endsAt),
      status: noticeStatusOf(r, now),
      pinned: r.pinned,
      tickerEnabled: r.tickerEnabled,
      tickerText: r.tickerText,
      hiddenAt: isoOrNull(r.hiddenAt),
      maintenanceId: r.maintenanceId,
      createdBy: { id: r.createdBy, name: nameOf.get(r.createdBy) ?? '' },
      updatedBy: { id: r.updatedBy, name: nameOf.get(r.updatedBy) ?? '' },
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      version: r.version,
    }));
  }

  function bodyOf(input: CreateNoticeRequest | UpdateNoticeRequest) {
    return {
      category: input.category,
      title: input.title,
      body: normalizeBody(input.body),
      startsAt: floorToSecond(input.startsAt),
      endsAt: input.endsAt ? floorToSecond(input.endsAt) : null,
      pinned: input.pinned,
      tickerEnabled: input.tickerEnabled,
      tickerText: input.tickerEnabled ? input.tickerText : (input.tickerText ?? null),
    };
  }

  async function updateVersioned(tx: Executor, row: NoticeRow, set: Partial<NoticeRow>) {
    const r = await tx
      .update(notices)
      .set({ ...set, version: row.version + 1 })
      .where(and(eq(notices.id, row.id), eq(notices.version, row.version)));
    if (affectedRows(r) !== 1) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 공지를 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
      );
    }
  }

  function assertVersion(row: NoticeRow, version: number) {
    if (row.version !== version) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 공지를 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
        { currentVersion: row.version },
      );
    }
  }

  return {
    async list(q: ListNoticesQuery) {
      const conds: SQL[] = [];
      if (q.category) conds.push(eq(notices.category, q.category));
      if (!q.includeHidden) conds.push(isNull(notices.hiddenAt));
      const where = conds.length ? and(...conds) : undefined;
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(notices)
          .where(where)
          .orderBy(desc(notices.startsAt), desc(notices.id))
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(notices).where(where),
      ]);
      return {
        items: await toViews(rows),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    async get(id: number): Promise<NoticeView> {
      return (await toViews([await load(id)]))[0]!;
    },

    async create(
      actor: AuthContext,
      input: CreateNoticeRequest,
      audit: AuditContext,
      record?: (tx: Executor, id: number) => Promise<void>,
    ): Promise<NoticeView> {
      const body = bodyOf(input);
      const id = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(notices)
          .values({ ...body, createdBy: actor.adminId, updatedBy: actor.adminId })
          .$returningId();
        await writeAudit(tx, audit, {
          action: AuditAction.NOTICE_CREATE,
          targetType: AuditTargetType.NOTICE,
          targetId: created!.id,
          reason: input.reason,
          after: noticeSnapshot(body),
        });
        if (record) await record(tx, created!.id);
        return created!.id;
      });
      return (await toViews([await load(id)]))[0]!;
    },

    async update(
      actor: AuthContext,
      id: number,
      input: UpdateNoticeRequest,
      audit: AuditContext,
    ): Promise<NoticeView> {
      const row = await load(id);
      if (row.hiddenAt)
        throw new BusinessRuleError(ErrorCode.NOTICE_NOT_EDITABLE, '내린 공지는 바꿀 수 없습니다.');
      assertVersion(row, input.version);
      const body = bodyOf(input);
      await db.transaction(async (tx) => {
        await updateVersioned(tx, row, { ...body, updatedBy: actor.adminId });
        await writeAudit(tx, audit, {
          action: AuditAction.NOTICE_UPDATE,
          targetType: AuditTargetType.NOTICE,
          targetId: id,
          reason: input.reason,
          before: noticeSnapshot(row),
          after: noticeSnapshot(body),
        });
      });
      return (await toViews([await load(id)]))[0]!;
    },

    async hide(
      actor: AuthContext,
      id: number,
      input: HideNoticeRequest,
      audit: AuditContext,
    ): Promise<NoticeView> {
      const row = await load(id);
      if (row.hiddenAt)
        throw new BusinessRuleError(ErrorCode.NOTICE_NOT_EDITABLE, '이미 내린 공지입니다.');
      assertVersion(row, input.version);
      await db.transaction(async (tx) => {
        await updateVersioned(tx, row, { hiddenAt: new Date(), updatedBy: actor.adminId });
        await writeAudit(tx, audit, {
          action: AuditAction.NOTICE_HIDE,
          targetType: AuditTargetType.NOTICE,
          targetId: id,
          reason: input.reason,
          before: { status: noticeStatusOf(row) },
          after: { status: NoticeStatus.HIDDEN },
        });
      });
      return (await toViews([await load(id)]))[0]!;
    },

    /** 게임용: 게시 중 공지 (고정 → 최신) */
    async published(at = new Date()): Promise<GameNotice[]> {
      const rows = await db
        .select()
        .from(notices)
        .where(publishedAt(at))
        .orderBy(desc(notices.pinned), desc(notices.startsAt), desc(notices.id))
        .limit(100);
      return rows.map((r) => ({
        id: r.id,
        category: r.category as NoticeCategory,
        title: r.title,
        body: r.body,
        pinned: r.pinned,
        startsAt: iso(r.startsAt),
        endsAt: isoOrNull(r.endsAt),
      }));
    },

    /** 로비 한 줄 공지 (최대 5개, 고정 → 최신) */
    async tickers(at = new Date()): Promise<{ noticeId: number; text: string }[]> {
      const rows = await db
        .select({ id: notices.id, text: notices.tickerText })
        .from(notices)
        .where(and(publishedAt(at), eq(notices.tickerEnabled, true)))
        .orderBy(desc(notices.pinned), desc(notices.startsAt), desc(notices.id))
        .limit(NOTICE_TICKER_MAX);
      return rows.filter((r) => r.text).map((r) => ({ noticeId: r.id, text: r.text! }));
    },
  };
}

export type NoticeService = ReturnType<typeof createNoticeService>;
