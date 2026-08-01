import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against source, so `pnpm test` never depends on build order.
      '@atrium/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
      '@atrium/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'auth',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
