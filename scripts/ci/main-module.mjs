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
 * predicate is how fifteen copies of a defect happen, so there is one copy, and
 * `mainGuardProblems()` below is what keeps it the only one: `gate-selftest.mjs`
 * runs it over this directory, so re-introducing the broken spelling fails the
 * suite on the commit that writes it.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The comparison this file exists to replace, in every spelling seen so far.
 *
 * Deliberately a *source* scan rather than a lint rule: the defect is a string
 * comparison that is correct-looking and wrong, and what has to be refused is
 * the shape, wherever somebody writes it next.
 */
const BROKEN_GUARD =
  /import\.meta\.url\s*={2,3}\s*[`'"]file:\/\/|[`'"]file:\/\/[^\n]{0,80}={2,3}\s*import\.meta\.url/;

/** Files that may not be run at all, so a guard in them would be theatre. */
const NOT_ENTRY_POINTS = new Set(['main-module.mjs']);

/**
 * Every file in `directory` whose main-module guard is the broken comparison.
 *
 * @param {string} directory
 * @param {(path: string) => string} [read] injectable so the self-test can
 *   hand this a fixture without writing files
 * @returns {string[]} human-readable problems; empty means every guard is sound
 */
export function mainGuardProblems(directory, read = (path) => readFileSync(path, 'utf8')) {
  const problems = [];
  // Recursive, because "the directory this happens to be flat today" is the
  // same kind of assumption as "the checkout path happens to have no space in
  // it" — which is what made this defect latent rather than absent.
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      problems.push(...mainGuardProblems(full, read));
      continue;
    }
    if (!entry.name.endsWith('.mjs') || NOT_ENTRY_POINTS.has(entry.name)) continue;
    if (!BROKEN_GUARD.test(read(full))) continue;
    problems.push(
      `${full} decides whether it was run by comparing \`import.meta.url\` against \`file://\` + \`process.argv[1]\`. \`import.meta.url\` percent-encodes and resolves symlinks; \`process.argv[1]\` does neither, so a checkout path containing a space — or an invocation through a symlink — makes the comparison false, and the script exits 0 having printed nothing and asserted nothing. Measured: \`node "/tmp/g/with space/g.mjs"\` exits 0 where \`node /tmp/g/g.mjs\` exits 3. Use \`isMainModule(import.meta.url)\` from scripts/ci/main-module.mjs.`,
    );
  }
  return problems;
}
