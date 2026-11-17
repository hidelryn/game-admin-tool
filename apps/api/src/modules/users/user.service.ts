import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  AuditAction,
  AuditTargetType,
  ErrorCode,
  UserStatus,
  type ActivitiesQuery,
  type ListUsersQuery,
  type SuspendUserRequest,
  type UnsuspendUserRequest,
  type UserActivity,
  type UserDetail,
  type UserSummary,
} from '@game-admin/shared';
import { BusinessRuleError, ConflictError } from '../../common/errors/app-error.js';
import { decodeCursor, pageOf } from '../../common/http/cursor.js';
import { escapeLike } from '../../common/http/like.js';
import { maskEmail } from '../../common/http/mask.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import {
  currencies,
  userActivityLogs,
  userCurrencies,
  userSuspensions,
  users,
} from '../../infra/db/schema/index.js';
import {
  systemAuditContext,
  writeAudit,
  writeAuditMany,
  type AuditContext,
} from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';
import {
  findActiveSuspension,
  getUserOrThrow,
  isWithdrawn,
  toSuspension,
  type UserRow,
} from './user.repository.js';

const toSummary = (u: UserRow): UserSummary => ({
  publicId: u.publicId,
  nickname: u.nickname,
  email: maskEmail(u.email),
  level: u.level,
  status: u.status as UserStatus,
  registeredAt: iso(u.registeredAt),
  lastLoginAt: isoOrNull(u.lastLoginAt),
});

const toActivity = (a: typeof userActivityLogs.$inferSelect): UserActivity => ({
  id: a.id,
  type: a.type,
  payload: a.payload ?? null,
  occurredAt: iso(a.occurredAt),
});

const activityCursor = z.object({ t: z.string().datetime(), id: z.number().int().positive() });

export function createUserService(deps: { db: Executor; confirmation: Confirmation }) {
  const { db, confirmation } = deps;

  return {
    async list(q: ListUsersQuery) {
      const conds: SQL[] = [];
      if (q.publicId) conds.push(eq(users.publicId, q.publicId));
      if (q.nickname) conds.push(like(users.nickname, `${escapeLike(q.nickname)}%`));
      if (q.status) conds.push(eq(users.status, q.status));
      if (q.registeredFrom) conds.push(gte(users.registeredAt, q.registeredFrom));
      if (q.registeredTo) conds.push(lte(users.registeredAt, q.registeredTo));
      const where = conds.length ? and(...conds) : undefined;
      const order =
        q.sort === 'registeredAt:asc'
          ? [asc(users.registeredAt), asc(users.id)]
          : q.sort === 'lastLoginAt:desc'
            ? [desc(users.lastLoginAt), desc(users.id)]
            : [desc(users.registeredAt), desc(users.id)];

      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(users)
          .where(where)
          .orderBy(...order)
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(users).where(where),
      ]);
      return {
        items: rows.map(toSummary),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    async detail(publicId: string): Promise<UserDetail> {
      const user = await getUserOrThrow(db, publicId);
      const [balances, active, recent] = await Promise.all([
        db
          .select({ currencyCode: currencies.code, balance: userCurrencies.balance })
          .from(currencies)
          .leftJoin(
            userCurrencies,
            and(eq(userCurrencies.currencyId, currencies.id), eq(userCurrencies.userId, user.id)),
          )
          .orderBy(asc(currencies.id)),
        findActiveSuspension(db, user.id),
        db
          .select()
          .from(userActivityLogs)
          .where(eq(userActivityLogs.userId, user.id))
          .orderBy(desc(userActivityLogs.occurredAt), desc(userActivityLogs.id))
          .limit(5),
      ]);
      return {
        ...toSummary(user),
        balances: balances.map((b) => ({ currencyCode: b.currencyCode, balance: b.balance ?? 0 })),
        activeSuspension: active ? toSuspension(active) : null,
        recentActivities: recent.map(toActivity),
      };
    },

    /** 개인정보 원문 열람 — 열람 자체를 감사 로그로 남긴다 (FR-USR-07, FR-LOG-05) */
    async pii(publicId: string, audit: AuditContext) {
      const user = await getUserOrThrow(db, publicId);
      await writeAudit(db, audit, {
        action: AuditAction.USER_PII_VIEW,
        targetType: AuditTargetType.USER,
        targetId: user.publicId,
      });
      return { publicId: user.publicId, email: user.email };
    },

    async activities(publicId: string, q: ActivitiesQuery) {
      const user = await getUserOrThrow(db, publicId);
      const cursor = decodeCursor(q.cursor, activityCursor);
      const conds: SQL[] = [eq(userActivityLogs.userId, user.id)];
      if (q.type) conds.push(eq(userActivityLogs.type, q.type));
      if (q.from) conds.push(gte(userActivityLogs.occurredAt, q.from));
      if (q.to) conds.push(lte(userActivityLogs.occurredAt, q.to));
      if (cursor) {
        const t = new Date(cursor.t);
        conds.push(
          or(
            lt(userActivityLogs.occurredAt, t),
            and(eq(userActivityLogs.occurredAt, t), lt(userActivityLogs.id, cursor.id)),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(userActivityLogs)
        .where(and(...conds))
        .orderBy(desc(userActivityLogs.occurredAt), desc(userActivityLogs.id))
        .limit(q.size + 1);
      const { items, nextCursor } = pageOf(rows, q.size, (last) => ({
        t: last.occurredAt.toISOString(),
        id: last.id,
      }));
      return { items: items.map(toActivity), meta: { size: q.size, nextCursor } };
    },

    async suspensions(publicId: string) {
      const user = await getUserOrThrow(db, publicId);
      const rows = await db
        .select()
        .from(userSuspensions)
        .where(eq(userSuspensions.userId, user.id))
        .orderBy(desc(userSuspensions.id));
      return rows.map(toSuspension);
    },

    /** 기간 정지 L1, 영구 정지 L2(확인 토큰) — architecture.md 4.4 */
    async suspend(
      actor: AuthContext,
      publicId: string,
      input: SuspendUserRequest,
      audit: AuditContext,
    ) {
      const user = await getUserOrThrow(db, publicId);
      if (isWithdrawn(user))
        throw new BusinessRuleError(ErrorCode.USER_WITHDRAWN, '탈퇴한 회원입니다.');
      if (user.status === UserStatus.SUSPENDED || (await findActiveSuspension(db, user.id))) {
        throw new ConflictError(
          ErrorCode.ALREADY_SUSPENDED,
          '이미 정지된 회원입니다. 해제 후 다시 정지하세요.',
        );
      }

      const now = new Date();
      const endsAt = input.permanent
        ? null
        : new Date(now.getTime() + input.durationDays! * 86_400_000);
      if (input.permanent) {
        const { confirmationToken, ...payload } = input;
        await confirmation.require({
          adminId: actor.adminId,
          action: 'USER_SUSPEND_PERMANENT',
          payload: { publicId, ...payload },
          token: confirmationToken,
          preview: () => ({
            publicId,
            nickname: user.nickname,
            permanent: true,
            currentStatus: user.status,
          }),
        });
      }

      return db.transaction(async (tx) => {
        await tx.update(users).set({ status: UserStatus.SUSPENDED }).where(eq(users.id, user.id));
        const [created] = await tx
          .insert(userSuspensions)
          .values({
            userId: user.id,
            reason: input.reason,
            startsAt: now,
            endsAt,
            suspendedBy: actor.adminId,
          })
          .$returningId();
        await writeAudit(tx, audit, {
          action: AuditAction.USER_SUSPEND,
          targetType: AuditTargetType.USER,
          targetId: user.publicId,
          reason: input.reason,
          before: { status: user.status },
          after: {
            status: UserStatus.SUSPENDED,
            endsAt: endsAt?.toISOString() ?? null,
            permanent: !endsAt,
          },
        });
        const [row] = await tx
          .select()
          .from(userSuspensions)
          .where(eq(userSuspensions.id, created!.id));
        return toSuspension(row!);
      });
    },

    async unsuspend(
      actor: AuthContext,
      publicId: string,
      input: UnsuspendUserRequest,
      audit: AuditContext,
    ) {
      const user = await getUserOrThrow(db, publicId);
      const active = await findActiveSuspension(db, user.id);
      if (user.status !== UserStatus.SUSPENDED && !active) {
        throw new ConflictError(ErrorCode.NOT_SUSPENDED, '정지 상태가 아닙니다.');
      }
      await db.transaction(async (tx) => {
        await tx.update(users).set({ status: UserStatus.ACTIVE }).where(eq(users.id, user.id));
        if (active) {
          await tx
            .update(userSuspensions)
            .set({ releasedAt: new Date(), releasedBy: actor.adminId, releaseReason: input.reason })
            .where(eq(userSuspensions.id, active.id));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.USER_UNSUSPEND,
          targetType: AuditTargetType.USER,
          targetId: user.publicId,
          reason: input.reason,
          before: { status: user.status, suspensionId: active?.id ?? null },
          after: { status: UserStatus.ACTIVE },
        });
      });
    },
  };
}

/**
 * 기간이 끝난 정지를 자동 해제 (Worker 가 주기적으로 호출) — database.md 4.2
 * @returns 해제한 회원 수
 */
export async function releaseExpiredSuspensions(
  db: Executor,
  now = new Date(),
  batch = 500,
): Promise<number> {
  const expired = await db
    .select({ id: userSuspensions.id, userId: userSuspensions.userId, publicId: users.publicId })
    .from(userSuspensions)
    .innerJoin(users, eq(users.id, userSuspensions.userId))
    .where(
      and(
        isNull(userSuspensions.releasedAt),
        isNotNull(userSuspensions.endsAt),
        lte(userSuspensions.endsAt, now),
      ),
    )
    .limit(batch);
  if (expired.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const e of expired) {
      await tx
        .update(userSuspensions)
        .set({ releasedAt: now, releaseReason: '정지 기간 만료 (자동 해제)' })
        .where(and(eq(userSuspensions.id, e.id), isNull(userSuspensions.releasedAt)));
      await tx
        .update(users)
        .set({ status: UserStatus.ACTIVE })
        .where(and(eq(users.id, e.userId), eq(users.status, UserStatus.SUSPENDED)));
    }
    await writeAuditMany(
      tx,
      systemAuditContext(null, `suspension-expiry-${now.getTime()}`),
      expired.map((e) => ({
        action: AuditAction.USER_UNSUSPEND,
        targetType: AuditTargetType.USER,
        targetId: e.publicId,
        reason: '정지 기간 만료 (자동 해제)',
        after: { status: UserStatus.ACTIVE, suspensionId: e.id },
      })),
    );
  });
  return expired.length;
}

export type UserService = ReturnType<typeof createUserService>;
