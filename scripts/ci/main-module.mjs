/**
 * "Was this file run, or imported?" — asked so that the answer is never a
 * silent no.
 *
 * ── THE DEFECT (#40 round 5) ────────────────────────────────────────────────
 * Fifteen files in this directory ended with the same four lines:
 *
 *     if (import.meta.url === `file://${process.argv[1]}`) {
 *       process.exit(main());
 *     }
 *
 * and every one of them was a fail-open. `import.meta.url` is a URL: it
 * percent-encodes anything that is not URL-safe, and Node has already resolved
 * it through any symlink on the way. `process.argv[1]` is a path, encoded
 * nowhere and resolved not at all. The two agree for `/home/x/repo`, and stop
 * agreeing the moment either is true. Measured, on this machine:
 *
 *     node /tmp/g/g.mjs                          MAIN ran   exit 3
 *     node "/tmp/g/with space/g.mjs"                        exit 0   (silent)
 *     node /tmp/g/link.mjs        (a symlink)               exit 0   (silent)
 *
 * A checkout path with a space in it, or an invocation through a symlink, and
 * the assertion prints nothing, asserts nothing, and exits **0**. That is the
 * exact failure the whole `deploy` job exists to prevent, in the file that
 * prevents it — and both self-tests, `gate-selftest.mjs` and
 * `workflow-policy-selftest.mjs`, had it too, so the thing that would have
 * noticed was disarmed by the same line. `github.workspace` has no space in it
 * today, which is why this was latent rather than live, and "today's path
 * happens to be plain" is not a property anything here should rest on.
 *
 * ── THE FIX, AND WHY IT IS A SHARED FILE ────────────────────────────────────
 * `fileURLToPath` undoes the encoding, and `realpathSync` undoes the symlink on
 * both sides — the cheap comparison first, so the common case costs nothing and
 * a deleted entry point cannot throw. Fifteen copies of a subtle four-line
 * predicate is how fifteen copies of a defect happen, so there is one copy.
 *
 * ── WHY THE SCANNER IS NOT IN HERE ANY MORE (#40 round 6) ───────────────────
 * Round 5 kept the scanner that enforces this in this file, as a pair of
 * substring tests over each file's source. Two things were wrong with that and
 * both are recorded in `guard-scan.mjs`, which now owns it: a substring test
 * cannot tell a guard from a string literal that quotes one, and this file had
 * to be *exempted* from its own rule because it has to say the words it forbids.
 * The scanner parses now, so it reads neither comments nor string literals and
 * needs no exemption list — which is why the broken guard can be quoted verbatim
 * eight lines above this sentence.
 *
 * This file therefore imports nothing but `node:` builtins and is the one module
 * every entry point here loads. `guard-scan.mjs` pulls in the TypeScript
 * compiler; the fifteen scripts that only need the predicate should not.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module named by `url` is the entry point node was given.
 *
 * @param {string} url the caller's `import.meta.url`
 * @param {string[]} [argv] defaults to `process.argv`
 */
export function isMainModule(url, argv = process.argv) {
  const entry = argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const here = fileURLToPath(url);
  if (entry === here) return true;
  try {
    return realpathSync(entry) === realpathSync(here);
  } catch {
    // The entry point does not exist on disk any more, or is not readable.
    // Whatever node was given, it was not this file by a path we can confirm.
    return false;
  }
}
