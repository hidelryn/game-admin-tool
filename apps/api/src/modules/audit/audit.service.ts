import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ErrorCode,
  RoleCode,
  type AuditLogItem,
  type ListAuditLogsQuery,
} from '@game-admin/shared';
import { NotFoundError } from '../../common/errors/app-error.js';
import { decodeCursor, pageOf } from '../../common/http/cursor.js';
import { iso } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { admins, auditLogs } from '../../infra/db/schema/index.js';
import type { AuthContext } from '../auth/auth-context.js';

const columns = {
  id: auditLogs.id,
  adminId: auditLogs.adminId,
  adminName: admins.name,
  apiTokenId: auditLogs.apiTokenId,
  channel: auditLogs.channel,
  action: auditLogs.action,
  targetType: auditLogs.targetType,
  targetId: auditLogs.targetId,
  reason: auditLogs.reason,
  before: auditLogs.beforeData,
  after: auditLogs.afterData,
  result: auditLogs.result,
  errorCode: auditLogs.errorCode,
  requestId: auditLogs.requestId,
  ip: auditLogs.ip,
  createdAt: auditLogs.createdAt,
};

interface Row {
  id: number;
  adminId: number | null;
  adminName: string | null;
  apiTokenId: number | null;
  channel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  result: string;
  errorCode: string | null;
  requestId: string | null;
  ip: string | null;
  createdAt: Date;
}

const toItem = (r: Row): AuditLogItem => ({
  id: r.id,
  admin: r.adminId ? { id: r.adminId, name: r.adminName ?? '' } : null,
  apiTokenId: r.apiTokenId,
  channel: r.channel,
  action: r.action,
  targetType: r.targetType,
  targetId: r.targetId,
  reason: r.reason,
  before: r.before,
  after: r.after,
  result: r.result,
  errorCode: r.errorCode,
  requestId: r.requestId,
  ip: r.ip,
  createdAt: iso(r.createdAt),
});

/**
 * 운영 로그 조회 (FR-LOG-03). 수정·삭제 기능은 의도적으로 없다 (FR-LOG-04).
 * CS 역할은 본인 작업만 조회 (architecture.md 4.3)
 */
export function createAuditService(deps: { db: Executor }) {
  const { db } = deps;
  const scope = (actor: AuthContext): SQL | undefined =>
    actor.roleCode === RoleCode.CS ? eq(auditLogs.adminId, actor.adminId) : undefined;

  return {
    async list(actor: AuthContext, q: ListAuditLogsQuery) {
      const cursor = decodeCursor(q.cursor, z.object({ id: z.number().int().positive() }));
      const conds: SQL[] = [];
      const s = scope(actor);
      if (s) conds.push(s);
      if (q.adminId) conds.push(eq(auditLogs.adminId, q.adminId));
      if (q.action) conds.push(eq(auditLogs.action, q.action));
      if (q.targetType) conds.push(eq(auditLogs.targetType, q.targetType));
      if (q.targetId) conds.push(eq(auditLogs.targetId, q.targetId));
      if (q.channel) conds.push(eq(auditLogs.channel, q.channel));
      if (q.result) conds.push(eq(auditLogs.result, q.result));
      if (q.from) conds.push(gte(auditLogs.createdAt, q.from));
      if (q.to) conds.push(lte(auditLogs.createdAt, q.to));
      if (cursor) conds.push(lt(auditLogs.id, cursor.id));

      const rows = (await db
        .select(columns)
        .from(auditLogs)
        .leftJoin(admins, eq(admins.id, auditLogs.adminId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLogs.id))
        .limit(q.size + 1)) as Row[];
      const { items, nextCursor } = pageOf(rows, q.size, (last) => ({ id: last.id }));
      return { items: items.map(toItem), meta: { size: q.size, nextCursor } };
    },

    async get(actor: AuthContext, id: number): Promise<AuditLogItem> {
      const s = scope(actor);
      const [row] = (await db
        .select(columns)
        .from(auditLogs)
        .leftJoin(admins, eq(admins.id, auditLogs.adminId))
        .where(s ? and(eq(auditLogs.id, id), s) : eq(auditLogs.id, id))
        .limit(1)) as Row[];
      if (!row) throw new NotFoundError(ErrorCode.NOT_FOUND, '운영 로그를 찾을 수 없습니다.');
      return toItem(row);
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
