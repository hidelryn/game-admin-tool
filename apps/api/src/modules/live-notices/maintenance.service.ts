import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  ErrorCode,
  MaintenanceStatus,
  maintenanceStatusOf,
  NoticeCategory,
  UserStatus,
  type CreateMaintenanceRequest,
  type GameMaintenanceState,
  type MaintenanceActionRequest,
  type MaintenanceChangePreview,
  type MaintenanceView,
  type PageQuery,
  type UpdateMaintenanceRequest,
} from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import { floorToSecond } from '../../common/time.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import type { NamedLock } from '../../infra/db/named-lock.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import { admins, maintenances, notices, users } from '../../infra/db/schema/index.js';
import { systemAuditContext, writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';

type MaintenanceRow = typeof maintenances.$inferSelect;

/** 점검 생성·수정·시작은 한 번에 하나씩 (기간 겹침 검사와 세션 세대 증가를 직렬화) */
const LOCK = 'game-admin:maintenance';
/** 게임 API 가 매 요청 보는 점검 상태 캐시 (원본은 DB) */
const CACHE_KEY = 'game:maintenance-state';
const CACHE_TTL_SEC = 30;
/** 긴급 점검 미리보기: 이 시간 안에 접속한 회원을 "끊길 사람"으로 본다 */
const RECENT_PLAYER_MS = 30 * 60_000;

/** 실제 종료 시각: "지금 열기"로 앞당겼으면 그 시각 */
const effectiveEnd = sql`coalesce(${maintenances.endedAt}, ${maintenances.endsAt})`;
const endOf = (m: Pick<MaintenanceRow, 'endedAt' | 'endsAt'>) => m.endedAt ?? m.endsAt;

/** 캐시에 담는 "지금 또는 다음" 점검 (기간이 겹치지 않으므로 하나) */
interface CachedState {
  next: {
    id: number;
    title: string;
    message: string;
    startsAt: string;
    endsAt: string;
    startedAt: string | null;
    allow: string[];
  } | null;
  sessionEpoch: number;
}

const SNAP_FIELDS = ['title', 'message', 'startsAt', 'endsAt', 'allowPublicIds'] as const;
const snapshotOf = (r: Pick<MaintenanceRow, (typeof SNAP_FIELDS)[number]>) =>
  Object.fromEntries(
    SNAP_FIELDS.map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]]),
  );

/**
 * 게임 점검 (docs/maintenance-notice.md)
 * - 예약 등록·시작 전 수정·취소: L1 / 긴급 시작·진행 중 연장·지금 열기: L2
 * - 차단은 게임 API 만 (운영자는 점검 중에도 작업 가능)
 * - 시작 시 세션 세대 번호를 올린다 → 게임 서버는 낮은 세대로 접속한 유저를 끊는다
 */
export function createMaintenanceService(deps: {
  db: Executor;
  redis: RedisHandle;
  logger: Logger;
  confirmation: Confirmation;
  lock: NamedLock;
  /** 점검 공지 문구의 시각 표기 (기본 KST) */
  tzOffsetMin: number;
}) {
  const { db, redis, logger, confirmation, lock, tzOffsetMin } = deps;

  // ───────────── 공통 ─────────────

  const fmt = (d: Date) => {
    const k = new Date(d.getTime() + tzOffsetMin * 60_000).toISOString();
    return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
  };

  /** 점검과 같이 가는 공지 문구 */
  function noticeContent(m: { title: string; message: string; startsAt: Date; endsAt: Date }) {
    const period = `${fmt(m.startsAt)} ~ ${fmt(m.endsAt)}`;
    return {
      title: `[점검] ${m.title}`.slice(0, 60),
      body: `${m.message.replace(/\r\n?/g, '\n')}\n\n점검 시간: ${period} (KST)`,
      tickerText: `점검 안내: ${period} (KST)`.slice(0, 80),
      endsAt: m.endsAt,
    };
  }

  async function load(id: number): Promise<MaintenanceRow> {
    const [row] = await db.select().from(maintenances).where(eq(maintenances.id, id)).limit(1);
    if (!row) throw new NotFoundError(ErrorCode.MAINTENANCE_NOT_FOUND, '점검을 찾을 수 없습니다.');
    return row;
  }

  async function toViews(rows: MaintenanceRow[]): Promise<MaintenanceView[]> {
    if (!rows.length) return [];
    const adminIds = [...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]))];
    const noticeIds = rows.map((r) => r.noticeId).filter((v): v is number => v !== null);
    const [names, ns] = await Promise.all([
      db
        .select({ id: admins.id, name: admins.name })
        .from(admins)
        .where(inArray(admins.id, adminIds)),
      noticeIds.length
        ? db
            .select({ id: notices.id, title: notices.title })
            .from(notices)
            .where(inArray(notices.id, noticeIds))
        : Promise.resolve([]),
    ]);
    const nameOf = new Map(names.map((a) => [a.id, a.name]));
    const noticeOf = new Map(ns.map((n) => [n.id, n]));
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      startsAt: iso(r.startsAt),
      endsAt: iso(r.endsAt),
      status: maintenanceStatusOf(r, now),
      startedAt: isoOrNull(r.startedAt),
      endedAt: isoOrNull(r.endedAt),
      canceledAt: isoOrNull(r.canceledAt),
      allowPublicIds: r.allowPublicIds ?? [],
      sessionEpoch: r.sessionEpoch,
      notice: r.noticeId ? (noticeOf.get(r.noticeId) ?? null) : null,
      createdBy: { id: r.createdBy, name: nameOf.get(r.createdBy) ?? '' },
      updatedBy: { id: r.updatedBy, name: nameOf.get(r.updatedBy) ?? '' },
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      version: r.version,
    }));
  }

  const viewOf = async (id: number) => (await toViews([await load(id)]))[0]!;

  function assertVersion(row: MaintenanceRow, version: number) {
    if (row.version !== version) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 점검을 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
        { currentVersion: row.version },
      );
    }
  }

  async function updateVersioned(
    tx: Executor,
    row: MaintenanceRow,
    set: Partial<typeof maintenances.$inferInsert>,
  ) {
    const r = await tx
      .update(maintenances)
      .set({ ...set, version: row.version + 1 })
      .where(and(eq(maintenances.id, row.id), eq(maintenances.version, row.version)));
    if (affectedRows(r) !== 1) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 점검을 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
      );
    }
  }

  /** 점검 기간은 겹칠 수 없다 (취소·이미 연 점검 제외). 잠금 안에서 호출 */
  async function assertNoOverlap(tx: Executor, startsAt: Date, endsAt: Date, exceptId?: number) {
    const conds: SQL[] = [
      isNull(maintenances.canceledAt),
      lt(maintenances.startsAt, endsAt),
      sql`${effectiveEnd} > ${startsAt}`,
    ];
    if (exceptId) conds.push(ne(maintenances.id, exceptId));
    const [hit] = await tx
      .select({ id: maintenances.id, title: maintenances.title })
      .from(maintenances)
      .where(and(...conds))
      .limit(1);
    if (hit) {
      throw new ConflictError(
        ErrorCode.MAINTENANCE_OVERLAP,
        `"${hit.title}" 점검과 기간이 겹칩니다.`,
        { maintenanceId: hit.id },
      );
    }
  }

  const withLock = <T>(fn: (tx: Executor) => Promise<T>) => lock(LOCK, () => db.transaction(fn));

  async function currentEpoch(ex: Executor = db): Promise<number> {
    const [r] = await ex
      .select({ v: sql<number | null>`max(${maintenances.sessionEpoch})` })
      .from(maintenances);
    return Number(r?.v ?? 0);
  }

  /** 시작 처리: 세션 세대 +1, 시작 시각 기록 (조건부 UPDATE → 한 번만). 잠금 안에서 호출 */
  async function startInTx(tx: Executor, id: number, now: Date, audit: AuditContext) {
    const epoch = (await currentEpoch(tx)) + 1;
    const r = await tx
      .update(maintenances)
      .set({ startedAt: now, sessionEpoch: epoch })
      .where(and(eq(maintenances.id, id), isNull(maintenances.startedAt)));
    if (affectedRows(r) !== 1) return null;
    await writeAudit(tx, audit, {
      action: AuditAction.MAINTENANCE_START,
      targetType: AuditTargetType.MAINTENANCE,
      targetId: id,
      after: { sessionEpoch: epoch, startedAt: now.toISOString() },
    });
    return epoch;
  }

  async function recentPlayers(now: Date): Promise<number> {
    const [r] = await db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.status, UserStatus.ACTIVE),
          gte(users.lastLoginAt, new Date(now.getTime() - RECENT_PLAYER_MS)),
        ),
      );
    return r?.n ?? 0;
  }

  // ───────────── 게임 차단 상태 (캐시) ─────────────

  async function loadState(now: Date): Promise<CachedState> {
    const [row] = await db
      .select()
      .from(maintenances)
      .where(and(isNull(maintenances.canceledAt), sql`${effectiveEnd} > ${now}`))
      .orderBy(maintenances.startsAt)
      .limit(1);
    return {
      next: row
        ? {
            id: row.id,
            title: row.title,
            message: row.message,
            startsAt: iso(row.startsAt),
            endsAt: iso(endOf(row)),
            startedAt: isoOrNull(row.startedAt),
            allow: row.allowPublicIds ?? [],
          }
        : null,
      sessionEpoch: await currentEpoch(),
    };
  }

  async function invalidate() {
    try {
      await redis.redis.del(CACHE_KEY);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'maintenance cache invalidate failed');
    }
  }

  /** Redis → 없으면 DB (Redis 장애 시에도 DB 로 정확히 판단) */
  async function cachedState(now: Date): Promise<CachedState> {
    try {
      const raw = await redis.redis.get(CACHE_KEY);
      if (raw) return JSON.parse(raw) as CachedState;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'maintenance cache read failed — DB 로 판단');
      return loadState(now);
    }
    const state = await loadState(now);
    try {
      await redis.redis.set(CACHE_KEY, JSON.stringify(state), 'EX', CACHE_TTL_SEC);
    } catch {
      /* 캐시 저장 실패는 무시 (다음 요청도 DB) */
    }
    return state;
  }

  const isActive = (s: CachedState, now: Date) =>
    !!s.next && new Date(s.next.startsAt) <= now && now < new Date(s.next.endsAt);

  /** 시작 시각이 지났는데 아직 시작 처리 안 된 점검 → 세대 증가 (워커 + 첫 요청) */
  async function startDue(now = new Date()): Promise<number[]> {
    const due = await db
      .select({ id: maintenances.id })
      .from(maintenances)
      .where(
        and(
          isNull(maintenances.canceledAt),
          isNull(maintenances.startedAt),
          sql`${maintenances.startsAt} <= ${now}`,
          sql`${effectiveEnd} > ${now}`,
        ),
      );
    if (!due.length) return [];
    const system = systemAuditContext(null, `maintenance-start:${now.toISOString()}`);
    const started: number[] = [];
    await lock(LOCK, async () => {
      for (const { id } of due) {
        await db.transaction(async (tx) => {
          if ((await startInTx(tx, id, now, system)) !== null) started.push(id);
        });
      }
    });
    if (started.length) await invalidate();
    return started;
  }

  /** 게임·백오피스 공통 현재 상태 */
  async function state(now = new Date()): Promise<GameMaintenanceState & { allow: string[] }> {
    let s = await cachedState(now);
    if (isActive(s, now) && !s.next!.startedAt) {
      // 워커보다 먼저 시작 시각을 맞은 요청 — 바로 세대를 올려 세션 종료 신호를 늦추지 않는다
      await startDue(now).catch((err: Error) =>
        logger.warn({ err: err.message }, 'maintenance lazy start failed'),
      );
      s = await loadState(now);
    }
    const active = isActive(s, now);
    return {
      active,
      maintenanceId: active ? s.next!.id : null,
      title: active ? s.next!.title : null,
      message: active ? s.next!.message : null,
      endsAt: active ? s.next!.endsAt : null,
      sessionEpoch: s.sessionEpoch,
      allow: active ? s.next!.allow : [],
    };
  }

  const maintenanceError = (s: GameMaintenanceState) =>
    new AppError(503, ErrorCode.MAINTENANCE, s.message ?? '게임 점검 중입니다.', {
      maintenanceId: s.maintenanceId,
      title: s.title,
      endsAt: s.endsAt,
    });

  // ───────────── 운영 ─────────────

  return {
    state,
    startDue,

    /** 백오피스 상단 띠용 */
    async current(): Promise<GameMaintenanceState> {
      const { allow: _a, ...s } = await state();
      return s;
    },

    /** 점검 중이면 503 (예외 회원은 통과) */
    async assertOpen(publicId: string) {
      const s = await state();
      if (s.active && !s.allow.includes(publicId)) throw maintenanceError(s);
    },

    /**
     * 여러 회원 요청(이벤트 묶음): 막힌 회원 목록을 돌려준다. 전원이 막히면 503
     */
    async blockedOf(publicIds: string[]): Promise<Set<string>> {
      const s = await state();
      if (!s.active) return new Set();
      const blocked = new Set(publicIds.filter((p) => !s.allow.includes(p)));
      if (blocked.size === new Set(publicIds).size) throw maintenanceError(s);
      return blocked;
    },

    async list(q: PageQuery) {
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(maintenances)
          .orderBy(desc(maintenances.startsAt), desc(maintenances.id))
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(maintenances),
      ]);
      return {
        items: await toViews(rows),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    get: viewOf,

    /** 예약(L1) 또는 긴급 즉시 시작(L2) */
    async create(
      actor: AuthContext,
      input: CreateMaintenanceRequest,
      audit: AuditContext,
      record?: (tx: Executor, id: number) => Promise<void>,
    ): Promise<MaintenanceView> {
      const { confirmationToken, ...payload } = input;
      const requested = new Date();
      if (input.startNow) {
        if (input.endsAt <= requested)
          throw new BusinessRuleError(
            ErrorCode.MAINTENANCE_NOT_EDITABLE,
            '종료 예정 시각은 지금 이후여야 합니다.',
          );
        await confirmation.require<MaintenanceChangePreview>({
          adminId: actor.adminId,
          action: 'MAINTENANCE_START_NOW',
          payload,
          token: confirmationToken,
          preview: async () => {
            const n = await recentPlayers(requested);
            return {
              maintenanceId: null,
              title: input.title,
              action: 'START_NOW',
              startsAt: requested.toISOString(),
              endsAt: input.endsAt.toISOString(),
              recentPlayers: n,
              warnings: [
                `지금 바로 게임 접속을 막습니다. 최근 30분 접속 회원 약 ${n.toLocaleString()}명의 연결이 끊깁니다.`,
                input.allowPublicIds.length
                  ? `예외 회원 ${input.allowPublicIds.length}명은 계속 접속할 수 있습니다.`
                  : '예외 회원이 없습니다. 테스트 계정도 막힙니다.',
                '운영자 백오피스는 계속 쓸 수 있습니다.',
              ],
            };
          },
        });
      } else if (input.startsAt! <= requested) {
        throw new BusinessRuleError(
          ErrorCode.MAINTENANCE_NOT_EDITABLE,
          '예약 시작 시각은 지금 이후여야 합니다. 바로 시작하려면 "긴급 점검"을 쓰세요.',
        );
      }

      const now = floorToSecond(new Date());
      const startsAt = input.startNow ? now : floorToSecond(input.startsAt!);
      const endsAt = floorToSecond(input.endsAt);
      const id = await withLock(async (tx) => {
        await assertNoOverlap(tx, startsAt, endsAt);
        const [created] = await tx
          .insert(maintenances)
          .values({
            title: input.title,
            message: input.message,
            startsAt,
            endsAt,
            allowPublicIds: input.allowPublicIds,
            createdBy: actor.adminId,
            updatedBy: actor.adminId,
          })
          .$returningId();
        const mid = created!.id;
        let noticeId: number | null = null;
        if (input.createNotice) {
          const c = noticeContent({ title: input.title, message: input.message, startsAt, endsAt });
          const [n] = await tx
            .insert(notices)
            .values({
              category: NoticeCategory.MAINTENANCE,
              title: c.title,
              body: c.body,
              startsAt: now,
              endsAt: c.endsAt,
              pinned: true,
              tickerEnabled: true,
              tickerText: c.tickerText,
              maintenanceId: mid,
              createdBy: actor.adminId,
              updatedBy: actor.adminId,
            })
            .$returningId();
          noticeId = n!.id;
          await tx.update(maintenances).set({ noticeId }).where(eq(maintenances.id, mid));
          await writeAudit(tx, audit, {
            action: AuditAction.NOTICE_CREATE,
            targetType: AuditTargetType.NOTICE,
            targetId: noticeId,
            reason: input.reason,
            after: { maintenanceId: mid, title: c.title, auto: true },
          });
        }
        await writeAudit(tx, audit, {
          action: AuditAction.MAINTENANCE_CREATE,
          targetType: AuditTargetType.MAINTENANCE,
          targetId: mid,
          reason: input.reason,
          after: {
            title: input.title,
            message: input.message,
            startsAt: iso(startsAt),
            endsAt: iso(endsAt),
            allowPublicIds: input.allowPublicIds,
            emergency: input.startNow,
            noticeId,
          },
        });
        if (input.startNow) await startInTx(tx, mid, now, audit);
        if (record) await record(tx, mid);
        return mid;
      });
      await invalidate();
      return viewOf(id);
    },

    /**
     * 수정
     * - 시작 전: 전부 (L1)
     * - 진행 중: 시작 시각 고정. 종료 예정을 바꾸면 L2(연장·단축), 문구·예외 회원만이면 L1
     */
    async update(
      actor: AuthContext,
      id: number,
      input: UpdateMaintenanceRequest,
      audit: AuditContext,
    ): Promise<MaintenanceView> {
      const row = await load(id);
      const now = new Date();
      const status = maintenanceStatusOf(row, now);
      if (status === MaintenanceStatus.ENDED || status === MaintenanceStatus.CANCELED) {
        throw new BusinessRuleError(
          ErrorCode.MAINTENANCE_NOT_EDITABLE,
          status === MaintenanceStatus.ENDED
            ? '끝난 점검은 바꿀 수 없습니다.'
            : '취소된 점검은 바꿀 수 없습니다.',
        );
      }
      assertVersion(row, input.version);
      const { confirmationToken, reason, version: _v, ...raw } = input;
      const body = {
        ...raw,
        startsAt: floorToSecond(raw.startsAt),
        endsAt: floorToSecond(raw.endsAt),
      };

      if (status === MaintenanceStatus.SCHEDULED) {
        if (body.startsAt <= now)
          throw new BusinessRuleError(
            ErrorCode.MAINTENANCE_NOT_EDITABLE,
            '예약 시작 시각은 지금 이후여야 합니다. 바로 시작하려면 새 "긴급 점검"을 쓰세요.',
          );
      } else {
        if (body.startsAt.getTime() !== row.startsAt.getTime())
          throw new BusinessRuleError(
            ErrorCode.MAINTENANCE_NOT_EDITABLE,
            '진행 중인 점검의 시작 시각은 바꿀 수 없습니다.',
          );
        if (body.endsAt <= now)
          throw new BusinessRuleError(
            ErrorCode.MAINTENANCE_NOT_EDITABLE,
            '지금 끝내려면 "지금 열기"를 쓰세요.',
          );
        if (body.endsAt.getTime() !== row.endsAt.getTime()) {
          const longer = body.endsAt > row.endsAt;
          await confirmation.require<MaintenanceChangePreview>({
            adminId: actor.adminId,
            action: 'MAINTENANCE_EXTEND',
            payload: { id, version: row.version, ...snapshotOf(body), reason },
            token: confirmationToken,
            preview: async () => ({
              maintenanceId: id,
              title: row.title,
              action: 'EXTEND',
              startsAt: iso(row.startsAt),
              endsAt: iso(body.endsAt),
              recentPlayers: await recentPlayers(now),
              warnings: [
                longer
                  ? `점검이 ${fmt(row.endsAt)} → ${fmt(body.endsAt)} 로 늘어납니다. 유저는 그동안 계속 접속할 수 없습니다.`
                  : `점검이 ${fmt(body.endsAt)} 에 일찍 끝납니다.`,
                '점검 공지의 시간도 함께 바뀝니다.',
              ],
            }),
          });
        }
      }

      await withLock(async (tx) => {
        await assertNoOverlap(tx, body.startsAt, body.endsAt, id);
        await updateVersioned(tx, row, { ...body, updatedBy: actor.adminId });
        if (row.noticeId) {
          const c = noticeContent(body);
          await tx
            .update(notices)
            .set({
              title: c.title,
              body: c.body,
              tickerText: c.tickerText,
              endsAt: c.endsAt,
              updatedBy: actor.adminId,
              version: sql`${notices.version} + 1`,
            })
            .where(and(eq(notices.id, row.noticeId), isNull(notices.hiddenAt)));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.MAINTENANCE_UPDATE,
          targetType: AuditTargetType.MAINTENANCE,
          targetId: id,
          reason,
          before: snapshotOf(row),
          after: { ...snapshotOf(body), whileActive: status === MaintenanceStatus.ACTIVE },
        });
      });
      await invalidate();
      return viewOf(id);
    },

    /** 시작 전 취소 (L1) — 점검 공지도 내린다 */
    async cancel(
      actor: AuthContext,
      id: number,
      input: MaintenanceActionRequest,
      audit: AuditContext,
    ): Promise<MaintenanceView> {
      const row = await load(id);
      const status = maintenanceStatusOf(row);
      if (status !== MaintenanceStatus.SCHEDULED) {
        throw new BusinessRuleError(
          ErrorCode.MAINTENANCE_NOT_EDITABLE,
          status === MaintenanceStatus.ACTIVE
            ? '진행 중인 점검은 취소할 수 없습니다. "지금 열기"를 쓰세요.'
            : '시작 전인 점검만 취소할 수 있습니다.',
        );
      }
      assertVersion(row, input.version);
      const now = new Date();
      await db.transaction(async (tx) => {
        await updateVersioned(tx, row, { canceledAt: now, updatedBy: actor.adminId });
        if (row.noticeId) {
          await tx
            .update(notices)
            .set({ hiddenAt: now, updatedBy: actor.adminId, version: sql`${notices.version} + 1` })
            .where(and(eq(notices.id, row.noticeId), isNull(notices.hiddenAt)));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.MAINTENANCE_CANCEL,
          targetType: AuditTargetType.MAINTENANCE,
          targetId: id,
          reason: input.reason,
          before: snapshotOf(row),
          after: { canceled: true, noticeHidden: !!row.noticeId },
        });
      });
      await invalidate();
      return viewOf(id);
    },

    /** 진행 중 점검 지금 열기 (L2) — 즉시 차단 해제, 점검 공지 게시 종료 */
    async openNow(
      actor: AuthContext,
      id: number,
      input: MaintenanceActionRequest,
      audit: AuditContext,
    ): Promise<MaintenanceView> {
      const row = await load(id);
      if (maintenanceStatusOf(row) !== MaintenanceStatus.ACTIVE) {
        throw new BusinessRuleError(
          ErrorCode.MAINTENANCE_NOT_EDITABLE,
          '진행 중인 점검만 열 수 있습니다.',
        );
      }
      assertVersion(row, input.version);
      await confirmation.require<MaintenanceChangePreview>({
        adminId: actor.adminId,
        action: 'MAINTENANCE_OPEN_NOW',
        payload: { id, version: row.version, reason: input.reason },
        token: input.confirmationToken,
        preview: () => ({
          maintenanceId: id,
          title: row.title,
          action: 'OPEN_NOW',
          startsAt: iso(row.startsAt),
          endsAt: new Date().toISOString(),
          recentPlayers: 0,
          warnings: [
            `예정(${fmt(row.endsAt)})보다 일찍 점검을 끝내고 바로 접속을 엽니다.`,
            '점검 작업이 모두 끝났는지 확인하세요.',
          ],
        }),
      });
      const now = floorToSecond(new Date());
      await db.transaction(async (tx) => {
        await updateVersioned(tx, row, { endedAt: now, updatedBy: actor.adminId });
        if (row.noticeId) {
          await tx
            .update(notices)
            .set({ endsAt: now, updatedBy: actor.adminId, version: sql`${notices.version} + 1` })
            .where(and(eq(notices.id, row.noticeId), isNull(notices.hiddenAt)));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.MAINTENANCE_END,
          targetType: AuditTargetType.MAINTENANCE,
          targetId: id,
          reason: input.reason,
          before: { endsAt: iso(row.endsAt) },
          after: { endedAt: iso(now), early: true },
        });
      });
      await invalidate();
      return viewOf(id);
    },

    /** 워커(1분): 시작할 점검 처리 + 캐시 새로 */
    async runLifecycle(now = new Date()) {
      const started = await startDue(now);
      await invalidate();
      return { started };
    },
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
