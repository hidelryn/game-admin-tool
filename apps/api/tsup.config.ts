import { defineConfig } from 'tsup';

export default defineConfig({
  // dist/server.js, dist/migrate.js 로 평탄하게 출력
  entry: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    migrate: 'src/infra/db/migrate.ts',
    seed: 'src/scripts/seed.ts',
    'seed-game': 'src/scripts/seed-game.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // 워크스페이스 패키지(@game-admin/*)는 TS 소스 그대로이므로 번들에 포함한다.
  noExternal: [/^@game-admin\//],
});
