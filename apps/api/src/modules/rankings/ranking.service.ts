import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  min,
  or,
  sql,
} from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  DangerAction,
  ErrorCode,
  RANKING_SCORE_MAX,
  SnapshotKind,
  tierLabel,
  tierSize,
  RANKING_REWARD_MAX_RECIPIENTS,
  type DangerPreview,
  type RankingRestoreResult,
  type RankingRewardRequest,
  type RankingRewardResult,
  type RankingEntry,
  type RankingResetResult,
  type RankingBoardView,
  type RankingSeasonView,
  type RankingSnapshotSummary,
  type UserRankView,
} from '@game-admin/shared';
import type { Logger } from '../../common/logger.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import {
  rankingBoards,
  rankingRewardPayouts,
  rankingScores,
  rankingSeasons,
  rankingSnapshots,
  users,
} from '../../infra/db/schema/index.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import type { MailService } from '../mails/mail.service.js';
import { systemAuditContext, writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';
import { getUserOrThrow, isWithdrawn } from '../users/user.repository.js';
import { decodeMember, encodeMember } from './member-codec.js';
import { seqFromTime, type SeqGenerator } from './seq-generator.js';
import { withDeadlockRetry } from '../../infra/db/retry.js';

const LOAD_BATCH = 5_000;
const EXPORT_BATCH = 5_000;

/**
 * 랭킹 (database.md 4.4)
 * - 순위: ① 점수 높은 순 ② 같은 점수면 먼저 기록한 순 (achieved_seq, 시간 기반 번호)
 * - 원본: MySQL ranking_scores / 조회: Redis ZSET rank:v2:season:{id} (점수 = 원점수, 멤버 = 기록순서+userId)
 * - ZSET 이 없으면(최초·Redis 재시작) MySQL 에서 지연 로딩
 * - 재구성: 임시 키에 적재 후 RENAME 으로 원자 교체 → 조회 중단 없음
 * - Redis 장애 시 랭킹 API 만 503, 다른 기능은 영향 없음
 */
/**
 * Redis 동기화 스크립트 (원자적)
 * - ZSET 이 아직 없으면 아무것도 안 함 → 다음 조회 때 MySQL 에서 통째로 적재
 * - 회원의 예전 멤버를 해시에서 찾아 점수를 비교: 새 점수가 더 높을 때만 교체
 *   → 같은 회원의 갱신이 커밋 순서와 다르게 도착해도 최고 점수가 남는다 (DB 와 같은 규칙)
 */
const SYNC_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local old = redis.call('HGET', KEYS[2], ARGV[1])
if old then
  local s = redis.call('ZSCORE', KEYS[1], old)
  if s and tonumber(s) >= tonumber(ARGV[2]) then return 0 end
  redis.call('ZREM', KEYS[1], old)
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1`;

/** 적재 시작 시각보다 이만큼 앞선 번호부터 따라잡기 (번호 발급 후 커밋까지 걸린 트랜잭션 대비) */
const CATCH_UP_MARGIN_MS = 30_000;

export function createRankingService(deps: {
  db: Executor;
  redis: RedisHandle;
  logger: Logger;
  confirmation: Confirmation;
  seq: SeqGenerator;
  mails: Pick<MailService, 'resolveRewards' | 'createUserMailInTx'>;
}) {
  const { db, logger, confirmation, seq: seqGen, mails } = deps;
  const r = deps.redis.redis;
  const key = (seasonId: number) => `rank:v2:season:${seasonId}`;
  /** userId → 현재 멤버 (예전 멤버를 지우기 위해) */
  const membersKey = (seasonId: number) => `rank:v2:season:${seasonId}:members`;

  async function syncOne(seasonId: number, userId: number, score: number, achievedSeq: number) {
    await r.eval(
      SYNC_LUA,
      2,
      key(seasonId),
      membersKey(seasonId),
      String(userId),
      String(score),
      encodeMember(achievedSeq, userId),
    );
  }

  async function withRedis<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof BusinessRuleError) throw err;
      logger.error({ err: (err as Error).message }, 'ranking redis error');
      throw new ServiceUnavailableError(
        ErrorCode.RANKING_UNAVAILABLE,
        '랭킹 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
      );
    }
  }

  async function getSeason(seasonId: number) {
    const [row] = await db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, seasonId))
      .limit(1);
    if (!row) throw new NotFoundError(ErrorCode.SEASON_NOT_FOUND, '시즌을 찾을 수 없습니다.');
    return row;
  }

  /** 보드는 몇 개뿐이라 매번 읽는다 (시드로 고정, 변경 드묾) */
  async function boardsById() {
    const rows = await db
      .select()
      .from(rankingBoards)
      .orderBy(asc(rankingBoards.sortOrder), asc(rankingBoards.id));
    return new Map(rows.map((b) => [b.id, { id: b.id, code: b.code, name: b.name }]));
  }

  const seasonViewWith =
    (boards: Map<number, RankingBoardView>) =>
    (s: typeof rankingSeasons.$inferSelect): RankingSeasonView => ({
      id: s.id,
      board: boards.get(s.boardId) ?? { id: s.boardId, code: '?', name: '?' },
      name: s.name,
      status: s.status,
      startsAt: iso(s.startsAt),
      endsAt: isoOrNull(s.endsAt),
      resetCount: s.resetCount,
    });

  /**
   * 재구성: MySQL → 임시 키(ZSET + 회원 해시) → RENAME 으로 원자 교체 → 따라잡기
   * 적재하는 동안 커밋된 점수는 스트리밍에서 빠질 수 있으므로, 적재 시작 시점(−30초) 이후 번호의 기록을
   * 교체 후 다시 읽어 SYNC_LUA 로 반영한다 (점수 비교 규칙 덕분에 여러 번 반영해도 결과가 같다).
   */
  async function rebuildFromDb(seasonId: number): Promise<number> {
    const catchUpFrom = seqFromTime(Date.now() - CATCH_UP_MARGIN_MS);
    const suffix = `:tmp:${randomUUID()}`;
    const tmpZ = `${key(seasonId)}${suffix}`;
    const tmpH = `${membersKey(seasonId)}${suffix}`;
    let lastUserId = 0;
    let total = 0;
    for (;;) {
      const rows = await db
        .select({
          userId: rankingScores.userId,
          score: rankingScores.score,
          achievedSeq: rankingScores.achievedSeq,
        })
        .from(rankingScores)
        .where(and(eq(rankingScores.seasonId, seasonId), gt(rankingScores.userId, lastUserId)))
        .orderBy(asc(rankingScores.userId))
        .limit(LOAD_BATCH);
      if (!rows.length) break;
      const zargs: (string | number)[] = [];
      const hargs: string[] = [];
      for (const row of rows) {
        // 상한을 넘는 값이 DB 에 있으면 잘라 넣지 않고 실패시킨다 (오류를 숨기지 않음)
        if (row.score > RANKING_SCORE_MAX) {
          throw new BusinessRuleError(
            ErrorCode.SCORE_OUT_OF_RANGE,
            `상한을 넘는 점수가 있습니다 (userId=${row.userId}, score=${row.score}).`,
          );
        }
        const member = encodeMember(row.achievedSeq, row.userId);
        zargs.push(row.score, member);
        hargs.push(String(row.userId), member);
      }
      await r
        .multi()
        .zadd(tmpZ, ...zargs)
        .hset(tmpH, ...hargs)
        .exec();
      total += rows.length;
      lastUserId = rows[rows.length - 1]!.userId;
    }

    if (total === 0) {
      await r.del(key(seasonId), membersKey(seasonId));
      return 0;
    }
    await r.multi().rename(tmpZ, key(seasonId)).rename(tmpH, membersKey(seasonId)).exec();

    const recent = await db
      .select({
        userId: rankingScores.userId,
        score: rankingScores.score,
        achievedSeq: rankingScores.achievedSeq,
      })
      .from(rankingScores)
      .where(
        and(eq(rankingScores.seasonId, seasonId), gte(rankingScores.achievedSeq, catchUpFrom)),
      );
    for (const row of recent) await syncOne(seasonId, row.userId, row.score, row.achievedSeq);
    return total;
  }

  /** ZSET 이 없으면 MySQL 에서 적재 (동시 요청은 락으로 한 번만) */
  async function ensureLoaded(seasonId: number) {
    if ((await r.exists(key(seasonId))) === 1) return;
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(rankingScores)
      .where(eq(rankingScores.seasonId, seasonId));
    if (n === 0) return;
    const lock = `rank:loading:${seasonId}`;
    if ((await r.set(lock, '1', 'EX', 60, 'NX')) === 'OK') {
      try {
        await rebuildFromDb(seasonId);
      } finally {
        await r.del(lock);
      }
      return;
    }
    // 다른 요청이 적재 중 → 최대 3초 대기
    for (let i = 0; i < 30 && (await r.exists(key(seasonId))) === 0; i++)
      await new Promise((res) => setTimeout(res, 100));
  }

  /** ZREVRANGE WITHSCORES 결과 → 화면용 (달성 시각은 MySQL 에서) */
  async function toEntries(
    seasonId: number,
    flat: string[],
    startRank: number,
  ): Promise<RankingEntry[]> {
    const pairs: { userId: number; score: number }[] = [];
    for (let i = 0; i < flat.length; i += 2)
      pairs.push({ userId: decodeMember(flat[i]!).userId, score: Number(flat[i + 1]) });
    if (!pairs.length) return [];
    const ids = pairs.map((p) => p.userId);
    const [us, scores] = await Promise.all([
      db
        .select({ id: users.id, publicId: users.publicId, nickname: users.nickname })
        .from(users)
        .where(inArray(users.id, ids)),
      db
        .select({ userId: rankingScores.userId, achievedAt: rankingScores.achievedAt })
        .from(rankingScores)
        .where(and(eq(rankingScores.seasonId, seasonId), inArray(rankingScores.userId, ids))),
    ]);
    return pairs.map((p, i) => {
      const u = us.find((x) => x.id === p.userId);
      const achievedAt = scores.find((x) => x.userId === p.userId)?.achievedAt;
      return {
        rank: startRank + i,
        publicId: u?.publicId ?? '',
        nickname: u?.nickname ?? '(탈퇴)',
        score: p.score,
        achievedAt: achievedAt ? achievedAt.toISOString() : '',
      };
    });
  }

  /** 현재 원본 점수를 순위대로 스냅샷에 복사 (같은 트랜잭션 안에서 호출) */
  async function insertSnapshot(
    tx: Executor,
    seasonId: number,
    snapshotId: string,
    reason: string,
    kind: SnapshotKind,
  ) {
    const inserted = await tx.execute(sql`
      INSERT INTO ranking_snapshots (season_id, snapshot_id, rank_no, user_id, score, kind, reason, created_at)
      SELECT season_id, ${snapshotId},
             ROW_NUMBER() OVER (ORDER BY score DESC, achieved_seq ASC),
             user_id, score, ${kind}, ${reason.slice(0, 200)}, NOW()
        FROM ranking_scores
       WHERE season_id = ${seasonId}`);
    return affectedRows(inserted);
  }

  /** 스냅샷 존재 확인 + 인원·생성 시각 */
  async function snapshotMeta(seasonId: number, snapshotId: string) {
    const [row] = await db
      .select({ n: count(), createdAt: min(rankingSnapshots.createdAt) })
      .from(rankingSnapshots)
      .where(
        and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.snapshotId, snapshotId)),
      );
    if (!row || row.n === 0 || !row.createdAt)
      throw new NotFoundError(ErrorCode.SNAPSHOT_NOT_FOUND, '스냅샷을 찾을 수 없습니다.');
    return { count: row.n, createdAt: row.createdAt };
  }

  /** 지금 순위에 있는 인원 (확인 화면용) */
  async function currentCount(seasonId: number): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(rankingScores)
      .where(eq(rankingScores.seasonId, seasonId));
    return row?.n ?? 0;
  }

  /** 초기화: 스냅샷(ROW_NUMBER) → 원본 삭제 → Redis 키 삭제 → 커밋. Redis 삭제가 실패하면 전체 롤백 */
  async function executeReset(
    seasonId: number,
    reason: string,
    audit: AuditContext,
    record?: (tx: Executor, result: RankingResetResult) => Promise<void>,
  ): Promise<RankingResetResult> {
    await getSeason(seasonId);
    const snapshotId = randomUUID();
    return db.transaction(async (tx) => {
      const archivedCount = await insertSnapshot(
        tx,
        seasonId,
        snapshotId,
        reason,
        SnapshotKind.RESET,
      );
      await tx.delete(rankingScores).where(eq(rankingScores.seasonId, seasonId));
      await tx
        .update(rankingSeasons)
        .set({ resetCount: sql`${rankingSeasons.resetCount} + 1` })
        .where(eq(rankingSeasons.id, seasonId));
      await writeAudit(tx, audit, {
        action: AuditAction.RANKING_RESET,
        targetType: AuditTargetType.RANKING_SEASON,
        targetId: seasonId,
        reason,
        after: {
          snapshotId,
          archivedCount,
        },
      });
      const result = { snapshotId, archivedCount };
      if (record) await record(tx, result);
      await withRedis(() => r.del(key(seasonId), membersKey(seasonId)));
      return result;
    });
  }

  /**
   * 스냅샷 복원 (교체): 현재 순위를 BACKUP 스냅샷으로 보관 → 원본 삭제 → 스냅샷 순위를 원본으로 복사
   * - 기록 시각은 스냅샷 시각, 기록 순서 번호는 "스냅샷 시각 기준 번호 + 순위" → 스냅샷 순위(동점 순서 포함)가 그대로 재현되고,
   *   복원 뒤 새로 기록한 점수는 같은 점수여도 아래에 선다(더 늦게 기록했으므로)
   * - 복원도 되돌릴 수 있다: BACKUP 스냅샷을 다시 복원하면 됨
   */
  async function executeRestore(
    seasonId: number,
    snapshotId: string,
    reason: string,
    audit: AuditContext,
    record?: (tx: Executor, result: RankingRestoreResult) => Promise<void>,
  ): Promise<RankingRestoreResult> {
    await getSeason(seasonId);
    const meta = await snapshotMeta(seasonId, snapshotId);
    const baseSeq = seqFromTime(meta.createdAt.getTime());
    const backupSnapshotId = randomUUID();
    return db.transaction(async (tx) => {
      const backedUp = await insertSnapshot(
        tx,
        seasonId,
        backupSnapshotId,
        `복원 전 자동 보관 — ${reason}`,
        SnapshotKind.BACKUP,
      );
      await tx.delete(rankingScores).where(eq(rankingScores.seasonId, seasonId));
      const restored = await tx.execute(sql`
        INSERT INTO ranking_scores (season_id, user_id, score, achieved_at, achieved_seq)
        SELECT season_id, user_id, score, created_at, ${baseSeq} + rank_no
          FROM ranking_snapshots
         WHERE season_id = ${seasonId} AND snapshot_id = ${snapshotId}`);
      const restoredCount = affectedRows(restored);
      await writeAudit(tx, audit, {
        action: AuditAction.RANKING_RESTORE,
        targetType: AuditTargetType.RANKING_SEASON,
        targetId: seasonId,
        reason,
        after: {
          snapshotId,
          restoredCount,
          backupSnapshotId: backedUp ? backupSnapshotId : null,
        },
      });
      const result = { restoredCount, backupSnapshotId: backedUp ? backupSnapshotId : null };
      if (record) await record(tx, result);
      // 다음 조회 때 MySQL 에서 다시 적재 (Redis 삭제 실패 시 전체 롤백)
      await withRedis(() => r.del(key(seasonId), membersKey(seasonId)));
      return result;
    });
  }

  /** 구간 대상 합계가 한도를 넘으면 거부 (스냅샷 인원 기준, 탈퇴 제외 전) */
  function assertRecipientCap(tiers: RankingRewardRequest['tiers'], snapshotCount: number) {
    const total = tiers.reduce((n, t) => n + tierSize(t, snapshotCount), 0);
    if (total > RANKING_REWARD_MAX_RECIPIENTS) {
      throw new BusinessRuleError(
        ErrorCode.RECIPIENT_LIMIT_EXCEEDED,
        `순위 보상은 한 번에 ${RANKING_REWARD_MAX_RECIPIENTS.toLocaleString()}명까지 보낼 수 있습니다. (현재 ${total.toLocaleString()}명)`,
        { total, limit: RANKING_REWARD_MAX_RECIPIENTS },
      );
    }
    return total;
  }

  /** 같은 스냅샷 보상이 이미 지급됐으면 거부 (확인 화면 전에 — 최종 차단은 UNIQUE 제약) */
  async function assertNoReward(snapshotId: string) {
    const [paid] = await db
      .select({ id: rankingRewardPayouts.id })
      .from(rankingRewardPayouts)
      .where(eq(rankingRewardPayouts.snapshotId, snapshotId))
      .limit(1);
    if (paid)
      throw new ConflictError(
        ErrorCode.SNAPSHOT_REWARD_EXISTS,
        '이 스냅샷의 순위 보상은 이미 지급했습니다.',
        { payoutId: paid.id },
      );
  }

  /**
   * 스냅샷 순위 보상: 구간마다 우편 1통 (보상은 우편함에서 수령)
   * - 탈퇴 회원은 제외하고 인원을 기록
   * - payout 행(snapshot_id UNIQUE)을 같은 트랜잭션에서 먼저 넣어 중복 실행을 DB 가 막는다
   */
  async function executeReward(
    seasonId: number,
    input: RankingRewardRequest,
    audit: AuditContext,
    record?: (tx: Executor, result: RankingRewardResult) => Promise<void>,
  ): Promise<RankingRewardResult> {
    await getSeason(seasonId);
    assertRecipientCap(input.tiers, (await snapshotMeta(seasonId, input.snapshotId)).count);
    const resolved = await Promise.all(input.tiers.map((t) => mails.resolveRewards(t.rewards)));
    const tiers = [...input.tiers]
      .map((t, i) => ({ ...t, resolved: resolved[i]! }))
      .sort((a, b) => a.fromRank - b.fromRank);

    try {
      return await db.transaction(async (tx) => {
        const [payout] = await tx
          .insert(rankingRewardPayouts)
          .values({
            seasonId,
            snapshotId: input.snapshotId,
            tiers: input.tiers,
            mailIds: [],
            recipientCount: 0,
            skippedCount: 0,
            createdBy: audit.adminId!,
          })
          .$returningId();
        const payoutId = payout!.id;

        const sent: RankingRewardResult['mails'] = [];
        let recipientCount = 0;
        let skippedCount = 0;
        for (const t of tiers) {
          const rows = await tx
            .select({ userId: rankingSnapshots.userId, status: users.status })
            .from(rankingSnapshots)
            .leftJoin(users, eq(users.id, rankingSnapshots.userId))
            .where(
              and(
                eq(rankingSnapshots.seasonId, seasonId),
                eq(rankingSnapshots.snapshotId, input.snapshotId),
                t.toRank === null
                  ? gte(rankingSnapshots.rankNo, t.fromRank) // 마지막 순위까지
                  : between(rankingSnapshots.rankNo, t.fromRank, t.toRank),
              ),
            );
          const eligible = rows
            .filter((x) => x.status && !isWithdrawn({ status: x.status }))
            .map((x) => x.userId);
          skippedCount += rows.length - eligible.length;
          if (!eligible.length) continue;
          const label = tierLabel(t);
          const mailId = await mails.createUserMailInTx(
            tx,
            audit,
            {
              title: `${input.title} (${label})`,
              body: input.body,
              expiresInDays: input.expiresInDays,
              reason: input.reason,
              createdBy: audit.adminId!,
            },
            t.resolved,
            eligible,
            { source: 'RANKING_REWARD', payoutId, snapshotId: input.snapshotId, tier: label },
          );
          recipientCount += eligible.length;
          sent.push({
            fromRank: t.fromRank,
            toRank: t.toRank,
            mailId,
            recipientCount: eligible.length,
          });
        }

        await tx
          .update(rankingRewardPayouts)
          .set({ mailIds: sent.map((m) => m.mailId), recipientCount, skippedCount })
          .where(eq(rankingRewardPayouts.id, payoutId));
        await writeAudit(tx, audit, {
          action: AuditAction.RANKING_REWARD,
          targetType: AuditTargetType.RANKING_SEASON,
          targetId: seasonId,
          reason: input.reason,
          after: {
            snapshotId: input.snapshotId,
            payoutId,
            recipientCount,
            skippedCount,
            mails: sent,
          },
        });
        const result = { payoutId, recipientCount, skippedCount, mails: sent };
        if (record) await record(tx, result);
        return result;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError(
          ErrorCode.SNAPSHOT_REWARD_EXISTS,
          '이 스냅샷의 순위 보상은 이미 지급했습니다.',
        );
      }
      throw err;
    }
  }

  return {
    async seasons(): Promise<RankingSeasonView[]> {
      const [rows, boards] = await Promise.all([
        db.select().from(rankingSeasons).orderBy(desc(rankingSeasons.id)),
        boardsById(),
      ]);
      return rows.map(seasonViewWith(boards));
    },

    async boards(): Promise<RankingBoardView[]> {
      return [...(await boardsById()).values()];
    },

    /** 보드 코드 → 그 보드의 진행 중 시즌 id (게임 점수 기록용) */
    async activeSeasonOf(boardCode: string): Promise<number | null> {
      const [row] = await db
        .select({ id: rankingSeasons.id })
        .from(rankingSeasons)
        .innerJoin(rankingBoards, eq(rankingBoards.id, rankingSeasons.boardId))
        .where(and(eq(rankingBoards.code, boardCode), eq(rankingSeasons.status, 'ACTIVE')))
        .orderBy(desc(rankingSeasons.id))
        .limit(1);
      return row?.id ?? null;
    },

    async ranking(seasonId: number, offset: number, limit: number) {
      const season = await getSeason(seasonId);
      return withRedis(async () => {
        await ensureLoaded(seasonId);
        const [flat, total] = await Promise.all([
          r.zrevrange(key(seasonId), offset, offset + limit - 1, 'WITHSCORES'),
          r.zcard(key(seasonId)),
        ]);
        return {
          season: seasonViewWith(await boardsById())(season),
          entries: await toEntries(seasonId, flat, offset + 1),
          total,
        };
      });
    },

    async userRank(seasonId: number, publicId: string): Promise<UserRankView> {
      const season = await getSeason(seasonId);
      const user = await getUserOrThrow(db, publicId);
      const [mine] = await db
        .select({ seq: rankingScores.achievedSeq })
        .from(rankingScores)
        .where(and(eq(rankingScores.seasonId, seasonId), eq(rankingScores.userId, user.id)));
      if (!mine)
        return { season: seasonViewWith(await boardsById())(season), me: null, neighbors: [] };
      return withRedis(async () => {
        await ensureLoaded(seasonId);
        const rank = await r.zrevrank(key(seasonId), encodeMember(mine.seq, user.id));
        if (rank === null)
          return { season: seasonViewWith(await boardsById())(season), me: null, neighbors: [] };
        const start = Math.max(0, rank - 5);
        const entries = await toEntries(
          seasonId,
          await r.zrevrange(key(seasonId), start, rank + 5, 'WITHSCORES'),
          start + 1,
        );
        return {
          season: seasonViewWith(await boardsById())(season),
          me: entries.find((e) => e.publicId === user.publicId) ?? null,
          neighbors: entries,
        };
      });
    },

    /**
     * 게임 서버(시뮬레이터)의 점수 갱신 — 최고 점수만 유지
     *
     * 1. 앱에서 시간 기반 순서 번호 발급 (중앙 잠금 없음)
     * 2. INSERT … ON DUPLICATE KEY UPDATE 로 더 높을 때만 저장 (같은 회원 동시 갱신은 행 잠금으로 직렬화, 갭 락 없음)
     * 3. 커밋 후 Redis 반영 (SYNC_LUA). Redis 가 실패해도 점수는 이미 저장됨 →
     *    해당 시즌 키를 지워 다음 조회 때 MySQL 에서 다시 적재 (+ Worker 가 주기적으로 재구성)
     */
    async recordScore(seasonId: number, publicId: string, score: number, achievedAt = new Date()) {
      if (!Number.isSafeInteger(score) || score < 0 || score > RANKING_SCORE_MAX) {
        throw new BusinessRuleError(
          ErrorCode.SCORE_OUT_OF_RANGE,
          `점수는 0 ~ ${RANKING_SCORE_MAX} 사이의 정수여야 합니다.`,
        );
      }
      const season = await getSeason(seasonId);
      // 진행 중 시즌에만 기록 (워커 전환이 늦어도 기간 밖이면 거부)
      const now = Date.now();
      if (
        season.status !== 'ACTIVE' ||
        season.startsAt.getTime() > now ||
        (season.endsAt && season.endsAt.getTime() <= now)
      ) {
        throw new BusinessRuleError(
          ErrorCode.SEASON_NOT_ACTIVE,
          '진행 중인 시즌이 아니라 점수를 기록할 수 없습니다.',
          {
            seasonId,
            status: season.status,
          },
        );
      }
      const user = await getUserOrThrow(db, publicId);

      /**
       * INSERT … ON DUPLICATE KEY UPDATE 한 문장으로 "없으면 넣고, 더 높으면 갱신"
       * ⚠️ SELECT … FOR UPDATE 로 먼저 조회하면 행이 없을 때 갭 락이 걸리고, 동시에 첫 점수를 넣는
       *    서로 다른 회원들의 INSERT(삽입 의도 락)와 충돌해 데드락이 난다 → 미리 잠그지 않는다
       * SET 순서가 중요: score 를 마지막에 바꿔야 IF 조건이 갱신 전 점수와 비교된다
       * 실제로 내 기록이 반영됐는지는 저장된 achieved_seq 가 내 번호인지로 판단 (번호는 요청마다 유일)
       */
      const result = await withDeadlockRetry(() => {
        const achievedSeq = seqGen.next();
        return db.transaction(async (tx) => {
          // ODKU 의 SET 은 왼쪽부터 차례로 평가되고, 뒤 항목은 앞에서 바뀐 값을 본다.
          // Drizzle 은 SET 순서를 테이블 컬럼 정의 순서(score 먼저)로 만들어 버리므로,
          // "score 는 맨 마지막에 갱신" 을 보장하려고 이 문장만 직접 쓴다.
          const at = sql.param(achievedAt, rankingScores.achievedAt);
          await tx.execute(sql`
            INSERT INTO ranking_scores (season_id, user_id, score, achieved_at, achieved_seq)
            VALUES (${seasonId}, ${user.id}, ${score}, ${at}, ${achievedSeq})
            ON DUPLICATE KEY UPDATE
              achieved_at  = IF(VALUES(score) > score, VALUES(achieved_at),  achieved_at),
              achieved_seq = IF(VALUES(score) > score, VALUES(achieved_seq), achieved_seq),
              score        = GREATEST(score, VALUES(score))
          `);
          const [saved] = await tx
            .select({ score: rankingScores.score, achievedSeq: rankingScores.achievedSeq })
            .from(rankingScores)
            .where(and(eq(rankingScores.seasonId, seasonId), eq(rankingScores.userId, user.id)));
          return { updated: saved!.achievedSeq === achievedSeq, score: saved!.score, achievedSeq };
        });
      });

      if (result.updated) {
        try {
          await syncOne(seasonId, user.id, result.score, result.achievedSeq);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, seasonId },
            'ranking redis sync failed — 다음 조회 때 재적재',
          );
          await r.del(key(seasonId), membersKey(seasonId)).catch(() => undefined);
        }
      }
      return { updated: result.updated, score: result.score };
    },

    /** Worker: 진행 중 시즌 재구성 (Redis 동기화 실패 등으로 어긋난 부분 자가 복구) */
    async reconcileActive(): Promise<{ seasonId: number; loaded: number }[]> {
      const active = await db
        .select({ id: rankingSeasons.id })
        .from(rankingSeasons)
        .where(eq(rankingSeasons.status, 'ACTIVE'));
      const out = [];
      for (const s of active)
        out.push({ seasonId: s.id, loaded: await withRedis(() => rebuildFromDb(s.id)) });
      return out;
    },

    /** Redis 재구성은 DB 트랜잭션 밖의 작업 → 끝난 뒤 감사 로그와 idempotency 결과를 한 트랜잭션으로 기록 */
    async rebuild(
      seasonId: number,
      reason: string,
      audit: AuditContext,
      record?: (tx: Executor, result: { seasonId: number; loaded: number }) => Promise<void>,
    ) {
      await getSeason(seasonId);
      const loaded = await withRedis(() => rebuildFromDb(seasonId));
      const result = { seasonId, loaded };
      await db.transaction(async (tx) => {
        await writeAudit(tx, audit, {
          action: AuditAction.RANKING_REBUILD,
          targetType: AuditTargetType.RANKING_SEASON,
          targetId: seasonId,
          reason,
          after: { loaded },
        });
        if (record) await record(tx, result);
      });
      return result;
    },

    /** 초기화 (L3): 빨간 경고 확인 후 실행 — 웹에서만. 직전 순위는 RESET 스냅샷으로 보관 */
    async reset(
      actor: AuthContext,
      seasonId: number,
      input: { reason: string; confirmationToken?: string },
      audit: AuditContext,
      record?: (tx: Executor, result: RankingResetResult) => Promise<void>,
    ) {
      const season = await getSeason(seasonId);
      await confirmation.require<DangerPreview>({
        adminId: actor.adminId,
        action: DangerAction.RANKING_RESET,
        payload: { seasonId, reason: input.reason },
        token: input.confirmationToken,
        webOnly: { channel: actor.channel },
        preview: async () => ({
          action: DangerAction.RANKING_RESET,
          title: `랭킹 초기화: ${season.name}`,
          facts: [
            { label: '시즌', value: `${season.name} (#${seasonId})` },
            { label: '지워질 순위', value: `${(await currentCount(seasonId)).toLocaleString()}명` },
          ],
          warnings: [
            '이 시즌의 모든 점수가 지워지고 순위가 비워집니다. 게임에도 바로 반영됩니다.',
            '지우기 직전 순위는 스냅샷으로 보관되어, 스냅샷 복원으로 되돌릴 수 있습니다.',
          ],
        }),
      });
      return executeReset(seasonId, input.reason, audit, record);
    },

    /** 스냅샷 복원 (L3): 현재 순위를 스냅샷으로 교체 — 웹에서만. 직전 상태는 BACKUP 으로 자동 보관 */
    async restore(
      actor: AuthContext,
      seasonId: number,
      input: { snapshotId: string; reason: string; confirmationToken?: string },
      audit: AuditContext,
      record?: (tx: Executor, result: RankingRestoreResult) => Promise<void>,
    ) {
      const season = await getSeason(seasonId);
      const meta = await snapshotMeta(seasonId, input.snapshotId);
      await confirmation.require<DangerPreview>({
        adminId: actor.adminId,
        action: DangerAction.RANKING_RESTORE,
        payload: { seasonId, snapshotId: input.snapshotId, reason: input.reason },
        token: input.confirmationToken,
        webOnly: { channel: actor.channel },
        preview: async () => ({
          action: DangerAction.RANKING_RESTORE,
          title: `랭킹 스냅샷 복원: ${season.name}`,
          facts: [
            { label: '시즌', value: `${season.name} (#${seasonId})` },
            {
              label: '복원할 스냅샷',
              value: `${iso(meta.createdAt).slice(0, 16).replace('T', ' ')} (UTC) · ${meta.count.toLocaleString()}명`,
            },
            { label: '지금 순위', value: `${(await currentCount(seasonId)).toLocaleString()}명` },
          ],
          warnings: [
            '지금 순위를 스냅샷 순위로 통째로 바꿉니다. 스냅샷 이후에 오른 점수는 사라집니다.',
            '지금 순위는 자동으로 보관되어, 그 스냅샷을 다시 복원하면 되돌릴 수 있습니다.',
          ],
        }),
      });
      return executeRestore(seasonId, input.snapshotId, input.reason, audit, record);
    },

    /** 스냅샷 순위 보상 (L3): 구간마다 우편 — 웹에서만, 스냅샷당 1회 */
    async reward(
      actor: AuthContext,
      seasonId: number,
      input: RankingRewardRequest,
      audit: AuditContext,
      record?: (tx: Executor, result: RankingRewardResult) => Promise<void>,
    ) {
      const season = await getSeason(seasonId);
      const { confirmationToken, ...reward } = input;
      const meta = await snapshotMeta(seasonId, reward.snapshotId);
      const total = assertRecipientCap(reward.tiers, meta.count);
      const resolved = await Promise.all(reward.tiers.map((t) => mails.resolveRewards(t.rewards)));
      await assertNoReward(reward.snapshotId);
      await confirmation.require<DangerPreview>({
        adminId: actor.adminId,
        action: DangerAction.RANKING_REWARD,
        payload: { seasonId, ...reward },
        token: confirmationToken,
        webOnly: { channel: actor.channel },
        preview: () => ({
          action: DangerAction.RANKING_REWARD,
          title: `순위 보상 우편: ${season.name}`,
          facts: [
            { label: '대상 (스냅샷 기준)', value: `최대 ${total.toLocaleString()}명` },
            ...reward.tiers.map((t, i) => ({
              label: tierLabel(t),
              value: resolved[i]!.map((x) => `${x.name} ${x.quantity.toLocaleString()}`).join(', '),
            })),
            { label: '수령 기한', value: `${reward.expiresInDays}일` },
          ],
          warnings: [
            '확인하면 구간마다 우편이 바로 발송됩니다 (탈퇴 회원 제외).',
            '같은 스냅샷으로는 한 번만 지급할 수 있습니다.',
          ],
        }),
      });
      return executeReward(seasonId, reward, audit, record);
    },

    async snapshots(seasonId: number): Promise<RankingSnapshotSummary[]> {
      await getSeason(seasonId);
      const [rows, payouts] = await Promise.all([
        db
          .select({
            snapshotId: rankingSnapshots.snapshotId,
            kind: rankingSnapshots.kind,
            reason: rankingSnapshots.reason,
            n: count(),
            createdAt: min(rankingSnapshots.createdAt),
          })
          .from(rankingSnapshots)
          .where(eq(rankingSnapshots.seasonId, seasonId))
          .groupBy(rankingSnapshots.snapshotId, rankingSnapshots.kind, rankingSnapshots.reason)
          .orderBy(desc(min(rankingSnapshots.createdAt))),
        db.select().from(rankingRewardPayouts).where(eq(rankingRewardPayouts.seasonId, seasonId)),
      ]);
      const payoutOf = new Map(payouts.map((p) => [p.snapshotId, p]));
      return rows.map((s) => {
        const p = payoutOf.get(s.snapshotId);
        return {
          snapshotId: s.snapshotId,
          kind: s.kind as SnapshotKind,
          reason: s.reason,
          count: s.n,
          createdAt: s.createdAt ? iso(s.createdAt) : '',
          payout: p
            ? {
                id: p.id,
                recipientCount: p.recipientCount,
                skippedCount: p.skippedCount,
                mailIds: p.mailIds,
                createdAt: iso(p.createdAt),
              }
            : null,
        };
      });
    },

    /** CSV 내보내기용: 순위 순으로 5,000행씩 (메모리에 전체를 올리지 않음) */
    async *snapshotRows(seasonId: number, snapshotId: string) {
      await snapshotMeta(seasonId, snapshotId);
      let after = 0;
      for (;;) {
        const rows = await db
          .select({
            rank: rankingSnapshots.rankNo,
            publicId: users.publicId,
            nickname: users.nickname,
            score: rankingSnapshots.score,
          })
          .from(rankingSnapshots)
          .leftJoin(users, eq(users.id, rankingSnapshots.userId))
          .where(
            and(
              eq(rankingSnapshots.seasonId, seasonId),
              eq(rankingSnapshots.snapshotId, snapshotId),
              gt(rankingSnapshots.rankNo, after),
            ),
          )
          .orderBy(asc(rankingSnapshots.rankNo))
          .limit(EXPORT_BATCH);
        if (!rows.length) return;
        yield rows;
        after = rows[rows.length - 1]!.rank;
        if (rows.length < EXPORT_BATCH) return;
      }
    },

    /** 내보내기 기록 (순위·닉네임 대량 반출이므로 운영 로그에 남김) */
    async recordExport(seasonId: number, snapshotId: string, rows: number, audit: AuditContext) {
      await writeAudit(db, audit, {
        action: AuditAction.RANKING_SNAPSHOT_EXPORT,
        targetType: AuditTargetType.RANKING_SEASON,
        targetId: seasonId,
        after: { snapshotId, rows, format: 'csv' },
      });
    },

    async snapshot(seasonId: number, snapshotId: string, offset: number, limit: number) {
      const rows = await db
        .select({
          rank: rankingSnapshots.rankNo,
          publicId: users.publicId,
          nickname: users.nickname,
          score: rankingSnapshots.score,
        })
        .from(rankingSnapshots)
        .leftJoin(users, eq(users.id, rankingSnapshots.userId))
        .where(
          and(
            eq(rankingSnapshots.seasonId, seasonId),
            eq(rankingSnapshots.snapshotId, snapshotId),
            gt(rankingSnapshots.rankNo, offset),
          ),
        )
        .orderBy(asc(rankingSnapshots.rankNo))
        .limit(limit);
      if (!rows.length && offset === 0)
        throw new NotFoundError(ErrorCode.SNAPSHOT_NOT_FOUND, '스냅샷을 찾을 수 없습니다.');
      return rows.map((r) => ({
        ...r,
        publicId: r.publicId ?? '',
        nickname: r.nickname ?? '(탈퇴)',
      }));
    },

    /**
     * 시즌 수명 주기 (워커 1분마다 + 스케줄 변경 직후)
     * - 예정 → 진행: 시작 시각이 지났고 아직 안 끝난 시즌
     * - 진행·예정 → 종료: 종료 시각이 지난 시즌. 같은 트랜잭션에서 최종(FINAL) 스냅샷 생성 (점수는 지우지 않음)
     * - 조건부 UPDATE 로 전환하므로 워커가 여러 개 돌거나 동시에 불려도 한 번만 처리된다
     */
    async runSeasonLifecycle(now = new Date()) {
      const system = systemAuditContext(null, `season-lifecycle:${now.toISOString()}`);
      const started: number[] = [];
      const ended: { seasonId: number; snapshotId: string; archivedCount: number }[] = [];

      const toStart = await db
        .select({ id: rankingSeasons.id })
        .from(rankingSeasons)
        .where(
          and(
            eq(rankingSeasons.status, 'SCHEDULED'),
            lte(rankingSeasons.startsAt, now),
            or(isNull(rankingSeasons.endsAt), gt(rankingSeasons.endsAt, now)),
          ),
        );
      for (const { id } of toStart) {
        await db.transaction(async (tx) => {
          const r = await tx
            .update(rankingSeasons)
            .set({ status: 'ACTIVE' })
            .where(and(eq(rankingSeasons.id, id), eq(rankingSeasons.status, 'SCHEDULED')));
          if (affectedRows(r) !== 1) return; // 다른 워커가 먼저 처리
          await writeAudit(tx, system, {
            action: AuditAction.RANKING_SEASON_START,
            targetType: AuditTargetType.RANKING_SEASON,
            targetId: id,
          });
          started.push(id);
        });
      }

      const toEnd = await db
        .select({ id: rankingSeasons.id, name: rankingSeasons.name })
        .from(rankingSeasons)
        .where(
          and(
            inArray(rankingSeasons.status, ['SCHEDULED', 'ACTIVE']),
            lte(rankingSeasons.endsAt, now),
          ),
        );
      for (const s of toEnd) {
        await db.transaction(async (tx) => {
          const r = await tx
            .update(rankingSeasons)
            .set({ status: 'ENDED' })
            .where(
              and(
                eq(rankingSeasons.id, s.id),
                inArray(rankingSeasons.status, ['SCHEDULED', 'ACTIVE']),
              ),
            );
          if (affectedRows(r) !== 1) return;
          const snapshotId = randomUUID();
          const archivedCount = await insertSnapshot(
            tx,
            s.id,
            snapshotId,
            `${s.name} 종료 — 최종 순위`,
            SnapshotKind.FINAL,
          );
          await writeAudit(tx, system, {
            action: AuditAction.RANKING_SEASON_END,
            targetType: AuditTargetType.RANKING_SEASON,
            targetId: s.id,
            after: { snapshotId, archivedCount },
          });
          ended.push({ seasonId: s.id, snapshotId, archivedCount });
        });
      }
      if (started.length || ended.length) logger.info({ started, ended }, 'season lifecycle');
      return { started, ended };
    },

    /** 테스트·시뮬레이터용: 확인 절차 없이 직접 실행 (라우터 경로와 같은 실행 함수) */
    executeReset,
    executeRestore,
    executeReward,
  };
}

export type RankingService = ReturnType<typeof createRankingService>;
