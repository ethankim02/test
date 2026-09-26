import { defineConfig } from 'vitest/config';

// Integration tests talk to a real Postgres instance (DATABASE_URL /
// MIGRATOR_DATABASE_URL from .env). They are excluded from `pnpm test`
// (the fast, no-database suite) and run separately via `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
  },
});
