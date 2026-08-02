/**
 * The in-flight mutation record — crash recovery for the mutant runner.
 *
 * Applying a mutation and undoing it are two moments, and anything that kills the
 * process between them leaves an earlier round's behaviour in the working tree.
 * The runner's `SIGINT`/`SIGTERM` handlers cover a clean interrupt; they do not
 * cover `kill -9`, an OOM, a killed process group, or a laptop lid. What is left
 * behind is a source file silently reverted, or a database object silently
 * replaced — and the next `pnpm test` may or may not notice.
 *
 * A plain `git status` cannot tell the difference: a fix branch has legitimate
 * uncommitted work by definition. So the record is explicit rather than inferred
 * — the in-flight mutation and, for a file, its original bytes.
 *
 * ## Why this is its own module (#22 gauntlet r5 delta, polish)
 *
 * > mutant SIGKILL recovery is best-effort, so between a kill and the next run
 * > `pnpm test` can be green on a mutated tree, and no mutant asserts recovery.
 *
 * Both halves are granted, and they need different answers.
 *
 * **"No mutant asserts recovery"** is why the logic lives here instead of inside
 * `run.mjs`. A script that runs its work at import time cannot be unit-tested
 * without running it, so recovery was the one part of the instrument with no
 * instrument of its own. It is a pure function of a record and a filesystem now,
 * `mutants/inflight.test.ts` drives all four of its outcomes, and the mutant
 * `inflight_recovery_is_a_no_op` makes that suite go red.
 *
 * **"`pnpm test` can be green on a mutated tree"** is not something recovery can
 * fix, because recovery runs on the *next mutant run* and the window is before
 * it. That one is closed from the other end: `mutants/ledger.test.ts` fails when
 * a record is present, so the ordinary gate refuses a tree that is mid-mutation
 * rather than reporting green over it. It is placed in that file deliberately —
 * the runner excludes `ledger.test.ts` from every mutant's score, so a guard that
 * is *supposed* to fire during a live mutant run cannot hand out false credit.
 *
 * What remains after both, stated rather than papered over: between the kill and
 * the next verification run of any kind, the tree is mutated and nothing has said
 * so. No process is alive to notice; a filesystem record is the most an
 * interrupted process can leave. The guarantee is that **no run which does
 * anything reports a result over it** — the ordinary suite goes red, and the
 * mutant runner recovers before it measures its baseline.
 *
 * `refuse` never deletes the record. A refusal that erases its own evidence is
 * worse than the crash it is reporting.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write the record. Called before a mutation is applied, never after. */
export function markInFlight(path, record) {
  writeFileSync(path, JSON.stringify(record));
}

/** Delete the record. Called after the mutation has been undone, never before. */
export function clearInFlight(path) {
  rmSync(path, { force: true });
}

/**
 * Put back whatever a killed run left applied.
 *
 * Returns a verdict rather than exiting, so a test can drive every branch:
 *
 *  - `{ status: 'clean' }` — no record; nothing was interrupted.
 *  - `{ status: 'recovered', id, file }` — a `file` mutation was undone from the
 *    record's own bytes and the record deleted. The caller rebuilds and continues.
 *  - `{ status: 'refuse', reason }` — a `sql` mutation, or a record that does not
 *    parse. Neither can be undone from here: the database is not a file and cannot
 *    be put back from a record, and an unreadable record names nothing. The caller
 *    stops, and the record stays on disk.
 */
export function recoverInterruptedRun({ path, root }) {
  if (!existsSync(path)) return { status: 'clean' };
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      status: 'refuse',
      reason:
        `${path} exists and does not parse. A previous run died mid-mutation and its record is\n` +
        'unreadable; restore the working tree by hand (git diff will show the mutation) and delete\n' +
        'the file before running again.',
    };
  }
  if (record.kind !== 'file') {
    return {
      status: 'refuse',
      reason:
        `a previous run died with the sql mutant "${record.id}" applied to the database. This run\n` +
        'would measure a mutated schema, so it is refusing. Re-apply the migrations to a clean\n' +
        `database (\`pnpm test:integration\` recreates one) and delete ${path}.`,
    };
  }
  writeFileSync(join(root, record.file), record.original);
  rmSync(path, { force: true });
  return { status: 'recovered', id: record.id, file: record.file };
}
