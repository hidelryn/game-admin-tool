import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  ErrorCode,
  ScheduleKind,
  ScheduleStatus,
  scheduleStatusOf,
  type CreateScheduleRequest,
  type ListSchedulesQuery,
  type LiveOpsView,
  type PopupFrequency,
  type ScheduleActionRequest,
  type ScheduleChangePreview,
  type ScheduleView,
  type UpdateScheduleRequest,
} from '@game-admin/shared';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import { admins, rankingBoards, rankingSeasons, schedules } from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';
import type { AssetService } from '../assets/asset.service.js';
import type { NamedLock } from '../../infra/db/named-lock.js';
import { floorToSecond } from '../../common/time.js';

type ScheduleRow = typeof schedules.$inferSelect;
/** 스케줄 몫의 live-ops (점검·티커는 게임 API 라우터가 합친다) */
export type ScheduleLiveOps = Omit<LiveOpsView, 'maintenance' | 'sessionEpoch' | 'tickers'>;

/** 시즌 기간 겹침 검사·생성을 한 번에 하나씩 (같은 시각에 두 운영자가 겹치는 시즌을 만드는 경합 방지) */
/** 보드마다 잠금 (아레나·월드아레나는 서로 막지 않음) */
const seasonLockName = (boardId: number) => `game-admin:season-schedule:${boardId}`;

/** 감사 로그·미리보기에 남길 수정 가능 필드 */
const EDITABLE = [
  'title',
  'description',
  'startsAt',
  'endsAt',
  'popupEnabled',
  'popupFrequency',
  'bannerEnabled',
  'priority',
  'imageAssetId',
  'link',
] as const;

const snapshotOf = (r: Pick<ScheduleRow, (typeof EDITABLE)[number]>) =>
  Object.fromEntries(
    EDITABLE.map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]]),
  );

/**
 * 스케줄 (docs/schedule.md)
 * - 시작 전: 생성·수정·취소 L1
 * - 진행 중: 수정·이벤트 내리기·시즌 조기 종료 L2 (영향 미리보기 → 확인 토큰)
 * - 종료·취소된 일정은 수정 불가
 * - 랭킹 시즌은 ranking_seasons 와 1:1 로 같이 만들고 고친다. 상태 전환은 시즌 수명 주기 워커가 담당
 */
export function createScheduleService(deps: {
  db: Executor;
  confirmation: Confirmation;
  assets: Pick<AssetService, 'views' | 'exists'>;
  /** 시즌 조기 종료 직후 바로 종료 처리 (워커 주기를 기다리지 않음) */
  runSeasonLifecycle: () => Promise<unknown>;
  lock: NamedLock;
}) {
  const { db, confirmation, assets, runSeasonLifecycle, lock } = deps;

  async function load(id: number): Promise<ScheduleRow> {
    const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    if (!row) throw new NotFoundError(ErrorCode.SCHEDULE_NOT_FOUND, '스케줄을 찾을 수 없습니다.');
    return row;
  }

  async function toViews(rows: ScheduleRow[]): Promise<ScheduleView[]> {
    if (!rows.length) return [];
    const adminIds = [...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]))];
    const seasonIds = rows.map((r) => r.rankingSeasonId).filter((v): v is number => v !== null);
    const [names, seasons, images] = await Promise.all([
      db
        .select({ id: admins.id, name: admins.name })
        .from(admins)
        .where(inArray(admins.id, adminIds)),
      seasonIds.length
        ? db
            .select({
              id: rankingSeasons.id,
              name: rankingSeasons.name,
              status: rankingSeasons.status,
              board: { id: rankingBoards.id, code: rankingBoards.code, name: rankingBoards.name },
            })
            .from(rankingSeasons)
            .innerJoin(rankingBoards, eq(rankingBoards.id, rankingSeasons.boardId))
            .where(inArray(rankingSeasons.id, seasonIds))
        : Promise.resolve([]),
      assets.views(rows.map((r) => r.imageAssetId).filter((v): v is number => v !== null)),
    ]);
    const nameOf = new Map(names.map((a) => [a.id, a.name]));
    const seasonOf = new Map(seasons.map((s) => [s.id, s]));
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as ScheduleKind,
      title: r.title,
      description: r.description,
      startsAt: iso(r.startsAt),
      endsAt: iso(r.endsAt),
      status: scheduleStatusOf(r, now),
      popupEnabled: r.popupEnabled,
      popupFrequency: r.popupFrequency as PopupFrequency,
      bannerEnabled: r.bannerEnabled,
      priority: r.priority,
      image: r.imageAssetId ? (images.get(r.imageAssetId) ?? null) : null,
      link: r.link,
      rankingSeason: r.rankingSeasonId ? (seasonOf.get(r.rankingSeasonId) ?? null) : null,
      canceledAt: isoOrNull(r.canceledAt),
      createdBy: { id: r.createdBy, name: nameOf.get(r.createdBy) ?? '' },
      updatedBy: { id: r.updatedBy, name: nameOf.get(r.updatedBy) ?? '' },
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      version: r.version,
    }));
  }

  async function assertImage(imageAssetId: number | null) {
    if (imageAssetId && !(await assets.exists(imageAssetId))) {
      throw new BusinessRuleError(
        ErrorCode.ASSET_NOT_FOUND,
        '이미지를 찾을 수 없습니다. 다시 올려 주세요.',
      );
    }
  }

  /** 랭킹 시즌 기간 겹침 (취소된 시즌 제외). 같은 아레나 모드는 한 번에 하나 */
  /** 같은 보드 안에서만 시즌 기간 겹침 금지 (다른 보드끼리는 동시에 진행 가능) */
  async function assertNoSeasonOverlap(
    tx: Executor,
    boardId: number,
    startsAt: Date,
    endsAt: Date,
    exceptId?: number,
  ) {
    const conds: SQL[] = [
      eq(schedules.kind, ScheduleKind.RANKING_SEASON),
      eq(rankingSeasons.boardId, boardId),
      isNull(schedules.canceledAt),
      lt(schedules.startsAt, endsAt),
      gt(schedules.endsAt, startsAt),
    ];
    if (exceptId) conds.push(ne(schedules.id, exceptId));
    const [hit] = await tx
      .select({ id: schedules.id, title: schedules.title })
      .from(schedules)
      .innerJoin(rankingSeasons, eq(rankingSeasons.id, schedules.rankingSeasonId))
      .where(and(...conds))
      .limit(1);
    if (hit) {
      throw new ConflictError(
        ErrorCode.SCHEDULE_OVERLAP,
        `"${hit.title}" 시즌과 기간이 겹칩니다. 같은 랭킹에서는 시즌을 한 번에 하나만 진행할 수 있습니다.`,
        {
          scheduleId: hit.id,
        },
      );
    }
  }

  /** 시즌 관련 변경은 이름 잠금으로 직렬화 → 겹침 검사와 저장 사이에 다른 시즌이 끼어들 수 없음 */
  const withSeasonLock = <T>(boardId: number, fn: (tx: Executor) => Promise<T>): Promise<T> =>
    lock(seasonLockName(boardId), () => db.transaction(fn));

  async function assertBoard(boardId: number) {
    const [b] = await db
      .select({ id: rankingBoards.id })
      .from(rankingBoards)
      .where(eq(rankingBoards.id, boardId))
      .limit(1);
    if (!b) throw new BusinessRuleError(ErrorCode.SEASON_NOT_FOUND, '없는 랭킹 종류입니다.');
  }

  /** 시즌 일정의 보드 id */
  async function boardOf(row: ScheduleRow): Promise<number> {
    const [s] = await db
      .select({ boardId: rankingSeasons.boardId })
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, row.rankingSeasonId!))
      .limit(1);
    return s?.boardId ?? 1;
  }

  function assertEditable(row: ScheduleRow, now = new Date()) {
    const status = scheduleStatusOf(row, now);
    if (status === ScheduleStatus.ENDED || status === ScheduleStatus.CANCELED) {
      throw new BusinessRuleError(
        ErrorCode.SCHEDULE_NOT_EDITABLE,
        status === ScheduleStatus.ENDED
          ? '종료된 일정은 바꿀 수 없습니다.'
          : '취소된 일정은 바꿀 수 없습니다.',
      );
    }
    return status;
  }

  function assertVersion(row: ScheduleRow, version: number) {
    if (row.version !== version) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 일정을 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
        {
          currentVersion: row.version,
        },
      );
    }
  }

  /** 버전이 그대로일 때만 갱신 (동시 수정 방지) */
  async function updateVersioned(
    tx: Executor,
    row: ScheduleRow,
    set: Partial<typeof schedules.$inferInsert>,
  ) {
    const r = await tx
      .update(schedules)
      .set({ ...set, version: row.version + 1 })
      .where(and(eq(schedules.id, row.id), eq(schedules.version, row.version)));
    if (affectedRows(r) !== 1) {
      throw new ConflictError(
        ErrorCode.VERSION_CONFLICT,
        '다른 운영자가 먼저 이 일정을 바꿨습니다. 새로 불러온 뒤 다시 시도하세요.',
      );
    }
  }

  const preview = (
    row: ScheduleRow,
    action: ScheduleChangePreview['action'],
    after: { startsAt: Date; endsAt: Date } | null,
    warnings: string[],
  ): ScheduleChangePreview => ({
    scheduleId: row.id,
    kind: row.kind as ScheduleKind,
    title: row.title,
    action,
    before: { startsAt: iso(row.startsAt), endsAt: iso(row.endsAt) },
    after: after ? { startsAt: iso(after.startsAt), endsAt: iso(after.endsAt) } : null,
    warnings,
  });

  return {
    async list(q: ListSchedulesQuery): Promise<ScheduleView[]> {
      const conds: SQL[] = [lt(schedules.startsAt, q.to), gt(schedules.endsAt, q.from)];
      if (q.kind) conds.push(eq(schedules.kind, q.kind));
      if (!q.includeCanceled) conds.push(isNull(schedules.canceledAt));
      const rows = await db
        .select()
        .from(schedules)
        .where(and(...conds))
        .orderBy(asc(schedules.startsAt), asc(schedules.id))
        .limit(500);
      return toViews(rows);
    },

    async get(id: number): Promise<ScheduleView> {
      return (await toViews([await load(id)]))[0]!;
    },

    /** @param record 멱등 키 결과를 같은 트랜잭션에 저장 (재전송 시 같은 일정 id 를 돌려줌) */
    async create(
      actor: AuthContext,
      input: CreateScheduleRequest,
      audit: AuditContext,
      record?: (tx: Executor, id: number) => Promise<void>,
    ): Promise<ScheduleView> {
      if (input.endsAt <= new Date())
        throw new BusinessRuleError(
          ErrorCode.SCHEDULE_NOT_EDITABLE,
          '이미 끝난 기간으로는 만들 수 없습니다.',
        );
      await assertImage(input.imageAssetId);
      const { reason, kind, rankingBoardId, ...raw } = input;
      if (kind === ScheduleKind.RANKING_SEASON) await assertBoard(rankingBoardId!);
      const body = {
        ...raw,
        startsAt: floorToSecond(raw.startsAt),
        endsAt: floorToSecond(raw.endsAt),
      };

      const run = async (tx: Executor) => {
        let rankingSeasonId: number | null = null;
        if (kind === ScheduleKind.RANKING_SEASON) {
          await assertNoSeasonOverlap(tx, input.rankingBoardId!, body.startsAt, body.endsAt);
          // 상태는 예정으로 두고, 시작 시각이 되면 워커가 진행으로 바꾼다
          const [season] = await tx
            .insert(rankingSeasons)
            .values({
              boardId: input.rankingBoardId!,
              name: input.title,
              status: 'SCHEDULED',
              startsAt: body.startsAt,
              endsAt: body.endsAt,
            })
            .$returningId();
          rankingSeasonId = season!.id;
        }
        const [created] = await tx
          .insert(schedules)
          .values({
            kind,
            ...body,
            rankingSeasonId,
            createdBy: actor.adminId,
            updatedBy: actor.adminId,
          })
          .$returningId();
        await writeAudit(tx, audit, {
          action: AuditAction.SCHEDULE_CREATE,
          targetType: AuditTargetType.SCHEDULE,
          targetId: created!.id,
          reason,
          after: {
            kind,
            ...snapshotOf({ ...body }),
            rankingSeasonId,
            rankingBoardId: rankingBoardId ?? null,
          },
        });
        if (record) await record(tx, created!.id);
        return created!.id;
      };
      const id =
        kind === ScheduleKind.RANKING_SEASON
          ? await withSeasonLock(input.rankingBoardId!, run)
          : await db.transaction(run);
      if (kind === ScheduleKind.RANKING_SEASON) await runSeasonLifecycle(); // 지금 시작하는 시즌이면 바로 진행으로
      return (await toViews([await load(id)]))[0]!;
    },

    async update(
      actor: AuthContext,
      id: number,
      input: UpdateScheduleRequest,
      audit: AuditContext,
    ): Promise<ScheduleView> {
      const row = await load(id);
      const now = new Date();
      const status = assertEditable(row, now);
      assertVersion(row, input.version);
      await assertImage(input.imageAssetId);
      const { reason, version: _v, confirmationToken, ...raw } = input;
      const body = {
        ...raw,
        startsAt: floorToSecond(raw.startsAt),
        endsAt: floorToSecond(raw.endsAt),
      };
      const isSeason = row.kind === ScheduleKind.RANKING_SEASON;
      const boardId = isSeason ? await boardOf(row) : 0;

      if (status === ScheduleStatus.ACTIVE) {
        if (body.startsAt.getTime() !== row.startsAt.getTime()) {
          throw new BusinessRuleError(
            ErrorCode.SCHEDULE_NOT_EDITABLE,
            '진행 중인 일정의 시작 시각은 바꿀 수 없습니다.',
          );
        }
        if (body.endsAt <= now) {
          throw new BusinessRuleError(
            ErrorCode.SCHEDULE_NOT_EDITABLE,
            isSeason ? '지금 끝내려면 "조기 종료"를 쓰세요.' : '지금 내리려면 "내리기"를 쓰세요.',
          );
        }
        // 진행 중 수정은 영향 미리보기 확인 후 실행 (L2)
        const warnings: string[] = ['게임에 노출 중인 일정입니다. 저장하면 바로 반영됩니다.'];
        if (isSeason && body.endsAt.getTime() !== row.endsAt.getTime()) {
          warnings.push(
            body.endsAt < row.endsAt
              ? '시즌 종료가 앞당겨집니다. 회원이 점수를 올릴 시간이 줄고, 최종 순위·보상 대상이 달라질 수 있습니다.'
              : '시즌 종료가 늦춰집니다. 최종 순위·보상 시점도 함께 늦춰집니다.',
          );
        }
        await confirmation.require<ScheduleChangePreview>({
          adminId: actor.adminId,
          action: 'SCHEDULE_UPDATE',
          payload: { id, version: row.version, ...snapshotOf(body), reason },
          token: confirmationToken,
          preview: () =>
            preview(row, 'UPDATE', { startsAt: body.startsAt, endsAt: body.endsAt }, warnings),
        });
      }

      const run = async (tx: Executor) => {
        if (isSeason) await assertNoSeasonOverlap(tx, boardId, body.startsAt, body.endsAt, id);
        await updateVersioned(tx, row, { ...body, updatedBy: actor.adminId });
        if (isSeason && row.rankingSeasonId) {
          await tx
            .update(rankingSeasons)
            .set({ name: body.title, startsAt: body.startsAt, endsAt: body.endsAt })
            .where(eq(rankingSeasons.id, row.rankingSeasonId));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.SCHEDULE_UPDATE,
          targetType: AuditTargetType.SCHEDULE,
          targetId: id,
          reason,
          before: snapshotOf(row),
          after: { ...snapshotOf(body), whileActive: status === ScheduleStatus.ACTIVE },
        });
      };
      if (isSeason) await withSeasonLock(boardId, run);
      else await db.transaction(run);
      if (isSeason) await runSeasonLifecycle();
      return (await toViews([await load(id)]))[0]!;
    },

    /**
     * 취소·내리기
     * - 시작 전(시즌·이벤트): L1, 게임에 나간 적 없음
     * - 진행 중 이벤트: L2 "내리기" — 게임 노출 즉시 중단
     * - 진행 중 시즌: 불가 → 조기 종료 사용 (점수·보상 이력 보존)
     */
    async cancel(
      actor: AuthContext,
      id: number,
      input: ScheduleActionRequest,
      audit: AuditContext,
    ): Promise<ScheduleView> {
      const row = await load(id);
      const status = assertEditable(row);
      assertVersion(row, input.version);
      const isSeason = row.kind === ScheduleKind.RANKING_SEASON;
      if (status === ScheduleStatus.ACTIVE) {
        if (isSeason)
          throw new BusinessRuleError(
            ErrorCode.SCHEDULE_NOT_EDITABLE,
            '진행 중인 시즌은 취소할 수 없습니다. "조기 종료"를 쓰세요.',
          );
        await confirmation.require<ScheduleChangePreview>({
          adminId: actor.adminId,
          action: 'SCHEDULE_CANCEL',
          payload: { id, version: row.version, reason: input.reason },
          token: input.confirmationToken,
          preview: () =>
            preview(row, 'CANCEL', null, [
              '게임에서 바로 사라집니다(팝업·배너 포함).',
              '다시 노출하려면 새 일정을 만들어야 합니다.',
            ]),
        });
      }
      await db.transaction(async (tx) => {
        await updateVersioned(tx, row, { canceledAt: new Date(), updatedBy: actor.adminId });
        if (isSeason && row.rankingSeasonId) {
          await tx
            .update(rankingSeasons)
            .set({ status: 'CANCELED' })
            .where(
              and(
                eq(rankingSeasons.id, row.rankingSeasonId),
                eq(rankingSeasons.status, 'SCHEDULED'),
              ),
            );
        }
        await writeAudit(tx, audit, {
          action: AuditAction.SCHEDULE_CANCEL,
          targetType: AuditTargetType.SCHEDULE,
          targetId: id,
          reason: input.reason,
          before: { status, ...snapshotOf(row) },
          after: { canceled: true, whileActive: status === ScheduleStatus.ACTIVE },
        });
      });
      return (await toViews([await load(id)]))[0]!;
    },

    /** 진행 중 시즌 조기 종료 (L2): 종료 시각을 지금으로 → 바로 종료 처리(최종 스냅샷) */
    async endNow(
      actor: AuthContext,
      id: number,
      input: ScheduleActionRequest,
      audit: AuditContext,
    ): Promise<ScheduleView> {
      const row = await load(id);
      const status = assertEditable(row);
      assertVersion(row, input.version);
      if (row.kind !== ScheduleKind.RANKING_SEASON || status !== ScheduleStatus.ACTIVE) {
        throw new BusinessRuleError(
          ErrorCode.SCHEDULE_NOT_EDITABLE,
          '조기 종료는 진행 중인 시즌만 할 수 있습니다.',
        );
      }
      const now = floorToSecond(new Date()); // 바로 이어지는 종료 처리에서 '이미 끝남'으로 판정되도록
      await confirmation.require<ScheduleChangePreview>({
        adminId: actor.adminId,
        action: 'SCHEDULE_END_NOW',
        payload: { id, version: row.version, reason: input.reason },
        token: input.confirmationToken,
        preview: () =>
          preview(row, 'END_NOW', { startsAt: row.startsAt, endsAt: now }, [
            '지금 시즌을 끝냅니다. 이후 점수는 기록되지 않습니다.',
            '현재 순위로 최종 스냅샷이 만들어지고, 거기서 순위 보상을 지급할 수 있습니다.',
          ]),
      });
      await withSeasonLock(await boardOf(row), async (tx) => {
        await updateVersioned(tx, row, { endsAt: now, updatedBy: actor.adminId });
        if (row.rankingSeasonId)
          await tx
            .update(rankingSeasons)
            .set({ endsAt: now })
            .where(eq(rankingSeasons.id, row.rankingSeasonId));
        await writeAudit(tx, audit, {
          action: AuditAction.SCHEDULE_UPDATE,
          targetType: AuditTargetType.SCHEDULE,
          targetId: id,
          reason: input.reason,
          before: { endsAt: iso(row.endsAt) },
          after: { endsAt: iso(now), endedEarly: true },
        });
      });
      await runSeasonLifecycle();
      return (await toViews([await load(id)]))[0]!;
    },

    /** 게임 서버용: 그 시각에 진행 중이고 취소되지 않은 일정 → 시즌·이벤트·팝업·배너 */
    async liveOps(at = new Date()): Promise<ScheduleLiveOps> {
      const rows = await db
        .select()
        .from(schedules)
        .where(
          and(
            isNull(schedules.canceledAt),
            sql`${schedules.startsAt} <= ${at}`,
            gt(schedules.endsAt, at),
          ),
        )
        .orderBy(desc(schedules.priority), asc(schedules.startsAt), asc(schedules.id));
      const images = await assets.views(
        rows.map((r) => r.imageAssetId).filter((v): v is number => v !== null),
      );
      const imageUrl = (r: ScheduleRow) =>
        r.imageAssetId ? (images.get(r.imageAssetId)?.url ?? null) : null;
      const seasonRows = rows.filter((r) => r.kind === ScheduleKind.RANKING_SEASON);
      const seasonBoards = seasonRows.length
        ? await db
            .select({
              id: rankingSeasons.id,
              code: rankingBoards.code,
              name: rankingBoards.name,
              sortOrder: rankingBoards.sortOrder,
            })
            .from(rankingSeasons)
            .innerJoin(rankingBoards, eq(rankingBoards.id, rankingSeasons.boardId))
            .where(
              inArray(
                rankingSeasons.id,
                seasonRows.map((r) => r.rankingSeasonId!),
              ),
            )
        : [];
      const boardOfSeason = new Map(seasonBoards.map((b) => [b.id, b]));
      return {
        now: at.toISOString(),
        seasons: seasonRows
          .map((sr) => ({ sr, b: boardOfSeason.get(sr.rankingSeasonId!) }))
          .sort((x, y) => (x.b?.sortOrder ?? 0) - (y.b?.sortOrder ?? 0))
          .map(({ sr, b }) => ({
            id: sr.rankingSeasonId!,
            boardCode: b?.code ?? '',
            boardName: b?.name ?? '',
            name: sr.title,
            startsAt: iso(sr.startsAt),
            endsAt: iso(sr.endsAt),
          })),
        events: rows
          .filter((r) => r.kind === ScheduleKind.EVENT)
          .map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            startsAt: iso(r.startsAt),
            endsAt: iso(r.endsAt),
          })),
        popups: rows
          .filter((r) => r.popupEnabled)
          .map((r) => ({
            id: r.id,
            title: r.title,
            imageUrl: imageUrl(r),
            link: r.link,
            frequency: r.popupFrequency as PopupFrequency,
            priority: r.priority,
          })),
        banners: rows
          .filter((r) => r.bannerEnabled && imageUrl(r))
          .map((r) => ({
            id: r.id,
            title: r.title,
            imageUrl: imageUrl(r)!,
            link: r.link,
            priority: r.priority,
            endsAt: iso(r.endsAt),
          })),
      };
    },
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
