import { defineConfig } from 'vitest/config';

/** 웹 단위 테스트: 화면 없이 순수 함수만 (파일 파서·검증, 경로 검사) */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
