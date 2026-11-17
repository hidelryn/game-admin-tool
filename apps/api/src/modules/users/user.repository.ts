import { and, desc, eq, isNull } from 'drizzle-orm';
import { ErrorCode, UserStatus, type UserSuspension } from '@game-admin/shared';
import { NotFoundError } from '../../common/errors/app-error.js';
import { isoOrNull, iso } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { userSuspensions, users } from '../../infra/db/schema/index.js';

export type UserRow = typeof users.$inferSelect;

export async function findUserByPublicId(db: Executor, publicId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.publicId, publicId)).limit(1);
  return row ?? null;
}

export async function getUserOrThrow(db: Executor, publicId: string): Promise<UserRow> {
  const user = await findUserByPublicId(db, publicId);
  if (!user)
    throw new NotFoundError(ErrorCode.USER_NOT_FOUND, `회원을 찾을 수 없습니다: ${publicId}`);
  return user;
}

export const isWithdrawn = (u: Pick<UserRow, 'status'>) => u.status === UserStatus.WITHDRAWN;

/** 해제되지 않은 가장 최근 정지 */
export async function findActiveSuspension(db: Executor, userId: number) {
  const [row] = await db
    .select()
    .from(userSuspensions)
    .where(and(eq(userSuspensions.userId, userId), isNull(userSuspensions.releasedAt)))
    .orderBy(desc(userSuspensions.id))
    .limit(1);
  return row ?? null;
}

export function toSuspension(r: typeof userSuspensions.$inferSelect): UserSuspension {
  return {
    id: r.id,
    reason: r.reason,
    startsAt: iso(r.startsAt),
    endsAt: isoOrNull(r.endsAt),
    suspendedBy: r.suspendedBy,
    releasedAt: isoOrNull(r.releasedAt),
    releasedBy: r.releasedBy,
    releaseReason: r.releaseReason,
  };
}
