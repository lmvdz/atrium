import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against core's source, so `pnpm test` never depends on build order.
      //
      // #40 round 7: this was the one consumer of @atrium/core without the
      // alias its four neighbours all carry, and `pnpm test` from a clean
      // checkout exited 1 because of it — six ingest files collected zero tests
      // with `Failed to resolve entry for package "@atrium/core"`, because
      // core's `exports` point at `dist/` and `dist/` is build output. CI never
      // saw it: `.github/workflows/ci.yml` builds the packages before the vitest
      // step. Locally it self-healed on the second run, because
      // apps/server/test/entrypoint-env.test.ts builds the packages when their
      // `dist` is missing — so the failure was real, one-shot, and invisible to
      // anyone who ran the command twice.
      '@atrium/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'ingest',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
