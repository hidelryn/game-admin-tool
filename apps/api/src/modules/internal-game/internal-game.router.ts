import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  liveOpsQuerySchema,
  ActivityType,
  ErrorCode,
  gameClaimRequestSchema,
  gameCurrencyRequestSchema,
  gameEventsRequestSchema,
  gameScoreRequestSchema,
  idParamSchema,
  publicIdSchema,
  sampleUsersQuerySchema,
  UserStatus,
  type GameEventsResult,
  type LiveOpsView,
} from '@game-admin/shared';
import { BusinessRuleError, UnauthorizedError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import { rankingSeasons, userActivityLogs, users } from '../../infra/db/schema/index.js';
import type { CurrencyService } from '../currencies/currency.service.js';
import type { MailService } from '../mails/mail.service.js';
import type { RankingService } from '../rankings/ranking.service.js';
import type { ScheduleService } from '../schedules/schedule.service.js';
import type { MaintenanceService } from '../live-notices/maintenance.service.js';
import type { NoticeService } from '../live-notices/notice.service.js';

/**
 * 게임 서버 역할을 대신하는 내부 API (api-specification.md 2.12)
 *
 * ⚠️ 운영자 인증이 아니라 내부 키로만 보호되고, 재화를 만들 수 있는 경로다.
 * - INTERNAL_API_KEY 가 없거나 NODE_ENV=production 이면 라우터 자체를 등록하지 않는다 (404)
 * - 키는 X-Internal-Key 헤더, 상수 시간 비교
 */
export function internalGameRouter(deps: {
  db: Executor;
  apiKey: string;
  currencyService: CurrencyService;
  mailService: MailService;
  rankingService: RankingService;
  scheduleService: ScheduleService;
  maintenanceService: MaintenanceService;
  noticeService: NoticeService;
}): Router {
  const {
    db,
    currencyService,
    mailService,
    rankingService,
    scheduleService,
    maintenanceService,
    noticeService,
  } = deps;
  const router = Router();
  const expected = Buffer.from(deps.apiKey);

  const requireKey: RequestHandler = (req, _res, next) => {
    const given = Buffer.from(req.header('x-internal-key') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedError(ErrorCode.AUTH_REQUIRED, '내부 API 키가 올바르지 않습니다.');
    }
    next();
  };
  router.use('/internal/game', requireKey);

  /** 활동 중인 회원 무작위 샘플 (id 구간에서 시작점을 랜덤으로) */
  router.get('/internal/game/users/sample', async (req, res) => {
    const { size } = sampleUsersQuerySchema.parse(req.query);
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
    res.json({ data: rows.map((r) => r.publicId) });
  });

  /** 활동 이벤트 기록. 정지·탈퇴 회원은 거부 (정지가 실제로 게임 접속을 막는 것처럼) */
  router.post('/internal/game/events', async (req, res) => {
    const { events } = gameEventsRequestSchema.parse(req.body);
    const ids = [...new Set(events.map((e) => e.publicId))];
    // 점검 중: 예외 회원만 통과, 전원 막히면 503
    const blocked = await maintenanceService.blockedOf(ids);
    const found = await db
      .select({ id: users.id, publicId: users.publicId, status: users.status })
      .from(users)
      .where(inArray(users.publicId, ids));
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
    res.json({ data: result });
  });

  router.post('/internal/game/scores', async (req, res) => {
    const input = gameScoreRequestSchema.parse(req.body);
    await maintenanceService.assertOpen(input.publicId);
    // 시즌 지정 → 보드 지정(그 보드의 진행 중 시즌) → 둘 다 없으면 진행 중 시즌이 하나일 때만
    let seasonId = input.seasonId ?? null;
    if (!seasonId && input.boardCode) {
      seasonId = await rankingService.activeSeasonOf(input.boardCode);
      if (!seasonId)
        throw new BusinessRuleError(
          ErrorCode.SEASON_NOT_ACTIVE,
          `${input.boardCode} 랭킹에 진행 중인 시즌이 없습니다.`,
        );
    }
    if (!seasonId) {
      const active = await db
        .select({ id: rankingSeasons.id })
        .from(rankingSeasons)
        .where(eq(rankingSeasons.status, 'ACTIVE'))
        .limit(2);
      if (!active.length)
        throw new BusinessRuleError(ErrorCode.SEASON_NOT_ACTIVE, '진행 중인 시즌이 없습니다.');
      if (active.length > 1)
        throw new BusinessRuleError(
          ErrorCode.SEASON_NOT_ACTIVE,
          '진행 중인 랭킹이 여러 개입니다. boardCode 를 지정하세요.',
        );
      seasonId = active[0]!.id;
    }
    res.json({ data: await rankingService.recordScore(seasonId, input.publicId, input.score) });
  });

  router.post('/internal/game/currencies', async (req, res) => {
    const input = gameCurrencyRequestSchema.parse(req.body);
    await maintenanceService.assertOpen(input.publicId);
    res.json({
      data: await currencyService.gameChange(
        input.publicId,
        input.currencyCode,
        input.delta,
        input.reason,
      ),
    });
  });

  router.get('/internal/game/users/:publicId/mails', async (req, res) => {
    res.json({ data: await mailService.mailbox(publicIdSchema.parse(req.params.publicId)) });
  });

  router.post('/internal/game/mails/:mailId/claim', async (req, res) => {
    const { publicId } = gameClaimRequestSchema.parse(req.body);
    await maintenanceService.assertOpen(publicId);
    res.json({ data: await mailService.claim(publicId, idParamSchema.parse(req.params.mailId)) });
  });

  /**
   * 지금 게임에 보여줄 것: 진행 중 시즌·이벤트·팝업·배너 (docs/schedule.md 7장) + 점검·세션 세대·티커
   * 점검 중에도 열림 (로그인 화면 안내용). ?at= 는 스케줄·티커 미리보기에만 적용, 점검 상태는 항상 지금
   */
  router.get('/internal/game/live-ops', async (req, res) => {
    const { at } = liveOpsQuerySchema.parse(req.query);
    const when = at ?? new Date();
    const [base, m, tickers] = await Promise.all([
      scheduleService.liveOps(when),
      maintenanceService.state(),
      noticeService.tickers(when),
    ]);
    const { allow: _allow, ...maintenance } = m;
    const view: LiveOpsView = { ...base, maintenance, sessionEpoch: m.sessionEpoch, tickers };
    res.json({ data: view });
  });

  /** 게시 중 공지 (고정 → 최신). 점검 중에도 열림 */
  router.get('/internal/game/notices', async (_req, res) => {
    res.json({ data: await noticeService.published() });
  });

  return router;
}
