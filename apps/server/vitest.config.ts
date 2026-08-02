import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test against SOURCE, so `pnpm test` never depends on build order — the auth
 * lane's rule, kept.
 *
 * THE ARRAY FORM, AND THE ORDER, ARE LOAD-BEARING. Vite matches a string alias
 * by PREFIX, so a bare `'@atrium/db'` entry also swallows `@atrium/db/schema`
 * and rewrote it to `packages/db/src/index.ts/schema` — ENOTDIR, and both of the
 * realtime lane's server suites failed to import at all. The subpath is listed
 * first and matched exactly; `@atrium/db` maps to `.` and `@atrium/db/schema` to
 * `./schema`, exactly as the package's own `exports` map says.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@atrium/db/schema',
        replacement: fileURLToPath(new URL('../../packages/db/src/schema.ts', import.meta.url)),
      },
      {
        find: '@atrium/auth',
        replacement: fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      },
      {
        find: '@atrium/db',
        replacement: fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      },
      {
        find: '@atrium/core',
        replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
