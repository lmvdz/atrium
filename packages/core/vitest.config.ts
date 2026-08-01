import { defineConfig } from 'vitest/config';

/**
 * **`testTimeout` is declared, and r7's review is why it has to be.**
 *
 * This package's evidence is brute force: three tests sweep all 1,112,064
 * non-surrogate code points, and a fourth sweeps 28,561 quote/statement pairs.
 * Nothing declared a timeout, so they ran against vitest's 5000 ms default —
 * and the reviewer measured the code-point sweep at **5277 ms** on an idle
 * machine. Six consecutive `pnpm test` runs on a pristine checkout exited
 * 1, 1, 0, 1, 0, 0, always the same two tests, always `Test timed out in
 * 5000ms`. The first green was luck; a slower CI box fails every time. The two
 * tests it flipped are the two the round's whole evidentiary posture rests on,
 * which is the worst possible pair to have flaking.
 *
 * The repair is two-part, and the sharding is the load-bearing half:
 *
 *  1. Each full-range sweep is **sharded into its seventeen Unicode planes**
 *     (`tokens.test.ts`, `residue.test.ts`) and the pair sweep into its thirteen
 *     alphabet entries. Coverage is unchanged — a test beside each one adds the
 *     shards back up and fails if one did not run — and the slowest shard
 *     measures **501 ms** here, against 3503 ms for the unsharded loop under
 *     the same load.
 *  2. This budget, at **20× the slowest shard measured on this machine and 3.8×
 *     the slowest single observation anyone has recorded** (the reviewer's
 *     5277 ms). It is a margin for a slow or contended box, not a licence: a
 *     shard that takes twenty times its measured cost is a performance
 *     regression worth a red test, and this still catches one.
 *
 * Measured 2026-08-01 on a contended 4-core box (load average 23) at the tip of
 * `fix/core-engine-r7`: slowest shard 501 ms, whole package 1009 tests in ~10 s.
 * If a shard ever approaches this number, shard it further rather than raising
 * it — the number that stays honest is the one nothing is near.
 */
export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
