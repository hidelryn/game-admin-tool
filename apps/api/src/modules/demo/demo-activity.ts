import { ActivityType, ErrorCode, type GameEventsRequest } from '@game-admin/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import type { CurrencyService } from '../currencies/currency.service.js';
import type { MailService } from '../mails/mail.service.js';
import type { RankingService } from '../rankings/ranking.service.js';
import type { ScheduleService } from '../schedules/schedule.service.js';
import type { MaintenanceService } from '../live-notices/maintenance.service.js';
import { recordGameEvents, sampleActiveUsers } from '../internal-game/game-actions.js';
import { planSession } from '../analytics/game-model.js';
import type { PurchaseService } from '../analytics/purchase.service.js';

/**
 * 체험 모드 가상 활동 (worker `demo-activity`, docs/demo-mode.md)
 *
 * 운영 환경에서는 내부 게임 API(시뮬레이터)가 꺼져 있어서 대시보드의 "오늘" 이 비어 보인다.
 * 체험 서버에서만 worker 가 몇 분마다 시뮬레이터 한 틱과 같은 일을 서비스 계층으로 직접 한다 (HTTP·내부 키 없음).
 * 접속·스테이지 진행(game-model) → 결제 → 재화 획득/소비 → 랭킹 점수 → 우편 수령. 점검 중이면 쉰다.
 */
export interface DemoActivityDeps {
  db: Executor;
  currencyService: Pick<CurrencyService, 'gameChange'>;
  mailService: Pick<MailService, 'mailbox' | 'claim'>;
  rankingService: Pick<RankingService, 'activeSeasonOf' | 'recordScore'>;
  scheduleService: Pick<ScheduleService, 'liveOps'>;
  maintenanceService: Pick<MaintenanceService, 'state' | 'blockedOf'>;
  purchaseService: Pick<PurchaseService, 'record'>;
}

export interface DemoActivityResult {
  skipped?: 'maintenance' | 'no-users';
  users: number;
  logins: number;
  clears: number;
  earned: number;
  spent: number;
  insufficient: number;
  scores: number;
  claims: number;
  purchases: number;
  errors: number;
}

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const chance = (p: number) => Math.random() < p;

/** 잔액 부족·시즌 없음 같은 정상적인 게임 규칙 거절인지 */
const ruleRejected = (err: unknown, code?: string) =>
  err instanceof AppError && (code ? err.code === code : err.status < 500);

export async function runDemoActivity(
  deps: DemoActivityDeps,
  opts: { users: number; now?: Date },
): Promise<DemoActivityResult> {
  const now = opts.now ?? new Date();
  const r: DemoActivityResult = {
    users: 0,
    logins: 0,
    clears: 0,
    earned: 0,
    spent: 0,
    insufficient: 0,
    scores: 0,
    claims: 0,
    purchases: 0,
    errors: 0,
  };

  // 점검 중엔 게임 서버도 플레이를 받지 않는다
  if ((await deps.maintenanceService.state()).active) return { ...r, skipped: 'maintenance' };

  // 최근 3일 안에 접속한 회원만 — 이미 떠난 회원이 되살아나지 않게 (이탈 분석이 흐려짐)
  const sampled = await sampleActiveUsers(deps.db, opts.users, { recentDays: 3 });
  if (!sampled.length) return { ...r, skipped: 'no-users' };
  r.users = sampled.length;

  // 1) 접속 + 스테이지 진행 (game-model: 순서대로, 20·45·80 은 난이도 벽)
  const plans = new Map(
    sampled.map((u) => [u.publicId, planSession(Math.random, u, { stamina: true })]),
  );
  const events: GameEventsRequest['events'] = sampled.flatMap(({ publicId }) => [
    { publicId, type: ActivityType.LOGIN, occurredAt: now },
    ...plans.get(publicId)!.clears.map((stage, i) => ({
      publicId,
      type: ActivityType.STAGE_CLEAR,
      payload: { stage, stars: rand(1, 3) },
      occurredAt: new Date(now.getTime() + (i + 1) * 1000),
    })),
  ]);
  const ev = await recordGameEvents(deps.db, deps.maintenanceService, events);
  const rejected = new Set(ev.rejected.map((x) => x.publicId));
  r.logins = sampled.filter((u) => !rejected.has(u.publicId)).length;
  r.clears = ev.accepted - r.logins;

  // 진행 중 시즌 보드
  const boards = (await deps.scheduleService.liveOps(now)).seasons.map((s) => s.boardCode);

  // 2) 회원별 결제·재화·점수·우편 (동시 5명씩 — 체험 서버 DB 부하를 낮게)
  const players = sampled.filter((u) => !rejected.has(u.publicId));
  for (let i = 0; i < players.length; i += 5) {
    await Promise.all(
      players.slice(i, i + 5).map(async ({ publicId, maxStage }) => {
        const plan = plans.get(publicId)!;
        const step = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (err) {
            if (ruleRejected(err, ErrorCode.INSUFFICIENT_BALANCE)) r.insufficient++;
            else if (!ruleRejected(err)) r.errors++;
          }
        };
        if (plan.purchase) {
          const code = plan.purchase;
          await step(async () => {
            await deps.purchaseService.record(publicId, code, now);
            r.purchases++;
          });
        }
        for (const l of plan.ledger) {
          await step(async () => {
            await deps.currencyService.gameChange(publicId, l.currencyCode, l.delta, l.reason);
            if (l.delta > 0) r.earned++;
            else r.spent++;
          });
        }
        if (boards.length && chance(0.3))
          await step(async () => {
            const seasonId = await deps.rankingService.activeSeasonOf(
              boards[rand(0, boards.length - 1)]!,
            );
            if (!seasonId) return;
            const stage = plan.clears.at(-1) ?? maxStage;
            await deps.rankingService.recordScore(seasonId, publicId, stage * 400 + rand(0, 2_000));
            r.scores++;
          });
        if (chance(0.5))
          await step(async () => {
            const box = await deps.mailService.mailbox(publicId);
            const claimable = box.filter(
              (m) => m.status === 'SENT' && !m.claimedAt && new Date(m.expiresAt) > now,
            );
            for (const m of claimable.slice(0, 3)) {
              await deps.mailService.claim(publicId, m.mailId, now);
              r.claims++;
            }
          });
      }),
    );
  }
  return r;
}
