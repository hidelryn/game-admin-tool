import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { admins, auditLogs, maintenances, notices } from '../../src/infra/db/schema/index.js';
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
const GAME = { 'X-Internal-Key': KEY };
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

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

const maintenanceBody = (over: Record<string, unknown> = {}) => ({
  title: '정기 점검',
  message: '서버 안정화 작업을 진행합니다.',
  startsAt: inHours(24),
  endsAt: inHours(26),
  allowPublicIds: [],
  reason: '정기 점검 예약',
  ...over,
});

const createMaintenance = (over: Record<string, unknown> = {}, token = op) =>
  request(t.app)
    .post('/api/v1/maintenances')
    .set(bearer(token))
    .set(idem())
    .send(maintenanceBody(over));

/** L2: 첫 호출 → 422 + 확인 토큰, 같은 본문 + 토큰으로 두 번째 호출 */
async function confirmed(
  path: string,
  payload: Record<string, unknown>,
  method: 'post' | 'put' = 'post',
) {
  const key = idem();
  const send = (body: Record<string, unknown>) =>
    (method === 'put' ? request(t.app).put(path) : request(t.app).post(path))
      .set(bearer(op))
      .set(key)
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

/** 긴급 점검 시작 (L2 확인까지) */
async function startEmergency(over: Record<string, unknown> = {}) {
  const { startsAt: _s, ...rest } = maintenanceBody({
    title: '긴급 점검',
    startNow: true,
    endsAt: inHours(1),
    reason: '결제 오류 긴급 점검',
    ...over,
  });
  const { preview, res } = await confirmed('/api/v1/maintenances', rest);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { preview, view: res.body.data };
}

const liveOps = () => request(t.app).get('/api/v1/internal/game/live-ops').set(GAME);
const score = (publicId: string) =>
  request(t.app)
    .post('/api/v1/internal/game/scores')
    .set(GAME)
    .send({ boardCode: 'ARENA', publicId, score: 1234 });
const earn = (publicId: string) =>
  request(t.app)
    .post('/api/v1/internal/game/currencies')
    .set(GAME)
    .send({ publicId, currencyCode: 'GOLD', delta: 100, reason: '스테이지 보상' });

/** 시작 시각이 이미 지난, 아직 시작 처리 안 된 점검을 DB 에 직접 (워커가 늦은 상황) */
async function insertDueMaintenance() {
  const [admin] = await t.ctx.db.db.select({ id: admins.id }).from(admins).limit(1);
  const startsAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
  const [row] = await t.ctx.db.db
    .insert(maintenances)
    .values({
      title: '예약 점검',
      message: '예약 점검입니다.',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * HOUR),
      allowPublicIds: [],
      createdBy: admin!.id,
      updatedBy: admin!.id,
    })
    .$returningId();
  return row!.id;
}

describe('점검 예약', () => {
  it('예약하면 점검 공지(고정 + 한 줄 공지)가 같이 생기고, 시작 전엔 게임이 열려 있다', async () => {
    const res = await createMaintenance();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'SCHEDULED', sessionEpoch: null, version: 1 });
    expect(res.body.data.notice).not.toBeNull();

    const [n] = await t.ctx.db.db
      .select()
      .from(notices)
      .where(eq(notices.id, res.body.data.notice.id));
    expect(n).toMatchObject({
      category: 'MAINTENANCE',
      pinned: true,
      tickerEnabled: true,
      maintenanceId: res.body.data.id,
    });
    expect(n!.endsAt!.toISOString()).toBe(res.body.data.endsAt);

    const live = await liveOps();
    expect(live.status).toBe(200);
    expect(live.body.data.maintenance.active).toBe(false);
    expect(live.body.data.sessionEpoch).toBe(0);
    expect(live.body.data.tickers[0].text).toContain('점검 안내');

    const u = await createUser(t.ctx.db.db);
    expect((await score(u.publicId)).status).toBe(200);
  });

  it('공지 없이 예약할 수도 있다', async () => {
    const res = await createMaintenance({ createNotice: false });
    expect(res.status).toBe(201);
    expect(res.body.data.notice).toBeNull();
  });

  it('예약 시작 시각이 지났으면 422 (긴급 점검을 써야 함)', async () => {
    const res = await createMaintenance({ startsAt: inHours(-1), endsAt: inHours(1) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAINTENANCE_NOT_EDITABLE');
  });

  it('기간이 겹치면 409, 동시에 두 개를 만들어도 하나만 성공', async () => {
    expect((await createMaintenance()).status).toBe(201);
    const overlap = await createMaintenance({ startsAt: inHours(25), endsAt: inHours(27) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('MAINTENANCE_OVERLAP');

    const [a, b] = await Promise.all([
      createMaintenance({ startsAt: inHours(48), endsAt: inHours(50) }),
      createMaintenance({ startsAt: inHours(49), endsAt: inHours(51) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('시작 전 시간을 바꾸면 점검 공지 기간·문구도 맞춰진다', async () => {
    const m = (await createMaintenance()).body.data;
    const res = await request(t.app)
      .put(`/api/v1/maintenances/${m.id}`)
      .set(bearer(op))
      .send({
        ...maintenanceBody({ startsAt: inHours(30), endsAt: inHours(33) }),
        reason: '점검 시간 변경',
        version: m.version,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [n] = await t.ctx.db.db.select().from(notices).where(eq(notices.id, m.notice.id));
    expect(n!.endsAt!.toISOString()).toBe(res.body.data.endsAt);
    expect(n!.version).toBe(2);
  });

  it('시작 전 취소(L1) → 점검 공지도 내려간다', async () => {
    const m = (await createMaintenance()).body.data;
    const res = await request(t.app)
      .post(`/api/v1/maintenances/${m.id}/cancel`)
      .set(bearer(op))
      .send({ reason: '일정 연기로 취소', version: m.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('CANCELED');
    const [n] = await t.ctx.db.db.select().from(notices).where(eq(notices.id, m.notice.id));
    expect(n!.hiddenAt).not.toBeNull();
    expect((await liveOps()).body.data.tickers).toEqual([]);
  });

  it('고객지원은 점검을 만들 수 없다 (403)', async () => {
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    expect((await createMaintenance({}, cs)).status).toBe(403);
  });
});

describe('긴급 점검과 게임 차단', () => {
  it('L2 확인 화면에 최근 30분 접속자 수 → 확인 후 즉시 차단·세션 세대 증가', async () => {
    await createUser(t.ctx.db.db, { lastLoginAt: new Date(Date.now() - 5 * 60_000) });
    await createUser(t.ctx.db.db, { lastLoginAt: new Date(Date.now() - 10 * 60_000) });
    await createUser(t.ctx.db.db, { lastLoginAt: new Date(Date.now() - 3 * HOUR) });

    const { preview, view } = await startEmergency();
    expect(preview).toMatchObject({ action: 'START_NOW', recentPlayers: 2 });
    expect(view).toMatchObject({ status: 'ACTIVE', sessionEpoch: 1 });
    expect(view.startedAt).not.toBeNull();

    const live = await liveOps();
    expect(live.body.data.maintenance).toMatchObject({ active: true, title: '긴급 점검' });
    expect(live.body.data.sessionEpoch).toBe(1);

    const current = await request(t.app).get('/api/v1/maintenances/current').set(bearer(op));
    expect(current.body.data).toMatchObject({ active: true, maintenanceId: view.id });
  });

  it('점검 중: 플레이 API 는 503, 예외 회원은 통과, live-ops·공지·회원 샘플은 열림', async () => {
    const qa = await createUser(t.ctx.db.db);
    const player = await createUser(t.ctx.db.db);
    await startEmergency({ allowPublicIds: [qa.publicId] });

    const blocked = await score(player.publicId);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('MAINTENANCE');
    expect(blocked.body.error.details.endsAt).toBeTruthy();
    expect((await earn(player.publicId)).status).toBe(503);
    const claim = await request(t.app)
      .post('/api/v1/internal/game/mails/1/claim')
      .set(GAME)
      .send({ publicId: player.publicId });
    expect(claim.status).toBe(503);

    expect((await earn(qa.publicId)).status).toBe(200);
    expect((await score(qa.publicId)).status).toBe(200);

    // 이벤트 묶음: 전원 막히면 503, 예외 회원이 섞이면 그 회원만 받음
    const only = await request(t.app)
      .post('/api/v1/internal/game/events')
      .set(GAME)
      .send({ events: [{ publicId: player.publicId, type: 'LOGIN' }] });
    expect(only.status).toBe(503);
    const mixed = await request(t.app)
      .post('/api/v1/internal/game/events')
      .set(GAME)
      .send({
        events: [
          { publicId: player.publicId, type: 'LOGIN' },
          { publicId: qa.publicId, type: 'LOGIN' },
        ],
      });
    expect(mixed.status).toBe(200);
    expect(mixed.body.data).toEqual({
      accepted: 1,
      rejected: [{ publicId: player.publicId, reason: 'MAINTENANCE' }],
    });

    expect((await liveOps()).status).toBe(200);
    expect((await request(t.app).get('/api/v1/internal/game/notices').set(GAME)).status).toBe(200);
    expect(
      (await request(t.app).get('/api/v1/internal/game/users/sample?size=5').set(GAME)).status,
    ).toBe(200);
  });

  it('진행 중 예외 회원 추가는 L1 로 바로 반영', async () => {
    const qa = await createUser(t.ctx.db.db);
    const { view } = await startEmergency();
    expect((await earn(qa.publicId)).status).toBe(503);
    const res = await request(t.app)
      .put(`/api/v1/maintenances/${view.id}`)
      .set(bearer(op))
      .send({
        title: view.title,
        message: view.message,
        startsAt: view.startsAt,
        endsAt: view.endsAt,
        allowPublicIds: [qa.publicId],
        reason: 'QA 계정 접속 허용',
        version: view.version,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await earn(qa.publicId)).status).toBe(200);
  });

  it('진행 중 연장은 L2, 점검 공지 종료도 같이 늘어남. 시작 시각은 못 바꿈', async () => {
    const { view } = await startEmergency();
    const base = {
      title: view.title,
      message: view.message,
      startsAt: view.startsAt,
      allowPublicIds: [],
      reason: '작업 지연으로 연장',
      version: view.version,
    };
    const moved = await request(t.app)
      .put(`/api/v1/maintenances/${view.id}`)
      .set(bearer(op))
      .send({ ...base, startsAt: inHours(-1), endsAt: inHours(3) });
    expect(moved.status).toBe(422);
    expect(moved.body.error.code).toBe('MAINTENANCE_NOT_EDITABLE');

    const { preview, res } = await confirmed(
      `/api/v1/maintenances/${view.id}`,
      { ...base, endsAt: inHours(3) },
      'put',
    );
    expect(preview.action).toBe('EXTEND');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [n] = await t.ctx.db.db.select().from(notices).where(eq(notices.id, view.notice.id));
    expect(n!.endsAt!.toISOString()).toBe(res.body.data.endsAt);
  });

  it('진행 중 점검은 취소 불가, 지금 열기(L2) 후 바로 접속 가능', async () => {
    const player = await createUser(t.ctx.db.db);
    const { view } = await startEmergency();

    const cancel = await request(t.app)
      .post(`/api/v1/maintenances/${view.id}/cancel`)
      .set(bearer(op))
      .send({ reason: '진행 중 취소 시도', version: view.version });
    expect(cancel.status).toBe(422);

    const { preview, res } = await confirmed(`/api/v1/maintenances/${view.id}/open-now`, {
      reason: '작업 조기 완료',
      version: view.version,
    });
    expect(preview.action).toBe('OPEN_NOW');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('ENDED');

    expect((await earn(player.publicId)).status).toBe(200);
    const live = await liveOps();
    expect(live.body.data.maintenance.active).toBe(false);
    expect(live.body.data.sessionEpoch).toBe(1); // 세대는 그대로 (다시 끊지 않음)
    expect(live.body.data.tickers).toEqual([]);
  });

  it('Redis 가 죽어도 DB 로 판단해 차단한다', async () => {
    const player = await createUser(t.ctx.db.db);
    await startEmergency();
    const spy = vi.spyOn(t.ctx.redis.redis, 'get').mockRejectedValue(new Error('redis down'));
    try {
      expect((await score(player.publicId)).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('예약 점검 자동 시작', () => {
  it('워커 두 개가 동시에 돌아도 한 번만 시작 (세대 +1, 감사 로그 1건)', async () => {
    const id = await insertDueMaintenance();
    const [a, b] = await Promise.all([
      t.services.maintenanceService.runLifecycle(),
      t.services.maintenanceService.runLifecycle(),
    ]);
    expect([...a.started, ...b.started]).toEqual([id]);
    const [row] = await t.ctx.db.db.select().from(maintenances).where(eq(maintenances.id, id));
    expect(row!.sessionEpoch).toBe(1);
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'MAINTENANCE_START'), eq(auditLogs.targetId, String(id))));
    expect(logs).toHaveLength(1);
  });

  it('워커보다 게임 요청이 먼저 와도 그 자리에서 시작 처리 (세션 종료 신호가 늦지 않음)', async () => {
    await insertDueMaintenance();
    const live = await liveOps();
    expect(live.body.data.maintenance.active).toBe(true);
    expect(live.body.data.sessionEpoch).toBe(1);
  });
});

describe('공지', () => {
  const noticeBody = (over: Record<string, unknown> = {}) => ({
    category: 'NOTICE',
    title: '신규 서버 오픈 안내',
    body: '새 서버가 열렸습니다.',
    startsAt: inHours(-1),
    endsAt: inHours(24),
    pinned: false,
    tickerEnabled: false,
    tickerText: null,
    reason: '공지 등록 테스트',
    ...over,
  });
  const createNotice = (over: Record<string, unknown> = {}, token = op) =>
    request(t.app).post('/api/v1/notices').set(bearer(token)).set(idem()).send(noticeBody(over));
  const published = async () =>
    (await request(t.app).get('/api/v1/internal/game/notices').set(GAME)).body.data as {
      title: string;
    }[];

  it('게시 기간 안의 공지만 게임에 나가고, 고정 → 최신 순', async () => {
    await createNotice({ title: '오래된 공지', startsAt: inHours(-5) });
    await createNotice({ title: '고정 공지', startsAt: inHours(-10), pinned: true });
    await createNotice({ title: '새 공지', startsAt: inHours(-1) });
    await createNotice({ title: '예약 공지', startsAt: inHours(5) });
    await createNotice({ title: '끝난 공지', startsAt: inHours(-5), endsAt: inHours(-1) });
    await createNotice({ title: '계속 공지', startsAt: inHours(-2), endsAt: null });
    expect((await published()).map((n) => n.title)).toEqual([
      '고정 공지',
      '새 공지',
      '계속 공지',
      '오래된 공지',
    ]);
  });

  it('본문의 HTML 은 지우거나 바꾸지 않고 평문 그대로 저장', async () => {
    const html = '<script>alert(1)</script>\r\n<b>굵게</b>';
    const res = await createNotice({ body: html });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.body).toBe('<script>alert(1)</script>\n<b>굵게</b>');
  });

  it('티커: 켜면 문구 필수, live-ops 에 최대 5개', async () => {
    const missing = await createNotice({ tickerEnabled: true, tickerText: null });
    expect(missing.status).toBe(400);
    for (let i = 0; i < 6; i++) {
      expect((await createNotice({ tickerEnabled: true, tickerText: `한 줄 ${i}` })).status).toBe(
        201,
      );
    }
    expect((await liveOps()).body.data.tickers).toHaveLength(5);
  });

  it('수정은 version 으로 보호, 내리면 게임에서 사라진다', async () => {
    const n = (await createNotice()).body.data;
    const upd = await request(t.app)
      .put(`/api/v1/notices/${n.id}`)
      .set(bearer(op))
      .send({ ...noticeBody({ title: '바뀐 제목' }), version: n.version });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    const stale = await request(t.app)
      .put(`/api/v1/notices/${n.id}`)
      .set(bearer(op))
      .send({ ...noticeBody({ title: '늦은 수정' }), version: n.version });
    expect(stale.status).toBe(409);

    const hide = await request(t.app)
      .post(`/api/v1/notices/${n.id}/hide`)
      .set(bearer(op))
      .send({ reason: '잘못 올린 공지', version: upd.body.data.version });
    expect(hide.status).toBe(200);
    expect(hide.body.data.status).toBe('HIDDEN');
    expect(await published()).toEqual([]);
  });

  it('고객지원은 공지를 쓸 수 있고, 조회 전용은 못 쓴다', async () => {
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    expect((await createNotice({}, cs)).status).toBe(201);
    expect((await createNotice({}, viewer)).status).toBe(403);
    const list = await request(t.app).get('/api/v1/notices').set(bearer(viewer));
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
  });
});
