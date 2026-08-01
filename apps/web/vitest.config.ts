import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * A unit-test project for `apps/web`'s server-side modules.
 *
 * There was none before round 5, which is why `lib/env.ts` — the file that
 * decides whether this app will serve production traffic at all — had no test
 * of its own for four rounds. Playwright covers the app through a browser; it
 * cannot flip `NODE_ENV` and watch a boot condition refuse.
 *
 * `server-only` is aliased to that package's own `empty.js` — the exact module
 * it exports under the `react-server` condition, which is what Next resolves
 * when it compiles these files for the server. (Setting `resolve.conditions`
 * alone is not enough: the package is CommonJS and gets resolved through
 * `main`, so the throwing module wins.) The alias is therefore not a stub we
 * wrote; it is the same file the framework picks.
 */
export default defineConfig({
  resolve: {
    conditions: ['react-server', 'node', 'import', 'default'],
    alias: {
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
      // Test against source, so `pnpm test` never depends on build order.
      '@atrium/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      '@atrium/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@atrium/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
