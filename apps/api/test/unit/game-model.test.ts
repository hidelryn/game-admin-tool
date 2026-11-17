import { describe, expect, it } from 'vitest';
import { stageBucketOf, stageBucketLabel, STAGE_MAX } from '@game-admin/shared';
import { clearChance, isWall, planSession } from '../../src/modules/analytics/game-model.js';

/** 정해진 값을 차례로 돌려주는 난수 (끝나면 마지막 값 반복) */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

describe('스테이지 구간 (다음 도전 스테이지 기준)', () => {
  it('최고 클리어 → 구간 시작', () => {
    expect(stageBucketOf(0)).toBe(1); // 1 스테이지 도전 중
    expect(stageBucketOf(9)).toBe(1); // 10 도전 중 → 1~10
    expect(stageBucketOf(10)).toBe(11);
    expect(stageBucketOf(19)).toBe(11); // 20(벽) 도전 중 → 11~20
    expect(stageBucketOf(STAGE_MAX)).toBe(111); // 끝까지 깨면 마지막 구간
    expect(stageBucketLabel(111)).toBe('111~120');
  });
});

describe('플레이 모델', () => {
  it('벽(20·45·80)은 일반 스테이지보다 훨씬 어렵고, 결제 부활이면 쉬워진다', () => {
    expect(isWall(20) && isWall(45) && isWall(80)).toBe(true);
    expect(isWall(21)).toBe(false);
    expect(clearChance(20, false)).toBeLessThan(0.2);
    expect(clearChance(19, false)).toBeGreaterThan(0.8);
    expect(clearChance(20, true)).toBeGreaterThan(clearChance(20, false) + 0.3);
  });

  it('스테이지는 순서대로만 깬다', () => {
    const plan = planSession(seq(0.99, 0, 0, 0, 0), { maxStage: 5, payCount: 0 }); // 시도 4번 모두 성공
    expect(plan.clears).toEqual([6, 7, 8, 9]);
    expect(plan.stuckAt).toBeNull();
    expect(plan.ledger[0]).toMatchObject({ currencyCode: 'GOLD', reason: '스테이지 클리어 보상' });
  });

  it('벽에서 막히면 결제 후 유료 젬으로 부활할 수 있다', () => {
    // 시도 1번(0) → 실패(0.9) → 결제 결정(0) → 첫 결제 상품(0 → 스타터) → 부활 성공(0)
    const plan = planSession(seq(0, 0.9, 0, 0, 0), { maxStage: 19, payCount: 0 });
    expect(plan.purchase).toBe('STARTER_PACK');
    expect(plan.ledger).toContainEqual({
      currencyCode: 'GEM',
      delta: -50,
      reason: '스테이지 부활',
    });
    expect(plan.clears).toEqual([20]);
  });

  it('벽에서 막힌 채 끝나면 일반 구간보다 잘 떠난다', () => {
    const quitRate = (maxStage: number) => {
      let r = 0x9e3779b9;
      const rand = () => {
        r = (r * 1664525 + 1013904223) >>> 0;
        return r / 4294967296;
      };
      let quits = 0;
      for (let i = 0; i < 20_000; i++)
        if (planSession(rand, { maxStage, payCount: 0 }).quit) quits++;
      return quits / 20_000;
    };
    expect(quitRate(19)).toBeGreaterThan(quitRate(30) * 3);
  });

  it('행동력은 옵션 — 켜면 회복과 입장 소비가 같은 양', () => {
    const plan = planSession(seq(0, 0), { maxStage: 3, payCount: 0 }, { stamina: true });
    const st = plan.ledger.filter((l) => l.currencyCode === 'STAMINA');
    expect(st).toHaveLength(2);
    expect(st[0]!.delta + st[1]!.delta).toBe(0);
  });
});
