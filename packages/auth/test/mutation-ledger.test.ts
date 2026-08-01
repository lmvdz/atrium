import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script with no declarations; the point of this
// file is that the instrument is reachable by a test at all.
import { flattenPlaywright, judge } from '../../../scripts/mutation-ledger.mjs';

/**
 * The mutation ledger's own verdict rules, tested.
 *
 * ## Why the instrument has tests
 *
 * `scripts/mutation-ledger.mjs` is what every "this test catches X" claim in
 * this ticket rests on. Rounds 6 to 9 each found the same shape one layer
 * further in:
 *
 *  - round 6 recorded seven passes against `drop-join` because the mutation was
 *    never compiled into the `dist` the e2e imports;
 *  - round 9 found that a mutation whose target had moved threw where nobody was
 *    looking, and added `--verify`;
 *  - the round-9 delta found that `--verify` proves the mutation bites the
 *    *code* and not that the *check* bit the mutation — a row could still be
 *    credited to a suite that was skipped.
 *
 * `--prove` closes the last one by running the suite and asserting a red result.
 * That makes the ledger a thing that decides, and a thing that decides can be
 * wrong in silence — so the decision is a pure function, `judge`, and these are
 * its cases. Testing it through `--prove` would mean spawning real suites, which
 * is why the previous three layers went untested: too expensive to be worth it,
 * so nobody did.
 *
 * ## The three fail-open shapes, each with a case
 *
 * A "red" verdict is what credits a row. Every case below is a way a run can
 * *look* red while measuring nothing, and each has been seen for real:
 *
 *  1. **A non-zero exit with no failing test.** A missing file, a broken build,
 *     a bad filter, a runner that crashed on startup. This is the shape the
 *     round-9 delta named for the ledger and the shape `RETRO.md` records for
 *     the CI gate — a gate that passes when the suite never ran.
 *  2. **A suite that was already red.** Then the row measures the suite's
 *     health, not the mutation.
 *  3. **An equal-size-but-different failure set.** Counts move, and none of the
 *     movement is this mutation. `caught` is the intersection with what was
 *     passing before, which is the only version of the number worth quoting.
 *
 * Catches: any change to `judge` that lets one of those return `red`. There is
 * no mutation-ledger row for this file, deliberately — a mutation that broke
 * `judge` would be measured by the ledger that contains it, which is the
 * circularity the whole exercise is about. It is pinned by value instead.
 */

interface Run {
  exitCode: number;
  total: number;
  failed: number;
  tests: { fullName: string; status: string }[];
  parseError?: string;
}

function run(tests: [string, 'passed' | 'failed'][], overrides: Partial<Run> = {}): Run {
  const built = tests.map(([fullName, status]) => ({ fullName, status }));
  return {
    exitCode: built.some((test) => test.status === 'failed') ? 1 : 0,
    total: built.length,
    failed: built.filter((test) => test.status === 'failed').length,
    tests: built,
    ...overrides,
  };
}

const GREEN = run([
  ['a', 'passed'],
  ['b', 'passed'],
  ['c', 'passed'],
]);

describe('judge — the ledger only credits a row when the check actually fired', () => {
  it('returns red, and names what it caught, when the mutation breaks passing tests', () => {
    // The control. Without this every assertion below is satisfied by a
    // `judge` that never returns red at all.
    const verdict = judge(
      GREEN,
      run([
        ['a', 'failed'],
        ['b', 'failed'],
        ['c', 'passed'],
      ]),
    );
    expect(verdict.verdict).toBe('red');
    expect(verdict.caught).toEqual(['a', 'b']);
  });

  it('refuses a non-zero exit with no failing test — the suite did not run', () => {
    /**
     * The exact shape the round-9 delta described: "a row can still be credited
     * to a suite that was skipped". A runner that could not start, a filter that
     * matched no file and a build that failed all exit non-zero having measured
     * nothing, and an exit-code check reads every one of them as proof.
     */
    const verdict = judge(GREEN, { exitCode: 1, total: 0, failed: 0, tests: [] });
    expect(verdict.verdict).toBe('unmeasured');
  });

  it('refuses a run whose JSON could not be read, however it exited', () => {
    // No report is not a result. Silently treating it as one is how "0 caught"
    // becomes indistinguishable from "not measured".
    const verdict = judge(GREEN, {
      exitCode: 1,
      total: 0,
      failed: 0,
      tests: [],
      parseError: 'the runner wrote no JSON report',
    });
    expect(verdict.verdict).toBe('unmeasured');
    expect(verdict.why).toContain('no JSON report');
  });

  it('refuses a baseline that was not green', () => {
    const verdict = judge(
      run([
        ['a', 'failed'],
        ['b', 'passed'],
      ]),
      run([
        ['a', 'failed'],
        ['b', 'failed'],
      ]),
    );
    expect(verdict.verdict).toBe('no-baseline');
  });

  it('refuses a baseline that ran no tests, which is not the same as a green one', () => {
    // `vitest run some/path/that/moved.ts` exits 0 having run nothing on some
    // configurations, and an empty green is the most convincing false receipt
    // available.
    const verdict = judge({ exitCode: 0, total: 0, failed: 0, tests: [] }, run([['a', 'failed']]));
    expect(verdict.verdict).toBe('no-baseline');
    expect(verdict.why).toContain('no tests');
  });

  it('refuses a failure set that does not overlap what was passing', () => {
    /**
     * The equal-size-but-different case. Three failed before, three failed
     * after, and not one of them is this mutation — every count-based check
     * reads that as caught. `caught` is the intersection, so it is empty and the
     * verdict says so.
     */
    const baseline = run([
      ['a', 'passed'],
      ['b', 'passed'],
    ]);
    const mutated = run([
      ['a', 'passed'],
      ['b', 'passed'],
      ['c-new-test', 'failed'],
    ]);
    const verdict = judge(baseline, mutated);
    expect(verdict.verdict).toBe('unrelated');
    expect(verdict.caught).toEqual([]);
  });

  it('refuses a suite that stayed green under the mutation', () => {
    const verdict = judge(GREEN, GREEN);
    expect(verdict.verdict).toBe('green');
    expect(verdict.why).toContain('not caught');
  });
});

describe('flattenPlaywright — the e2e half is parsed, not inferred from an exit code', () => {
  it('reads nested suites into full names and a pass/fail per spec', () => {
    // Playwright nests file → describe → spec and puts the status three levels
    // further down again. A row credited to the e2e suite is credited on this.
    const out: { fullName: string; status: string }[] = [];
    flattenPlaywright(
      {
        suites: [
          {
            title: 'room-access.spec.ts',
            suites: [
              {
                title: 'room authorization',
                specs: [
                  { title: 'denies a non-member', tests: [{ results: [{ status: 'passed' }] }] },
                  { title: 'denies a demoted admin', tests: [{ results: [{ status: 'failed' }] }] },
                ],
              },
            ],
          },
        ],
      },
      [],
      out,
    );
    expect(out).toEqual([
      {
        fullName: 'room-access.spec.ts › room authorization › denies a non-member',
        status: 'passed',
      },
      {
        fullName: 'room-access.spec.ts › room authorization › denies a demoted admin',
        status: 'failed',
      },
    ]);
  });

  it('counts a spec with no results at all as failed, not as absent', () => {
    // A spec that never ran must not vanish from the report, or a suite that
    // died halfway looks like a smaller green suite.
    const out: { fullName: string; status: string }[] = [];
    flattenPlaywright({ specs: [{ title: 'never ran', tests: [{ results: [] }] }] }, [], out);
    expect(out).toEqual([{ fullName: 'never ran', status: 'failed' }]);
  });
});
