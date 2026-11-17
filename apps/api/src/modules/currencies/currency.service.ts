import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  AuditAction,
  AuditTargetType,
  BULK_GRANT_CONFIRM_THRESHOLD,
  Channel,
  CurrencySource,
  ErrorCode,
  DangerAction,
  type DangerPreview,
  type BulkGrant,
  type BulkGrantResult,
  type ChangeCurrencyRequest,
  type CurrencyBalance,
  type CurrencyChangePreview,
  type CurrencyChangeResult,
  type CurrencyInfo,
  type CurrencyTransaction,
  type CurrencyTransactionsQuery,
} from '@game-admin/shared';
import { BusinessRuleError } from '../../common/errors/app-error.js';
import { decodeCursor, pageOf } from '../../common/http/cursor.js';
import { iso } from '../../common/http/serialize.js';
import type { Executor } from '../../infra/db/types.js';
import { withDeadlockRetry } from '../../infra/db/retry.js';
import {
  admins,
  currencies,
  currencyTransactions,
  userCurrencies,
  users,
} from '../../infra/db/schema/index.js';
import { writeAudit, writeAuditMany, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';
import { getUserOrThrow, isWithdrawn } from '../users/user.repository.js';
import { applyCurrencyChange } from './currency.ledger.js';

type CurrencyRow = typeof currencies.$inferSelect;
export type ChangeOp = 'GRANT' | 'DEDUCT';

/**
 * 위험도 판정 (architecture.md 4.4, mcp-tools.md 2.4~2.5)
 * - 회수: 항상 L2
 * - 지급: 1회 상한 초과 또는 MCP 채널의 유료 재화 → L2
 */
export function needsConfirmation(
  op: ChangeOp,
  amount: number,
  currency: Pick<CurrencyRow, 'grantLimitPerRequest' | 'isPaid'>,
  channel: string,
) {
  if (op === 'DEDUCT') return true;
  if (amount > currency.grantLimitPerRequest) return true;
  return channel === Channel.MCP && currency.isPaid;
}

/** 재화별 합계 (요청에 처음 나온 순서) */
export function bulkTotals(entries: readonly { currencyCode: string; amount: number }[]) {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.currencyCode, (totals.get(e.currencyCode) ?? 0) + e.amount);
  return [...totals].map(([currencyCode, amount]) => ({ currencyCode, amount }));
}

/**
 * 대량 지급 요약 (L3 확인 화면 제목)
 * - 재화 1종·같은 수량: "GOLD 50개 × 3명 지급"
 * - 재화 1종·다른 수량: "GOLD 총 1,230개 · 3명 지급 (1인 30~1,000개)"
 * - 여러 재화: "3명 · 5건 지급 (GOLD 1,200개, GEM 30개, FREE_GEM 10개 외 1종)"
 */
export function summarizeBulkGrant(v: Pick<BulkGrant, 'entries'>): string {
  const totals = bulkTotals(v.entries);
  const users = new Set(v.entries.map((e) => e.publicId)).size.toLocaleString();
  if (totals.length === 1) {
    const code = totals[0]!.currencyCode;
    const amounts = v.entries.map((e) => e.amount);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (min === max) return `${code} ${min.toLocaleString()}개 × ${users}명 지급`;
    return `${code} 총 ${totals[0]!.amount.toLocaleString()}개 · ${users}명 지급 (1인 ${min.toLocaleString()}~${max.toLocaleString()}개)`;
  }
  const shown = totals.slice(0, 3).map((t) => `${t.currencyCode} ${t.amount.toLocaleString()}개`);
  const more = totals.length > 3 ? ` 외 ${totals.length - 3}종` : '';
  return `${users}명 · ${v.entries.length.toLocaleString()}건 지급 (${shown.join(', ')}${more})`;
}

export function createCurrencyService(deps: { db: Executor; confirmation: Confirmation }) {
  const { db, confirmation } = deps;

  async function getCurrency(code: string): Promise<CurrencyRow> {
    const [row] = await db.select().from(currencies).where(eq(currencies.code, code)).limit(1);
    if (!row)
      throw new BusinessRuleError(ErrorCode.INVALID_CURRENCY, `존재하지 않는 재화입니다: ${code}`);
    return row;
  }

  async function currentBalance(userId: number, currencyId: number) {
    const [row] = await db
      .select({ balance: userCurrencies.balance })
      .from(userCurrencies)
      .where(and(eq(userCurrencies.userId, userId), eq(userCurrencies.currencyId, currencyId)));
    return row?.balance ?? 0;
  }

  /** 재화 존재 + 행별 1인당 상한 (확인 화면 전·실행 시점 모두 검사 — 확인하는 사이 상한이 바뀔 수 있음) */
  async function assertBulkLimits(
    input: Pick<BulkGrant, 'entries'>,
  ): Promise<Map<string, CurrencyRow>> {
    const codes = [...new Set(input.entries.map((e) => e.currencyCode))];
    const rows = await db.select().from(currencies).where(inArray(currencies.code, codes));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const unknown = codes.filter((c) => !byCode.has(c));
    if (unknown.length) {
      throw new BusinessRuleError(
        ErrorCode.INVALID_CURRENCY,
        `존재하지 않는 재화입니다: ${unknown.join(', ')}`,
        { invalidCurrencies: unknown },
      );
    }
    const over = input.entries.filter(
      (e) => e.amount > byCode.get(e.currencyCode)!.grantLimitPerRequest,
    );
    if (over.length) {
      throw new BusinessRuleError(
        ErrorCode.EXCEEDS_GRANT_LIMIT,
        `1인당 지급 상한을 넘은 행이 ${over.length}건 있습니다.`,
        {
          // 필요한 필드만 명시 (행에 필드가 늘어도 에러 응답 형태는 그대로)
          overLimit: over.slice(0, 20).map((e) => ({
            publicId: e.publicId,
            currencyCode: e.currencyCode,
            amount: e.amount,
            limit: byCode.get(e.currencyCode)!.grantLimitPerRequest,
          })),
        },
      );
    }
    return byCode;
  }

  /** 대량 지급 실행. 전부 성공하거나 전부 실패 */
  async function executeBulkGrant(
    input: Pick<BulkGrant, 'entries'>,
    audit: AuditContext,
    record?: (tx: Executor, result: BulkGrantResult) => Promise<void>,
  ): Promise<BulkGrantResult> {
    const byCode = await assertBulkLimits(input);
    const publicIds = [...new Set(input.entries.map((e) => e.publicId))];
    const targets = await db
      .select({ id: users.id, publicId: users.publicId, status: users.status })
      .from(users)
      .where(inArray(users.publicId, publicIds));

    const userOf = new Map(targets.map((t) => [t.publicId, t]));
    const missing = publicIds.filter((p) => !userOf.has(p));
    if (missing.length) {
      throw new BusinessRuleError(
        ErrorCode.USER_NOT_FOUND,
        `존재하지 않는 회원이 ${missing.length}명 있습니다.`,
        {
          missing: missing.slice(0, 20),
        },
      );
    }
    const withdrawn = targets.filter(isWithdrawn).map((t) => t.publicId);
    if (withdrawn.length) {
      throw new BusinessRuleError(
        ErrorCode.USER_WITHDRAWN,
        `탈퇴한 회원이 ${withdrawn.length}명 있습니다.`,
        {
          withdrawn: withdrawn.slice(0, 20),
        },
      );
    }

    // 항상 (회원 id, 재화 id) 순서로 잠가 데드락 방지
    const work = input.entries
      .map((e) => ({ ...e, user: userOf.get(e.publicId)!, currency: byCode.get(e.currencyCode)! }))
      .sort((x, y) => x.user.id - y.user.id || x.currency.id - y.currency.id);

    return withDeadlockRetry(() =>
      db.transaction(async (tx) => {
        const changes = [];
        for (const w of work) {
          const r = await applyCurrencyChange(tx, {
            userId: w.user.id,
            currencyId: w.currency.id,
            maxBalance: w.currency.maxBalance,
            delta: w.amount,
            source: CurrencySource.ADMIN,
            reason: w.reason,
            adminId: audit.adminId,
            channel: audit.channel,
            requestId: audit.requestId,
          });
          changes.push({
            publicId: w.publicId,
            currencyCode: w.currencyCode,
            amount: w.amount,
            reason: w.reason,
            ...r,
          });
        }
        await writeAuditMany(
          tx,
          audit,
          changes.map((c) => ({
            action: AuditAction.CURRENCY_GRANT,
            targetType: AuditTargetType.USER,
            targetId: c.publicId,
            reason: c.reason,
            before: { currencyCode: c.currencyCode, balance: c.balanceBefore },
            after: {
              currencyCode: c.currencyCode,
              balance: c.balanceAfter,
              delta: c.amount,
              transactionId: c.transactionId,
              bulk: true,
            },
          })),
        );
        const result: BulkGrantResult = {
          status: 'EXECUTED',
          count: changes.length,
          userCount: publicIds.length,
          totals: bulkTotals(input.entries),
        };
        if (record) await record(tx, result);
        return result;
      }),
    );
  }

  return {
    async list(): Promise<CurrencyInfo[]> {
      const rows = await db.select().from(currencies).orderBy(asc(currencies.id));
      return rows.map((r) => ({
        code: r.code,
        name: r.name,
        isPaid: r.isPaid,
        maxBalance: r.maxBalance,
        grantLimitPerRequest: r.grantLimitPerRequest,
      }));
    },

    async balances(publicId: string): Promise<CurrencyBalance[]> {
      const user = await getUserOrThrow(db, publicId);
      const rows = await db
        .select({
          code: currencies.code,
          name: currencies.name,
          maxBalance: currencies.maxBalance,
          balance: userCurrencies.balance,
        })
        .from(currencies)
        .leftJoin(
          userCurrencies,
          and(eq(userCurrencies.currencyId, currencies.id), eq(userCurrencies.userId, user.id)),
        )
        .orderBy(asc(currencies.id));
      return rows.map((r) => ({
        currencyCode: r.code,
        name: r.name,
        balance: r.balance ?? 0,
        maxBalance: r.maxBalance,
      }));
    },

    async transactions(q: CurrencyTransactionsQuery) {
      const cursor = decodeCursor(q.cursor, z.object({ id: z.number().int().positive() }));
      const conds: SQL[] = [];
      if (q.publicId)
        conds.push(eq(currencyTransactions.userId, (await getUserOrThrow(db, q.publicId)).id));
      if (q.currencyCode)
        conds.push(eq(currencyTransactions.currencyId, (await getCurrency(q.currencyCode)).id));
      if (q.source) conds.push(eq(currencyTransactions.source, q.source));
      if (q.adminId) conds.push(eq(currencyTransactions.adminId, q.adminId));
      if (q.from) conds.push(gte(currencyTransactions.createdAt, q.from));
      if (q.to) conds.push(lte(currencyTransactions.createdAt, q.to));
      if (cursor) conds.push(lt(currencyTransactions.id, cursor.id));

      const rows = await db
        .select({
          id: currencyTransactions.id,
          publicId: users.publicId,
          currencyCode: currencies.code,
          delta: currencyTransactions.delta,
          balanceBefore: currencyTransactions.balanceBefore,
          balanceAfter: currencyTransactions.balanceAfter,
          source: currencyTransactions.source,
          reason: currencyTransactions.reason,
          adminId: currencyTransactions.adminId,
          adminName: admins.name,
          channel: currencyTransactions.channel,
          createdAt: currencyTransactions.createdAt,
        })
        .from(currencyTransactions)
        .innerJoin(currencies, eq(currencies.id, currencyTransactions.currencyId))
        .leftJoin(users, eq(users.id, currencyTransactions.userId))
        .leftJoin(admins, eq(admins.id, currencyTransactions.adminId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(currencyTransactions.id))
        .limit(q.size + 1);

      const { items, nextCursor } = pageOf(rows, q.size, (last) => ({ id: last.id }));
      const data: CurrencyTransaction[] = items.map((r) => ({
        ...r,
        source: r.source as CurrencyTransaction['source'],
        createdAt: iso(r.createdAt),
      }));
      return { items: data, meta: { size: q.size, nextCursor } };
    },

    /** 단건 지급·회수. L2 이면 확인 토큰 절차를 거친다 */
    async change(
      actor: AuthContext,
      op: ChangeOp,
      publicId: string,
      input: ChangeCurrencyRequest,
      audit: AuditContext,
      record?: (tx: Executor, result: CurrencyChangeResult) => Promise<void>,
    ): Promise<CurrencyChangeResult> {
      const user = await getUserOrThrow(db, publicId);
      if (isWithdrawn(user))
        throw new BusinessRuleError(ErrorCode.USER_WITHDRAWN, '탈퇴한 회원입니다.');
      const currency = await getCurrency(input.currencyCode);
      const delta = op === 'GRANT' ? input.amount : -input.amount;

      if (needsConfirmation(op, input.amount, currency, actor.channel)) {
        const before = await currentBalance(user.id, currency.id);
        if (before + delta < 0) {
          throw new BusinessRuleError(ErrorCode.INSUFFICIENT_BALANCE, '보유 재화가 부족합니다.', {
            balance: before,
            requested: input.amount,
          });
        }
        const { confirmationToken, ...payload } = input;
        await confirmation.require<CurrencyChangePreview>({
          adminId: actor.adminId,
          action: `CURRENCY_${op}`,
          payload: { publicId, ...payload },
          token: confirmationToken,
          preview: () => ({
            publicId,
            currencyCode: currency.code,
            delta,
            balanceBefore: before,
            balanceAfter: before + delta,
          }),
        });
      }

      return withDeadlockRetry(() =>
        db.transaction(async (tx) => {
          const r = await applyCurrencyChange(tx, {
            userId: user.id,
            currencyId: currency.id,
            maxBalance: currency.maxBalance,
            delta,
            source: CurrencySource.ADMIN,
            reason: input.reason,
            adminId: actor.adminId,
            channel: actor.channel,
            requestId: audit.requestId,
          });
          await writeAudit(tx, audit, {
            action: op === 'GRANT' ? AuditAction.CURRENCY_GRANT : AuditAction.CURRENCY_DEDUCT,
            targetType: AuditTargetType.USER,
            targetId: user.publicId,
            reason: input.reason,
            before: { currencyCode: currency.code, balance: r.balanceBefore },
            after: {
              currencyCode: currency.code,
              balance: r.balanceAfter,
              delta,
              transactionId: r.transactionId,
            },
          });
          const result: CurrencyChangeResult = {
            status: 'EXECUTED',
            transactionId: r.transactionId,
            publicId: user.publicId,
            currencyCode: currency.code,
            delta,
            balanceBefore: r.balanceBefore,
            balanceAfter: r.balanceAfter,
          };
          if (record) await record(tx, result);
          return result;
        }),
      );
    },

    /** 게임 서버(시뮬레이터)의 재화 획득·소비 — source=GAME, 감사 로그 대신 원장에만 기록 */
    async gameChange(publicId: string, currencyCode: string, delta: number, reason: string) {
      const user = await getUserOrThrow(db, publicId);
      if (isWithdrawn(user))
        throw new BusinessRuleError(ErrorCode.USER_WITHDRAWN, '탈퇴한 회원입니다.');
      const currency = await getCurrency(currencyCode);
      return withDeadlockRetry(() =>
        db.transaction((tx) =>
          applyCurrencyChange(tx, {
            userId: user.id,
            currencyId: currency.id,
            maxBalance: currency.maxBalance,
            delta,
            source: CurrencySource.GAME,
            reason,
            adminId: null,
            channel: null,
            requestId: null,
          }),
        ),
      );
    },

    /**
     * 대량 지급: 100명 미만은 바로 실행(L1)
     * 100명 이상은 빨간 경고 확인 후 실행(L3) — 웹에서만, MCP 는 미리보기까지
     */
    async bulkGrant(
      actor: AuthContext,
      input: BulkGrant,
      audit: AuditContext,
      record: (tx: Executor, status: number, body: unknown) => Promise<void>,
    ): Promise<BulkGrantResult> {
      const { confirmationToken, ...grant } = input;
      const userCount = new Set(grant.entries.map((e) => e.publicId)).size;
      if (userCount >= BULK_GRANT_CONFIRM_THRESHOLD) {
        // 확인 화면 전에 검증 가능한 것은 미리 확인 (재화 존재·상한)
        const byCode = await assertBulkLimits(grant);
        await confirmation.require<DangerPreview>({
          adminId: actor.adminId,
          action: DangerAction.CURRENCY_BULK_GRANT,
          payload: grant,
          token: confirmationToken,
          webOnly: { channel: actor.channel },
          preview: () => ({
            action: DangerAction.CURRENCY_BULK_GRANT,
            title: summarizeBulkGrant(grant),
            facts: [
              { label: '대상 회원', value: `${userCount.toLocaleString()}명` },
              { label: '지급 건수', value: `${grant.entries.length.toLocaleString()}건` },
              ...bulkTotals(grant.entries).map((t) => ({
                label: byCode.get(t.currencyCode)?.name ?? t.currencyCode,
                value: `총 ${t.amount.toLocaleString()}개`,
              })),
            ],
            warnings: [
              `${userCount.toLocaleString()}명에게 바로 지급됩니다.`,
              '되돌리려면 회원마다 회수해야 합니다. 파일 내용(회원 ID·수량)을 다시 확인하세요.',
            ],
          }),
        });
      }
      return executeBulkGrant(grant, audit, (tx, r) => record(tx, 200, { data: r }));
    },
  };
}

export type CurrencyService = ReturnType<typeof createCurrencyService>;
