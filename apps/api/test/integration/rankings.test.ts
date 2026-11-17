import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  admins,
  mailRecipients,
  mails,
  rankingRewardPayouts,
  rankingScores,
  rankingSeasons,
  users,
} from '../../src/infra/db/schema/index.js';
import type { AuditContext } from '../../src/modules/audit/audit.writer.js';
import { csvCell } from '../../src/modules/rankings/rankings.router.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  idem,
  login,
  type TestContext,
} from './helpers.js';

let t: TestContext;
let op: string;
let seasonId: number;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  op = (await login(t.app, ADMIN.operator)).accessToken;
  [{ id: seasonId }] = (await t.ctx.db.db
    .select({ id: rankingSeasons.id })
    .from(rankingSeasons)) as [{ id: number }];
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min));

/** seq 미지정 시 목록 순서대로 1, 2, 3… */
async function seedScores(list: { score: number; minute: number; seq?: number }[]) {
  const us = [];
  for (const [i, s] of list.entries()) {
    const u = await createUser(t.ctx.db.db);
    await t.ctx.db.db.insert(rankingScores).values({
      seasonId,
      userId: u.id,
      score: s.score,
      achievedAt: at(s.minute),
      achievedSeq: s.seq ?? i + 1,
    });
    us.push(u);
  }
  return us;
}

describe('랭킹 조회', () => {
  it('Redis 가 비어 있으면 MySQL 에서 적재하고, 동점은 먼저 기록한 회원이 상위', async () => {
    const [a, b, c] = await seedScores([
      { score: 500, minute: 10, seq: 30 },
      { score: 900, minute: 5, seq: 20 },
      { score: 500, minute: 1, seq: 10 },
    ]);
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.data.entries.map((e: { publicId: string }) => e.publicId)).toEqual([
      b!.publicId,
      c!.publicId,
      a!.publicId,
    ]);
    expect(res.body.data.entries[1]).toMatchObject({
      rank: 2,
      score: 500,
      achievedAt: at(1).toISOString(),
    });
  });

  it('회원 순위와 위아래 5명', async () => {
    const us = await seedScores(
      Array.from({ length: 15 }, (_, i) => ({ score: 1000 - i * 10, minute: i })),
    );
    const target = us[7]!;
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings/users/${target.publicId}`)
      .set(bearer(op));
    expect(res.body.data.me).toMatchObject({ rank: 8, score: 930 });
    expect(res.body.data.neighbors.map((e: { rank: number }) => e.rank)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it('같은 초에 같은 점수를 내도 먼저 기록한 회원이 상위 (ID 순서와 무관)', async () => {
    const later = await createUser(t.ctx.db.db); // id 가 작은 회원이 나중에 기록
    const first = await createUser(t.ctx.db.db);
    const sameSecond = at(0);
    await t.services.rankingService.recordScore(seasonId, first.publicId, 700, sameSecond);
    await t.services.rankingService.recordScore(seasonId, later.publicId, 700, sameSecond);
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(res.body.data.entries.map((e: { publicId: string }) => e.publicId)).toEqual([
      first.publicId,
      later.publicId,
    ]);
  });

  it('Redis 에 적재된 뒤 갱신해도 순위·건수가 정확하다 (예전 멤버 제거)', async () => {
    const [a, b] = await seedScores([
      { score: 100, minute: 0 },
      { score: 200, minute: 0 },
    ]);
    await request(t.app).get(`/api/v1/ranking-seasons/${seasonId}/rankings`).set(bearer(op)); // 적재
    await t.services.rankingService.recordScore(seasonId, a!.publicId, 300);
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(res.body.meta.total).toBe(2);
    expect(
      res.body.data.entries.map((e: { publicId: string; score: number }) => [e.publicId, e.score]),
    ).toEqual([
      [a!.publicId, 300],
      [b!.publicId, 200],
    ]);
  });

  it('여러 회원이 동시에 같은 점수를 기록해도 모두 반영되고, 기록 순서대로 정렬', async () => {
    await request(t.app).get(`/api/v1/ranking-seasons/${seasonId}/rankings`).set(bearer(op)); // (빈 시즌) 적재 시도
    const us = await Promise.all(Array.from({ length: 20 }, () => createUser(t.ctx.db.db)));
    await Promise.all(
      us.map((u) => t.services.rankingService.recordScore(seasonId, u.publicId, 500)),
    );
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings?limit=100`)
      .set(bearer(op));
    expect(res.body.meta.total).toBe(20);
    // Redis 순서 = MySQL 의 achieved_seq 오름차순
    const rows = await t.ctx.db.db
      .select()
      .from(rankingScores)
      .where(eq(rankingScores.seasonId, seasonId))
      .orderBy(rankingScores.achievedSeq);
    const byUser = new Map(us.map((u) => [u.id, u.publicId]));
    expect(res.body.data.entries.map((e: { publicId: string }) => e.publicId)).toEqual(
      rows.map((r) => byUser.get(r.userId)),
    );
  });

  it('같은 회원이 동시에 여러 점수를 내도 최고 점수 하나만 남는다 (Redis 도)', async () => {
    const [u] = await seedScores([{ score: 1, minute: 0 }]);
    await request(t.app).get(`/api/v1/ranking-seasons/${seasonId}/rankings`).set(bearer(op)); // 적재
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        t.services.rankingService.recordScore(seasonId, u!.publicId, 100 + i),
      ),
    );
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data.entries[0].score).toBe(114);
    const [row] = await t.ctx.db.db
      .select()
      .from(rankingScores)
      .where(eq(rankingScores.userId, u!.id));
    expect(row!.score).toBe(114);
  });

  it('재구성은 적재 중 들어온 기록도 따라잡는다', async () => {
    const [a] = await seedScores([{ score: 100, minute: 0 }]);
    const b = await createUser(t.ctx.db.db);
    // 재구성 직전에 기록된 점수 (적재 시작 시점 -30초 이후 번호) → 교체 후 따라잡기에서 반영
    await t.services.rankingService.recordScore(seasonId, b.publicId, 300);
    const r = await t.services.rankingService.reconcileActive();
    expect(r.find((x) => x.seasonId === seasonId)?.loaded).toBe(2);
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(res.body.data.entries.map((e: { publicId: string }) => e.publicId)).toEqual([
      b.publicId,
      a!.publicId,
    ]);
  });

  it('점수 갱신은 최고 점수만 유지', async () => {
    const [u] = await seedScores([{ score: 300, minute: 0 }]);
    await t.services.rankingService.recordScore(seasonId, u!.publicId, 100);
    await t.services.rankingService.recordScore(seasonId, u!.publicId, 800, at(30));
    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings/users/${u!.publicId}`)
      .set(bearer(op));
    expect(res.body.data.me).toMatchObject({ score: 800, achievedAt: at(30).toISOString() });
    const [row] = await t.ctx.db.db
      .select()
      .from(rankingScores)
      .where(eq(rankingScores.userId, u!.id));
    expect(row!.score).toBe(800);
  });

  it('범위를 벗어난 점수는 거부', async () => {
    const u = await createUser(t.ctx.db.db);
    await expect(
      t.services.rankingService.recordScore(seasonId, u.publicId, 1_000_000_000_001),
    ).rejects.toMatchObject({ code: 'SCORE_OUT_OF_RANGE' });
    // 천만 점은 정상
    await expect(
      t.services.rankingService.recordScore(seasonId, u.publicId, 10_000_000),
    ).resolves.toMatchObject({ updated: true });
  });

  it('없는 시즌은 404', async () => {
    const res = await request(t.app).get('/api/v1/ranking-seasons/9999/rankings').set(bearer(op));
    expect(res.body.error.code).toBe('SEASON_NOT_FOUND');
  });
});

describe('랭킹 관리', () => {
  it('재구성: MySQL 을 직접 고친 내용이 반영된다', async () => {
    const [u] = await seedScores([{ score: 100, minute: 0 }]);
    await request(t.app).get(`/api/v1/ranking-seasons/${seasonId}/rankings`).set(bearer(op)); // Redis 적재
    await t.ctx.db.db
      .update(rankingScores)
      .set({ score: 777 })
      .where(eq(rankingScores.userId, u!.id));

    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const viewerDenied = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/rebuild`)
      .set(bearer(op))
      .set(idem())
      .send({ reason: '권한 없는 재구성' });
    expect(viewerDenied.status).toBe(403);

    const res = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/rebuild`)
      .set(bearer(superToken))
      .set(idem())
      .send({ reason: '점수 보정 반영' });
    expect(res.body.data.loaded).toBe(1);
    const list = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(op));
    expect(list.body.data.entries[0].score).toBe(777);
  });

  it('초기화(L3): 빨간 경고 확인 후 스냅샷이 남고 랭킹이 비워진다', async () => {
    const [, seq50, seq40] = await seedScores([
      { score: 300, minute: 0 },
      { score: 100, minute: 0, seq: 50 },
      { score: 100, minute: 0, seq: 40 },
    ]);
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const { preview, res } = await confirmedPost(
      `/api/v1/ranking-seasons/${seasonId}/reset`,
      { reason: '시즌 1 종료 정산' },
      superToken,
    );
    expect(preview.action).toBe('RANKING_RESET');
    expect(preview.facts).toContainEqual({ label: '지워질 순위', value: '3명' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ archivedCount: 3 });
    const reviewer = superToken;

    const list = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/rankings`)
      .set(bearer(reviewer));
    expect(list.body.meta.total).toBe(0);

    const snaps = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/snapshots`)
      .set(bearer(reviewer));
    expect(snaps.body.data[0]).toMatchObject({ count: 3, reason: '시즌 1 종료 정산' });
    const detail = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/snapshots/${snaps.body.data[0].snapshotId}`)
      .set(bearer(reviewer));
    expect(detail.body.data.map((r: { rank: number; score: number }) => [r.rank, r.score])).toEqual(
      [
        [1, 300],
        [2, 100],
        [3, 100],
      ],
    );
    // 스냅샷의 동점 순서도 Redis 와 같은 기준: 먼저 기록한(seq 40) 회원이 위
    expect(detail.body.data[1].publicId).toBe(seq40!.publicId);
    expect(detail.body.data[2].publicId).toBe(seq50!.publicId);
    expect(
      await t.ctx.db.db.select().from(rankingScores).where(eq(rankingScores.seasonId, seasonId)),
    ).toHaveLength(0);
    const [season] = await t.ctx.db.db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, seasonId));
    expect(season!.resetCount).toBe(1);
  });
});

/** L3: 첫 호출 → 422 + 빨간 경고 미리보기, 같은 본문 + 토큰 → 실행 */
async function confirmedPost(path: string, body: Record<string, unknown>, token: string) {
  const key = idem();
  const first = await request(t.app).post(path).set(bearer(token)).set(key).send(body);
  expect(first.status, JSON.stringify(first.body)).toBe(422);
  expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
  const res = await request(t.app)
    .post(path)
    .set(bearer(token))
    .set(key)
    .send({ ...body, confirmationToken: first.body.error.details.confirmationToken });
  return { preview: first.body.error.details.preview, res };
}

async function systemAudit(): Promise<AuditContext> {
  const [row] = await t.ctx.db.db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.email, ADMIN.super));
  return { adminId: row!.id, apiTokenId: null, channel: 'WEB', requestId: null, ip: null };
}

/** 점수를 넣고 초기화해서 스냅샷 하나를 만든다 */
async function resetWith(list: { score: number; seq?: number }[]) {
  const us = await seedScores(list.map((x) => ({ ...x, minute: 0 })));
  const { snapshotId } = await t.services.rankingService.executeReset(
    seasonId,
    '시즌 종료 정산',
    await systemAudit(),
  );
  return { us, snapshotId };
}

const boardIds = async (token: string) =>
  (
    await request(t.app).get(`/api/v1/ranking-seasons/${seasonId}/rankings`).set(bearer(token))
  ).body.data.entries.map((e: { publicId: string }) => e.publicId);

describe('스냅샷 복원 (L3)', () => {
  it('확인 후 현재 순위를 스냅샷으로 교체하고, 직전 상태는 BACKUP 스냅샷으로 남는다', async () => {
    const { us, snapshotId } = await resetWith([
      { score: 300 },
      { score: 100, seq: 50 },
      { score: 100, seq: 40 },
    ]);
    const [a, b50, c40] = us;
    // 초기화 뒤 새 기록 1건
    const newcomer = await createUser(t.ctx.db.db);
    await t.services.rankingService.recordScore(seasonId, newcomer.publicId, 999);

    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const reviewer = superToken;
    const { preview, res } = await confirmedPost(
      `/api/v1/ranking-seasons/${seasonId}/restore`,
      { snapshotId, reason: '실수로 초기화한 시즌 복구' },
      superToken,
    );
    expect(preview.action).toBe('RANKING_RESTORE');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ restoredCount: 3 });

    // 스냅샷 순위 그대로 (동점은 먼저 기록한 seq 40 이 위), 초기화 뒤 기록은 사라짐
    expect(await boardIds(reviewer)).toEqual([a!.publicId, c40!.publicId, b50!.publicId]);

    const snaps = (
      await request(t.app)
        .get(`/api/v1/ranking-seasons/${seasonId}/snapshots`)
        .set(bearer(reviewer))
    ).body.data;
    const backup = snaps.find((x: { kind: string }) => x.kind === 'BACKUP');
    expect(backup).toMatchObject({ count: 1 });
    expect(backup.reason).toContain('복원 전 자동 보관');
  });

  it('복원한 뒤 같은 점수를 새로 기록하면 복원된 회원보다 아래', async () => {
    const { us, snapshotId } = await resetWith([{ score: 500 }]);
    await t.services.rankingService.executeRestore(
      seasonId,
      snapshotId,
      '복원 순서 확인',
      await systemAudit(),
    );
    const late = await createUser(t.ctx.db.db);
    await t.services.rankingService.recordScore(seasonId, late.publicId, 500);
    expect(await boardIds(op)).toEqual([us[0]!.publicId, late.publicId]);
  });

  it('없는 스냅샷은 요청 단계에서 404', async () => {
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const res = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/restore`)
      .set(bearer(superToken))
      .set(idem())
      .send({
        snapshotId: '00000000-0000-4000-8000-000000000000',
        reason: '없는 스냅샷 복원 시도',
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SNAPSHOT_NOT_FOUND');
  });
});

describe('스냅샷 순위 보상 (L3, 우편)', () => {
  const rewardBody = (snapshotId: string) => ({
    snapshotId,
    title: '시즌 1 순위 보상',
    body: '시즌 1 순위 보상입니다.',
    expiresInDays: 14,
    reason: '시즌 1 종료 보상',
    tiers: [
      { fromRank: 1, toRank: 1, rewards: [{ type: 'CURRENCY', code: 'GEM', quantity: 1000 }] },
      {
        fromRank: 2,
        toRank: 3,
        rewards: [
          { type: 'CURRENCY', code: 'GEM', quantity: 300 },
          { type: 'ITEM', code: 'SKIN_BOX', quantity: 1 },
        ],
      },
    ],
  });

  it('확인 후 구간마다 우편 1통, 탈퇴 회원은 제외하고, 같은 스냅샷엔 다시 요청할 수 없다', async () => {
    const { us, snapshotId } = await resetWith([
      { score: 400 },
      { score: 300 },
      { score: 200 },
      { score: 100 },
    ]);
    // 3위는 초기화 뒤 탈퇴
    await t.ctx.db.db.update(users).set({ status: 'WITHDRAWN' }).where(eq(users.id, us[2]!.id));

    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const { preview, res: done } = await confirmedPost(
      `/api/v1/ranking-seasons/${seasonId}/rewards`,
      rewardBody(snapshotId),
      superToken,
    );
    expect(preview.action).toBe('RANKING_REWARD');
    expect(preview.facts).toContainEqual({ label: '대상 (스냅샷 기준)', value: '최대 3명' });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.data).toMatchObject({ recipientCount: 2, skippedCount: 1 });
    const sent = done.body.data.mails as {
      fromRank: number;
      mailId: number;
      recipientCount: number;
    }[];
    expect(sent.map((m) => [m.fromRank, m.recipientCount])).toEqual([
      [1, 1],
      [2, 1],
    ]);

    const [mail2] = await t.ctx.db.db.select().from(mails).where(eq(mails.id, sent[1]!.mailId));
    expect(mail2!.title).toBe('시즌 1 순위 보상 (2~3위)');
    const recips = await t.ctx.db.db
      .select()
      .from(mailRecipients)
      .where(eq(mailRecipients.mailId, sent[1]!.mailId));
    expect(recips.map((r) => r.userId)).toEqual([us[1]!.id]); // 3위(탈퇴) 제외

    // 지급 끝난 뒤 재요청 불가 (확인 화면 전에 409)
    const again = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/rewards`)
      .set(bearer(superToken))
      .set(idem())
      .send(rewardBody(snapshotId));
    expect(again.status).toBe(409);
  });

  it('동시에 두 번 실행돼도 DB 제약으로 한 번만 지급', async () => {
    const { snapshotId } = await resetWith([{ score: 10 }]);
    const audit = await systemAudit();
    const input = {
      ...rewardBody(snapshotId),
      tiers: [rewardBody(snapshotId).tiers[0]!],
    } as Parameters<typeof t.services.rankingService.executeReward>[1];
    const results = await Promise.allSettled([
      t.services.rankingService.executeReward(seasonId, input, audit),
      t.services.rankingService.executeReward(seasonId, input, audit),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await t.ctx.db.db.select().from(rankingRewardPayouts)).toHaveLength(1);
  });

  it('끝 순위를 비우면(null) 그 순위부터 마지막까지 받는다', async () => {
    const { us, snapshotId } = await resetWith([
      { score: 50 },
      { score: 40 },
      { score: 30 },
      { score: 20 },
      { score: 10 },
    ]);
    const body = {
      ...rewardBody(snapshotId),
      tiers: [
        { fromRank: 1, toRank: 2, rewards: [{ type: 'CURRENCY', code: 'GEM', quantity: 100 }] },
        {
          fromRank: 3,
          toRank: null,
          rewards: [{ type: 'CURRENCY', code: 'GOLD', quantity: 1000 }],
        },
      ],
    } as Parameters<typeof t.services.rankingService.executeReward>[1];
    const result = await t.services.rankingService.executeReward(
      seasonId,
      body,
      await systemAudit(),
    );
    expect(result.mails.map((m) => [m.fromRank, m.toRank, m.recipientCount])).toEqual([
      [1, 2, 2],
      [3, null, 3],
    ]);
    const [last] = await t.ctx.db.db
      .select()
      .from(mails)
      .where(eq(mails.id, result.mails[1]!.mailId));
    expect(last!.title).toBe('시즌 1 순위 보상 (3위~)');
    const recips = await t.ctx.db.db
      .select()
      .from(mailRecipients)
      .where(eq(mailRecipients.mailId, result.mails[1]!.mailId));
    expect(recips.map((r) => r.userId).sort()).toEqual([us[2]!.id, us[3]!.id, us[4]!.id].sort());
  });

  it.each([
    [
      '"마지막까지" 구간이 둘',
      [
        { fromRank: 1, toRank: null },
        { fromRank: 5, toRank: null },
      ],
    ],
    [
      '"마지막까지" 구간 뒤에 다른 구간',
      [
        { fromRank: 1, toRank: null },
        { fromRank: 1001, toRank: 2000 },
      ],
    ],
  ])('거부: %s', async (_, ranges) => {
    const { snapshotId } = await resetWith([{ score: 10 }]);
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const body = {
      ...rewardBody(snapshotId),
      tiers: ranges.map((r) => ({
        ...r,
        rewards: [{ type: 'CURRENCY', code: 'GOLD', quantity: 1 }],
      })),
    };
    const res = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/rewards`)
      .set(bearer(superToken))
      .set(idem())
      .send(body);
    expect(res.status).toBe(400);
  });

  it('구간이 겹치면 400', async () => {
    const { snapshotId } = await resetWith([{ score: 10 }]);
    const superToken = (await login(t.app, ADMIN.super)).accessToken;
    const body = rewardBody(snapshotId);
    body.tiers[1]!.fromRank = 1;
    const res = await request(t.app)
      .post(`/api/v1/ranking-seasons/${seasonId}/rewards`)
      .set(bearer(superToken))
      .set(idem())
      .send(body);
    expect(res.status).toBe(400);
  });
});

describe('스냅샷 CSV 내보내기', () => {
  it('엑셀 호환 CSV(BOM)로 순위대로 내보내고, 수식처럼 보이는 닉네임은 무력화하며, 운영 로그를 남긴다', async () => {
    const tricky = await createUser(t.ctx.db.db, { nickname: '=HYPERLINK("http://x")' });
    await t.ctx.db.db
      .insert(rankingScores)
      .values({ seasonId, userId: tricky.id, score: 50, achievedAt: at(0), achievedSeq: 1 });
    await seedScores([{ score: 70, minute: 0, seq: 2 }]);
    const { snapshotId } = await t.services.rankingService.executeReset(
      seasonId,
      '내보내기 테스트',
      await systemAudit(),
    );

    const res = await request(t.app)
      .get(`/api/v1/ranking-seasons/${seasonId}/snapshots/${snapshotId}/export`)
      .set(bearer(op))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = (res.body as string).split('\r\n');
    expect(lines[0]).toBe('\uFEFF순위,회원ID,닉네임,점수');
    expect(lines[1]!.startsWith('1,')).toBe(true);
    expect(lines[2]).toBe(`2,${tricky.publicId},"'=HYPERLINK(""http://x"")",50`);

    const logs = await request(t.app)
      .get('/api/v1/audit-logs?action=RANKING_SNAPSHOT_EXPORT')
      .set(bearer((await login(t.app, ADMIN.super)).accessToken));
    expect(logs.body.data[0].after).toMatchObject({ snapshotId, rows: 2 });
  });

  it('없는 스냅샷은 404 JSON', async () => {
    const res = await request(t.app)
      .get(
        `/api/v1/ranking-seasons/${seasonId}/snapshots/00000000-0000-4000-8000-000000000000/export`,
      )
      .set(bearer(op));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SNAPSHOT_NOT_FOUND');
  });

  it('csvCell: 쉼표·따옴표·수식 시작 문자 처리', () => {
    expect(csvCell('평범')).toBe('평범');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});
