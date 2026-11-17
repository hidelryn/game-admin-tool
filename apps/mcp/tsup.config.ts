import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { http: 'src/http.ts', stdio: 'src/stdio.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // 워크스페이스 패키지(@game-admin/*)는 TS 소스 그대로이므로 번들에 포함한다.
  noExternal: [/^@game-admin\//],
});
