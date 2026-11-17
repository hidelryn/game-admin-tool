import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hashPayload, stableStringify } from '../../src/common/http/stable-hash.js';
import { decodeCursor, encodeCursor, pageOf } from '../../src/common/http/cursor.js';
import { maskEmail } from '../../src/common/http/mask.js';
import { needsConfirmation } from '../../src/modules/currencies/currency.service.js';

describe('stableStringify / hashPayload', () => {
  it('키 순서가 달라도 같은 해시', () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      hashPayload({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
  });
  it('값이 다르면 다른 해시, undefined 필드는 무시', () => {
    expect(hashPayload({ amount: 100 })).not.toBe(hashPayload({ amount: 101 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('cursor', () => {
  const schema = z.object({ id: z.number() });
  it('왕복', () => {
    expect(decodeCursor(encodeCursor({ id: 42 }), schema)).toEqual({ id: 42 });
  });
  it('위조된 커서는 400 INVALID_CURSOR', () => {
    let error: unknown;
    try {
      decodeCursor('not-base64-json', schema);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });
  it('size+1 로 다음 페이지 판단', () => {
    const { items, nextCursor } = pageOf([{ id: 3 }, { id: 2 }, { id: 1 }], 2, (r) => ({
      id: r.id,
    }));
    expect(items).toHaveLength(2);
    expect(decodeCursor(nextCursor!, schema)).toEqual({ id: 2 });
    expect(pageOf([{ id: 1 }], 2, (r) => r).nextCursor).toBeNull();
  });
});

describe('maskEmail', () => {
  it.each([
    ['player123@example.com', 'pl*******@example.com'],
    ['ab@example.com', 'a***@example.com'],
    ['a@example.com', 'a***@example.com'],
    ['broken', '***'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});

describe('needsConfirmation (위험도 판정)', () => {
  const gold = { grantLimitPerRequest: 1_000_000, isPaid: false };
  const gem = { grantLimitPerRequest: 10_000, isPaid: true };
  it('회수는 항상 확인', () => expect(needsConfirmation('DEDUCT', 1, gold, 'WEB')).toBe(true));
  it('상한 이하 지급은 바로 실행', () =>
    expect(needsConfirmation('GRANT', 1_000_000, gold, 'WEB')).toBe(false));
  it('상한 초과 지급은 확인', () =>
    expect(needsConfirmation('GRANT', 1_000_001, gold, 'WEB')).toBe(true));
  it('MCP 의 유료 재화 지급은 확인', () => {
    expect(needsConfirmation('GRANT', 1, gem, 'MCP')).toBe(true);
    expect(needsConfirmation('GRANT', 1, gem, 'WEB')).toBe(false);
  });
});
