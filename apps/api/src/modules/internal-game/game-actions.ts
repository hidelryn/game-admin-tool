import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  ActivityType,
  UserStatus,
  type GameEventsRequest,
  type GameEventsResult,
} from '@game-admin/shared';
import type { Executor } from '../../infra/db/types.js';
import { userActivityLogs, users } from '../../infra/db/schema/index.js';
import type { MaintenanceService } from '../live-notices/maintenance.service.js';

/**
 * 게임 서버가 하는 일 중 내부 API 와 체험 모드 활동 생성기가 같이 쓰는 부분
 * (HTTP 를 거치지 않고 같은 규칙으로 기록하기 위해 분리)
 */

/** 활동 중인 회원 무작위 샘플 (id 구간에서 시작점을 랜덤으로) */
export async function sampleActiveUsers(db: Executor, size: number): Promise<string[]> {
  const [{ maxId } = { maxId: 0 }] = await db
    .select({ maxId: sql<number>`coalesce(max(${users.id}), 0)` })
    .from(users);
  const startId = Math.floor(Math.random() * Math.max(1, Number(maxId) - size));
  const rows = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(and(eq(users.status, UserStatus.ACTIVE), gte(users.id, startId)))
    .orderBy(users.id)
    .limit(size);
  return rows.map((r) => r.publicId);
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
    });
  }
  result.accepted = rows.length;
  return result;
}
