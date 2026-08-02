import { defineConfig } from 'vitest/config';

/**
 * The mutant ledger's own drift check, in the ordinary unit suite.
 *
 * It is a vitest project rather than a file inside one of the packages because
 * the ledger spans the repo — `apps/server`, `apps/web` and `packages/db` all
 * have mutants — and a check that lived in one of them would look like that
 * package's business.
 */
export default defineConfig({
  test: {
    name: 'mutants',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
