import { defineConfig } from 'vitest/config';

/** MCP 서버 테스트: API 는 가짜(메모리)로 대체 — DB·Redis 없이 실행 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/http.ts', 'src/stdio.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
});
