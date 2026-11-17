import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { rankingSeasons, rankingSnapshots, schedules } from '../../src/infra/db/schema/index.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  idem,
  login,
  type TestContext,
} from './helpers.js';

const KEY = 'internal-test-key-'.padEnd(40, 'k');
let t: TestContext;
let op: string;

beforeAll(async () => {
  t = await createTestContext({ INTERNAL_API_KEY: KEY });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  op = (await login(t.app, ADMIN.operator)).accessToken;
});

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
/** 1×1 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'EVENT',
  title: '경험치 2배 주말',
  description: '주말 동안 경험치 2배',
  startsAt: inDays(1),
  endsAt: inDays(3),
  reason: '주말 이벤트 등록',
  ...over,
});

const create = (over: Record<string, unknown> = {}, token = op) =>
  request(t.app).post('/api/v1/schedules').set(bearer(token)).set(idem()).send(body(over));

async function upload(data = PNG, name = 'banner.png') {
  return request(t.app)
    .post('/api/v1/assets')
    .set(bearer(op))
    .set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent(name))
    .send(data);
}

/** 시드 시즌(지금 ~ 28일 후)의 스케줄 */
async function seedSeasonSchedule() {
  const [row] = await t.ctx.db.db
    .select()
    .from(schedules)
    .where(eq(schedules.kind, 'RANKING_SEASON'));
  return row!;
}

/** L2: 첫 호출 → 422 + 확인 토큰, 같은 본문 + 토큰으로 두 번째 호출 */
async function confirmed(
  path: string,
  payload: Record<string, unknown>,
  method: 'post' | 'put' = 'post',
) {
  const send = (body: Record<string, unknown>) =>
    (method === 'put' ? request(t.app).put(path) : request(t.app).post(path))
      .set(bearer(op))
      .send(body);
  const first = await send(payload);
  expect(first.status, JSON.stringify(first.body)).toBe(422);
  expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
  const second = await send({
    ...payload,
    confirmationToken: first.body.error.details.confirmationToken,
  });
  return { preview: first.body.error.details.preview, res: second };
}

describe('스케줄 생성·조회', () => {
  it('이벤트를 만들면 예정 상태, 기간으로 조회된다', async () => {
    const res = await create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'EVENT',
      status: 'SCHEDULED',
      version: 1,
      rankingSeason: null,
    });
    const list = await request(t.app)
      .get(`/api/v1/schedules?from=${inDays(0)}&to=${inDays(10)}`)
      .set(bearer(op));
    expect(list.body.data.map((s: { title: string }) => s.title)).toContain('경험치 2배 주말');
  });

  it('랭킹 시즌을 만들면 시즌도 예정 상태로 같이 생긴다', async () => {
    const res = await create({
      kind: 'RANKING_SEASON',
      rankingBoardId: 1,
      title: '아레나 시즌 2',
      startsAt: inDays(30),
      endsAt: inDays(58),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.rankingSeason).toMatchObject({
      name: '아레나 시즌 2',
      status: 'SCHEDULED',
    });
  });

  it('시즌 기간이 다른 시즌과 겹치면 409', async () => {
    const res = await create({
      kind: 'RANKING_SEASON',
      rankingBoardId: 1,
      title: '겹치는 시즌',
      startsAt: inDays(10),
      endsAt: inDays(40),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SCHEDULE_OVERLAP');
  });

  it('동시에 겹치는 시즌 두 개를 만들어도 하나만 성공 (이름 잠금)', async () => {
    const [a, b] = await Promise.all([
      create({
        kind: 'RANKING_SEASON',
        rankingBoardId: 1,
        title: '시즌 A',
        startsAt: inDays(30),
        endsAt: inDays(40),
      }),
      create({
        kind: 'RANKING_SEASON',
        rankingBoardId: 1,
        title: '시즌 B',
        startsAt: inDays(35),
        endsAt: inDays(45),
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it.each([
    ['종료가 시작보다 앞', { startsAt: inDays(3), endsAt: inDays(1) }],
    ['javascript: 링크', { link: 'javascript:alert(1)' }],
    ['http(비보안) 링크', { link: 'http://example.com' }],
    ['배너인데 이미지 없음', { bannerEnabled: true }],
  ])('거부(400): %s', async (_, over) => {
    expect((await create(over)).status).toBe(400);
  });

  it('조회 전용 역할은 만들 수 없다 (403)', async () => {
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    expect((await create({}, viewer)).status).toBe(403);
    expect(
      (
        await request(t.app)
          .get(`/api/v1/schedules?from=${inDays(0)}&to=${inDays(10)}`)
          .set(bearer(viewer))
      ).status,
    ).toBe(200);
  });
});

describe('수정·취소 규칙', () => {
  it('시작 전 일정은 바로 수정(L1), 오래된 version 으로 고치면 409', async () => {
    const created = (await create()).body.data;
    const edit = (version: number, title: string) =>
      request(t.app)
        .put(`/api/v1/schedules/${created.id}`)
        .set(bearer(op))
        .send({ ...body({ title }), version });
    const ok = await edit(1, '경험치 3배 주말');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ title: '경험치 3배 주말', version: 2 });
    const stale = await edit(1, '늦게 저장한 제목');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('진행 중 시즌의 종료 시각 변경은 확인(L2) 후 실행, 시작 시각은 못 바꾼다', async () => {
    const season = await seedSeasonSchedule();
    const base = {
      title: season.title,
      startsAt: season.startsAt.toISOString(),
      endsAt: inDays(20),
      reason: '시즌 기간 단축',
      version: season.version,
    };
    const { preview, res } = await confirmed(`/api/v1/schedules/${season.id}`, base, 'put');
    expect(preview.warnings.join(' ')).toContain('앞당겨집니다');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [rs] = await t.ctx.db.db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, season.rankingSeasonId!));
    expect(rs!.endsAt!.toISOString().slice(0, 13)).toBe(base.endsAt.slice(0, 13));

    const moveStart = await request(t.app)
      .put(`/api/v1/schedules/${season.id}`)
      .set(bearer(op))
      .send({ ...base, startsAt: inDays(1), version: season.version + 1 });
    expect(moveStart.status).toBe(422);
    expect(moveStart.body.error.code).toBe('SCHEDULE_NOT_EDITABLE');
  });

  it('시작 전 시즌 취소 → 시즌도 CANCELED, 진행 중 시즌은 취소 불가', async () => {
    const future = (
      await create({
        kind: 'RANKING_SEASON',
        rankingBoardId: 1,
        title: '취소할 시즌',
        startsAt: inDays(30),
        endsAt: inDays(40),
      })
    ).body.data;
    const res = await request(t.app)
      .post(`/api/v1/schedules/${future.id}/cancel`)
      .set(bearer(op))
      .send({ reason: '시즌 계획 변경', version: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('CANCELED');
    const [rs] = await t.ctx.db.db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, future.rankingSeason.id));
    expect(rs!.status).toBe('CANCELED');

    const active = await seedSeasonSchedule();
    const no = await request(t.app)
      .post(`/api/v1/schedules/${active.id}/cancel`)
      .set(bearer(op))
      .send({ reason: '진행 중 취소 시도', version: active.version });
    expect(no.status).toBe(422);
  });

  it('진행 중 이벤트 내리기는 확인(L2) 후 게임 노출에서 빠진다', async () => {
    const ev = (
      await create({ startsAt: new Date(Date.now() - 60_000).toISOString(), popupEnabled: true })
    ).body.data;
    expect(ev.status).toBe('ACTIVE');
    const { res } = await confirmed(`/api/v1/schedules/${ev.id}/cancel`, {
      reason: '문구 오류로 내림',
      version: 1,
    });
    expect(res.status).toBe(200);
    const live = await request(t.app)
      .get('/api/v1/internal/game/live-ops')
      .set('X-Internal-Key', KEY);
    expect(live.body.data.popups).toHaveLength(0);
  });
});

describe('시즌 수명 주기', () => {
  it('조기 종료(L2) → 즉시 종료 + FINAL 스냅샷, 이후 점수 기록은 거부', async () => {
    const season = await seedSeasonSchedule();
    const seasonId = season.rankingSeasonId!;
    const u = await createUser(t.ctx.db.db);
    await t.services.rankingService.recordScore(seasonId, u.publicId, 500);

    const { preview, res } = await confirmed(`/api/v1/schedules/${season.id}/end-now`, {
      reason: '밸런스 문제로 조기 종료',
      version: season.version,
    });
    expect(preview.action).toBe('END_NOW');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('ENDED');

    const [rs] = await t.ctx.db.db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, seasonId));
    expect(rs!.status).toBe('ENDED');
    const finals = await t.ctx.db.db
      .select()
      .from(rankingSnapshots)
      .where(and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.kind, 'FINAL')));
    expect(finals).toHaveLength(1);
    expect(finals[0]!.score).toBe(500);

    await expect(
      t.services.rankingService.recordScore(seasonId, u.publicId, 999),
    ).rejects.toMatchObject({ code: 'SEASON_NOT_ACTIVE' });
  });

  it('예정 시즌은 시작 시각이 지나면 진행, 워커가 동시에 돌아도 종료·스냅샷은 한 번', async () => {
    const s = (
      await create({
        kind: 'RANKING_SEASON',
        rankingBoardId: 1,
        title: '시즌 2',
        startsAt: inDays(30),
        endsAt: inDays(31),
      })
    ).body.data;
    const seasonId = s.rankingSeason.id as number;
    // 시작 전엔 점수 거부
    const u = await createUser(t.ctx.db.db);
    await expect(
      t.services.rankingService.recordScore(seasonId, u.publicId, 1),
    ).rejects.toMatchObject({ code: 'SEASON_NOT_ACTIVE' });

    const r1 = await t.services.rankingService.runSeasonLifecycle(
      new Date(Date.now() + 30.5 * DAY),
    );
    expect(r1.started).toContain(seasonId);

    const end = new Date(Date.now() + 32 * DAY);
    const results = await Promise.all([
      t.services.rankingService.runSeasonLifecycle(end),
      t.services.rankingService.runSeasonLifecycle(end),
    ]);
    expect(
      results.flatMap((r) => r.ended.map((e) => e.seasonId)).filter((id) => id === seasonId),
    ).toHaveLength(1);
  });
});

describe('이미지 업로드', () => {
  it('PNG 업로드 → 공개 주소로 받으면 판별된 형식·nosniff, 같은 파일은 같은 id', async () => {
    const res = await upload();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ mime: 'image/png', width: 1, height: 1 });
    expect((await upload()).body.data.id).toBe(res.body.data.id);

    const file = await request(t.app).get(res.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
  });

  it.each([
    [
      'SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'evil.svg',
    ],
    ['이름만 png 인 HTML', Buffer.from('<html><script>alert(1)</script></html>'), 'fake.png'],
  ])('거부: %s', async (_, data, name) => {
    const res = await upload(data, name);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_IMAGE');
  });

  it('2MB 를 넘으면 거부', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect([413, 422]).toContain((await upload(big)).status);
  });

  it('없는 키·경로 조작은 404', async () => {
    expect(
      (await request(t.app).get('/api/v1/public/assets/00000000-0000-4000-8000-000000000000.png'))
        .status,
    ).toBe(404);
    expect((await request(t.app).get('/api/v1/public/assets/..%2F..%2Fpackage.json')).status).toBe(
      404,
    );
  });
});

describe('게임용 라이브 운영 API', () => {
  it('진행 중·취소 안 된 일정만, 우선순위 높은 순 / ?at= 로 미래 시각 미리보기', async () => {
    const img = (await upload()).body.data.id as number;
    const now = new Date(Date.now() - 60_000).toISOString();
    await create({
      title: '낮은 배너',
      startsAt: now,
      bannerEnabled: true,
      imageAssetId: img,
      priority: 1,
    });
    await create({
      title: '높은 배너',
      startsAt: now,
      bannerEnabled: true,
      popupEnabled: true,
      imageAssetId: img,
      priority: 9,
      link: 'game://shop',
    });
    await create({
      title: '다음 주 이벤트',
      startsAt: inDays(7),
      endsAt: inDays(9),
      popupEnabled: true,
    });

    const live = await request(t.app)
      .get('/api/v1/internal/game/live-ops')
      .set('X-Internal-Key', KEY);
    expect(live.status).toBe(200);
    expect(live.body.data.seasons).toEqual([
      expect.objectContaining({ boardCode: 'ARENA', name: '아레나 시즌 1' }),
    ]);
    expect(live.body.data.banners.map((b: { title: string }) => b.title)).toEqual([
      '높은 배너',
      '낮은 배너',
    ]);
    expect(live.body.data.popups).toEqual([
      expect.objectContaining({ title: '높은 배너', link: 'game://shop' }),
    ]);
    expect(live.body.data.banners[0].imageUrl).toMatch(/^\/api\/v1\/public\/assets\//);

    const later = await request(t.app)
      .get(`/api/v1/internal/game/live-ops?at=${inDays(8)}`)
      .set('X-Internal-Key', KEY);
    expect(later.body.data.popups.map((p: { title: string }) => p.title)).toEqual([
      '다음 주 이벤트',
    ]);
  });

  it('내부 키가 없으면 401', async () => {
    expect((await request(t.app).get('/api/v1/internal/game/live-ops')).status).toBe(401);
  });
});

describe('랭킹 보드 (아레나 · 월드아레나)', () => {
  const H = { 'X-Internal-Key': KEY };

  it('다른 보드끼리는 기간이 겹쳐도 되고, 같은 보드끼리는 409', async () => {
    const world = await create({
      kind: 'RANKING_SEASON',
      rankingBoardId: 2,
      title: '월드아레나 시즌 1',
      startsAt: inDays(1),
      endsAt: inDays(10),
    });
    expect(world.status, JSON.stringify(world.body)).toBe(201);
    expect(world.body.data.rankingSeason.board).toMatchObject({ code: 'WORLD_ARENA' });
    const sameBoard = await create({
      kind: 'RANKING_SEASON',
      rankingBoardId: 2,
      title: '겹치는 월드 시즌',
      startsAt: inDays(5),
      endsAt: inDays(12),
    });
    expect(sameBoard.status).toBe(409);
  });

  it('시즌인데 보드를 안 고르면 400, 없는 보드면 422', async () => {
    expect(
      (
        await create({
          kind: 'RANKING_SEASON',
          title: '보드 없음',
          startsAt: inDays(30),
          endsAt: inDays(31),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create({
          kind: 'RANKING_SEASON',
          rankingBoardId: 99,
          title: '없는 보드',
          startsAt: inDays(30),
          endsAt: inDays(31),
        })
      ).status,
    ).toBe(422);
  });

  it('두 보드가 동시에 진행되면 게임은 보드 코드로 점수를 보내야 한다', async () => {
    const world = (
      await create({
        kind: 'RANKING_SEASON',
        rankingBoardId: 2,
        title: '월드아레나 시즌 1',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: inDays(10),
      })
    ).body.data;
    expect(world.rankingSeason.status).toBe('ACTIVE'); // 생성 직후 수명 주기 실행 → 바로 진행
    const u = await createUser(t.ctx.db.db);

    const ambiguous = await request(t.app)
      .post('/api/v1/internal/game/scores')
      .set(H)
      .send({ publicId: u.publicId, score: 10 });
    expect(ambiguous.status).toBe(422);
    expect(ambiguous.body.error.code).toBe('SEASON_NOT_ACTIVE');

    const ok = await request(t.app)
      .post('/api/v1/internal/game/scores')
      .set(H)
      .send({ publicId: u.publicId, score: 10, boardCode: 'world_arena' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const board = await request(t.app)
      .get(`/api/v1/ranking-seasons/${world.rankingSeason.id}/rankings`)
      .set(bearer(op));
    expect(board.body.data.entries.map((e: { publicId: string }) => e.publicId)).toEqual([
      u.publicId,
    ]);
    expect(board.body.data.season.board).toMatchObject({ code: 'WORLD_ARENA', name: '월드아레나' });

    const live = await request(t.app).get('/api/v1/internal/game/live-ops').set(H);
    expect(live.body.data.seasons.map((x: { boardCode: string }) => x.boardCode)).toEqual([
      'ARENA',
      'WORLD_ARENA',
    ]);
  });

  it('보드 목록', async () => {
    const res = await request(t.app).get('/api/v1/ranking-boards').set(bearer(op));
    expect(res.body.data.map((b: { code: string }) => b.code)).toEqual(['ARENA', 'WORLD_ARENA']);
  });
});
