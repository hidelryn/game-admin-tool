import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 업로드 파일 저장소 — 로컬 폴더로 시작해 배포 때 S3 로 바꿀 수 있게 인터페이스로 분리 (docs/schedule.md 6장)
 * 키는 서버가 만든 "UUID.확장자" 만 받는다 → 경로 조작(../) 불가
 */
export interface AssetStorage {
  put(key: string, data: Buffer): Promise<void>;
  /** 없으면 null */
  get(key: string): Promise<Buffer | null>;
  /** 전부 지우기 (체험 서버 매일 초기화용). 지운 파일 수 */
  clear(): Promise<number>;
}

export const ASSET_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

function assertKey(key: string) {
  if (!ASSET_KEY_PATTERN.test(key)) throw new Error(`invalid asset key: ${key}`);
}

export function createLocalAssetStorage(dir: string): AssetStorage {
  const root = path.resolve(dir);
  return {
    async put(key, data) {
      assertKey(key);
      await mkdir(root, { recursive: true });
      // wx: 같은 이름이 있으면 실패 (덮어쓰기 금지)
      await writeFile(path.join(root, key), data, { flag: 'wx' });
    },
    async get(key) {
      assertKey(key);
      try {
        return await readFile(path.join(root, key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async clear() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      // 업로드 형식의 파일만 지운다 (같은 폴더의 다른 파일은 건드리지 않음)
      const targets = names.filter((n) => ASSET_KEY_PATTERN.test(n));
      await Promise.all(targets.map((n) => rm(path.join(root, n), { force: true })));
      return targets.length;
    },
  };
}

/** 테스트용 메모리 저장소 */
export function createMemoryAssetStorage(): AssetStorage & { size(): number } {
  const files = new Map<string, Buffer>();
  return {
    async put(key, data) {
      assertKey(key);
      files.set(key, Buffer.from(data));
    },
    async get(key) {
      assertKey(key);
      return files.get(key) ?? null;
    },
    async clear() {
      const n = files.size;
      files.clear();
      return n;
    },
    size: () => files.size,
  };
}
