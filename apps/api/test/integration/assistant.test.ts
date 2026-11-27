import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { desc, eq } from 'drizzle-orm';
import type { AssistantEvent } from '@game-admin/shared';
import { auditLogs } from '../../src/infra/db/schema/index.js';
import type { createScriptedLlm, LlmContent, LlmResponse } from '../../src/infra/llm/llm-client.js';
import {
  ADMIN,
  bearer,
  createTestContext,
  createUser,
  login,
  type TestContext,
} from './helpers.js';

/** AI 어시스턴트 (docs/ai-assistant.md) — LLM 은 정해진 응답을 돌려주는 가짜 */

let t: TestContext;
const llm = () => t.ctx.llm as ReturnType<typeof createScriptedLlm>;

beforeAll(async () => {
  t = await createTestContext({ ASSISTANT_PER_ADMIN_HOUR: '3' });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  llm().queue.length = 0;
  llm().requests.length = 0;
});

const toolUse = (id: string, name: string, input: unknown): LlmResponse => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20 },
});
const final = (text: string): LlmResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 200, outputTokens: 50 },
});

/** NDJSON 응답을 이벤트 배열로 */
async function chat(token: string, question: string) {
  const res = await request(t.app)
    .post('/api/v1/assistant/chat')
    .set(bearer(token))
    .send({ messages: [{ role: 'user', content: question }] })
    .buffer(true)
    .parse((r, cb) => {
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (d += c));
      r.on('end', () => cb(null, d));
    });
  const events =
    res.status === 200
      ? (res.body as string)
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as AssistantEvent)
      : [];
  return { res, events };
}

/** n 번째 LLM 요청에 담겨 간 도구 결과 */
const toolResultsOf = (n: number) =>
  (llm().requests[n]!.messages.at(-1)!.content as LlmContent[]).filter(
    (c): c is Extract<LlmContent, { type: 'tool_result' }> => c.type === 'tool_result',
  );

describe('질문 → 도구 조회 → 요약·차트', () => {
  it('도구를 골라 조회하고, 조회 값으로 그린 차트와 요약을 돌려준다', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const trend = await t.services.dashboardService.trends({ metric: 'dau' });
    llm().queue.push(
      toolUse('t1', 'get_kpi_trend', { metric: 'dau' }),
      toolUse('t2', 'render_chart', {
        type: 'line',
        title: 'DAU 추이',
        xKey: 'date',
        series: [{ key: 'value', label: 'DAU' }],
        data: trend.slice(-7),
        unit: '명',
      }),
      final('최근 7일 DAU 는 안정적입니다.'),
    );

    const { res, events } = await chat(op, '최근 일주일 DAU 어때?');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(events.map((e) => e.type)).toEqual(['tool', 'tool_done', 'answer', 'done']);
    const answer = events.find((e) => e.type === 'answer') as Extract<
      AssistantEvent,
      { type: 'answer' }
    >;
    expect(answer.text).toBe('최근 7일 DAU 는 안정적입니다.');
    expect(answer.charts).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 400, outputTokens: 90 },
    });

    // 도구 결과가 AI 에게 넘어갔고, 운영자 권한에 맞는 도구 목록이 갔다
    expect(toolResultsOf(1)[0]!.is_error).toBeFalsy();
    const sent = llm().requests[0]!.tools.map((x) => x.name);
    expect(sent).toContain('analyze_churn');
    expect(sent).toContain('render_chart');

    // 감사 로그: 질문·사용 도구만
    const [log] = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ASSISTANT_QUERY'))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(log!.result).toBe('SUCCESS');
    expect(log!.afterData).toMatchObject({
      question: '최근 일주일 DAU 어때?',
      tools: ['get_kpi_trend'],
      charts: 1,
    });
  });

  it('조회 결과에 없는 숫자로 그린 차트는 거부하고 AI 에게 알린다', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    llm().queue.push(
      toolUse('t1', 'get_dashboard_summary', {}),
      toolUse('t2', 'render_chart', {
        type: 'bar',
        title: '지어낸 값',
        xKey: 'name',
        series: [{ key: 'v', label: '값' }],
        data: [{ name: 'A', v: 98765.4 }],
      }),
      final('차트 없이 요약만 드립니다.'),
    );
    const { events } = await chat(op, '오늘 요약');
    const answer = events.find((e) => e.type === 'answer') as Extract<
      AssistantEvent,
      { type: 'answer' }
    >;
    expect(answer.charts).toHaveLength(0);
    const [r] = toolResultsOf(2);
    expect(r!.is_error).toBe(true);
    expect(r!.content).toContain('98765.4');
  });

  it('회원 정보에서 이메일은 AI 에게 넘기지 않는다', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const u = await createUser(t.ctx.db.db, { email: 'secret-person@example.net' });
    llm().queue.push(toolUse('t1', 'get_user', { publicId: u.publicId }), final('조회했습니다.'));
    await chat(op, `${u.publicId} 회원 상태`);
    const [r] = toolResultsOf(1);
    expect(r!.content).toContain(u.publicId);
    expect(r!.content).not.toContain('secret-person');
    expect(r!.content).not.toContain('"email"');
  });
});

describe('권한', () => {
  it('권한 없는 도구는 목록에도 없고, AI 가 이름을 지어내 불러도 막힌다', async () => {
    // CS 는 유저 분석(analytics:read) 권한이 없다
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    llm().queue.push(toolUse('t1', 'analyze_churn', {}), final('권한이 없어 볼 수 없습니다.'));
    const { events } = await chat(cs, '이탈 구간 알려줘');
    expect(llm().requests[0]!.tools.map((x) => x.name)).not.toContain('analyze_churn');
    expect(events.some((e) => e.type === 'tool')).toBe(false);
    const [r] = toolResultsOf(1);
    expect(r!.is_error).toBe(true);
  });

  it('API 토큰(MCP)으로는 쓸 수 없다', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const tok = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp', permissions: ['dashboard:read'], expiresInDays: 1 });
    const res = await request(t.app)
      .post('/api/v1/assistant/chat')
      .set(bearer(tok.body.data.token))
      .send({ messages: [{ role: 'user', content: '안녕' }] });
    expect(res.status).toBe(403);
    // 토큰에는 assistant:use 를 줄 수도 없다
    const bad = await request(t.app)
      .post('/api/v1/me/api-tokens')
      .set(bearer(op))
      .send({ name: 'mcp2', permissions: ['assistant:use'], expiresInDays: 1 });
    expect(bad.status).toBe(422);
  });

  it('상태: 권한에 따라 쓸 수 있는 도구가 다르다', async () => {
    const viewer = (await login(t.app, ADMIN.viewer)).accessToken;
    const cs = (await login(t.app, ADMIN.cs)).accessToken;
    const v = await request(t.app).get('/api/v1/assistant/status').set(bearer(viewer));
    const c = await request(t.app).get('/api/v1/assistant/status').set(bearer(cs));
    expect(v.body.data.configured).toBe(true);
    const names = (r: typeof v) => (r.body.data.tools as { name: string }[]).map((x) => x.name);
    expect(names(v)).toContain('analyze_purchases');
    expect(names(c)).not.toContain('analyze_purchases');
    expect(names(c)).toContain('search_users');
  });
});

describe('실패·한도', () => {
  it('LLM 호출이 실패하면 error 이벤트, 감사 로그는 FAILURE', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const { events } = await chat(op, '아무거나'); // 응답 대본이 비어 있어 호출 실패
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    const [log] = await t.ctx.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ASSISTANT_QUERY'))
      .limit(1);
    expect(log!.result).toBe('FAILURE');
  });

  it('운영자 시간당 질문 수 제한', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    for (let i = 0; i < 3; i++) {
      llm().queue.push(final('답'));
      expect((await chat(op, `질문 ${i}`)).res.status).toBe(200);
    }
    const over = await chat(op, '한 번 더');
    expect(over.res.status).toBe(429);
  });

  it('질문 형식 검증 (마지막은 질문, 길이 제한)', async () => {
    const op = (await login(t.app, ADMIN.operator)).accessToken;
    const res = await request(t.app)
      .post('/api/v1/assistant/chat')
      .set(bearer(op))
      .send({ messages: [{ role: 'assistant', content: '답' }] });
    expect(res.status).toBe(400);
    const long = await request(t.app)
      .post('/api/v1/assistant/chat')
      .set(bearer(op))
      .send({ messages: [{ role: 'user', content: 'x'.repeat(1001) }] });
    expect(long.status).toBe(400);
  });
});
