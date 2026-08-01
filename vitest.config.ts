import { defineConfig } from 'vitest/config';

/**
 * Root Vitest workspace. Each package that has tests declares itself here as a
 * project so `pnpm test` at the root runs the whole suite in one process pool.
 *
 * Playwright e2e lives in apps/web and is run separately (`pnpm test:e2e`) —
 * browser tests are deliberately not part of the unit-test workspace. `apps/web`
 * still appears here: its Playwright suite is configured elsewhere, and this
 * project covers the server-side modules a browser cannot reach, starting with
 * the boot conditions in `lib/env.ts`.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/ci-guard',
      'packages/core',
      'packages/db',
      'packages/auth',
      'packages/ingest',
      'apps/server',
      'apps/web',
    ],
  },
});
