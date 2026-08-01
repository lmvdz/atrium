/**
 * Where the repository is, asked so that the answer does not depend on where
 * anybody happened to be standing.
 *
 * ── THE DEFECT (#40 round 8, D7) ────────────────────────────────────────────
 * `gate-selftest.mjs` read `scripts`, `README.md` and `.github/workflows/ci.yml`
 * as paths relative to the current directory, and `checkerGraphProblems`
 * defaulted its root to `process.cwd()`. CI runs everything from the repository
 * root, so all of it worked; run from anywhere else, and it did three different
 * things:
 *
 *     pnpm -r typecheck                       exits 2 unless run from the root
 *     pnpm --filter @atrium/ci-guard test     exits 1 unless run from the root
 *     node ../../scripts/ci/gate-selftest.mjs README.md not found → *no README
 *                                             claims checked at all*, silently
 *
 * The third is the one that matters. `checkReadmeClaims` caught its own
 * `readFileSync` and returned `[]` — so from the wrong directory the readback
 * that keeps every count in the prose honest reported nothing and the gate went
 * green. A check that skips what it cannot find is a check with a hole shaped
 * like a working directory.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 * A walk upwards from wherever the caller is until a directory holds all three
 * markers this repository is defined by. It is deliberately *not* an environment
 * variable: a root that can be handed in from outside is a root a workflow step
 * can point at an empty directory, and every scan then reports a clean tree
 * because there is nothing in it. The one caller that legitimately needs a
 * different root — `positive-control.mjs`, which runs the shipped entry points
 * against a deliberately broken copy of the tree — gets it by running the child
 * process with its `cwd` set there, which is the same mechanism and needs no
 * second door.
 *
 * It is also not a claim that the answer is *this* repository: any directory
 * with those three markers satisfies it. That is the point — it is how the
 * broken copy is reachable at all — and it is why the markers are three rather
 * than one.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** What makes a directory this repository rather than some directory above it. */
const MARKERS = ['pnpm-workspace.yaml', join('.github', 'workflows'), join('scripts', 'ci')];

/**
 * The repository root containing `from`.
 *
 * @param {string} [from] where to start looking; defaults to the caller's cwd
 * @param {(path: string) => boolean} [exists] injectable for the tests
 * @returns {string} an absolute path
 * @throws when no directory at or above `from` holds every marker
 */
export function repoRoot(from = process.cwd(), exists = existsSync) {
  let current = resolve(from);
  for (;;) {
    if (MARKERS.every((marker) => exists(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `no repository root at or above ${resolve(from)}: nothing there holds all of ${MARKERS.join(', ')}. Every path these scripts read is resolved against this, rather than against the working directory, because a check that silently reads nothing from the wrong directory is a check that passes from the wrong directory.`,
      );
    }
    current = parent;
  }
}
