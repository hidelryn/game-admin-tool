import { createHash } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  AuditAction,
  AuditTargetType,
  Channel,
  DangerAction,
  DEMO_EMAIL_BODY_MAX,
  DEMO_EMAIL_SUBJECT_PREFIX,
  EMAIL_AD_PREFIX,
  EMAIL_BULK_CONFIRM_THRESHOLD,
  EMAIL_NIGHT_END_HOUR,
  EMAIL_NIGHT_START_HOUR,
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailTargetType,
  ErrorCode,
  Permission,
  UserStatus,
  type CancelEmailRequest,
  type DangerPreview,
  type EmailCampaignDetail,
  type EmailCampaignSummary,
  type EmailCounts,
  type EmailDeliveryItem,
  type EmailLimits,
  type EmailPreview,
  type EmailPreviewRequest,
  type EmailRenderRequest,
  type EmailRendered,
  type EmailSendResult,
  type ListEmailCampaignsQuery,
  type ListEmailDeliveriesQuery,
  type SendEmailRequest,
} from '@game-admin/shared';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../common/logger.js';
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/app-error.js';
import { iso, isoOrNull } from '../../common/http/serialize.js';
import { maskEmail } from '../../common/http/mask.js';
import { statDateOf } from '../../common/time.js';
import { affectedRows, type Executor } from '../../infra/db/types.js';
import type { RedisHandle } from '../../infra/redis/client.js';
import type { Mailer } from '../../infra/mail/mailer.js';
import { admins, emailCampaigns, emailDeliveries, users } from '../../infra/db/schema/index.js';
import { writeAudit, type AuditContext } from '../audit/audit.writer.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { Confirmation } from '../safety/confirmation.js';
import { renderEmail } from './email-template.js';

type Campaign = typeof emailCampaigns.$inferSelect;
type DeliveryRow = typeof emailDeliveries.$inferInsert;

const BATCH = 500;
/** SENDING 인 채로 이만큼 지나면 처리하던 프로세스가 죽은 것으로 보고 다시 가져간다 */
const STALE_MS = 10 * 60_000;
/** 링크·도메인 주소 — 체험 계정 직접 발송에서 금지 (스팸·피싱 통로 방지) */
const LINK_RE =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|kr|co|xyz|me|ly|app|dev|link|site|top)\b)/i;

const SKIPPED: readonly string[] = [
  EmailDeliveryStatus.SKIPPED_NO_CONSENT,
  EmailDeliveryStatus.SKIPPED_NIGHT,
  EmailDeliveryStatus.SKIPPED_INACTIVE,
];

const FOOTER = '이 메일은 Game Admin(게임 운영 백오피스 포트폴리오)에서 발송되었습니다.';
const AD_FOOTER =
  '광고성 메일 수신을 원하지 않으시면 게임 내 설정 > 알림에서 수신 동의를 해제할 수 있습니다.';
const DEMO_FOOTER =
  '포트폴리오 체험 기능으로 방문자가 입력한 주소로 보낸 메일입니다. 요청하지 않았다면 무시하셔도 됩니다.';

/**
 * 이메일 발송 (docs/email.md)
 *
 * 실제 발송(SMTP)은 다음 두 경우만 — 나머지는 "가상 발송"으로 기록만 남긴다 (회원 주소가 가상이라 보내면 반송됨)
 *  1) 주소 직접 입력 1건 (ADDRESS)
 *  2) 회원 대상이지만 주소가 EMAIL_REAL_ALLOWLIST 에 있고, 만든 운영자가 체험 계정이 아님
 * 하루 실제 발송 수는 EMAIL_DAILY_REAL_LIMIT 로 막는다 (무료 SMTP 한도 보호, Redis 장애면 보내지 않음)
 */
const floorToSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

export function createEmailService(deps: {
  db: Executor;
  redis: RedisHandle;
  logger: Logger;
  env: Env;
  confirmation: Confirmation;
  mailer: Mailer;
  isDemo: (email: string) => boolean;
  /** 즉시 발송을 요청 직후 백그라운드로 처리 (기본 true, 테스트는 끄고 dispatchDue 를 직접 부른다) */
  autoDispatch?: boolean;
}) {
  const { db, redis, logger, env, confirmation, mailer, isDemo } = deps;
  const autoDispatch = deps.autoDispatch ?? true;
  const allowlist = new Set(env.EMAIL_REAL_ALLOWLIST.map((a) => a.toLowerCase()));
  const inflight = new Set<Promise<unknown>>();
  const tz = env.STAT_TZ_OFFSET_MINUTES;

  const today = () => statDateOf(new Date(), tz);
  const isNight = (at: Date) => {
    const h = new Date(at.getTime() + tz * 60_000).getUTCHours();
    return h >= EMAIL_NIGHT_START_HOUR || h < EMAIL_NIGHT_END_HOUR;
  };

  // ───────── 실제 발송 한도 (Redis) ─────────

  async function counter(key: string): Promise<number> {
    const v = await redis.redis.get(key);
    return Number(v ?? 0);
  }
  /** 하루 실제 발송 1건 차감. 한도 초과·Redis 장애면 false (보내지 않음) */
  async function takeRealQuota(): Promise<boolean> {
    try {
      const key = `email:real:${today()}`;
      const n = await redis.redis.incr(key);
      await redis.redis.expire(key, 2 * 86_400);
      return n <= env.EMAIL_DAILY_REAL_LIMIT;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'email quota check failed — not sending');
      return false;
    }
  }

  // ───────── 체험 계정 직접 발송 검사 ─────────

  async function checkDemoAddressSend(input: SendEmailRequest, address: string) {
    if (input.cta) {
      throw new BusinessRuleError(
        ErrorCode.EMAIL_CONTENT_NOT_ALLOWED,
        '체험 계정 메일에는 버튼(링크)을 넣을 수 없습니다.',
      );
    }
    if (input.body.length > DEMO_EMAIL_BODY_MAX) {
      throw new BusinessRuleError(
        ErrorCode.EMAIL_CONTENT_NOT_ALLOWED,
        `체험 계정은 본문 ${DEMO_EMAIL_BODY_MAX}자까지 보낼 수 있습니다.`,
      );
    }
    if (LINK_RE.test(input.subject) || LINK_RE.test(input.body)) {
      throw new BusinessRuleError(
        ErrorCode.EMAIL_CONTENT_NOT_ALLOWED,
        '체험 계정 메일에는 링크·웹 주소를 넣을 수 없습니다.',
      );
    }
    const day = today();
    try {
      if ((await counter(`email:demo:day:${day}`)) >= env.DEMO_EMAIL_DAILY_LIMIT) {
        throw new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          '오늘 체험 계정 메일 발송 한도를 모두 썼습니다. 내일 다시 시도하세요.',
        );
      }
      const addrKey = `email:demo:addr:${createHash('sha256').update(address).digest('hex').slice(0, 32)}:${day}`;
      const first = await redis.redis.set(addrKey, '1', 'EX', 26 * 3600, 'NX');
      if (!first) {
        throw new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          '같은 주소로는 하루에 한 번만 보낼 수 있습니다.',
        );
      }
      await redis.redis.incr(`email:demo:day:${day}`);
      await redis.redis.expire(`email:demo:day:${day}`, 2 * 86_400);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        503,
        ErrorCode.RATE_LIMITED,
        '지금은 메일을 보낼 수 없습니다. 잠시 후 다시 시도하세요.',
      );
    }
  }

  // ───────── 메일 내용 ─────────

  /** 최종 제목·디자인 틀 적용 (email-template.ts) */
  function compose(
    c: Pick<Campaign, 'isAd' | 'demo' | 'targetType' | 'subject' | 'body' | 'ctaLabel' | 'ctaUrl'>,
  ) {
    const demoAddress = c.demo && c.targetType === EmailTargetType.ADDRESS;
    const subject =
      (c.isAd ? EMAIL_AD_PREFIX : '') + (demoAddress ? DEMO_EMAIL_SUBJECT_PREFIX : '') + c.subject;
    const footers = [FOOTER];
    if (c.isAd) footers.push(AD_FOOTER);
    if (demoAddress) footers.push(DEMO_FOOTER);
    const { html, text } = renderEmail({
      subject,
      body: c.body,
      cta: c.ctaLabel && c.ctaUrl ? { label: c.ctaLabel, url: c.ctaUrl } : null,
      footers,
      isAd: c.isAd,
    });
    return { subject, text, html };
  }

  async function sendReal(
    c: Campaign,
    to: string,
  ): Promise<Pick<DeliveryRow, 'status' | 'error' | 'messageId'>> {
    if (!(await takeRealQuota())) {
      return {
        status: EmailDeliveryStatus.FAILED,
        error: '하루 실제 발송 한도 초과',
        messageId: null,
      };
    }
    try {
      const { messageId } = await mailer.send({ to, ...compose(c) });
      return { status: EmailDeliveryStatus.SENT, error: null, messageId };
    } catch (err) {
      logger.warn({ err: (err as Error).message, campaignId: c.id }, 'email send failed');
      return {
        status: EmailDeliveryStatus.FAILED,
        error: (err as Error).message.slice(0, 300),
        messageId: null,
      };
    }
  }

  // ───────── 대상 ─────────

  type Candidate = {
    id: number;
    publicId: string;
    email: string;
    status: string;
    adEmailOptIn: boolean;
    nightOptIn: boolean;
  };

  /** 회원 1명을 어떻게 처리할지 (실제 발송 여부는 여기서 "real" 로만 표시) */
  function decide(c: Pick<Campaign, 'isAd' | 'demo'>, u: Candidate, night: boolean) {
    if (u.status !== UserStatus.ACTIVE) return EmailDeliveryStatus.SKIPPED_INACTIVE;
    if (c.isAd && !u.adEmailOptIn) return EmailDeliveryStatus.SKIPPED_NO_CONSENT;
    if (c.isAd && night && !u.nightOptIn) return EmailDeliveryStatus.SKIPPED_NIGHT;
    const real = mailer.real && !c.demo && allowlist.has(u.email.toLowerCase());
    return real ? 'REAL' : EmailDeliveryStatus.VIRTUAL;
  }

  const userCols = {
    id: users.id,
    publicId: users.publicId,
    email: users.email,
    status: users.status,
    adEmailOptIn: users.adEmailOptIn,
    nightOptIn: users.nightOptIn,
  };

  function targetWhere(c: Pick<Campaign, 'targetType' | 'targetPublicIds'>): SQL | undefined {
    if (c.targetType === EmailTargetType.USERS)
      return inArray(users.publicId, c.targetPublicIds ?? []);
    // 전체: 활동 중인 회원만 (탈퇴·정지 회원은 행을 만들지 않는다)
    return eq(users.status, UserStatus.ACTIVE);
  }

  // ───────── 처리 ─────────

  async function finalize(c: Campaign) {
    const rows = await db
      .select({ status: emailDeliveries.status, n: count() })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.campaignId, c.id))
      .groupBy(emailDeliveries.status);
    const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const counts = {
      totalCount: rows.reduce((s, r) => s + r.n, 0),
      sentCount: n(EmailDeliveryStatus.SENT),
      virtualCount: n(EmailDeliveryStatus.VIRTUAL),
      skippedCount: rows.filter((r) => SKIPPED.includes(r.status)).reduce((s, r) => s + r.n, 0),
      failedCount: n(EmailDeliveryStatus.FAILED),
    };
    await db
      .update(emailCampaigns)
      .set({ ...counts, status: EmailCampaignStatus.DONE, finishedAt: new Date() })
      .where(eq(emailCampaigns.id, c.id));
  }

  async function processCampaign(c: Campaign) {
    const night = isNight(new Date());

    if (c.targetType === EmailTargetType.ADDRESS) {
      const [done] = await db
        .select({ id: emailDeliveries.id })
        .from(emailDeliveries)
        .where(eq(emailDeliveries.campaignId, c.id))
        .limit(1);
      if (!done) {
        const to = c.targetAddress!;
        const result = mailer.real
          ? await sendReal(c, to)
          : {
              status: EmailDeliveryStatus.VIRTUAL,
              error: 'SMTP 미설정 — 가상 발송',
              messageId: null,
            };
        await db.insert(emailDeliveries).values({
          campaignId: c.id,
          userId: null,
          address: to,
          processedAt: new Date(),
          ...result,
        });
      }
      return finalize(c);
    }

    // 회원 대상: 아직 처리하지 않은 회원만 id 순으로 (중간에 죽었다가 다시 가져가도 이어서 처리)
    let lastId = 0;
    for (;;) {
      const batch: Candidate[] = await db
        .select(userCols)
        .from(users)
        .leftJoin(
          emailDeliveries,
          and(eq(emailDeliveries.campaignId, c.id), eq(emailDeliveries.userId, users.id)),
        )
        .where(and(targetWhere(c), gt(users.id, lastId), isNull(emailDeliveries.id)))
        .orderBy(users.id)
        .limit(BATCH);
      if (!batch.length) break;
      const rows: DeliveryRow[] = [];
      for (const u of batch) {
        const d = decide(c, u, night);
        const base = { campaignId: c.id, userId: u.id, address: u.email, processedAt: new Date() };
        if (d === 'REAL') rows.push({ ...base, ...(await sendReal(c, u.email)) });
        else rows.push({ ...base, status: d, error: null, messageId: null });
      }
      // 동시에 다른 처리기가 같은 회원을 넣었으면 건너뜀 (uk_email_deliveries_user)
      await db
        .insert(emailDeliveries)
        .values(rows)
        .onDuplicateKeyUpdate({ set: { campaignId: sql`${emailDeliveries.campaignId}` } });
      lastId = batch[batch.length - 1]!.id;
    }
    return finalize(c);
  }

  /** 예약 시각이 된(또는 처리하다 멈춘) 캠페인을 조건부 UPDATE 로 가져간다 — 여러 프로세스가 돌아도 한 곳만 */
  async function claim(id: number): Promise<Campaign | null> {
    const now = new Date();
    const res = await db
      .update(emailCampaigns)
      .set({ status: EmailCampaignStatus.SENDING, startedAt: now })
      .where(
        and(
          eq(emailCampaigns.id, id),
          or(
            and(
              eq(emailCampaigns.status, EmailCampaignStatus.SCHEDULED),
              lte(emailCampaigns.scheduledAt, now),
            ),
            and(
              eq(emailCampaigns.status, EmailCampaignStatus.SENDING),
              lt(emailCampaigns.startedAt, new Date(now.getTime() - STALE_MS)),
            ),
          ),
        ),
      );
    if (!affectedRows(res)) return null;
    const [c] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id)).limit(1);
    return c ?? null;
  }

  async function dispatchOne(id: number) {
    const c = await claim(id);
    if (!c) return false;
    await processCampaign(c);
    return true;
  }

  function background(id: number) {
    if (!autoDispatch) return;
    const p = dispatchOne(id)
      .catch((err: Error) =>
        logger.error({ err: err.message, campaignId: id }, 'email dispatch failed'),
      )
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  // ───────── 조회용 변환 ─────────

  const countsOf = (c: Campaign): EmailCounts => ({
    total: c.totalCount,
    sent: c.sentCount,
    virtual: c.virtualCount,
    skipped: c.skippedCount,
    failed: c.failedCount,
  });

  function summary(
    c: Campaign,
    creator: { id: number; name: string } | null,
  ): EmailCampaignSummary {
    return {
      id: c.id,
      targetType: c.targetType as EmailCampaignSummary['targetType'],
      targetLabel:
        c.targetType === EmailTargetType.ADDRESS
          ? maskEmail(c.targetAddress ?? '')
          : c.targetType === EmailTargetType.ALL
            ? '전체 회원'
            : `회원 ${(c.targetPublicIds ?? []).length.toLocaleString()}명`,
      subject: c.subject,
      isAd: c.isAd,
      status: c.status as EmailCampaignSummary['status'],
      scheduledAt: iso(c.scheduledAt),
      startedAt: isoOrNull(c.startedAt),
      finishedAt: isoOrNull(c.finishedAt),
      createdBy: creator,
      channel: c.channel,
      reason: c.reason,
      counts: countsOf(c),
      createdAt: iso(c.createdAt),
    };
  }

  async function load(id: number) {
    const [row] = await db
      .select({ c: emailCampaigns, adminName: admins.name })
      .from(emailCampaigns)
      .leftJoin(admins, eq(admins.id, emailCampaigns.createdBy))
      .where(eq(emailCampaigns.id, id))
      .limit(1);
    if (!row)
      throw new NotFoundError(ErrorCode.EMAIL_CAMPAIGN_NOT_FOUND, '이메일 발송 기록이 없습니다.');
    return row;
  }

  // ───────── 미리보기 ─────────

  async function preview(
    input: EmailPreviewRequest,
  ): Promise<EmailPreview & { missing: string[] }> {
    const at = input.scheduledAt ?? new Date();
    const night = isNight(at);
    const notes: string[] = [];
    if (!mailer.real) notes.push('SMTP 가 설정되지 않아 모든 메일이 가상 발송됩니다.');

    if (input.target.type === EmailTargetType.ADDRESS) {
      return {
        total: 1,
        real: mailer.real ? 1 : 0,
        virtual: mailer.real ? 0 : 1,
        skippedNoConsent: 0,
        skippedNight: 0,
        skippedInactive: 0,
        night,
        bulk: false,
        notes,
        missing: [],
      };
    }
    const c = {
      targetType: input.target.type,
      targetPublicIds: input.target.type === EmailTargetType.USERS ? input.target.publicIds : null,
    };
    const ad = input.isAd;
    const allow = [...allowlist];
    const [agg] = await db
      .select({
        total: count(),
        inactive:
          sql<number>`sum(case when ${users.status} <> ${UserStatus.ACTIVE} then 1 else 0 end)`.mapWith(
            Number,
          ),
        noConsent:
          sql<number>`sum(case when ${users.status} = ${UserStatus.ACTIVE} and ${ad} and not ${users.adEmailOptIn} then 1 else 0 end)`.mapWith(
            Number,
          ),
        night:
          sql<number>`sum(case when ${users.status} = ${UserStatus.ACTIVE} and ${ad && night} and ${users.adEmailOptIn} and not ${users.nightOptIn} then 1 else 0 end)`.mapWith(
            Number,
          ),
        allowed: allow.length
          ? sql<number>`sum(case when ${users.status} = ${UserStatus.ACTIVE} and (not ${ad} or (${users.adEmailOptIn} and (not ${ad && night} or ${users.nightOptIn}))) and lower(${users.email}) in (${sql.join(
              allow.map((a) => sql`${a}`),
              sql`, `,
            )}) then 1 else 0 end)`.mapWith(Number)
          : sql<number>`0`.mapWith(Number),
      })
      .from(users)
      .where(targetWhere(c));
    let missing: string[] = [];
    if (input.target.type === EmailTargetType.USERS) {
      const found = await db
        .select({ publicId: users.publicId })
        .from(users)
        .where(inArray(users.publicId, input.target.publicIds));
      const have = new Set(found.map((f) => f.publicId));
      missing = input.target.publicIds.filter((p) => !have.has(p));
    }
    const total = agg?.total ?? 0;
    const skippedInactive = agg?.inactive ?? 0;
    const skippedNoConsent = agg?.noConsent ?? 0;
    const skippedNight = agg?.night ?? 0;
    const real = mailer.real ? (agg?.allowed ?? 0) : 0;
    if (ad && night)
      notes.push('야간(21~08시)이라 야간 수신 동의 회원에게만 광고성 메일이 갑니다.');
    notes.push(
      '회원 주소는 가상(@example.com)이라 허용 목록 외 주소는 가상 발송으로 기록만 남깁니다.',
    );
    return {
      total,
      real,
      virtual: total - skippedInactive - skippedNoConsent - skippedNight - real,
      skippedNoConsent,
      skippedNight,
      skippedInactive,
      night,
      bulk:
        input.target.type === EmailTargetType.ALL ||
        input.target.publicIds.length >= EMAIL_BULK_CONFIRM_THRESHOLD,
      notes,
      missing,
    };
  }

  return {
    preview: async (actor: AuthContext, input: EmailPreviewRequest): Promise<EmailPreview> => {
      const { missing: _missing, ...p } = await preview(input);
      // 체험 계정의 회원 대상 발송은 모두 가상
      if (isDemo(actor.email) && input.target.type !== EmailTargetType.ADDRESS && p.real) {
        p.virtual += p.real;
        p.real = 0;
        p.notes.push('체험 계정의 회원 대상 발송은 모두 가상 발송입니다.');
      }
      return p;
    },

    /** 작성 화면 미리보기 — 실제 보낼 제목·HTML 그대로 */
    render(actor: AuthContext, input: EmailRenderRequest): EmailRendered {
      const { subject, html } = compose({
        isAd: input.targetType !== EmailTargetType.ADDRESS && input.isAd,
        demo: isDemo(actor.email),
        targetType: input.targetType,
        subject: input.subject,
        body: input.body,
        ctaLabel: input.cta?.label ?? null,
        ctaUrl: input.cta?.url ?? null,
      });
      return { subject, html };
    },

    limits(actor: AuthContext): EmailLimits {
      return {
        smtpConfigured: mailer.real,
        demo: isDemo(actor.email)
          ? {
              perIpPerHour: env.DEMO_EMAIL_PER_IP_HOUR,
              perAddressPerDay: 1,
              perDay: env.DEMO_EMAIL_DAILY_LIMIT,
              bodyMax: DEMO_EMAIL_BODY_MAX,
            }
          : null,
      };
    },

    /**
     * 발송 요청
     * - 주소 직접 입력: 웹 전용(AI 가 임의 주소로 내보내는 데이터 유출 통로 차단), 바로 보내고 결과 반환
     * - 회원 99명까지: L1 / 전체·100명 이상: L3(웹 전용 빨간 경고 확인)
     */
    async send(
      actor: AuthContext,
      input: SendEmailRequest,
      audit: AuditContext,
      record?: (tx: Executor, result: { campaignId: number }) => Promise<void>,
    ): Promise<EmailSendResult> {
      const demo = isDemo(actor.email);
      const now = new Date();
      const t = input.target;

      if (t.type === EmailTargetType.ADDRESS && actor.channel !== Channel.WEB) {
        throw new ForbiddenError(
          ErrorCode.CHANNEL_NOT_ALLOWED,
          '주소를 직접 입력하는 발송은 웹에서만 할 수 있습니다 (AI 로 외부 주소에 보내는 것을 막기 위해).',
        );
      }
      if (t.type === EmailTargetType.ALL && !actor.permissions.has(Permission.EMAIL_SEND_ALL)) {
        throw new ForbiddenError(
          ErrorCode.PERMISSION_DENIED,
          '전체 발송에는 email:send_all 권한이 필요합니다.',
        );
      }
      if (input.scheduledAt) {
        if (input.scheduledAt.getTime() < now.getTime() - 60_000)
          throw new BusinessRuleError(ErrorCode.VALIDATION_FAILED, '예약 시각이 이미 지났습니다.');
        if (input.scheduledAt.getTime() > now.getTime() + 30 * 86_400_000)
          throw new BusinessRuleError(
            ErrorCode.VALIDATION_FAILED,
            '예약은 30일 이내만 가능합니다.',
          );
      }
      if (t.type === EmailTargetType.ADDRESS && demo) await checkDemoAddressSend(input, t.address);

      const p = await preview({ target: t, isAd: input.isAd, scheduledAt: input.scheduledAt });
      if (p.missing.length) {
        throw new NotFoundError(
          ErrorCode.USER_NOT_FOUND,
          `없는 회원 ID 가 있습니다: ${p.missing.slice(0, 10).join(', ')}${p.missing.length > 10 ? ' …' : ''}`,
        );
      }
      if (t.type !== EmailTargetType.ADDRESS && p.bulk) {
        const { confirmationToken, ...payload } = input;
        await confirmation.require<DangerPreview>({
          adminId: actor.adminId,
          action: DangerAction.EMAIL_SEND_BULK,
          payload,
          token: confirmationToken,
          webOnly: { channel: actor.channel },
          preview: () => ({
            action: DangerAction.EMAIL_SEND_BULK,
            title: `${input.isAd ? '광고성 ' : ''}이메일 "${input.subject}"`,
            facts: [
              {
                label: '대상',
                value:
                  t.type === EmailTargetType.ALL
                    ? '전체 회원 (활동 중)'
                    : `회원 ${t.publicIds.length.toLocaleString()}명`,
              },
              {
                label: '발송 대상 (현재)',
                value: `${(p.total - p.skippedInactive - p.skippedNoConsent - p.skippedNight).toLocaleString()}명`,
              },
              {
                label: '실제 발송 / 가상',
                value: `${(demo ? 0 : p.real).toLocaleString()}통 / ${(demo ? p.real + p.virtual : p.virtual).toLocaleString()}통`,
              },
              {
                label: '수신 동의·야간 제외',
                value: `${(p.skippedNoConsent + p.skippedNight).toLocaleString()}명`,
              },
              {
                label: '발송 시각',
                value: input.scheduledAt
                  ? input.scheduledAt.toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)'
                  : '바로',
              },
            ],
            warnings: [
              '보낸 메일은 되돌릴 수 없습니다. 예약 발송은 보내기 전까지 취소할 수 있습니다.',
              ...(input.isAd
                ? ['광고성 메일은 제목에 (광고)가 붙고, 수신 동의하지 않은 회원은 자동 제외됩니다.']
                : []),
            ],
          }),
        });
      }

      // DATETIME(초) 칸은 밀리초를 반올림한다 → 바로 보내기가 "1초 뒤 예약"이 되어 처리기가 건너뛰지 않도록 초 단위로 내림
      const scheduledAt = floorToSecond(input.scheduledAt ?? now);
      const immediateAddress = t.type === EmailTargetType.ADDRESS;
      const campaignId = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(emailCampaigns)
          .values({
            targetType: t.type,
            targetPublicIds: t.type === EmailTargetType.USERS ? t.publicIds : null,
            targetAddress: t.type === EmailTargetType.ADDRESS ? t.address : null,
            subject: input.subject,
            body: input.body,
            isAd: input.isAd,
            ctaLabel: input.cta?.label ?? null,
            ctaUrl: input.cta?.url ?? null,
            // 주소 직접 입력은 이 요청에서 바로 처리하므로 처음부터 SENDING
            status: immediateAddress ? EmailCampaignStatus.SENDING : EmailCampaignStatus.SCHEDULED,
            scheduledAt,
            startedAt: immediateAddress ? now : null,
            demo,
            reason: input.reason,
            createdBy: actor.adminId,
            channel: actor.channel,
          })
          .$returningId();
        const id = created!.id;
        await writeAudit(tx, audit, {
          action: p.bulk && !immediateAddress ? AuditAction.EMAIL_SEND_ALL : AuditAction.EMAIL_SEND,
          targetType: AuditTargetType.EMAIL_CAMPAIGN,
          targetId: id,
          reason: input.reason,
          after: {
            target:
              t.type === EmailTargetType.ADDRESS
                ? { type: t.type, address: maskEmail(t.address) }
                : t.type === EmailTargetType.USERS
                  ? { type: t.type, count: t.publicIds.length }
                  : { type: t.type },
            subject: input.subject,
            isAd: input.isAd,
            cta: input.cta ?? null,
            scheduledAt: input.scheduledAt?.toISOString() ?? null,
            demo,
          },
        });
        if (record) await record(tx, { campaignId: id });
        return id;
      });

      if (immediateAddress) {
        const [c] = await db
          .select()
          .from(emailCampaigns)
          .where(eq(emailCampaigns.id, campaignId))
          .limit(1);
        await processCampaign(c!);
      } else if (!input.scheduledAt) {
        background(campaignId);
      }
      const [c] = await db
        .select()
        .from(emailCampaigns)
        .where(eq(emailCampaigns.id, campaignId))
        .limit(1);
      return { campaignId, status: c!.status as EmailSendResult['status'], counts: countsOf(c!) };
    },

    /** 예약 취소 (L1) — 아직 보내기 전(SCHEDULED)만 */
    async cancel(actor: AuthContext, id: number, input: CancelEmailRequest, audit: AuditContext) {
      const { c } = await load(id);
      if (c.status !== EmailCampaignStatus.SCHEDULED)
        throw new ConflictError(
          ErrorCode.EMAIL_NOT_CANCELABLE,
          '이미 보내기 시작했거나 끝난 발송은 취소할 수 없습니다.',
        );
      await db.transaction(async (tx) => {
        const res = await tx
          .update(emailCampaigns)
          .set({
            status: EmailCampaignStatus.CANCELED,
            canceledAt: new Date(),
            canceledBy: actor.adminId,
          })
          .where(
            and(
              eq(emailCampaigns.id, id),
              eq(emailCampaigns.status, EmailCampaignStatus.SCHEDULED),
            ),
          );
        if (!affectedRows(res))
          throw new ConflictError(
            ErrorCode.EMAIL_NOT_CANCELABLE,
            '방금 발송이 시작되어 취소할 수 없습니다.',
          );
        await writeAudit(tx, audit, {
          action: AuditAction.EMAIL_CANCEL,
          targetType: AuditTargetType.EMAIL_CAMPAIGN,
          targetId: id,
          reason: input.reason,
          before: { status: c.status, scheduledAt: c.scheduledAt.toISOString() },
        });
      });
      return { campaignId: id, status: EmailCampaignStatus.CANCELED };
    },

    async list(q: ListEmailCampaignsQuery) {
      const where = q.status ? eq(emailCampaigns.status, q.status) : undefined;
      const [rows, totals] = await Promise.all([
        db
          .select({ c: emailCampaigns, adminName: admins.name })
          .from(emailCampaigns)
          .leftJoin(admins, eq(admins.id, emailCampaigns.createdBy))
          .where(where)
          .orderBy(desc(emailCampaigns.id))
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(emailCampaigns).where(where),
      ]);
      return {
        items: rows.map((r) =>
          summary(
            r.c,
            r.c.createdBy && r.adminName ? { id: r.c.createdBy, name: r.adminName } : null,
          ),
        ),
        meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 },
      };
    },

    async detail(id: number): Promise<EmailCampaignDetail> {
      const { c, adminName } = await load(id);
      return {
        ...summary(c, c.createdBy && adminName ? { id: c.createdBy, name: adminName } : null),
        body: c.body,
        cta: c.ctaLabel && c.ctaUrl ? { label: c.ctaLabel, url: c.ctaUrl } : null,
        canceledAt: isoOrNull(c.canceledAt),
      };
    },

    async deliveries(id: number, q: ListEmailDeliveriesQuery) {
      await load(id);
      const where = and(
        eq(emailDeliveries.campaignId, id),
        q.status ? eq(emailDeliveries.status, q.status) : undefined,
      );
      const [rows, totals] = await Promise.all([
        db
          .select({ d: emailDeliveries, publicId: users.publicId, nickname: users.nickname })
          .from(emailDeliveries)
          .leftJoin(users, eq(users.id, emailDeliveries.userId))
          .where(where)
          .orderBy(emailDeliveries.id)
          .limit(q.size)
          .offset((q.page - 1) * q.size),
        db.select({ n: count() }).from(emailDeliveries).where(where),
      ]);
      const items: EmailDeliveryItem[] = rows.map((r) => ({
        id: r.d.id,
        publicId: r.publicId ?? null,
        nickname: r.nickname ?? null,
        address: maskEmail(r.d.address),
        status: r.d.status as EmailDeliveryItem['status'],
        error: r.d.error,
        processedAt: iso(r.d.processedAt),
      }));
      return { items, meta: { page: q.page, size: q.size, total: totals[0]?.n ?? 0 } };
    },

    /** Worker (1분): 예약 시각이 된 것 + 처리하다 멈춘 것 */
    async dispatchDue(limit = 5): Promise<{ processed: number }> {
      const now = new Date();
      const due = await db
        .select({ id: emailCampaigns.id })
        .from(emailCampaigns)
        .where(
          or(
            and(
              eq(emailCampaigns.status, EmailCampaignStatus.SCHEDULED),
              lte(emailCampaigns.scheduledAt, now),
            ),
            and(
              eq(emailCampaigns.status, EmailCampaignStatus.SENDING),
              lt(emailCampaigns.startedAt, new Date(now.getTime() - STALE_MS)),
            ),
          ),
        )
        .orderBy(emailCampaigns.scheduledAt)
        .limit(limit);
      let processed = 0;
      for (const { id } of due) if (await dispatchOne(id)) processed++;
      return { processed };
    },

    /** 백그라운드 즉시 발송이 끝날 때까지 (테스트·종료 시) */
    async idle() {
      await Promise.all([...inflight]);
    },
  };
}

export type EmailService = ReturnType<typeof createEmailService>;
