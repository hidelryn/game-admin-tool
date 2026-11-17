import { defineConfig } from 'vitest/config';

/**
 * 커버리지: 단위 + 통합 테스트를 한 번에 (Docker 필요)
 * npm run coverage -w @game-admin/api → apps/api/coverage/index.html
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 진입점·스크립트는 프로세스로 실행되는 코드라 테스트 대상에서 제외
      exclude: ['src/server.ts', 'src/worker.ts', 'src/scripts/**', 'src/infra/db/migrate.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
});
