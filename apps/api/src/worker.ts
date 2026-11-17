import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from './config/env.js';
import { createLogger } from './common/logger.js';
import { createDb } from './infra/db/client.js';
import { createRedis } from './infra/redis/client.js';
import { buildServices } from './bootstrap.js';
import { releaseExpiredSuspensions } from './modules/users/user.service.js';
import { aggregateDay, backfill } from './jobs/kpi.js';
import { statDateOf } from './common/time.js';
import { createPasswordHasher } from './modules/auth/password.js';
import { createLocalAssetStorage } from './infra/storage/asset-storage.js';
import { ensureDemoAccount, resetDemoData } from './modules/demo/demo.service.js';

/**
 * 백그라운드 작업 프로세스 (architecture.md 1.2)
 * API 와 같은 코드·이미지를 쓰고 진입점만 다르다 → 같은 서비스 계층으로 DB 를 다룬다.
 *
 * 스케줄은 BullMQ Job Scheduler 로 Redis 에 저장 → Worker 를 여러 개 띄워도 한 번씩만 실행된다.
 */
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
const db = createDb(env);
const redis = createRedis(env, logger);
await redis
  .connect()
  .catch((err: Error) => logger.warn({ err: err.message }, 'redis initial connect failed'));

const services = buildServices({ env, logger, db, redis });
const hasher = createPasswordHasher({
  memoryCost: env.ARGON2_MEMORY_KIB,
  timeCost: env.ARGON2_TIME_COST,
});

// 체험 모드: 기동할 때 체험 계정을 env 값에 맞춘다 (비밀번호를 바꾸면 재시작으로 반영)
if (env.DEMO_MODE) {
  const r = await ensureDemoAccount({ db: db.db, env, hasher }).catch((err: Error) => {
    logger.error({ err: err.message }, 'demo account setup failed');
    return 'failed';
  });
  logger.warn({ result: r, email: env.DEMO_ACCOUNT_EMAIL }, 'demo mode enabled');
}

// BullMQ 는 keyPrefix 대신 prefix 옵션을 쓰고, 블로킹 명령을 위해 maxRetriesPerRequest=null 이 필요하다
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prefix = `${env.REDIS_KEY_PREFIX}bull`;
const QUEUE = 'maintenance';

const jobs: Record<string, (job: Job) => Promise<unknown>> = {
  /** 정지 기간 만료 자동 해제 (1분) */
  async 'release-expired-suspensions'() {
    let total = 0;
    for (
      let n = await releaseExpiredSuspensions(db.db);
      n > 0;
      n = await releaseExpiredSuspensions(db.db)
    )
      total += n;
    return { released: total };
  },
  /** 일별 KPI: 어제 재집계 + 빠진 날짜 채우기 (매일 00:10 KST, 기동 시 1회) */
  async 'aggregate-daily-kpi'() {
    const days = await backfill(db.db, env.STAT_TZ_OFFSET_MINUTES, 60);
    return { aggregated: days };
  },
  /** 랭킹 시즌 자동 시작·종료 + 종료 시 최종 스냅샷 (1분) — docs/schedule.md 4장 */
  async 'season-lifecycle'() {
    return services.rankingService.runSeasonLifecycle();
  },
  /** 예약 점검 시작(세션 세대 증가) + 점검 상태 캐시 새로 (1분) — docs/maintenance-notice.md 4장 */
  async 'maintenance-lifecycle'() {
    return services.maintenanceService.runLifecycle();
  },
  /** ⚠️ 체험 서버 매일 초기화 (04:00 KST) — DEMO_MODE·DEMO_DAILY_RESET 둘 다 켰을 때만 등록 */
  async 'demo-reset'() {
    return resetDemoData({
      db,
      redis,
      env,
      logger,
      storage: createLocalAssetStorage(env.ASSET_STORAGE_DIR),
      hasher,
    });
  },
  /** 진행 중 시즌 랭킹 재구성 (10분) — Redis 동기화 실패 등으로 어긋난 부분 자가 복구 */
  async 'ranking-reconcile'() {
    return { seasons: await services.rankingService.reconcileActive() };
  },
  /** 오늘 KPI 를 미리 저장해 두기 (10분) — 대시보드는 오늘을 실시간 계산하지만, 장애 시 참고용 */
  async 'aggregate-today'() {
    const today = statDateOf(new Date(), env.STAT_TZ_OFFSET_MINUTES);
    await aggregateDay(db.db, today, env.STAT_TZ_OFFSET_MINUTES);
    return { today };
  },
};

const queue = new Queue(QUEUE, { connection, prefix });
const tz = 'Asia/Seoul';
await queue.upsertJobScheduler(
  'release-expired-suspensions',
  { every: 60_000 },
  { name: 'release-expired-suspensions' },
);
if (env.DEMO_MODE && env.DEMO_DAILY_RESET) {
  await queue.upsertJobScheduler(
    'demo-reset',
    { pattern: '0 4 * * *', tz },
    { name: 'demo-reset' },
  );
} else {
  await queue.removeJobScheduler('demo-reset');
}
// 승인 기능 제거(2026-11-16): 예전에 등록된 스케줄이 Redis 에 남아 있으면 지운다
await queue.removeJobScheduler('approvals-maintenance');
await queue.upsertJobScheduler(
  'aggregate-daily-kpi',
  { pattern: '10 0 * * *', tz },
  { name: 'aggregate-daily-kpi' },
);
await queue.upsertJobScheduler(
  'aggregate-today',
  { every: 10 * 60_000 },
  { name: 'aggregate-today' },
);
await queue.upsertJobScheduler(
  'ranking-reconcile',
  { every: 10 * 60_000 },
  { name: 'ranking-reconcile' },
);
await queue.upsertJobScheduler('season-lifecycle', { every: 60_000 }, { name: 'season-lifecycle' });
await queue.upsertJobScheduler(
  'maintenance-lifecycle',
  { every: 60_000 },
  { name: 'maintenance-lifecycle' },
);
// 기동 직후 한 번 채워 둔다 (같은 jobId 는 중복 등록되지 않음)
await queue.add(
  'aggregate-daily-kpi',
  {},
  { jobId: `boot-backfill-${statDateOf(new Date(), env.STAT_TZ_OFFSET_MINUTES)}` },
);

const worker = new Worker(
  QUEUE,
  async (job) => {
    const run = jobs[job.name];
    if (!run) throw new Error(`unknown job: ${job.name}`);
    const started = Date.now();
    const result = await run(job);
    logger.info({ job: job.name, ms: Date.now() - started, result }, 'job done');
    return result;
  },
  { connection, prefix, concurrency: 1 },
);
worker.on('failed', (job, err) => logger.error({ job: job?.name, err: err.message }, 'job failed'));
logger.info({ jobs: Object.keys(jobs) }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await worker.close();
  await queue.close();
  await connection.quit().catch(() => connection.disconnect());
  await Promise.allSettled([db.close(), redis.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
