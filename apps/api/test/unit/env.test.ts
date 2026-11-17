import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  MYSQL_HOST: 'localhost',
  MYSQL_DATABASE: 'db',
  MYSQL_USER: 'u',
  MYSQL_PASSWORD: 'p',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('필수값이 있으면 기본값을 채워 반환한다', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: 'http://a.com, http://b.com' });
    expect(env.API_PORT).toBe(4000);
    expect(env.MYSQL_PORT).toBe(3306);
    expect(env.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it('production 에서는 기본으로 Secure 쿠키', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });

  it('짧은 JWT 비밀키는 거부한다', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow();
    spy.mockRestore();
  });

  it('필수값이 없으면 기동을 실패시킨다', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadEnv({ ...base, MYSQL_PASSWORD: undefined })).toThrow(
      'Invalid environment variables',
    );
    spy.mockRestore();
  });
});
