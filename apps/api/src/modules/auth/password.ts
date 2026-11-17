import argon2 from 'argon2';

/**
 * 비밀번호 해시: argon2id (architecture.md 2.1)
 * 해시 문자열에 파라미터가 들어 있어 파라미터를 바꿔도 기존 해시 검증이 가능하다.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** 존재하지 않는 계정 로그인 시에도 같은 시간을 소모해 계정 존재 여부 노출을 막는다 */
  burn(plain: string): Promise<void>;
}

export function createPasswordHasher(opts: {
  memoryCost: number;
  timeCost: number;
}): PasswordHasher {
  const options = {
    type: argon2.argon2id,
    memoryCost: opts.memoryCost,
    timeCost: opts.timeCost,
    parallelism: 1,
  };
  let dummyHash: Promise<string> | null = null;

  return {
    hash: (plain) => argon2.hash(plain, options),
    async verify(hash, plain) {
      try {
        return await argon2.verify(hash, plain);
      } catch {
        // 형식이 깨진 해시 → 검증 실패로 처리 (예외를 숨기는 게 아니라 '불일치'가 정확한 의미)
        return false;
      }
    },
    needsRehash: (hash) => argon2.needsRehash(hash, options),
    async burn(plain) {
      dummyHash ??= argon2.hash('timing-equalizer-not-a-real-password', options);
      await argon2.verify(await dummyHash, plain).catch(() => false);
    },
  };
}

/** 임시 비밀번호: 정책(영문·숫자 포함, 10자 이상)을 항상 만족 */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${body}A7`;
}
