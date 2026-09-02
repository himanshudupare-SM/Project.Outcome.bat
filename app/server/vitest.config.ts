import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Integration tests share one Postgres database; run files serially.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // Entry points, config plumbing and the dev seed are exercised by
      // running the app, not by unit tests; counting them hides real gaps.
      exclude: ['src/main.ts', 'src/scripts/**', 'src/platform/migrate-cli.ts', 'src/platform/env*.ts'],
    },
  },
  resolve: {
    alias: { '@outcome/shared': new URL('../shared/src/index.ts', import.meta.url).pathname },
  },
});
