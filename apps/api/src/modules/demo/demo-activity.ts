import { ActivityType, ErrorCode, type GameEventsRequest } from '@game-admin/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { Executor } from '../../infra/db/types.js';
import type { CurrencyService } from '../currencies/currency.service.js';
import type { MailService } from '../mails/mail.service.js';
import type { RankingService } from '../rankings/ranking.service.js';
import type { ScheduleService } from '../schedules/schedule.service.js';
import type { MaintenanceService } from '../live-notices/maintenance.service.js';
import { recordGameEvents, sampleActiveUsers } from '../internal-game/game-actions.js';

/**
 * 체험 모드 가상 활동 (worker `demo-activity`, docs/demo-mode.md)
 *
 * 운영 환경에서는 내부 게임 API(시뮬레이터)가 꺼져 있어서 대시보드의 "오늘" 이 비어 보인다.
 * 체험 서버에서만 worker 가 몇 분마다 시뮬레이터 한 틱과 같은 일을 서비스 계층으로 직접 한다 (HTTP·내부 키 없음).
 * 접속·스테이지 클리어 → 재화 획득/소비 → 랭킹 점수 → 우편 수령. 점검 중이면 쉰다.
 */
export interface DemoActivityDeps {
  db: Executor;
  currencyService: Pick<CurrencyService, 'gameChange'>;
  mailService: Pick<MailService, 'mailbox' | 'claim'>;
  rankingService: Pick<RankingService, 'activeSeasonOf' | 'recordScore'>;
  scheduleService: Pick<ScheduleService, 'liveOps'>;
  maintenanceService: Pick<MaintenanceService, 'state' | 'blockedOf'>;
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
    errors: 0,
  };

  // 점검 중엔 게임 서버도 플레이를 받지 않는다
  if ((await deps.maintenanceService.state()).active) return { ...r, skipped: 'maintenance' };

  const ids = await sampleActiveUsers(deps.db, opts.users);
  if (!ids.length) return { ...r, skipped: 'no-users' };
  r.users = ids.length;

  // 1) 접속·스테이지 클리어
  const events = ids.flatMap((publicId) => {
    const list: GameEventsRequest['events'] = [
      { publicId, type: ActivityType.LOGIN, occurredAt: now },
    ];
    for (let i = 0; i < rand(0, 3); i++) {
      list.push({
        publicId,
        type: ActivityType.STAGE_CLEAR,
        payload: { stage: rand(1, 120), stars: rand(1, 3) },
        occurredAt: new Date(now.getTime() + (i + 1) * 1000),
      });
    }
    return list;
  });
  const ev = await recordGameEvents(deps.db, deps.maintenanceService, events);
  const rejected = new Set(ev.rejected.map((x) => x.publicId));
  r.logins = ids.filter((id) => !rejected.has(id)).length;
  r.clears = ev.accepted - r.logins;

  // 진행 중 시즌 보드
  const boards = (await deps.scheduleService.liveOps(now)).seasons.map((s) => s.boardCode);

  // 2) 회원별 재화·점수·우편 (동시 5명씩 — 체험 서버 DB 부하를 낮게)
  const players = ids.filter((id) => !rejected.has(id));
  for (let i = 0; i < players.length; i += 5) {
    await Promise.all(
      players.slice(i, i + 5).map(async (publicId) => {
        const step = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (err) {
            if (ruleRejected(err, ErrorCode.INSUFFICIENT_BALANCE)) r.insufficient++;
            else if (!ruleRejected(err)) r.errors++;
          }
        };
        await step(async () => {
          await deps.currencyService.gameChange(
            publicId,
            'GOLD',
            rand(100, 2_000),
            '스테이지 클리어 보상',
          );
          r.earned++;
        });
        if (chance(0.15))
          await step(async () => {
            await deps.currencyService.gameChange(
              publicId,
              'FREE_GEM',
              rand(5, 30),
              '일일 미션 보상',
            );
            r.earned++;
          });
        if (chance(0.4))
          await step(async () => {
            const gold = chance(0.5);
            await deps.currencyService.gameChange(
              publicId,
              gold ? 'GOLD' : 'STAMINA',
              -rand(10, 500),
              gold ? '장비 강화' : '스테이지 입장',
            );
            r.spent++;
          });
        if (boards.length && chance(0.3))
          await step(async () => {
            const seasonId = await deps.rankingService.activeSeasonOf(
              boards[rand(0, boards.length - 1)]!,
            );
            if (!seasonId) return;
            await deps.rankingService.recordScore(seasonId, publicId, rand(1_000, 60_000));
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
