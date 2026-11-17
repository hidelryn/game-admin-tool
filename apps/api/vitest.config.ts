import { defineConfig } from 'vitest/config';

/** 단위 테스트: 외부 의존성 없이 빠르게 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
