import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the client library only. The Playwright specs in `e2e/` are
 * run separately by `pnpm test:e2e` — browser tests are deliberately not part
 * of the unit-test workspace.
 */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
