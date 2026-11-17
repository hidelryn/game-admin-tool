import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  ActivityType,
  AuditAction,
  AuditTargetType,
  Channel,
  CurrencySource,
  ErrorCode,
  ITEM_REWARD_MAX,
  MAIL_MAX_RECIPIENTS_MCP,
  MailStatus,
  MailType,
  Permission,
  RewardType,
  DangerAction,
  UserStatus,
  type DangerPreview,
  type CancelMailRequest,
  type ListMailsQuery,
  type MailClaimResult,
  type MailDetail,
  type MailRecipientView,
  type MailRewardView,
  type MailSent,
  type MailSummary,
  type Reward,
  type SendGlobalMailRequest,
  type SendMailRequest,
  type UserMailboxItem,
} from '@game-admin/shared';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import { withDeadlockRetry } from '../../infra/db/retry.js';
import type { Executor } from '../../infra/db/types.js';
import { affectedRows } from '../../infra/db/types.js';
import {
  admins,
  currencies,
  globalMailClaims,
  items,
  mailRecipients,
  mailRewards,
  mails,
  userActivityLogs,
  userItems,
  users,
} from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import { applyCurrencyChange } from '../currencies/currency.ledger.js';
import type { Confirmation } from '../safety/confirmation.js';
import { getUserOrThrow, isWithdrawn } from '../users/user.repository.js';

type MailRow = typeof mails.$inferSelect;

export interface ResolvedReward {
  rewardType: RewardType;
  refId: number;
  quantity: number;
  code: string;
  name: string;
  maxBalance: number | null;
}

/** 전체 우편 대상 조건 (발송 시 수신자 행을 만들지 않고, 수령 시 판단 — database.md 4.3) */
function isEligible(mail: Pick<MailRow, 'targetFilter'>, user: { registeredAt: Date }) {
  const before = (mail.targetFilter as { registeredBefore?: string } | null)?.registeredBefore;
  return !before || user.registeredAt < new Date(before);
}

export function createMailService(deps: { db: Executor; confirmation: Confirmation }) {
  const { db, confirmation } = deps;

  async function catalog() {
    const [cs, is] = await Promise.all([db.select().from(currencies), db.select().from(items)]);
    return { currencies: cs, items: is };
  }

  /** 보상 코드 → 마스터 ID. 없는 코드·상한 초과는 거부 */
  async function resolveRewards(rewards: readonly Reward[]): Promise<ResolvedReward[]> {
    const { currencies: cs, items: is } = await catalog();
    return rewards.map((r) => {
      if (r.type === RewardType.CURRENCY) {
        const c = cs.find((x) => x.code === r.code);
        if (!c)
          throw new BusinessRuleError(
            ErrorCode.INVALID_REWARD,
            `존재하지 않는 재화입니다: ${r.code}`,
          );
        if (r.quantity > c.grantLimitPerRequest) {
          throw new BusinessRuleError(
            ErrorCode.REWARD_LIMIT_EXCEEDED,
            `${c.code} 보상은 ${c.grantLimitPerRequest}개까지입니다.`,
          );
        }
        return {
          rewardType: r.type,
          refId: c.id,
          quantity: r.quantity,
          code: c.code,
          name: c.name,
          maxBalance: c.maxBalance,
        };
      }
      const it = is.find((x) => x.code === r.code);
      if (!it)
        throw new BusinessRuleError(
          ErrorCode.INVALID_REWARD,
          `존재하지 않는 아이템입니다: ${r.code}`,
        );
      if (r.quantity > ITEM_REWARD_MAX) {
        throw new BusinessRuleError(
          ErrorCode.REWARD_LIMIT_EXCEEDED,
          `아이템 보상은 ${ITEM_REWARD_MAX}개까지입니다.`,
        );
      }
      return {
        rewardType: r.type,
        refId: it.id,
        quantity: r.quantity,
        code: it.code,
        name: it.name,
        maxBalance: null,
      };
    });
  }

  async function rewardViews(mailIds: number[]): Promise<Map<number, MailRewardView[]>> {
    const map = new Map<number, MailRewardView[]>();
    if (!mailIds.length) return map;
    const [rows, cat] = await Promise.all([
      db
        .select()
        .from(mailRewards)
        .where(inArray(mailRewards.mailId, mailIds))
        .orderBy(asc(mailRewards.id)),
      catalog(),
    ]);
    for (const r of rows) {
      const master =
        r.rewardType === RewardType.CURRENCY
          ? cat.currencies.find((c) => c.id === r.refId)
          : cat.items.find((i) => i.id === r.refId);
      const list = map.get(r.mailId) ?? [];
      list.push({
        type: r.rewardType as RewardType,
        code: master?.code ?? String(r.refId),
        name: master?.name ?? '',
        quantity: r.quantity,
      });
      map.set(r.mailId, list);
    }
    return map;
  }

  async function summaries(rows: MailRow[]): Promise<MailSummary[]> {
    const ids = rows.map((m) => m.id);
    if (!ids.length) return [];
    const [rewards, recipientCounts, claimedUser, claimedGlobal, creators] = await Promise.all([
      rewardViews(ids),
      db
        .select({ mailId: mailRecipients.mailId, n: count() })
        .from(mailRecipients)
        .where(inArray(mailRecipients.mailId, ids))
        .groupBy(mailRecipients.mailId),
      db
        .select({ mailId: mailRecipients.mailId, n: count() })
        .from(mailRecipients)
        .where(and(inArray(mailRecipients.mailId, ids), isNotNull(mailRecipients.claimedAt)))
        .groupBy(mailRecipients.mailId),
      db
        .select({ mailId: globalMailClaims.mailId, n: count() })
        .from(globalMailClaims)
        .where(inArray(globalMailClaims.mailId, ids))
        .groupBy(globalMailClaims.mailId),
      db
        .select({ id: admins.id, name: admins.name })
        .from(admins)
        .where(inArray(admins.id, [...new Set(rows.map((m) => m.createdBy))])),
    ]);
    const n = (list: { mailId: number; n: number }[], id: number) =>
      list.find((x) => x.mailId === id)?.n ?? 0;
    return rows.map((m) => ({
      id: m.id,
      type: m.type as MailType,
      title: m.title,
      status: m.status as MailStatus,
      rewards: rewards.get(m.id) ?? [],
      recipientCount: m.type === MailType.USER ? n(recipientCounts, m.id) : null,
      claimedCount: m.type === MailType.USER ? n(claimedUser, m.id) : n(claimedGlobal, m.id),
      expiresAt: iso(m.expiresAt),
      sentAt: isoOrNull(m.sentAt),
      canceledAt: isoOrNull(m.canceledAt),
      createdBy: { id: m.createdBy, name: creators.find((c) => c.id === m.createdBy)?.name ?? '' },
      reason: m.reason,
      createdAt: iso(m.createdAt),
    }));
  }

  async function loadMail(id: number): Promise<MailRow> {
    const [row] = await db.select().from(mails).where(eq(mails.id, id)).limit(1);
    if (!row) throw new NotFoundError(ErrorCode.MAIL_NOT_FOUND, '우편을 찾을 수 없습니다.');
    return row;
  }

  async function insertMail(
    tx: Executor,
    m: {
      type: MailType;
      title: string;
      body: string;
      expiresInDays: number;
      createdBy: number;
      reason: string;
      targetFilter?: Record<string, unknown> | null;
    },
    rewards: ResolvedReward[],
  ) {
    const now = new Date();
    const [created] = await tx
      .insert(mails)
      .values({
        type: m.type,
        title: m.title,
        body: m.body,
        status: MailStatus.SENT,
        sentAt: now,
        expiresAt: new Date(now.getTime() + m.expiresInDays * 86_400_000),
        targetFilter: m.targetFilter ?? null,
        createdBy: m.createdBy,
        reason: m.reason,
      })
      .$returningId();
    const mailId = created!.id;
    if (rewards.length) {
      await tx.insert(mailRewards).values(
        rewards.map((r) => ({
          mailId,
          rewardType: r.rewardType,
          refId: r.refId,
          quantity: r.quantity,
        })),
      );
    }
    return mailId;
  }

  const rewardAudit = (rs: ResolvedReward[]) =>
    rs.map((r) => ({ type: r.rewardType, code: r.code, quantity: r.quantity }));

  return {
    /** 보상 코드 검증·변환 (없는 코드·상한 초과 거부) — 다른 기능이 요청 시점에 미리 검증할 때 */
    resolveRewards,

    /**
     * 다른 기능(랭킹 보상 등)이 자기 트랜잭션 안에서 개별 우편을 만들 때
     * 대상 회원 검증은 호출하는 쪽 책임 (탈퇴 회원 제외 등)
     */
    async createUserMailInTx(
      tx: Executor,
      audit: AuditContext,
      m: { title: string; body: string; expiresInDays: number; reason: string; createdBy: number },
      rewards: ResolvedReward[],
      userIds: number[],
      auditExtra: Record<string, unknown> = {},
    ): Promise<number> {
      const mailId = await insertMail(tx, { type: MailType.USER, ...m }, rewards);
      for (let i = 0; i < userIds.length; i += 500) {
        await tx
          .insert(mailRecipients)
          .values(userIds.slice(i, i + 500).map((userId) => ({ mailId, userId })));
      }
      await writeAudit(tx, audit, {
        action: AuditAction.MAIL_SEND,
        targetType: AuditTargetType.MAIL,
        targetId: mailId,
        reason: m.reason,
        after: {
          title: m.title,
          rewards: rewardAudit(rewards),
          recipientCount: userIds.length,
          ...auditExtra,
        },
      });
      return mailId;
    },

    listItems() {
      return db
        .select({ code: items.code, name: items.name, stackable: items.stackable })
        .from(items)
        .orderBy(asc(items.id));
    },

    async list(q: ListMailsQuery) {
      const conds: SQL[] = [];
      if (q.type) conds.push(eq(mails.type, q.type));
      if (q.status) conds.push(eq(mails.status, q.status));
      if (q.createdBy) conds.push(eq(mails.createdBy, q.createdBy));
      if (q.from) conds.push(gte(mails.createdAt, q.from));
      if (q.to) conds.push(lte(mails.createdAt, q.to));
      const where = conds.length ? and(...conds) : undefined;
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(mails)
          .where(where)
          .orderBy(desc(mails.id))
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(mails).where(where),
      ]);
      return {
        items: await summaries(rows),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    async detail(id: number): Promise<MailDetail> {
      const mail = await loadMail(id);
      const [summary] = await summaries([mail]);
      return {
        ...summary!,
        body: mail.body,
        targetFilter: (mail.targetFilter as Record<string, unknown> | null) ?? null,
      };
    },

    async recipients(
      id: number,
      page: number,
      size: number,
    ): Promise<{ items: MailRecipientView[]; meta: object }> {
      const mail = await loadMail(id);
      if (mail.type === MailType.USER) {
        const [rows, totals] = await Promise.all([
          db
            .select({
              publicId: users.publicId,
              nickname: users.nickname,
              readAt: mailRecipients.readAt,
              claimedAt: mailRecipients.claimedAt,
            })
            .from(mailRecipients)
            .innerJoin(users, eq(users.id, mailRecipients.userId))
            .where(eq(mailRecipients.mailId, id))
            .orderBy(asc(users.id))
            .limit(size)
            .offset((page - 1) * size),
          db.select({ n: count() }).from(mailRecipients).where(eq(mailRecipients.mailId, id)),
        ]);
        return {
          items: rows.map((r) => ({
            ...r,
            readAt: isoOrNull(r.readAt),
            claimedAt: isoOrNull(r.claimedAt),
          })),
          meta: { page, size, total: totals[0]?.n ?? 0 },
        };
      }
      // 전체 우편은 수령한 회원만 존재
      const [rows, totals] = await Promise.all([
        db
          .select({
            publicId: users.publicId,
            nickname: users.nickname,
            claimedAt: globalMailClaims.claimedAt,
          })
          .from(globalMailClaims)
          .innerJoin(users, eq(users.id, globalMailClaims.userId))
          .where(eq(globalMailClaims.mailId, id))
          .orderBy(desc(globalMailClaims.claimedAt))
          .limit(size)
          .offset((page - 1) * size),
        db.select({ n: count() }).from(globalMailClaims).where(eq(globalMailClaims.mailId, id)),
      ]);
      return {
        items: rows.map((r) => ({ ...r, readAt: null, claimedAt: iso(r.claimedAt) })),
        meta: { page, size, total: totals[0]?.n ?? 0 },
      };
    },

    async sendToUsers(
      actor: AuthContext,
      input: SendMailRequest,
      audit: AuditContext,
      record?: (tx: Executor, result: MailSent) => Promise<void>,
    ): Promise<MailSent> {
      if (actor.channel === Channel.MCP && input.publicIds.length > MAIL_MAX_RECIPIENTS_MCP) {
        throw new BusinessRuleError(
          ErrorCode.RECIPIENT_LIMIT_EXCEEDED,
          `MCP 에서는 한 번에 ${MAIL_MAX_RECIPIENTS_MCP}명까지 발송할 수 있습니다.`,
        );
      }
      const rewards = await resolveRewards(input.rewards);
      const targets = await db
        .select({ id: users.id, publicId: users.publicId, status: users.status })
        .from(users)
        .where(inArray(users.publicId, input.publicIds));
      const found = new Set(targets.map((t) => t.publicId));
      const missing = input.publicIds.filter((p) => !found.has(p));
      if (missing.length) {
        throw new BusinessRuleError(
          ErrorCode.USER_NOT_FOUND,
          `존재하지 않는 회원이 ${missing.length}명 있습니다.`,
          { missing: missing.slice(0, 20) },
        );
      }
      const withdrawn = targets.filter(isWithdrawn).map((t) => t.publicId);
      if (withdrawn.length) {
        throw new BusinessRuleError(
          ErrorCode.USER_WITHDRAWN,
          `탈퇴한 회원이 ${withdrawn.length}명 있습니다.`,
          { withdrawn: withdrawn.slice(0, 20) },
        );
      }

      return db.transaction(async (tx) => {
        const mailId = await insertMail(
          tx,
          { type: MailType.USER, ...input, createdBy: actor.adminId },
          rewards,
        );
        for (let i = 0; i < targets.length; i += 500) {
          await tx
            .insert(mailRecipients)
            .values(targets.slice(i, i + 500).map((t) => ({ mailId, userId: t.id })));
        }
        await writeAudit(tx, audit, {
          action: AuditAction.MAIL_SEND,
          targetType: AuditTargetType.MAIL,
          targetId: mailId,
          reason: input.reason,
          after: {
            title: input.title,
            rewards: rewardAudit(rewards),
            recipientCount: targets.length,
            recipients: input.publicIds.slice(0, 100),
          },
        });
        const result: MailSent = { status: 'SENT', mailId, recipientCount: targets.length };
        if (record) await record(tx, result);
        return result;
      });
    },

    /**
     * 전체 발송 (L3): 빨간 경고 확인 후 바로 생성 — 웹에서만, MCP 는 미리보기까지
     * 수신자 행은 만들지 않고 수령 시 대상 조건을 판단 (database.md 4.3)
     */
    async sendGlobal(
      actor: AuthContext,
      input: SendGlobalMailRequest,
      audit: AuditContext,
      record?: (tx: Executor, result: { mailId: number }) => Promise<void>,
    ): Promise<{ mailId: number }> {
      const rewards = await resolveRewards(input.rewards);
      const registeredBefore = input.targetFilter?.registeredBefore ?? null;
      const targetFilter = registeredBefore
        ? { registeredBefore: registeredBefore.toISOString() }
        : null;
      const payload = {
        title: input.title,
        body: input.body,
        rewards: input.rewards,
        expiresInDays: input.expiresInDays,
        targetFilter,
        reason: input.reason,
      };
      await confirmation.require<DangerPreview>({
        adminId: actor.adminId,
        action: DangerAction.MAIL_SEND_ALL,
        payload,
        token: input.confirmationToken,
        webOnly: { channel: actor.channel },
        preview: async () => {
          const conds: SQL[] = [inArray(users.status, [UserStatus.ACTIVE, UserStatus.SUSPENDED])];
          if (registeredBefore) conds.push(sql`${users.registeredAt} < ${registeredBefore}`);
          const [n] = await db
            .select({ n: count() })
            .from(users)
            .where(and(...conds));
          return {
            action: DangerAction.MAIL_SEND_ALL,
            title: `전체 우편 "${input.title}"`,
            facts: [
              {
                label: '대상',
                value: registeredBefore
                  ? `${registeredBefore.toISOString().slice(0, 16).replace('T', ' ')} (UTC) 이전 가입 회원`
                  : '전체 회원',
              },
              { label: '대상 회원 (현재)', value: `약 ${(n?.n ?? 0).toLocaleString()}명` },
              ...rewards.map((r) => ({ label: r.name, value: `${r.quantity.toLocaleString()}개` })),
              { label: '수령 기한', value: `${input.expiresInDays}일` },
            ],
            warnings: [
              '확인하면 바로 모든 대상 회원의 우편함에 들어갑니다.',
              '발송 후 취소해도 이미 받은 보상은 회수되지 않습니다.',
            ],
          };
        },
      });
      return db.transaction(async (tx) => {
        const mailId = await insertMail(
          tx,
          {
            type: MailType.GLOBAL,
            ...payload,
            createdBy: actor.adminId,
          },
          rewards,
        );
        await writeAudit(tx, audit, {
          action: AuditAction.MAIL_SEND_ALL,
          targetType: AuditTargetType.MAIL,
          targetId: mailId,
          reason: input.reason,
          after: { title: input.title, rewards: rewardAudit(rewards), targetFilter },
        });
        if (record) await record(tx, { mailId });
        return { mailId };
      });
    },

    /** 발송 취소 (L2). 이미 받은 보상은 회수하지 않고, 미수령분만 막는다 */
    async cancel(actor: AuthContext, id: number, input: CancelMailRequest, audit: AuditContext) {
      const mail = await loadMail(id);
      if (mail.type === MailType.GLOBAL && !actor.permissions.has(Permission.MAIL_SEND_ALL)) {
        throw new ForbiddenError(
          ErrorCode.PERMISSION_DENIED,
          '전체 우편 취소에는 mail:send_all 권한이 필요합니다.',
        );
      }
      if (mail.status === MailStatus.CANCELED)
        throw new ConflictError(ErrorCode.MAIL_ALREADY_CANCELED, '이미 취소된 우편입니다.');
      const [summary] = await summaries([mail]);
      const { confirmationToken, ...payload } = input;
      await confirmation.require({
        adminId: actor.adminId,
        action: 'MAIL_CANCEL',
        payload: { mailId: id, ...payload },
        token: confirmationToken,
        preview: () => ({
          mailId: id,
          title: mail.title,
          type: mail.type,
          recipientCount: summary!.recipientCount,
          claimedCount: summary!.claimedCount,
        }),
      });
      await db.transaction(async (tx) => {
        const r = await tx
          .update(mails)
          .set({ status: MailStatus.CANCELED, canceledAt: new Date() })
          .where(and(eq(mails.id, id), eq(mails.status, MailStatus.SENT)));
        if (affectedRows(r) !== 1)
          throw new ConflictError(ErrorCode.MAIL_ALREADY_CANCELED, '이미 취소된 우편입니다.');
        await writeAudit(tx, audit, {
          action: AuditAction.MAIL_CANCEL,
          targetType: AuditTargetType.MAIL,
          targetId: id,
          reason: input.reason,
          before: { status: mail.status, claimedCount: summary!.claimedCount },
          after: { status: MailStatus.CANCELED },
        });
      });
      return this.detail(id);
    },

    async mailbox(publicId: string): Promise<UserMailboxItem[]> {
      const user = await getUserOrThrow(db, publicId);
      const [personal, globals, claims] = await Promise.all([
        db
          .select({ mail: mails, claimedAt: mailRecipients.claimedAt })
          .from(mailRecipients)
          .innerJoin(mails, eq(mails.id, mailRecipients.mailId))
          .where(eq(mailRecipients.userId, user.id))
          .orderBy(desc(mails.id))
          .limit(50),
        db
          .select()
          .from(mails)
          .where(eq(mails.type, MailType.GLOBAL))
          .orderBy(desc(mails.id))
          .limit(50),
        db.select().from(globalMailClaims).where(eq(globalMailClaims.userId, user.id)),
      ]);
      const eligibleGlobals = globals.filter((m) => isEligible(m, user));
      const rewards = await rewardViews([
        ...personal.map((p) => p.mail.id),
        ...eligibleGlobals.map((m) => m.id),
      ]);
      const view = (m: MailRow, claimedAt: Date | null): UserMailboxItem => ({
        mailId: m.id,
        type: m.type as MailType,
        title: m.title,
        rewards: rewards.get(m.id) ?? [],
        status: m.status as MailStatus,
        expiresAt: iso(m.expiresAt),
        claimedAt: isoOrNull(claimedAt),
      });
      return [
        ...personal.map((p) => view(p.mail, p.claimedAt)),
        ...eligibleGlobals.map((m) =>
          view(m, claims.find((c) => c.mailId === m.id)?.claimedAt ?? null),
        ),
      ].sort((a, b) => b.mailId - a.mailId);
    },

    /**
     * 우편 수령 (게임 서버/시뮬레이터가 호출) — 보상 지급과 수령 표시를 한 트랜잭션으로
     * 중복 수령: 개별 우편은 claimed_at IS NULL 조건부 UPDATE, 전체 우편은 (mail_id, user_id) PK 로 막는다
     */
    async claim(publicId: string, mailId: number, now = new Date()): Promise<MailClaimResult> {
      const user = await getUserOrThrow(db, publicId);
      if (isWithdrawn(user))
        throw new BusinessRuleError(ErrorCode.USER_WITHDRAWN, '탈퇴한 회원입니다.');
      const mail = await loadMail(mailId);
      const rewards = await db.select().from(mailRewards).where(eq(mailRewards.mailId, mailId));
      const cat = await catalog();

      if (mail.type === MailType.USER) {
        const [recipient] = await db
          .select()
          .from(mailRecipients)
          .where(and(eq(mailRecipients.mailId, mailId), eq(mailRecipients.userId, user.id)));
        if (!recipient)
          throw new NotFoundError(ErrorCode.MAIL_NOT_FOUND, '이 회원에게 발송된 우편이 아닙니다.');
      } else if (!isEligible(mail, user)) {
        throw new BusinessRuleError(ErrorCode.MAIL_NOT_CLAIMABLE, '수령 대상이 아닌 우편입니다.');
      }

      return withDeadlockRetry(() =>
        db.transaction(async (tx) => {
          // 취소와 동시에 일어나지 않도록 우편 행을 공유 잠금으로 확인
          const [locked] = await tx
            .select({ status: mails.status, expiresAt: mails.expiresAt })
            .from(mails)
            .where(eq(mails.id, mailId))
            .for('share');
          if (!locked || locked.status !== MailStatus.SENT || locked.expiresAt <= now) {
            throw new BusinessRuleError(
              ErrorCode.MAIL_NOT_CLAIMABLE,
              '취소되었거나 만료된 우편입니다.',
            );
          }

          if (mail.type === MailType.USER) {
            const r = await tx
              .update(mailRecipients)
              .set({ claimedAt: now, readAt: sql`coalesce(${mailRecipients.readAt}, ${now})` })
              .where(
                and(
                  eq(mailRecipients.mailId, mailId),
                  eq(mailRecipients.userId, user.id),
                  sql`${mailRecipients.claimedAt} is null`,
                ),
              );
            if (affectedRows(r) !== 1)
              throw new ConflictError(ErrorCode.MAIL_ALREADY_CLAIMED, '이미 수령한 우편입니다.');
          } else {
            try {
              await tx.insert(globalMailClaims).values({ mailId, userId: user.id, claimedAt: now });
            } catch (err) {
              if (isDuplicateKeyError(err))
                throw new ConflictError(ErrorCode.MAIL_ALREADY_CLAIMED, '이미 수령한 우편입니다.');
              throw err;
            }
          }

          const granted: MailRewardView[] = [];
          for (const r of rewards) {
            if (r.rewardType === RewardType.CURRENCY) {
              const c = cat.currencies.find((x) => x.id === r.refId)!;
              await applyCurrencyChange(tx, {
                userId: user.id,
                currencyId: c.id,
                maxBalance: c.maxBalance,
                delta: r.quantity,
                source: CurrencySource.MAIL,
                reason: `우편 수령 #${mailId}`,
                adminId: null,
                channel: null,
                requestId: null,
                mailId,
              });
              granted.push({
                type: RewardType.CURRENCY,
                code: c.code,
                name: c.name,
                quantity: r.quantity,
              });
            } else {
              const it = cat.items.find((x) => x.id === r.refId)!;
              await tx
                .insert(userItems)
                .values({ userId: user.id, itemId: it.id, quantity: r.quantity })
                .onDuplicateKeyUpdate({
                  set: { quantity: sql`${userItems.quantity} + ${r.quantity}` },
                });
              granted.push({
                type: RewardType.ITEM,
                code: it.code,
                name: it.name,
                quantity: r.quantity,
              });
            }
          }
          await tx.insert(userActivityLogs).values({
            userId: user.id,
            type: ActivityType.MAIL_CLAIM,
            payload: { mailId },
            occurredAt: now,
          });
          return {
            mailId,
            publicId: user.publicId,
            rewards: granted,
            claimedAt: now.toISOString(),
          };
        }),
      );
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
