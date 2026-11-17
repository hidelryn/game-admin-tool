import { defineConfig } from 'vitest/config';

/**
 * 통합 테스트: Testcontainers 로 실제 MySQL·Redis 를 띄워 실행 (Docker 필요)
 * 하나의 DB 를 공유하므로 파일 단위 병렬 실행을 끈다.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
