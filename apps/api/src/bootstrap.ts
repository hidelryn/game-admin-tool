import { Router } from 'express';
import { DEMO_TOKEN_ISSUE_PER_HOUR } from '@game-admin/shared';
import type { Env } from './config/env.js';
import type { Logger } from './common/logger.js';
import type { DbHandle } from './infra/db/client.js';
import type { RedisHandle } from './infra/redis/client.js';
import { createApp } from './app.js';
import { createPasswordHasher } from './modules/auth/password.js';
import { createTokenService } from './modules/auth/tokens.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAuthenticate } from './modules/auth/auth.middleware.js';
import { authRouter } from './modules/auth/auth.router.js';
import { createAdminService } from './modules/admins/admin.service.js';
import { adminsRouter } from './modules/admins/admins.router.js';
import { createApiTokenService } from './modules/api-tokens/api-token.service.js';
import { apiTokensRouter } from './modules/api-tokens/api-tokens.router.js';
import { createIdempotency } from './modules/safety/idempotency.js';
import { createConfirmation } from './modules/safety/confirmation.js';
import { createUserService } from './modules/users/user.service.js';
import { usersRouter } from './modules/users/users.router.js';
import { createCurrencyService } from './modules/currencies/currency.service.js';
import { currenciesRouter } from './modules/currencies/currencies.router.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { auditRouter } from './modules/audit/audit.router.js';
import { createMailService } from './modules/mails/mail.service.js';
import { mailsRouter } from './modules/mails/mails.router.js';
import { createRankingService } from './modules/rankings/ranking.service.js';
import { rankingsRouter } from './modules/rankings/rankings.router.js';
import { createSeqGenerator } from './modules/rankings/seq-generator.js';
import { createDashboardService } from './modules/dashboard/dashboard.service.js';
import { dashboardRouter } from './modules/dashboard/dashboard.router.js';
import { internalGameRouter } from './modules/internal-game/internal-game.router.js';
import { createRateLimit } from './common/middleware/rate-limit.js';
import { createLocalAssetStorage, type AssetStorage } from './infra/storage/asset-storage.js';
import { createAssetService } from './modules/assets/asset.service.js';
import { assetsRouter } from './modules/assets/assets.router.js';
import { createScheduleService } from './modules/schedules/schedule.service.js';
import { createNamedLock } from './infra/db/named-lock.js';
import { isDemoEmail } from './modules/demo/is-demo.js';
import { nextResetAt } from './modules/demo/demo-info.js';
import { demoRouter } from './modules/demo/demo.router.js';
import { schedulesRouter } from './modules/schedules/schedules.router.js';
import { createMaintenanceService } from './modules/live-notices/maintenance.service.js';
import { createNoticeService } from './modules/live-notices/notice.service.js';
import { liveNoticesRouter } from './modules/live-notices/live-notices.router.js';

export interface AppContext {
  env: Env;
  logger: Logger;
  db: DbHandle;
  redis: RedisHandle;
  /** 업로드 파일 저장소. 없으면 로컬 폴더(ASSET_STORAGE_DIR) — 테스트는 메모리 저장소를 넣는다 */
  assetStorage?: AssetStorage;
}

/**
 * 의존성 조립 (수동 DI). 서버·통합 테스트·Worker 가 같은 조립 코드를 사용한다.
 */
export function buildServices(ctx: AppContext) {
  const { env, logger } = ctx;
  const db = ctx.db.db;

  const hasher = createPasswordHasher({
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
  });
  const tokens = createTokenService({
    secret: env.JWT_ACCESS_SECRET,
    accessTtlSec: env.ACCESS_TOKEN_TTL_SEC,
  });
  const authenticate = createAuthenticate({ db, redis: ctx.redis, tokens, logger });

  // 공통 안전장치
  const idempotency = createIdempotency({ db, redis: ctx.redis, logger });
  const confirmation = createConfirmation({ redis: ctx.redis, logger });
  // 랭킹 보상이 우편을 쓰므로 먼저 만든다
  const mailService = createMailService({ db, confirmation });
  const assetService = createAssetService({
    db,
    storage: ctx.assetStorage ?? createLocalAssetStorage(ctx.env.ASSET_STORAGE_DIR),
  });

  const rankingService = createRankingService({
    db,
    redis: ctx.redis,
    logger,
    confirmation,
    seq: createSeqGenerator(env.RANKING_NODE_ID),
    mails: mailService,
  });
  const lock = createNamedLock(ctx.db.pool);
  const scheduleService = createScheduleService({
    db,
    confirmation,
    assets: assetService,
    runSeasonLifecycle: () => rankingService.runSeasonLifecycle(),
    lock,
  });
  const maintenanceService = createMaintenanceService({
    db,
    redis: ctx.redis,
    logger,
    confirmation,
    lock,
    tzOffsetMin: env.STAT_TZ_OFFSET_MINUTES,
  });
  const noticeService = createNoticeService({ db });

  return {
    authenticate,
    idempotency,
    authService: createAuthService({ db, redis: ctx.redis, env, logger, hasher, tokens }),
    adminService: createAdminService({ db, hasher }),
    apiTokenService: createApiTokenService({
      db,
      isDemo: (email) => isDemoEmail(env, email),
      demoExpiresBy: (now) => (env.DEMO_DAILY_RESET ? nextResetAt(now) : null),
    }),
    userService: createUserService({ db, confirmation }),
    currencyService: createCurrencyService({ db, confirmation }),
    mailService,
    assetService,
    rankingService,
    scheduleService,
    maintenanceService,
    noticeService,
    auditService: createAuditService({ db }),
    dashboardService: createDashboardService({
      db,
      redis: ctx.redis,
      logger,
      tzOffsetMin: env.STAT_TZ_OFFSET_MINUTES,
    }),
  };
}

export type Services = ReturnType<typeof buildServices>;

export function buildApp(ctx: AppContext, s: Services = buildServices(ctx)) {
  const { env, logger } = ctx;
  const { authenticate, idempotency } = s;

  const api = Router();
  const loginRateLimit = createRateLimit({
    redis: ctx.redis,
    logger,
    name: 'login',
    limit: env.LOGIN_RATE_LIMIT_PER_MIN,
    windowSec: 60,
  });
  api.use('/auth', authRouter({ authService: s.authService, authenticate, env, loginRateLimit }));
  api.use(
    adminsRouter({
      adminService: s.adminService,
      apiTokenService: s.apiTokenService,
      authenticate,
    }),
  );
  const demoTokenLimit = createRateLimit({
    redis: ctx.redis,
    logger,
    name: 'demo-token-issue',
    limit: DEMO_TOKEN_ISSUE_PER_HOUR,
    windowSec: 3600,
  });
  api.use(
    apiTokensRouter({
      apiTokenService: s.apiTokenService,
      authenticate,
      demoIssueLimit: (req, res, next) =>
        req.auth && isDemoEmail(env, req.auth.email) ? demoTokenLimit(req, res, next) : next(),
    }),
  );
  api.use(usersRouter({ userService: s.userService, authenticate }));
  api.use(currenciesRouter({ currencyService: s.currencyService, idempotency, authenticate }));
  api.use(mailsRouter({ mailService: s.mailService, idempotency, authenticate }));
  api.use(rankingsRouter({ rankingService: s.rankingService, idempotency, authenticate }));
  api.use(auditRouter({ auditService: s.auditService, authenticate }));
  api.use(dashboardRouter({ dashboardService: s.dashboardService, authenticate }));
  api.use(assetsRouter({ assetService: s.assetService, authenticate }));
  api.use(demoRouter({ env }));
  api.use(schedulesRouter({ scheduleService: s.scheduleService, idempotency, authenticate }));
  api.use(
    liveNoticesRouter({
      maintenanceService: s.maintenanceService,
      noticeService: s.noticeService,
      idempotency,
      authenticate,
    }),
  );

  // ⚠️ 내부 게임 API: 키가 있고 production 이 아닐 때만 등록
  if (env.INTERNAL_API_KEY && env.NODE_ENV !== 'production') {
    api.use(
      internalGameRouter({
        db: ctx.db.db,
        apiKey: env.INTERNAL_API_KEY,
        currencyService: s.currencyService,
        mailService: s.mailService,
        rankingService: s.rankingService,
        scheduleService: s.scheduleService,
        maintenanceService: s.maintenanceService,
        noticeService: s.noticeService,
      }),
    );
    logger.warn(
      'internal game API enabled (/api/v1/internal/game/*) — 운영 환경에서는 비활성화됩니다',
    );
  }

  return createApp({
    logger,
    corsOrigins: env.CORS_ORIGINS,
    health: { pingDb: ctx.db.ping, pingRedis: ctx.redis.ping },
    apiRouter: api,
  });
}
