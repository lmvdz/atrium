import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against source, so `pnpm test` never depends on build order.
      '@atrium/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      '@atrium/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@atrium/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
