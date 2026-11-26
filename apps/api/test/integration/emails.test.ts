import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, emailDeliveries, users } from '../../src/infra/db/schema/index.js';
import type { createFakeMailer } from '../../src/infra/mail/mailer.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import { ensureDemoAccount } from '../../src/modules/demo/demo.service.js';
import { statDateOf } from '../../src/common/time.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  idem,
  login,
  type TestContext,
} from './helpers.js';

/** 이메일 발송 (docs/email.md) */
const ALLOWED = 'qa-inbox@example.org';
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demoVisitor2026';

let t: TestContext;
let op: string;
const mailer = () => t.ctx.mailer as ReturnType<typeof createFakeMailer>;

beforeAll(async () => {
  t = await createTestContext({
    EMAIL_REAL_ALLOWLIST: ALLOWED,
    DEMO_MODE: 'true',
    DEMO_ACCOUNT_PASSWORD: DEMO_PASSWORD,
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  mailer().sent.length = 0;
  op = (await login(t.app, ADMIN.operator)).accessToken;
});

const send = (token: string, body: object, key?: ReturnType<typeof crypto.randomUUID>) =>
  request(t.app).post('/api/v1/emails').set(bearer(token)).set(idem(key)).send(body);
const reason = '이메일 발송 테스트';

describe('주소 직접 입력 (1건, 바로 발송)', () => {
  it('운영자: 실제 발송되고 결과가 바로 나온다, 감사 로그에는 주소를 가려서', async () => {
    const res = await send(op, {
      target: { type: 'ADDRESS', address: 'Visitor@Example.net' },
      subject: '안녕하세요',
      body: '테스트 메일입니다.',
      reason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'DONE', counts: { total: 1, sent: 1 } });
    expect(mailer().sent).toHaveLength(1);
    expect(mailer().sent[0]).toMatchObject({ to: 'visitor@example.net', subject: '안녕하세요' });
    expect(mailer().sent[0]!.text).toContain('Game Admin');
    const [log] = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'EMAIL_SEND'));
    expect(JSON.stringify(log!.afterData)).not.toContain('visitor@example.net');
  });

  it('SMTP 실패는 FAILED 로 기록', async () => {
    const res = await send(op, {
      target: { type: 'ADDRESS', address: 'fail@example.net' },
      subject: '실패',
      body: '본문',
      reason,
    });
    expect(res.body.data.counts).toMatchObject({ total: 1, failed: 1, sent: 0 });
  });

  it('하루 실제 발송 한도를 넘으면 보내지 않는다', async () => {
    const day = statDateOf(new Date(), t.ctx.env.STAT_TZ_OFFSET_MINUTES);
    await t.ctx.redis.redis.set(`email:real:${day}`, String(t.ctx.env.EMAIL_DAILY_REAL_LIMIT));
    const res = await send(op, {
      target: { type: 'ADDRESS', address: 'someone@example.net' },
      subject: '한도',
      body: '본문',
      reason,
    });
    expect(res.body.data.counts).toMatchObject({ failed: 1 });
    expect(mailer().sent).toHaveLength(0);
  });

  it('광고성·예약은 안 된다', async () => {
    const ad = await send(op, {
      target: { type: 'ADDRESS', address: 'a@example.net' },
      subject: '세일',
      body: '본문',
      isAd: true,
      reason,
    });
    expect(ad.status).toBe(400);
    const later = await send(op, {
      target: { type: 'ADDRESS', address: 'a@example.net' },
      subject: '나중에',
      body: '본문',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason,
    });
    expect(later.status).toBe(400);
  });

  it('MCP(API 토큰)로는 주소 직접 입력 발송 불가 — AI 가 외부로 내보내는 통로 차단', async () => {
    const tok = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp-test', permissions: ['email:send'], expiresInDays: 1 });
    expect(tok.status).toBe(201);
    const res = await send(tok.body.data.token, {
      target: { type: 'ADDRESS', address: 'leak@example.net' },
      subject: '유출',
      body: '본문',
      reason,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHANNEL_NOT_ALLOWED');
    expect(mailer().sent).toHaveLength(0);
  });

  it('같은 Idempotency-Key 재전송은 한 번만 보낸다', async () => {
    const body = {
      target: { type: 'ADDRESS', address: 'once@example.net' },
      subject: '한 번',
      body: '본문',
      reason,
    };
    const a = await send(op, body, '0b5a2a4c-7d1e-4c5a-9a7e-3f1d2c4b5a61');
    const b = await send(op, body, '0b5a2a4c-7d1e-4c5a-9a7e-3f1d2c4b5a61');
    expect(a.status).toBe(201);
    expect(b.body.data.campaignId).toBe(a.body.data.campaignId);
    expect(mailer().sent).toHaveLength(1);
  });
});

describe('디자인 틀', () => {
  it('평문이 틀(배너·제목·문단·버튼·안내)에 들어가고, 입력은 이스케이프', async () => {
    const res = await send(op, {
      target: { type: 'ADDRESS', address: 'design@example.net' },
      subject: '시즌 2 오픈 <b>',
      body: '첫 문단\n둘째 줄\n\n<script>alert(1)</script>',
      cta: { label: '지금 접속하기', url: 'https://example.com/play' },
      reason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const m = mailer().sent[0]!;
    expect(m.html).toContain('GAME ADMIN');
    expect(m.html).toContain('첫 문단<br>둘째 줄');
    expect(m.html).toContain('href="https://example.com/play"');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.text).toContain('지금 접속하기: https://example.com/play');
    const detail = await request(t.app)
      .get(`/api/v1/emails/${res.body.data.campaignId}`)
      .set(bearer(op));
    expect(detail.body.data.cta).toEqual({
      label: '지금 접속하기',
      url: 'https://example.com/play',
    });
  });

  it('버튼 링크는 https 만', async () => {
    const res = await send(op, {
      target: { type: 'ADDRESS', address: 'design@example.net' },
      subject: 's',
      body: 'b',
      cta: { label: '열기', url: 'javascript:alert(1)' },
      reason,
    });
    expect(res.status).toBe(400);
  });

  it('미리보기는 보낼 HTML 그대로, 아무것도 보내지 않음', async () => {
    const res = await request(t.app)
      .post('/api/v1/emails/render')
      .set(bearer(op))
      .send({ targetType: 'USERS', subject: '이벤트', body: '본문', isAd: true });
    expect(res.status).toBe(200);
    expect(res.body.data.subject).toBe('(광고) 이벤트');
    expect(res.body.data.html).toContain('광고</span>');
    expect(mailer().sent).toHaveLength(0);
  });
});

describe('회원 대상', () => {
  it('광고성: 동의 안 한 회원 제외, 가상 주소는 가상 발송, 허용 목록 주소만 실제 발송', async () => {
    const db = t.ctx.db.db;
    const optIn = await createUser(db, { adEmailOptIn: true, nightOptIn: true });
    const optOut = await createUser(db, { adEmailOptIn: false });
    const vip = await createUser(db, { email: ALLOWED, adEmailOptIn: true, nightOptIn: true });
    const res = await send(op, {
      target: { type: 'USERS', publicIds: [optIn.publicId, optOut.publicId, vip.publicId] },
      subject: '주말 이벤트',
      body: '보상 2배',
      isAd: true,
      reason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('SCHEDULED'); // 바로 발송도 처리는 비동기
    expect(await t.services.emailService.dispatchDue()).toEqual({ processed: 1 });

    const rows = await db
      .select({ userId: emailDeliveries.userId, status: emailDeliveries.status })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.campaignId, res.body.data.campaignId));
    const by = new Map(rows.map((r) => [r.userId, r.status]));
    expect(by.get(optIn.id)).toBe('VIRTUAL');
    expect(by.get(optOut.id)).toBe('SKIPPED_NO_CONSENT');
    expect(by.get(vip.id)).toBe('SENT');
    expect(mailer().sent).toHaveLength(1);
    expect(mailer().sent[0]!.subject).toBe('(광고) 주말 이벤트');
    expect(mailer().sent[0]!.text).toContain('수신 동의');

    const detail = await request(t.app)
      .get(`/api/v1/emails/${res.body.data.campaignId}`)
      .set(bearer(op));
    expect(detail.body.data).toMatchObject({
      status: 'DONE',
      counts: { total: 3, sent: 1, virtual: 1, skipped: 1, failed: 0 },
    });
    const list = await request(t.app)
      .get(`/api/v1/emails/${res.body.data.campaignId}/deliveries`)
      .set(bearer(op));
    expect(list.body.meta.total).toBe(3);
    expect(list.body.data.every((d: { address: string }) => d.address.includes('*'))).toBe(true);
  });

  it('미리보기: 야간 시각이면 야간 동의 없는 회원은 광고 제외', async () => {
    const db = t.ctx.db.db;
    await createUser(db, { adEmailOptIn: true, nightOptIn: false });
    await createUser(db, { adEmailOptIn: true, nightOptIn: true });
    const u = await db.select({ publicId: users.publicId }).from(users);
    // 내일 23:00 KST
    const kst = new Date(Date.now() + 86_400_000 + 9 * 3_600_000);
    const at = new Date(
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 23 - 9, 0),
    );
    const res = await request(t.app)
      .post('/api/v1/emails/preview')
      .set(bearer(op))
      .send({
        target: { type: 'USERS', publicIds: u.map((x) => x.publicId) },
        isAd: true,
        scheduledAt: at.toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 2, night: true, skippedNight: 1, bulk: false });
  });

  it('없는 회원 ID 는 거부', async () => {
    const res = await send(op, {
      target: { type: 'USERS', publicIds: ['NOPE_1'] },
      subject: 's',
      body: 'b',
      reason,
    });
    expect(res.status).toBe(404);
  });

  it('전체 발송은 L3: 빨간 경고 확인 후 실행, MCP 는 미리보기만', async () => {
    const db = t.ctx.db.db;
    await createUser(db);
    await createUser(db);
    const body = { target: { type: 'ALL' }, subject: '공지', body: '점검 안내', reason };
    const first = await send(op, body);
    expect(first.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(first.body.error.details.preview.action).toBe('EMAIL_SEND_BULK');
    const ok = await send(op, {
      ...body,
      confirmationToken: first.body.error.details.confirmationToken,
    });
    expect(ok.status).toBe(201);
    await t.services.emailService.dispatchDue();
    const detail = await request(t.app)
      .get(`/api/v1/emails/${ok.body.data.campaignId}`)
      .set(bearer(op));
    expect(detail.body.data.counts.total).toBe(2);

    const tok = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp-all', permissions: ['email:send', 'email:send_all'], expiresInDays: 1 });
    const mcp = await send(tok.body.data.token, body);
    expect(mcp.status).toBe(403);
    expect(mcp.body.error.details.preview.action).toBe('EMAIL_SEND_BULK');
  });

  it('예약 발송은 시각 전까지 취소할 수 있고, 취소하면 보내지 않는다', async () => {
    const u = await createUser(t.ctx.db.db);
    const res = await send(op, {
      target: { type: 'USERS', publicIds: [u.publicId] },
      subject: '예약',
      body: '본문',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason,
    });
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(await t.services.emailService.dispatchDue()).toEqual({ processed: 0 });
    const id = res.body.data.campaignId;
    const cancel = await request(t.app)
      .post(`/api/v1/emails/${id}/cancel`)
      .set(bearer(op))
      .send({ reason: '내용 수정 필요' });
    expect(cancel.body.data.status).toBe('CANCELED');
    const again = await request(t.app)
      .post(`/api/v1/emails/${id}/cancel`)
      .set(bearer(op))
      .send({ reason: '내용 수정 필요' });
    expect(again.status).toBe(409);
    const logs = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'EMAIL_CANCEL'), eq(auditLogs.targetId, String(id))));
    expect(logs).toHaveLength(1);
  });
});

describe('체험 계정', () => {
  const hasher = createPasswordHasher({ memoryCost: 4096, timeCost: 2 });
  let demo: string;
  beforeEach(async () => {
    await ensureDemoAccount({ db: t.ctx.db.db, env: t.ctx.env, hasher });
    demo = (await login(t.app, DEMO_EMAIL, DEMO_PASSWORD)).accessToken;
  });

  it('주소 직접 입력은 실제 발송 (제목에 체험 표시), 같은 주소는 하루 1번', async () => {
    const body = {
      target: { type: 'ADDRESS', address: 'recruiter@example.net' },
      subject: '포트폴리오 체험',
      body: '안녕하세요, 체험 메일입니다.',
      reason,
    };
    const a = await send(demo, body);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data.counts.sent).toBe(1);
    expect(mailer().sent[0]!.subject).toBe('[Game Admin 체험] 포트폴리오 체험');
    expect(mailer().sent[0]!.text).toContain('체험 기능');
    const b = await send(demo, body);
    expect(b.status).toBe(429);
  });

  it('버튼(링크)도 넣을 수 없다', async () => {
    const res = await send(demo, {
      target: { type: 'ADDRESS', address: 'y@example.net' },
      subject: '이벤트',
      body: '본문',
      cta: { label: '열기', url: 'https://example.com' },
      reason,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMAIL_CONTENT_NOT_ALLOWED');
  });

  it('링크가 든 메일은 거부', async () => {
    const res = await send(demo, {
      target: { type: 'ADDRESS', address: 'x@example.net' },
      subject: '이벤트',
      body: '여기로 오세요 https://evil.example',
      reason,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMAIL_CONTENT_NOT_ALLOWED');
    expect(mailer().sent).toHaveLength(0);
  });

  it('회원 대상 발송은 허용 목록 주소여도 가상 발송', async () => {
    const vip = await createUser(t.ctx.db.db, { email: ALLOWED });
    const res = await send(demo, {
      target: { type: 'USERS', publicIds: [vip.publicId] },
      subject: '안내',
      body: '본문',
      reason,
    });
    expect(res.status).toBe(201);
    await t.services.emailService.dispatchDue();
    const [row] = await t.ctx.db.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.campaignId, res.body.data.campaignId));
    expect(row!.status).toBe('VIRTUAL');
    expect(mailer().sent).toHaveLength(0);
  });

  it('IP 당 시간당 횟수 제한', async () => {
    for (let i = 0; i < t.ctx.env.DEMO_EMAIL_PER_IP_HOUR; i++) {
      const r = await send(demo, {
        target: { type: 'ADDRESS', address: `v${i}@example.net` },
        subject: '체험',
        body: '본문',
        reason,
      });
      expect(r.status).toBe(201);
    }
    const over = await send(demo, {
      target: { type: 'ADDRESS', address: 'over@example.net' },
      subject: '체험',
      body: '본문',
      reason,
    });
    expect(over.status).toBe(429);
  });
});
