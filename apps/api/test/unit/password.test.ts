import { describe, expect, it } from 'vitest';
import { passwordPolicySchema } from '@game-admin/shared';
import {
  createPasswordHasher,
  generateTemporaryPassword,
} from '../../src/modules/auth/password.js';

const hasher = createPasswordHasher({ memoryCost: 4096, timeCost: 2 });

describe('password hasher (argon2id)', () => {
  it('해시 후 검증', async () => {
    const hash = await hasher.hash('Correct-horse-1');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await hasher.verify(hash, 'Correct-horse-1')).toBe(true);
    expect(await hasher.verify(hash, 'wrong-password-1')).toBe(false);
  });

  it('깨진 해시는 예외 없이 false', async () => {
    expect(await hasher.verify('not-a-hash', 'x')).toBe(false);
  });

  it('파라미터가 바뀌면 재해시 필요', async () => {
    const hash = await hasher.hash('Correct-horse-1');
    const stronger = createPasswordHasher({ memoryCost: 8192, timeCost: 3 });
    expect(hasher.needsRehash(hash)).toBe(false);
    expect(stronger.needsRehash(hash)).toBe(true);
  });

  it('임시 비밀번호는 항상 정책을 만족한다', () => {
    for (let i = 0; i < 100; i++) {
      expect(passwordPolicySchema.safeParse(generateTemporaryPassword()).success).toBe(true);
    }
  });
});
