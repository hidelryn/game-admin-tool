import type { Request } from 'express';
import { Channel, type AuditAction, type AuditTargetType } from '@game-admin/shared';
import type { Executor } from '../../infra/db/types.js';
import { auditLogs } from '../../infra/db/schema/index.js';

/** 누가·어떤 경로로 (요청 단위) */
export interface AuditContext {
  adminId: number | null;
  apiTokenId: number | null;
  channel: Channel;
  requestId: string | null;
  ip: string | null;
}

/** 무엇을·왜·어떻게 바뀌었나 (작업 단위) */
export interface AuditEntry {
  action: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string | number;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  result?: 'SUCCESS' | 'FAILURE';
  errorCode?: string;
  /** 로그인처럼 아직 인증 전인 경우 대상 운영자를 주체로 기록 */
  adminIdOverride?: number | null;
}

export function auditContextOf(req: Request): AuditContext {
  return {
    adminId: req.auth?.adminId ?? null,
    apiTokenId: req.auth?.apiTokenId ?? null,
    channel: req.auth?.channel ?? Channel.WEB,
    requestId: req.id ? String(req.id) : null,
    ip: req.ip ?? null,
  };
}

export function systemAuditContext(adminId: number | null, requestId: string): AuditContext {
  return { adminId, apiTokenId: null, channel: Channel.SYSTEM, requestId, ip: null };
}

/**
 * 감사 로그 기록. 변경 작업과 **같은 트랜잭션(executor)** 으로 호출해야 한다 (architecture.md 1.3).
 */
export async function writeAudit(db: Executor, ctx: AuditContext, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values(toRow(ctx, e));
}

/** 대량 작업(예: 대량 지급)은 대상별로 한 행씩, 한 번의 INSERT 로 */
export async function writeAuditMany(
  db: Executor,
  ctx: AuditContext,
  entries: AuditEntry[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += 500) {
    await db.insert(auditLogs).values(entries.slice(i, i + 500).map((e) => toRow(ctx, e)));
  }
}

function toRow(ctx: AuditContext, e: AuditEntry): typeof auditLogs.$inferInsert {
  return {
    adminId: e.adminIdOverride !== undefined ? e.adminIdOverride : ctx.adminId,
    apiTokenId: ctx.apiTokenId,
    channel: ctx.channel,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId !== undefined ? String(e.targetId) : null,
    reason: e.reason ?? null,
    beforeData: e.before ?? null,
    afterData: e.after ?? null,
    result: e.result ?? 'SUCCESS',
    errorCode: e.errorCode ?? null,
    requestId: ctx.requestId,
    ip: ctx.ip,
  };
}
