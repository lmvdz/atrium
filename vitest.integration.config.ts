import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The real-Postgres suite (issue #22). Separate from `vitest.config.ts` on
 * purpose: `pnpm test` must stay runnable with nothing but Node, and a suite
 * that needs a database should say so by failing to connect, not by skipping
 * itself into a green tick.
 *
 *   pnpm test:integration           # compose up → migrate → run → down
 *
 * These tests exercise the migrations in `packages/db/drizzle` as applied to a
 * live server — never a hand-assembled schema and never a regex over the SQL,
 * which is the #19 finding this arrangement answers. A constraint that exists
 * in a string but not in the database is exactly the failure mode.
 */

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Array form, because order decides: `@atrium/db/schema` has to be matched
    // before the bare `@atrium/db` prefix would swallow it.
    alias: [
      { find: /^@atrium\/db\/schema$/, replacement: src('./packages/db/src/schema.ts') },
      { find: /^@atrium\/db$/, replacement: src('./packages/db/src/index.ts') },
      { find: /^@atrium\/core$/, replacement: src('./packages/core/src/index.ts') },
      // The identity package, for the suite that wires the real Better Auth
      // upgrade authenticator instead of the stub. Source rather than `dist` for
      // the same reason as the other three: the suite must never depend on build
      // order, and what the compiler checks has to be what the runner runs.
      { find: /^@atrium\/auth$/, replacement: src('./packages/auth/src/index.ts') },
      /**
       * `server-only` — the same alias `apps/web/vitest.config.ts` carries, and
       * for the same reason.
       *
       * The package's job is to make a client bundle fail loudly if it pulls in a
       * server module: its default export throws on import. There is no client
       * bundle here — this runner IS the server, on a real Postgres — so the
       * throw would only prevent the suite from exercising the modules whose
       * server-side behaviour it exists to test (#121's certify path is the first
       * one). The target is `server-only/empty.js`, the module the package itself
       * exports under the `react-server` condition; it is not a stub written here.
       */
      { find: /^server-only$/, replacement: src('./apps/web/node_modules/server-only/empty.js') },
    ],
  },
  test: {
    name: 'integration',
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    globalSetup: ['integration/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * One file at a time. Every append takes the same ledger-wide advisory
     * lock, so parallel files would serialize on it anyway — and they would
     * truncate the database out from under each other while doing it.
     */
    fileParallelism: false,
  },
});
