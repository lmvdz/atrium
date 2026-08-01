import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — the runner and its parts are plain ESM, deliberately: they
// run as `node mutants/run.mjs` with no build step, because an instrument that
// needs the build it is measuring is an instrument that can be broken by the
// thing it exists to catch.
import { clearInFlight, markInFlight, recoverInterruptedRun } from './inflight.mjs';

/**
 * Crash recovery for the mutant runner, driven directly (#22 gauntlet r5 delta,
 * polish).
 *
 * > mutant SIGKILL recovery is best-effort, so between a kill and the next run
 * > `pnpm test` can be green on a mutated tree, and no mutant asserts recovery.
 *
 * The second clause is what this file answers. Round 5 built the recovery and
 * measured it with nothing — it lived inside `run.mjs`, which does its work at
 * import time, so the only way to exercise it was to kill a real run. An
 * unmeasured recovery path in the instrument that measures everything else is
 * exactly the "the instrument had the defect it hunts" entry in the RETRO.
 *
 * Every test below simulates the kill rather than performing one: a record on
 * disk beside a file whose bytes disagree with it **is** what a `kill -9` leaves,
 * and reproducing the state is what the recovery is a function of. All four
 * outcomes, because the failure this closes was a `commit` that had three ways
 * out and a test for one of them.
 *
 * The first clause — the window in which `pnpm test` runs green over a mutated
 * tree — cannot be closed by recovery at all, since recovery happens on the next
 * *mutant* run. It is closed from the other end, in `ledger.test.ts`, which fails
 * whenever a record is present so the ordinary gate refuses a tree that is
 * mid-mutation. See the header of `inflight.mjs` for what is left after both.
 */

const dirs: string[] = [];

function scratch(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'atrium-inflight-'));
  dirs.push(root);
  return { root, path: join(root, '.inflight.json') };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the mutant runner recovers a run that was killed mid-mutation', () => {
  it('puts a mutated file back from the record and clears it', () => {
    // Catches: `inflight_recovery_is_a_no_op` — recovery that returns "clean"
    // without looking, which is r5's behaviour for every crash that was not a
    // clean SIGINT: the mutated bytes stay on disk and the next run measures them.
    const { root, path } = scratch();
    const target = join(root, 'source.ts');
    writeFileSync(target, 'the real code\n');
    const original = readFileSync(target, 'utf8');

    // What a `kill -9` between `markInFlight` and the restore leaves behind.
    markInFlight(path, { id: 'some_mutant', kind: 'file', file: 'source.ts', original });
    writeFileSync(target, 'an earlier round’s behaviour\n');

    const verdict = recoverInterruptedRun({ path, root });

    expect(verdict).toEqual({ status: 'recovered', id: 'some_mutant', file: 'source.ts' });
    expect(readFileSync(target, 'utf8')).toBe(original);
    // Cleared, so the next run does not re-recover a file nobody mutated.
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to run at all when the leftover mutation was a sql one', () => {
    /**
     * A database is not a file and cannot be put back from a record. Restoring
     * the migration statements would work only if the process that died had got
     * as far as recording which ones — and it is precisely the process that died.
     * So this refuses rather than guessing, and the run stops.
     *
     * Catches: `inflight_recovery_is_a_no_op`, whose no-op lets a run measure a
     * schema an earlier mutant replaced and credit the results to this one.
     */
    const { root, path } = scratch();
    markInFlight(path, { id: 'payload_room_may_disagree', kind: 'sql' });

    const verdict = recoverInterruptedRun({ path, root });

    expect(verdict.status).toBe('refuse');
    expect(verdict.reason).toContain('payload_room_may_disagree');
    // The record survives a refusal. A refusal that erases its own evidence
    // leaves the next person with a mutated database and nothing that says so.
    expect(existsSync(path)).toBe(true);
  });

  it('refuses on a record it cannot read, rather than assuming there was none', () => {
    // A half-written record is the most likely artefact of a kill: the write is
    // not atomic. Treating an unparseable one as "nothing was in flight" would be
    // the fail-open every other guard in this repo exists to refuse.
    const { root, path } = scratch();
    writeFileSync(path, '{"id":"half-writ');

    const verdict = recoverInterruptedRun({ path, root });

    expect(verdict.status).toBe('refuse');
    expect(verdict.reason).toContain('does not parse');
    expect(existsSync(path)).toBe(true);
  });

  it('does nothing when no run was interrupted', () => {
    // The non-vacuity half: if `recover` reported "recovered" or "refuse" on a
    // clean tree, the three tests above would pass for the wrong reason.
    const { root, path } = scratch();
    expect(recoverInterruptedRun({ path, root })).toEqual({ status: 'clean' });

    // And `clearInFlight` on a record that is not there is not an error — the
    // runner calls it in a `finally`, on paths where the record was never written.
    expect(() => clearInFlight(path)).not.toThrow();
  });
});
