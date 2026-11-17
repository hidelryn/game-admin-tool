import { describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';

const logger = pino({ level: 'silent' });

function appWith(db: boolean, redis: boolean) {
  return createApp({
    logger,
    corsOrigins: [],
    health: { pingDb: async () => db, pingRedis: async () => redis },
  });
}

describe('health', () => {
  it('GET /api/v1/health/live → 200', async () => {
    const res = await request(appWith(false, false)).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('의존성이 모두 정상이면 ready 200', async () => {
    const res = await request(appWith(true, true)).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ mysql: 'up', redis: 'up' });
  });

  it('Redis 가 내려가면 ready 503 + degraded', async () => {
    const res = await request(appWith(true, false)).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe('degraded');
  });
});

describe('error handling', () => {
  it('없는 경로는 공통 에러 형식 404', async () => {
    const res = await request(appWith(true, true)).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('잘못된 JSON 은 400 VALIDATION_FAILED', async () => {
    const res = await request(appWith(true, true))
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('외부 X-Request-Id 는 형식이 맞을 때만 사용한다', async () => {
    const ok = await request(appWith(true, true))
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'abc-12345678');
    expect(ok.headers['x-request-id']).toBe('abc-12345678');
    const bad = await request(appWith(true, true))
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'bad id; injected=1');
    expect(bad.headers['x-request-id']).not.toContain('injected');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
