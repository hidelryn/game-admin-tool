import { STAGE_MAX } from '@game-admin/shared';

/**
 * 가상 플레이어 행동 모델 (docs/analytics.md 4장) — 시드·시뮬레이터·체험 모드 가상 활동이 같이 쓴다
 *
 * - 스테이지는 1부터 순서대로 도전한다. 일반 스테이지는 대부분 깨지만 20·45·80 은 "난이도 벽"
 * - 벽에 막히면 결제하거나(결제하면 부활로 한 번 더 강하게 도전), 일정 확률로 그만둔다(이탈)
 * - 재화: 클리어 보상 골드 획득, 장비·스킬 강화에 골드 소비, 부활·뽑기에 젬 소비, 입장에 행동력 소비
 * 순수 함수 — 난수 함수(rand)를 받으므로 시드는 결정적으로, 실시간 활동은 Math.random 으로 돌린다
 */
export type Rand = () => number;

/** 벽 스테이지의 1회 클리어 확률 */
export const STAGE_WALLS: Readonly<Record<number, number>> = { 20: 0.16, 45: 0.11, 80: 0.07 };
export const isWall = (stage: number) => STAGE_WALLS[stage] !== undefined;

export function clearChance(stage: number, boosted: boolean): number {
  const wall = STAGE_WALLS[stage];
  if (wall !== undefined) return boosted ? Math.min(0.85, wall + 0.5) : wall;
  return Math.max(0.6, 0.96 - stage * 0.003);
}

export interface PlayerState {
  /** 최고 클리어 스테이지 */
  maxStage: number;
  /** 지금까지 결제 횟수 */
  payCount: number;
}

export interface LedgerStep {
  currencyCode: 'GOLD' | 'GEM' | 'FREE_GEM' | 'STAMINA';
  /** 양수 = 획득, 음수 = 소비 */
  delta: number;
  reason: string;
}

export interface SessionPlan {
  /** 이번 접속에서 깬 스테이지 (순서대로) */
  clears: number[];
  /** 마지막에 막힌 스테이지 (없으면 null) */
  stuckAt: number | null;
  /** 결제할 상품 코드 (부활 전에 결제) */
  purchase: string | null;
  /** 재화 변경 — 순서대로 적용, 잔액이 모자라면 그 단계만 건너뛴다 */
  ledger: LedgerStep[];
  /** 이번 접속을 마지막으로 그만두는지 */
  quit: boolean;
}

const pickWeighted = <T>(rand: Rand, items: readonly (readonly [T, number])[]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r < 0) return v;
  }
  return items[items.length - 1]![0];
};

function pickProduct(rand: Rand, payCount: number): string {
  if (payCount === 0) return rand() < 0.6 ? 'STARTER_PACK' : 'GEM_330';
  return pickWeighted(rand, [
    ['GEM_60', 25],
    ['GEM_330', 35],
    ['GEM_700', 22],
    ['GEM_2400', 7],
    ['MONTHLY_PASS', 11],
  ] as const);
}

/**
 * 한 번 접속해서 하는 일
 * @param stamina 행동력 획득·소비도 기록할지 (시드는 데이터 양 때문에 끔)
 */
export function planSession(
  rand: Rand,
  state: PlayerState,
  opts: { stamina?: boolean } = {},
): SessionPlan {
  const plan: SessionPlan = { clears: [], stuckAt: null, purchase: null, ledger: [], quit: false };
  let stage = state.maxStage;
  const attempts = 1 + Math.floor(rand() * 4);
  let tries = 0;
  let gold = 0;

  const attempt = (boosted: boolean) => {
    tries++;
    const next = stage + 1;
    if (rand() < clearChance(next, boosted)) {
      plan.clears.push(next);
      gold += 50 + next * 15;
      stage = next;
      plan.stuckAt = null;
      return true;
    }
    plan.stuckAt = next;
    return false;
  };

  for (let i = 0; i < attempts && stage < STAGE_MAX; i++) attempt(false);

  // 벽에 막힘 → 결제 후 부활(유료 젬) 또는 무료 젬 부활
  const wall = plan.stuckAt !== null && isWall(plan.stuckAt);
  if (wall) {
    const buy = rand() < (state.payCount > 0 ? 0.15 : 0.03);
    if (buy) {
      plan.purchase = pickProduct(rand, state.payCount);
      plan.ledger.push({ currencyCode: 'GEM', delta: -50, reason: '스테이지 부활' });
      attempt(true);
    } else if (rand() < 0.3) {
      plan.ledger.push({ currencyCode: 'FREE_GEM', delta: -30, reason: '스테이지 부활' });
      attempt(rand() < 0.5);
    }
  } else if (rand() < 0.0015) {
    plan.purchase = pickProduct(rand, state.payCount); // 충동 구매
  }

  if (gold > 0)
    plan.ledger.unshift({ currencyCode: 'GOLD', delta: gold, reason: '스테이지 클리어 보상' });
  if (opts.stamina) {
    plan.ledger.unshift({ currencyCode: 'STAMINA', delta: -tries * 6, reason: '스테이지 입장' });
    plan.ledger.unshift({ currencyCode: 'STAMINA', delta: tries * 6, reason: '행동력 자연 회복' });
  }
  if (rand() < 0.4)
    plan.ledger.push({
      currencyCode: 'GOLD',
      delta: -(200 + Math.floor(rand() * (stage * 40 + 500))),
      reason: '장비 강화',
    });
  if (rand() < 0.2)
    plan.ledger.push({
      currencyCode: 'GOLD',
      delta: -(100 + Math.floor(rand() * (stage * 20 + 300))),
      reason: '스킬 강화',
    });
  if (rand() < 0.08)
    plan.ledger.push({ currencyCode: 'FREE_GEM', delta: -150, reason: '장비 뽑기' });
  if (state.payCount > 0 && rand() < 0.12)
    plan.ledger.push({ currencyCode: 'GEM', delta: -300, reason: '장비 뽑기' });
  if (rand() < 0.15)
    plan.ledger.push({
      currencyCode: 'FREE_GEM',
      delta: 10 + Math.floor(rand() * 20),
      reason: '일일 미션 보상',
    });

  // 이탈: 벽에서 막힌 채 끝나면 크게, 초반(튜토리얼 구간)도 조금 높게. 결제한 사람은 덜 떠난다
  const stuckAtWall = plan.stuckAt !== null && isWall(plan.stuckAt);
  const payer = state.payCount > 0 || plan.purchase !== null;
  const base = stuckAtWall ? 0.11 : stage < 5 ? 0.07 : 0.012;
  plan.quit = rand() < (payer ? base * 0.4 : base);
  return plan;
}
