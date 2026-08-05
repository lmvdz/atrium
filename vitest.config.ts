import { defineConfig } from 'vitest/config';

/**
 * Root Vitest workspace. Each package that has tests declares itself here as a
 * project so `pnpm test` at the root runs the whole suite in one process pool.
 *
 * Playwright e2e lives in apps/web and is run separately (`pnpm test:e2e`) —
 * browser tests are deliberately not part of the unit-test workspace. `apps/web`
 * still appears here: its Playwright suite is configured elsewhere, and this
 * project covers everything a browser is the wrong instrument for — the
 * component library under jsdom, the client's socket-URL derivation, and the
 * server-side boot conditions in `lib/env.ts`.
 *
 * The real-Postgres integration suite is not here either. It has its own config
 * (`vitest.integration.config.ts`) and its own command, `pnpm test:integration`,
 * because `pnpm test` must stay runnable with nothing but Node — and because a
 * database-backed test that skips itself when the database is missing turns a
 * verification gate into decoration.
 *
 * `mutants` IS here, and it is the realtime lane's root-level mutant runner
 * (`mutants/run.mjs`), whose own guards — the in-flight crash record and the
 * ledger's shape — are ordinary unit tests. Note that the core lane keeps a
 * SECOND, independent runner at `packages/core/mutants/`, which has no tests of
 * its own and is not a project here.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/db',
      'packages/auth',
      'packages/ingest',
      'apps/server',
      'apps/web',
      'mutants',
    ],
  },
});
