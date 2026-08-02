#!/usr/bin/env node
/**
 * The `atrium-ingest` executable: one file whose only job is to run.
 *
 * ── WHY THE ENTRY DECISION IS GONE RATHER THAN FIXED (#40 round 9, D7) ──────
 * `cli.ts` used to end with
 *
 *     const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
 *     if (entry === fileURLToPath(import.meta.url)) { … }
 *
 * which is the round-4 guard this repository spent a whole round removing from
 * `scripts/`: `import.meta.url` is a URL that percent-encodes and has already
 * been resolved through every symlink; `process.argv[1]` is a path that is
 * neither. Reproduced by a blind critic on the shipped build — `node
 * packages/ingest/dist/cli.js` prints usage, and the same file **through a
 * symlink prints nothing and exits 0**. A CLI that silently does nothing when
 * invoked through a link (a `node_modules/.bin` shim, a Homebrew cellar, a
 * `pnpm` store path) is the same fail-open, shipped.
 *
 * `scripts/ci/main-module.mjs` is the answer inside `scripts/`, and it is not
 * importable from here: this package is built with `tsc` into `dist/`, and a
 * relative import that climbs out of `rootDir` does not compile. The better
 * answer needs no predicate at all — a module that is *only* an entry point does
 * not have to ask whether it is one. `cli.ts` is now a plain module that exports
 * `main`, this file is the `bin`, and the question that had a subtle wrong
 * answer no longer gets asked.
 */
import { main } from './cli.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
