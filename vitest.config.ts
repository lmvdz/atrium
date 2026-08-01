import { defineConfig } from 'vitest/config';

/**
 * Root Vitest workspace. Each package that has tests declares itself here as a
 * project so `pnpm test` at the root runs the whole suite in one process pool.
 *
 * Playwright e2e lives in apps/web and is run separately (`pnpm test:e2e`) —
 * browser tests are deliberately not part of the unit-test workspace.
 *
 * The real-Postgres integration suite is not here either. It has its own config
 * (`vitest.integration.config.ts`) and its own command, `pnpm test:integration`,
 * because `pnpm test` must stay runnable with nothing but Node — and because a
 * database-backed test that skips itself when the database is missing turns a
 * verification gate into decoration.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/db',
      'packages/ingest',
      'apps/server',
      'apps/web',
      'mutants',
    ],
  },
});
