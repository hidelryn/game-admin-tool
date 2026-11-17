import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { readRefreshCookie } from '../../src/modules/auth/cookies.js';

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as Request;
const token = 'a'.repeat(43);

describe('readRefreshCookie', () => {
  it('여러 쿠키 중 ga_rt 만 읽는다', () => {
    expect(readRefreshCookie(req(`foo=bar; ga_rt=${token}; x=y`))).toBe(token);
  });
  it('없거나 형식이 이상하면 null', () => {
    expect(readRefreshCookie(req())).toBeNull();
    expect(readRefreshCookie(req('ga_rt=<script>'))).toBeNull();
  });
});
