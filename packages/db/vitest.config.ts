import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against core's source, so `pnpm test` never depends on build order.
      '@atrium/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'db',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
