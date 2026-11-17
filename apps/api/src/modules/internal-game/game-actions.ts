import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  ActivityType,
  UserStatus,
  type GameEventsRequest,
  type GameEventsResult,
  type SampledUser,
} from '@game-admin/shared';
import type { Executor } from '../../infra/db/types.js';
import { purchases, userActivityLogs, users } from '../../infra/db/schema/index.js';
import type { MaintenanceService } from '../live-notices/maintenance.service.js';

/**
 * 게임 서버가 하는 일 중 내부 API 와 체험 모드 활동 생성기가 같이 쓰는 부분
 * (HTTP 를 거치지 않고 같은 규칙으로 기록하기 위해 분리)
 */

/**
 * 활동 중인 회원 무작위 샘플 (id 구간에서 시작점을 랜덤으로)
 * recentDays: 최근 N일 안에 접속(또는 가입)한 회원만 — 이미 이탈한 회원이 되살아나 분석이 흐려지지 않게
 */
export async function sampleActiveUsers(
  db: Executor,
  size: number,
  opts: { recentDays?: number } = {},
): Promise<SampledUser[]> {
  const [{ maxId } = { maxId: 0 }] = await db
    .select({ maxId: sql<number>`coalesce(max(${users.id}), 0)` })
    .from(users);
  const recent = opts.recentDays ? new Date(Date.now() - opts.recentDays * 86_400_000) : null;
  const where = (startId: number) =>
    and(
      eq(users.status, UserStatus.ACTIVE),
      gte(users.id, startId),
      recent ? or(gte(users.lastLoginAt, recent), gte(users.registeredAt, recent)) : undefined,
    );
  const pickFrom = (startId: number) =>
    db
      .select({
        publicId: users.publicId,
        maxStage: users.maxStage,
        payCount:
          sql<number>`(select count(*) from ${purchases} where ${purchases.userId} = ${users.id})`.mapWith(
            Number,
          ),
      })
      .from(users)
      .where(where(startId))
      .orderBy(users.id)
      .limit(size);
  const startId = Math.floor(Math.random() * Math.max(1, Number(maxId) - size));
  const rows = await pickFrom(startId);
  // 뒤쪽 구간에 조건 맞는 회원이 모자라면 처음부터 다시
  return rows.length >= size || startId === 0 ? rows : pickFrom(0);
}

type GameEvent = GameEventsRequest['events'][number];

/** 활동 이벤트 기록. 정지·탈퇴 회원과 점검 중(예외 회원 제외)은 거부 */
export async function recordGameEvents(
  db: Executor,
  maintenanceService: Pick<MaintenanceService, 'blockedOf'>,
  events: GameEvent[],
): Promise<GameEventsResult> {
  const ids = [...new Set(events.map((e) => e.publicId))];
  const blocked = await maintenanceService.blockedOf(ids);
  const found = ids.length
    ? await db
        .select({ id: users.id, publicId: users.publicId, status: users.status })
        .from(users)
        .where(inArray(users.publicId, ids))
    : [];
  const byPublicId = new Map(found.map((u) => [u.publicId, u]));
  const result: GameEventsResult = { accepted: 0, rejected: [] };
  const rows: (typeof userActivityLogs.$inferInsert)[] = [];
  const logins = new Map<number, Date>();
  const stages = new Map<number, number>();
  for (const e of events) {
    if (blocked.has(e.publicId)) {
      result.rejected.push({ publicId: e.publicId, reason: 'MAINTENANCE' });
      continue;
    }
    const u = byPublicId.get(e.publicId);
    if (!u) {
      result.rejected.push({ publicId: e.publicId, reason: 'USER_NOT_FOUND' });
      continue;
    }
    if (u.status !== UserStatus.ACTIVE) {
      result.rejected.push({ publicId: e.publicId, reason: `USER_${u.status}` });
      continue;
    }
    const at = e.occurredAt ?? new Date();
    rows.push({ userId: u.id, type: e.type, payload: e.payload ?? null, occurredAt: at });
    if (e.type === ActivityType.LOGIN && (!logins.get(u.id) || at > logins.get(u.id)!))
      logins.set(u.id, at);
    const stage = Number(e.payload?.stage);
    if (e.type === ActivityType.STAGE_CLEAR && Number.isInteger(stage) && stage > 0)
      stages.set(u.id, Math.max(stages.get(u.id) ?? 0, stage));
  }
  if (rows.length) {
    await db.transaction(async (tx) => {
      await tx.insert(userActivityLogs).values(rows);
      for (const [userId, at] of logins) {
        await tx
          .update(users)
          .set({ lastLoginAt: sql`greatest(coalesce(${users.lastLoginAt}, ${at}), ${at})` })
          .where(eq(users.id, userId));
      }
      // 최고 클리어 스테이지 (분석 구간 기준) — 줄어들지 않게
      for (const [userId, stage] of stages) {
        await tx
          .update(users)
          .set({ maxStage: sql`greatest(${users.maxStage}, ${stage})` })
          .where(eq(users.id, userId));
      }
    });
  }
  result.accepted = rows.length;
  return result;
}
