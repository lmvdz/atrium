import { defineConfig } from 'vitest/config';

/**
 * The daemon's own unit suite — no database, no server, no `@atrium/*`.
 *
 * apps/loop is a protocol-only client (#148): its source imports nothing from
 * the rest of the monorepo, so there are no source aliases to declare here. The
 * cross-process acceptance test — the one that drives a real server on a real
 * Postgres and executes the crash-replay — lives in `integration/loop/` under
 * `vitest.integration.config.ts`, because a database-backed test that skips
 * itself when the database is missing turns a verification gate into decoration.
 */
export default defineConfig({
  test: {
    name: 'loop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
