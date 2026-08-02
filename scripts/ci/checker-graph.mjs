/**
 * A checker that checks checkers: who *asserts* on each rule, can its subject
 * disarm its witness, and does the rule still do anything when you replace it?
 *
 * ── THE DEFECT THIS GENERALISES (#40 round 6) ───────────────────────────────
 * `mainGuardProblems` enforced the main-module guard across `scripts/`. It was
 * invoked in exactly one place in the repository: line 1407 of
 * `gate-selftest.mjs` — a file inside `scripts/`, and therefore one of its own
 * subjects. Disarming `gate-selftest.mjs` disarmed the only thing that would
 * have objected to `gate-selftest.mjs` being disarmed. One edit, and the rule
 * stopped existing without anything going red.
 *
 * That is not a fact about the guard. It is a fact about the *shape* of the
 * invocation graph, and it is checkable:
 *
 *   **Every enforcement check must have at least one witness that is not among
 *   the files it checks, every declared witness must be something CI actually
 *   runs, and a witness is a place that asserts on the check's result — not
 *   merely a place that calls it.**
 *
 * ── THE THREE HOLES ROUND 6 LEFT, ALL MEASURED (#40 round 7) ────────────────
 * A blind critic stood up the real stack and executed all three.
 *
 *  1. **Centralising concentrated the failure and the witness never followed.**
 *     Round 6 replaced fifteen copies of the guard with one shared predicate,
 *     `isMainModule`. `packages/ci-guard` had no case for that predicate's
 *     *behaviour* — it checked the *shape* of the guard in its callers — and the
 *     registry had no row for it. So one statement in `main-module.mjs`:
 *
 *         if (process.env.GITHUB_JOB === 'verify') return false;
 *
 *     killed the whole `verify` job and left `deploy` working. Measured: eleven
 *     of twenty-one CI entry points went from "says something" to `exit=0
 *     bytes=0`, 176 gate cases and 182 policy mutations stopped running, and
 *     `npx vitest run --project ci-guard` reported **0, 49 passed**. Round 5's
 *     defect cost 316 assertions for two `&&` in two files; this cost 358 for
 *     one statement in one file, because the fix for round 5 made the blast
 *     radius bigger. **Every refactor that replaces N copies with one shared
 *     implementation converts N independent failures into one total failure, and
 *     the tests written for the N copies do not transfer.** `sharedModuleProblems`
 *     below turns that sentence into a rule.
 *
 *  2. **A row's fixture probed a different function than the row named.**
 *     `ENFORCEMENT[0]` was `check: 'mainGuardProblems'` with a `violate` that
 *     called `guardProblems`, and nothing checked the two matched. Gutting
 *     `mainGuardProblems` to `return []`: ci-guard **0, 49 passed**. So the
 *     fixture does not reach for the check any more — it is *handed* it, and it
 *     is run a second time against deliberate replacements. A fixture that
 *     ignores what it was handed and calls the module binding instead is caught
 *     by construction, because the replacement run then reports nothing.
 *
 *  3. **An invoker with no assertion satisfied the graph.** `calledNames` asked
 *     whether a check is *called*, never whether its result is *asserted on*.
 *     Stripping four `expect(…)` wrappers while keeping every call left ci-guard
 *     at 49 passed with the main-module rule entirely gone. "Presence is not
 *     use" had been applied to the check and not to the witness. `assertedNames`
 *     replaces `calledNames`: a name counts when its result reaches an assertion,
 *     through one of three declared shapes and no others.
 *
 * ── AND WHY THE DEAD-CODE TEST IS AN ALLOWLIST NOW ──────────────────────────
 * Round 6 refused four shapes of statically dead call position — `if (false)`,
 * `it.skip`, after-`return`, the false arm of a ternary — and the critic counted
 * twenty-one more that walked through, `describe.each([])` and a never-called
 * function among them. The repository's own standing rule, written in this same
 * commit range, is that denylists of evasions are unbounded and the compliant
 * forms get allowlisted. `assertedNames` names the three shapes in which a
 * result is asserted on and refuses the complement, so `while (false)`,
 * `xdescribe`, `const t = it; t.skip(…)`, `Promise.resolve().then(…)` and the
 * next one nobody has thought of are all simply not one of the three.
 *
 * ── WHAT IT STILL DOES NOT CLAIM ────────────────────────────────────────────
 * Static reachability, not execution: a live `it` whose `expect` compares two
 * constants is an assertion by this rule and proves nothing, and only the
 * replacement runs below reach that. The registry is data in this same commit,
 * so someone editing a check can edit its row; the drift test makes that loud
 * rather than impossible, and the README readback makes deleting a row loud too.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { notAVerdict } from './child-verdict.mjs';
import { composeArgs } from './compose.mjs';
import { mainGuardProblems } from './guard-scan.mjs';
import { requireFrom } from './import-from.mjs';
import { isMainModule } from './main-module.mjs';
import { CONTROLS, controlProblems, expectationProblems } from './positive-control.mjs';
import { manifestPath } from './record-built-images.mjs';
import { repoRoot } from './repo-root.mjs';
import { fail, readFreshReport } from './report-file.mjs';
import { scanForExpectedFailures } from './scan-expected-failures.mjs';
import { completedCommands } from './shell-command.mjs';
import {
  absentDeployment,
  check,
  compared,
  failures,
  mailpit,
  resetFailures,
  runtimeFloorProblems,
  stackTarget,
  verdict,
} from './stack-client.mjs';
import { checkWorkflowFile, ciScriptName, protectedCommandCoverage } from './workflow-policy.mjs';

/** Directories that hold source this repository wrote. */
const SOURCE_ROOTS = ['scripts', 'packages', 'apps'];
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts'];
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'playwright-report',
  'test-results',
  'drizzle',
]);
const WORKFLOW_DIRECTORY = '.github/workflows';
const MANIFEST = '.github/ci-manifest.json';
/** This file. Its assertions are contract probes, not witnesses. */
const REGISTRY_FILE = 'scripts/ci/checker-graph.mjs';

/** The fixture the guard scanner must object to, in its round-5 spelling. */
const BROKEN_GUARD =
  "import { isMainModule } from './main-module.mjs';\nif (isMainModule(import.meta.url) && process.env.CI === undefined) {\n  process.exit(main());\n}\n";
/** The same attack in its round-7 spelling: the gate is inside the exit. */
const GATED_EXIT_GUARD =
  "import { isMainModule } from './main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(process.env.CI === undefined ? await main() : 0);\n}\n";

/**
 * `expected` unless `actual` says so, as a problem list.
 *
 * Every contract below is written with this, so "the check reported nothing
 * about an input that violates it" and "the check reported something about an
 * input that does not" are the same kind of sentence and neither can be left
 * out by accident.
 */
function expectProblem(condition, what) {
  return condition ? [] : [what];
}

/**
 * Every check in this repository that enforces a rule over files or decides
 * something on behalf of many of them, and the complete set of places that
 * assert on it.
 *
 * `subjects` is what the check reads or decides for — the files that could
 * contain the edit it is supposed to notice. `invokers` is every place outside
 * the module that defines it where its result is *asserted on*. At least one
 * must lie outside every subject prefix, and that is the entire point of the
 * table.
 *
 * `fn` is the real implementation and `contract(fn, ctx)` is a description of
 * how it must behave, written so that it returns `[]` for the real one. `mutants`
 * are deliberate replacements the contract must reject. Both halves are required:
 * a contract nothing can fail is prose, and a mutant nothing catches is a check
 * with no test. See `effectProblems`.
 */
export const ENFORCEMENT = [
  {
    check: 'mainGuardProblems',
    definedIn: 'scripts/ci/guard-scan.mjs',
    fn: mainGuardProblems,
    subjects: ['scripts/'],
    invokers: [
      'scripts/ci/gate-selftest.mjs',
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'the round-5 spelling was enforced only from gate-selftest.mjs, which is one of the files it scans; two `&&` insertions removed 316 assertions with every gate green',
    contract: (scan, { root }) => [
      ...expectProblem(
        scan(join(root, 'scripts')).length === 0,
        'it reports problems about the real `scripts/` tree, which is clean',
      ),
      ...expectProblem(
        scan(join(root, 'scripts'), (path) =>
          path.endsWith('assert-tables.mjs') ? BROKEN_GUARD : readFileSync(path, 'utf8'),
        ).some((problem) => /condition is not exactly/.test(problem)),
        'it says nothing about the round-5 guard planted in assert-tables.mjs — the exact two-character edit that removed 316 assertions',
      ),
      // And the round-7 spelling of the same attack, which round 6's body rule
      // accepted: the gate is not in the condition, it is in the exit's argument.
      ...expectProblem(
        scan(join(root, 'scripts'), (path) =>
          path.endsWith('assert-tables.mjs') ? GATED_EXIT_GUARD : readFileSync(path, 'utf8'),
        ).some((problem) => /decided by something other than the work/.test(problem)),
        'it says nothing about a guard whose exit status is `process.env.CI === undefined ? await main() : 0` — the round-5 conjunct moved into the argument, one insertion per file, which round 6 accepted',
      ),
    ],
    mutants: [
      { name: 'gutted to `return []`', fn: () => [] },
      { name: 'stuck reporting on everything', fn: () => ['a problem'] },
    ],
  },
  {
    // #40 round 7's critical finding. Fifteen copies of a four-line predicate
    // became one, and nothing outside `scripts/` tested that one's behaviour.
    check: 'isMainModule',
    definedIn: 'scripts/ci/main-module.mjs',
    fn: isMainModule,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      "every entry point under scripts/ decides 'was I run?' by calling this, so one statement here is every one of them; `if (process.env.GITHUB_JOB === 'verify') return false;` was measured to take 358 assertions out of CI with a completely green build",
    contract: (isMain, { workspace }) => mainModuleContract(isMain, workspace),
    mutants: [
      { name: 'always false — every entry point silently does nothing', fn: () => false },
      { name: 'always true — every import runs the script', fn: () => true },
      {
        // The measured one. `GITHUB_JOB` is set by GitHub per job, so this kills
        // `verify` and leaves `deploy` working: a completely green build.
        name: 'false exactly under the `verify` job (the round-7 critical finding)',
        fn: (url, argv) => process.env.GITHUB_JOB !== 'verify' && isMainModule(url, argv),
      },
    ],
  },
  {
    check: 'checkerGraphProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (options) => checkerGraphProblems(options),
    subjects: ['scripts/'],
    invokers: [
      'scripts/ci/gate-selftest.mjs',
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'a check about self-reference that is only witnessed by its own subjects would be the joke it is trying to stop',
    // Every case here hands in its own registry. Letting one of them fall back
    // to `ENFORCEMENT` would make this row's contract run this row's contract,
    // which is not a subtle bug — it is an unkillable process — but it is worth
    // saying out loud that a registry of checks that includes the registry
    // checker has exactly one shape that terminates.
    contract: (graph, { root }) => [
      ...expectProblem(
        graph({ root, registry: [HEALTHY_ROW] }).length === 0,
        'it reports problems about a row that satisfies every rule in it',
      ),
      ...expectProblem(
        graph({ root, registry: [SELF_ENFORCING_ROW] }).some((problem) =>
          /Sole enforcer, sole exception/.test(problem),
        ),
        'it accepts a check whose only witness is one of its own subjects — the round-5 graph exactly',
      ),
      ...expectProblem(
        graph({
          root,
          registry: [{ ...HEALTHY_ROW, definedIn: 'scripts/ci/compose.mjs' }],
        }).some((problem) => /exports no such name/.test(problem)),
        'it accepts a row that names a module the check does not come from — which is what `sharedModuleProblems` counts and what the witness set excludes',
      ),
      ...expectProblem(
        graph({ root, registry: [{ ...HEALTHY_ROW, mutants: [] }] }).some((problem) =>
          /no mutants/.test(problem),
        ),
        'it accepts a row whose contract nothing can fail',
      ),
      ...expectProblem(
        graph({
          root,
          // Calls what it was handed, and asserts nothing about the answer.
          registry: [
            {
              ...HEALTHY_ROW,
              contract: (scan) => {
                scan();
                return [];
              },
            },
          ],
        }).some((problem) => /does not reject the mutant/.test(problem)),
        'it accepts a contract that reports nothing about a deliberately wrong implementation — the shape a fixture takes when it ignores what it was handed and calls the real function by name',
      ),
      ...expectProblem(
        graph({ root, registry: [{ ...HEALTHY_ROW, contract: () => [] }] }).some((problem) =>
          /never called the implementation it was handed/.test(problem),
        ),
        'it accepts a contract that never runs the check at all — `(fn) => fn === theRealOne ? [] : ["wrong"]` is clean for the implementation and loud for every mutant while asserting nothing whatsoever, and it passes every other rule here',
      ),
      ...expectProblem(
        graph({
          root,
          // Every mutant refuses to run at all, so each is "rejected" by its own
          // shape and the contract is never asked anything.
          registry: [
            {
              ...HEALTHY_ROW,
              mutants: [
                {
                  name: 'throws the moment it is called',
                  fn: () => {
                    throw new Error('no');
                  },
                },
              ],
            },
          ],
        }).some((problem) =>
          /rejected by throwing rather than by anything the contract checked/.test(problem),
        ),
        'it accepts a row whose only mutant is rejected by throwing, which tests the mutant rather than the contract',
      ),
    ],
    mutants: [
      { name: 'gutted to `return []`', fn: () => [] },
      { name: 'stuck reporting on everything', fn: () => ['a problem'] },
    ],
  },
  {
    check: 'assertedNames',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (path, source) => assertedNames(path, source),
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'this is what decides who witnesses every other row, so a version of it that counts everything makes the whole table an ornament — which is what round 6 shipped, counting a bare call as a witness',
    contract: (asserted) => [
      ...expectProblem(
        asserted('f.test.ts', `it('x', () => { expect(${CHECK}('scripts')).toEqual([]); });`).has(
          CHECK,
        ),
        'it does not count an `expect` over a live call in a real test, which would make the rule a ban on witnesses',
      ),
      ...DEAD_POSITIONS.flatMap(([where, source]) =>
        expectProblem(
          !asserted('f.test.ts', source).has(CHECK),
          `it counts a call ${where}, which cannot assert anything`,
        ),
      ),
    ],
    mutants: [
      { name: 'counts every name it sees', fn: () => new Set([CHECK]) },
      { name: 'counts nothing', fn: () => new Set() },
    ],
  },
  {
    check: 'sharedModuleProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (root, read, list, registry) => sharedModuleProblems(root, read, list, registry),
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'this is the rule that makes the *next* centralisation loud, so a version of it that reports nothing puts the repository back where round 6 left it: a helper extracted, fifteen callers depending on it, and no test outside scripts/ that runs it',
    contract: (sweep, { root }) => [
      ...expectProblem(
        sweep(root).length === 0,
        'it reports a shared module with no row against the real tree, where every one has a row',
      ),
      ...expectProblem(
        sweep(
          root,
          readFileSync,
          readdirSync,
          ENFORCEMENT.filter((entry) => entry.definedIn !== 'scripts/ci/main-module.mjs'),
        ).some((problem) => /main-module\.mjs is imported by/.test(problem)),
        "it says nothing when the round-7 finding's own predicate has no row, which is the state that cost 358 assertions",
      ),
    ],
    mutants: [
      { name: 'sweeps nothing', fn: () => [] },
      { name: 'reports every module', fn: () => ['a module'] },
    ],
  },
  {
    check: 'checkWorkflowFile',
    definedIn: 'scripts/ci/workflow-policy.mjs',
    fn: checkWorkflowFile,
    subjects: ['.github/workflows/'],
    invokers: [
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'the policy engine reads the workflow; the workflow decides whether the policy engine runs. Neither can be the only witness for the other',
    contract: (policy, { root, read }) => [
      ...expectProblem(
        policy(String(read(join(root, `${WORKFLOW_DIRECTORY}/ci.yml`), 'utf8')), 'ci.yml')
          .length === 0,
        'it reports violations about the real ci.yml, which is clean',
      ),
      ...expectProblem(
        policy(
          'name: probe\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n    steps:\n      - run: echo hi\n',
          'probe.yml',
        ).length > 0,
        'it says nothing about a workflow with `continue-on-error: true` on a job',
      ),
    ],
    mutants: [
      { name: 'gutted to `return []`', fn: () => [] },
      { name: 'stuck reporting on everything', fn: () => [{ rule: 'x', message: 'y' }] },
    ],
  },
  {
    check: 'protectedCommandCoverage',
    definedIn: 'scripts/ci/workflow-policy.mjs',
    fn: protectedCommandCoverage,
    subjects: ['.github/workflows/'],
    invokers: [
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because: 'same graph as checkWorkflowFile, and it is the rule with the widest blast radius',
    contract: (coverage, { root, read }) => {
      const jobs =
        parseYaml(String(read(join(root, `${WORKFLOW_DIRECTORY}/ci.yml`), 'utf8')))?.jobs ?? {};
      return [
        ...expectProblem(
          coverage(jobs).length === 0,
          'it reports gaps in the real workflow, whose protected verbs are all covered',
        ),
        ...expectProblem(
          coverage(jobs, []).length > 0,
          'it says nothing when the protected command set is emptied — the mutation the policy self-test runs',
        ),
      ];
    },
    mutants: [
      { name: 'gutted to `return []`', fn: () => [] },
      { name: 'stuck reporting on everything', fn: () => ['a gap'] },
    ],
  },
  {
    check: 'scanForExpectedFailures',
    definedIn: 'scripts/ci/scan-expected-failures.mjs',
    fn: scanForExpectedFailures,
    subjects: ['packages/', 'apps/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'its subjects are the test files, and every witness is outside them — this row is here as the control: it is what a healthy graph looks like. `assert-vitest-report.mjs` calls it and is *not* listed: it consumes the answer rather than asserting on it, which round 6 would have counted and round 7 does not',
    contract: (scan) => [
      ...expectProblem(
        scan(['x.test.ts'], () => "import { it } from 'vitest';\nit('a', () => {});\n").findings
          .length === 0,
        'it finds an expected-failure annotation in a test file that has none',
      ),
      ...expectProblem(
        scan(['x.test.ts'], () => "import { it } from 'vitest';\nit.fails('a', () => {});\n")
          .findings.length > 0,
        'it says nothing about a literal `it.fails`, which is a test that passes by failing',
      ),
    ],
    mutants: [
      { name: 'gutted to no findings', fn: () => ({ findings: [] }) },
      { name: 'stuck finding everything', fn: () => ({ findings: [{ file: 'x' }] }) },
    ],
  },
  {
    // The exit status of six of the deploy job's assertion scripts.
    check: 'verdict',
    definedIn: 'scripts/ci/stack-client.mjs',
    fn: { check, compared, verdict, failures, resetFailures, runtimeFloorProblems },
    subjects: ['scripts/'],
    invokers: ['packages/ci-guard/test/checkers.test.ts'],
    because:
      "`report()` is the last statement of six deploy assertions, so `check(false, …)` that records nothing, or a verdict that returns 0 with failures recorded, turns six red gates green in one edit — and every count claim in every receipt stays true. It is the round-7 critical finding's class one function over: a decision centralised for many callers, tested by none of them. Round 10 put the runtime floors in the same place, for the same reason: `compared` is what a fold over a computed population records, and a version of it that records nothing puts every loop-driven assertion back to a source floor of 1 that comparing nothing satisfies",
    contract: (client) => {
      // `verdict` prints, and a contract probe's output in the middle of a
      // self-test's is a receipt nobody can read. Muted for the two calls only.
      const speech = { error: console.error, info: console.info };
      console.error = () => {};
      console.info = () => {};
      let returned;
      let afterFalse;
      let failing;
      let afterTrue;
      let passing;
      let counted;
      let shortRun;
      let longEnough;
      try {
        client.resetFailures();
        returned = client.check(false, 'a planted failure');
        afterFalse = client.failures.length;
        failing = client.verdict('probe');
        client.resetFailures();
        client.check(true, 'a satisfied assertion');
        afterTrue = client.failures.length;
        passing = client.verdict('probe');
        client.resetFailures();
        // The runtime half: a fold that examined forty subjects records forty
        // assertions, and a run below its floor is a failure rather than a pass.
        counted = client.compared(40, 'a comparison over forty subjects');
        const floors = (entry) => () => ({ floors: entry });
        shortRun = client.runtimeFloorProblems(
          'probe',
          { assertions: 1, requests: 0 },
          floors({ minRun: 230 }),
        );
        longEnough = client.runtimeFloorProblems(
          'probe',
          { assertions: 260, requests: 25 },
          floors({ minRun: 230, minRequests: 18 }),
        );
        client.resetFailures();
      } finally {
        console.error = speech.error;
        console.info = speech.info;
      }
      return [
        ...expectProblem(afterFalse === 1, 'a failed `check` records nothing, so nothing can fail'),
        ...expectProblem(returned === false, '`check` does not return the condition it was given'),
        ...expectProblem(
          failing === 1,
          'the verdict over a recorded failure is not a failing exit',
        ),
        ...expectProblem(afterTrue === 0, 'a satisfied `check` records a failure anyway'),
        ...expectProblem(passing === 0, 'the verdict over a clean run is not a passing exit'),
        ...expectProblem(
          counted === 40,
          '`compared` does not report back the population it was told about, so a caller cannot pass the count through',
        ),
        ...expectProblem(
          shortRun.some((problem) => /recorded 1 assertion\(s\) in this run/.test(problem)),
          'a run that made one assertion where the manifest says two hundred and thirty is not reported, which is the r10 D2 gutting exactly',
        ),
        ...expectProblem(
          longEnough.length === 0,
          'a run that did the work is reported anyway, which makes the floor noise rather than a gate',
        ),
      ];
    },
    // Four names, one decision: `check` records, `failures` holds, `verdict`
    // reads, `resetFailures` clears, and the contract above exercises all four.
    // Declared, because `sharedModuleProblems` counts *bindings* now and a row
    // that covered its module wholesale is how a new shared decision arrives in
    // an already-rowed file with nothing to test it.
    covers: ['check', 'compared', 'verdict', 'failures', 'resetFailures', 'runtimeFloorProblems'],
    mutants: [
      {
        name: 'a `check` that records nothing',
        fn: {
          check: () => false,
          compared,
          verdict,
          failures,
          resetFailures,
          runtimeFloorProblems,
        },
      },
      {
        name: 'a verdict that always passes',
        fn: { check, compared, verdict: () => 0, failures, resetFailures, runtimeFloorProblems },
      },
      {
        name: 'a verdict that always fails',
        fn: { check, compared, verdict: () => 1, failures, resetFailures, runtimeFloorProblems },
      },
      {
        name: 'a run floor nothing is ever under',
        fn: {
          check,
          compared,
          verdict,
          failures,
          resetFailures,
          runtimeFloorProblems: () => [],
        },
      },
      {
        name: 'a `compared` that swallows the population it was told about',
        fn: { check, compared: () => 0, verdict, failures, resetFailures, runtimeFloorProblems },
      },
    ],
  },
  {
    check: 'stackTarget',
    definedIn: 'scripts/ci/stack-client.mjs',
    fn: stackTarget,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      "every request the deploy job makes is aimed by this one function, so a version of it that answered `http://localhost` would have five assertions cheerfully reporting on a stack nobody deployed — and the whole point of the TLS in this job is that the certificate chain is verified against the deployment's own CA rather than waved through",
    contract: (where, { workspace }) => {
      const ca = join(workspace, 'ca.pem');
      writeFileSync(ca, 'a certificate\n');
      const configured = where({
        ATRIUM_STACK_DOMAIN: 'atrium.localhost',
        ATRIUM_STACK_CA: ca,
        ATRIUM_STACK_HTTPS_PORT: '8443',
      });
      const bare = where({});
      return [
        ...expectProblem(
          configured.origin === 'https://atrium.localhost',
          `it aims at ${configured.origin} rather than at the configured domain over TLS`,
        ),
        ...expectProblem(
          configured.httpsPort === 8443,
          'it ignores ATRIUM_STACK_HTTPS_PORT, so a stack published on another port is unreachable and the failure reads as a broken deployment',
        ),
        ...expectProblem(
          String(configured.ca ?? '').includes('a certificate'),
          "it does not read the deployment's own certificate authority, and an assertion with no CA either trusts the system store — where this certificate is not — or is one flag away from verifying nothing",
        ),
        ...expectProblem(
          bare.ca === undefined && bare.httpsPort === 443 && bare.address === '127.0.0.1',
          'an unset environment does not fall back to the published loopback port with no CA',
        ),
      ];
    },
    mutants: [
      {
        name: 'cleartext against localhost, whatever the environment says',
        fn: () => ({
          domain: 'localhost',
          address: '127.0.0.1',
          httpsPort: 80,
          httpPort: 80,
          origin: 'http://localhost',
        }),
      },
      {
        name: 'the right origin with no certificate authority',
        fn: (env = {}) => ({ ...stackTarget({ ...env, ATRIUM_STACK_CA: '' }) }),
      },
    ],
  },
  {
    check: 'composeArgs',
    definedIn: 'scripts/ci/compose.mjs',
    fn: composeArgs,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'fourteen scripts resolve which stack they are looking at through this one function, and a version of it that dropped an overlay would have the preflight, the boot and every assertion inspecting different stacks while each reported cleanly on the one it saw',
    contract: (args) => {
      const both = args({
        ATRIUM_COMPOSE_PROJECT: 'atrium-ci',
        ATRIUM_COMPOSE_FILES: 'docker-compose.yml:docker-compose.mailpit.yml',
      });
      return [
        ...expectProblem(
          both.join(' ') === '-p atrium-ci -f docker-compose.yml -f docker-compose.mailpit.yml',
          `it resolves the deploy job's two-file list to \`${both.join(' ')}\``,
        ),
        ...expectProblem(
          args({}).join(' ') === '-p atrium -f docker-compose.yml',
          'an unset environment does not fall back to the single base file under the default project',
        ),
      ];
    },
    mutants: [
      { name: 'drops the overlay', fn: () => ['-p', 'atrium-ci', '-f', 'docker-compose.yml'] },
      { name: 'ignores the environment entirely', fn: () => [] },
    ],
  },
  {
    check: 'completedCommands',
    definedIn: 'scripts/ci/shell-command.mjs',
    fn: completedCommands,
    // Both: it *reads* the workflows, and the edit that would break it is in
    // `scripts/`. `subjects` is "where the edit this check is supposed to notice
    // could live", and naming only the workflows would have let a witness under
    // `scripts/` satisfy the outside-witness rule for a parser that lives there.
    subjects: ['scripts/', '.github/workflows/'],
    invokers: ['packages/ci-guard/test/checkers.test.ts'],
    because:
      'every presence rule in workflow-policy.mjs is a predicate over what this returns, so a parser that yields nothing makes every required step read as present-or-absent by accident rather than by reading the script',
    contract: (parse) => {
      const argvOf = (script) => parse(script).map((command) => command.argv.join(' '));
      return [
        ...expectProblem(
          argvOf('echo exec node scripts/ci/x.mjs').join('|') === 'echo exec node scripts/ci/x.mjs',
          'an `echo` of a command does not read as one `echo` with three arguments',
        ),
        ...expectProblem(
          argvOf('node scripts/ci/x.mjs').join('|') === 'node scripts/ci/x.mjs',
          'a plain invocation does not read as itself',
        ),
        ...expectProblem(
          argvOf('git fetch origin &').length === 0,
          'a backgrounded command reads as completed, which is the race the prerequisite rules exist to refuse',
        ),
        ...expectProblem(
          argvOf('# node scripts/ci/x.mjs').length === 0,
          'a comment reads as a command',
        ),
      ];
    },
    mutants: [
      { name: 'parses nothing', fn: () => [] },
      { name: 'returns one command whatever it is given', fn: () => [{ argv: ['node'], raw: [] }] },
    ],
  },
  {
    check: 'readFreshReport',
    definedIn: 'scripts/ci/report-file.mjs',
    fn: readFreshReport,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'this is the runtime half of the freshness pair — the policy half proves the workflow *exports* a run-start, and this proves the report was written after it. A blind critic backdated the export with `date -d -5hours` and a two-hour-stale report reported no problems, so the two halves are checked from the same registry now',
    contract: (fresh, { workspace }) => {
      const path = join(workspace, 'report.json');
      const now = Date.now();
      writeFileSync(path, '{"ok":true}\n');
      const clean = fresh(path, now - 60_000, 'the probe').problems;
      // The critic's exploit, made literal: the report is two hours older than
      // the run whose result it is supposed to be.
      utimesSync(path, (now - 2 * 60 * 60 * 1000) / 1000, (now - 2 * 60 * 60 * 1000) / 1000);
      const stale = fresh(path, now - 60_000, 'the probe').problems;
      return [
        ...expectProblem(
          clean.length === 0,
          'it calls a report written after this run started stale',
        ),
        ...expectProblem(
          stale.some((problem) => /is stale: last written/.test(problem)),
          'it accepts a report written two hours before the run that supposedly produced it',
        ),
        ...expectProblem(
          fresh(join(workspace, 'absent.json'), now, 'the probe').problems.length > 0,
          'a report that was never written reads as an empty run rather than a failed one',
        ),
      ];
    },
    mutants: [
      { name: 'every report is fresh', fn: () => ({ json: {}, problems: [] }) },
      { name: 'every report is stale', fn: () => ({ json: undefined, problems: ['stale'] }) },
    ],
  },
  {
    /**
     * ── TWO IMPORTERS IS UNDER THE THRESHOLD AND OVER THE STAKE (r9) ─────────
     * `SHARED_MODULE_THRESHOLD` is three, and `fail` from report-file.mjs has
     * two importers: `assert-vitest-report.mjs` and `assert-playwright-report.mjs`.
     * A blind critic measured what that costs — `return 1` to `return 0` and
     * **both** report assertions print every problem they found as an
     * `::error::` annotation and exit 0. Two is not a habit and three is; that
     * argument is about when a *number* forces a row, and it was never an
     * argument that a decision under the number is safe. The threshold is not
     * the only thing that may put a binding in this table, and this is the
     * second binding put here by the stake rather than by the count.
     */
    check: 'fail',
    definedIn: 'scripts/ci/report-file.mjs',
    fn: fail,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'it is the exit status of both report gates. `return 0` here prints every problem as a GitHub annotation and exits 0, which is louder on the page than silence and exactly as green — the same shape as the `process.on("exit")` rewrite guard-scan.mjs refuses, one function further in',
    contract: (status) => {
      // Silenced while it runs: `fail` prints `::error::` lines, and a contract
      // that leaves GitHub annotations on a green run is a contract that teaches
      // readers to ignore annotations.
      const said = console.error;
      console.error = () => {};
      try {
        return [
          ...expectProblem(
            status(['a problem'], 'the probe') === 1,
            'a list of problems is not a failing status, so both report gates would annotate their findings and exit 0',
          ),
          ...expectProblem(
            status(['a', 'b'], 'the probe') === 1,
            'two problems are not a failing status either',
          ),
        ];
      } finally {
        console.error = said;
      }
    },
    mutants: [
      { name: 'always green', fn: () => 0 },
      { name: 'green for a single problem', fn: (problems) => (problems.length > 1 ? 1 : 0) },
      { name: 'returns the count rather than a status', fn: (problems) => problems.length },
    ],
  },
  {
    check: 'manifestPath',
    definedIn: 'scripts/ci/record-built-images.mjs',
    fn: manifestPath,
    subjects: ['scripts/'],
    invokers: ['packages/ci-guard/test/checkers.test.ts'],
    because:
      'the image-identity chain is "what was built" compared against "what is running", and both halves find each other through this path; a default here rather than a hard error is how a stale manifest from an earlier run becomes the thing every later assertion agrees with',
    contract: (where) => {
      let threw = false;
      try {
        where({});
      } catch {
        threw = true;
      }
      return [
        ...expectProblem(threw, 'an unset ATRIUM_IMAGE_MANIFEST resolves to some default'),
        ...expectProblem(
          where({ ATRIUM_IMAGE_MANIFEST: '/tmp/probe.json' }) === '/tmp/probe.json',
          'it does not return the path the environment names',
        ),
      ];
    },
    mutants: [
      { name: 'a silent default', fn: () => '/tmp/images.json' },
      {
        name: 'always throws',
        fn: () => {
          throw new Error('no');
        },
      },
    ],
  },
  {
    /**
     * #40 round 9, D1. The rule that a control's expectation must be about a
     * behaviour, made a function so it can be run over the shipped table.
     */
    check: 'expectationProblems',
    definedIn: 'scripts/ci/positive-control.mjs',
    fn: (controls) => expectationProblems(controls),
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'round 8\'s three deploy controls each expected `/assert-page-serves/` — the script\'s own name, which every Node stack trace supplies for free. Measured on r8 as committed: the control was scored "red as required" against an `ENOENT` for a certificate authority the job does not write until six steps later, so it proved the assertion went red because a file was missing and never because the deployment was missing. A version of this that reports nothing puts every control back to being satisfied by any red at all',
    contract: (rule) => {
      const identity = {
        deploy: [
          { id: 'assert-x', entry: 'assert-x', expect: /assert-x/, world: 'w', because: 'b' },
        ],
      };
      const behaviour = {
        deploy: [
          {
            id: 'assert-x',
            entry: 'assert-x',
            // The sentence the *planted* world produces. `/assert-x: \d+
            // assertion\(s\) failed\./` was here until round 10's D6: that is
            // the line `verdict` prints for any recorded failure whatever, so it
            // was a pattern about the file rather than about the world, and
            // `preconditionReds` generates it into the corpus now.
            expect: /assert-x: nothing is serving this deployment/,
            world: 'w',
            because: 'b',
          },
        ],
      };
      const count = {
        deploy: [
          {
            id: 'assert-x',
            entry: 'assert-x',
            expect: /assert-x: \d+ assertion\(s\) failed\./,
            world: 'w',
            because: 'b',
          },
        ],
      };
      return [
        ...expectProblem(
          rule(count).some((problem) => /is satisfied by/.test(problem)),
          'it accepts an expectation that is only a count of failures, which any red in that file satisfies — the round-10 D6 finding, on two shipped controls',
        ),
        ...expectProblem(
          rule(behaviour).length === 0,
          'it reports a problem about an expectation that matches the sentence an assertion records, which is the shape every control here is meant to have',
        ),
        ...expectProblem(
          rule(identity).some((problem) => /satisfied by a Node stack trace/.test(problem)),
          "it accepts an expectation that is just the script's own name — the round-8 defect verbatim, and the reason three controls were green against a missing file",
        ),
        ...expectProblem(
          rule({ deploy: [{ id: 'assert-x', entry: 'assert-x', world: 'w', because: 'b' }] }).some(
            (problem) => /no `expect` regular expression/.test(problem),
          ),
          'it accepts a control with no expectation at all, which any non-zero exit satisfies',
        ),
        ...expectProblem(
          rule(CONTROLS).length === 0,
          'it reports a problem about the shipped control table, which must be clean',
        ),
      ];
    },
    mutants: [
      { name: 'accepts every expectation', fn: () => [] },
      { name: 'rejects every expectation', fn: () => ['a problem'] },
      {
        name: 'only checks the empty string — the identity match, unopposed',
        fn: (controls) =>
          Object.values(controls).flatMap((rows) =>
            rows.flatMap((row) => (row.expect?.test('') ? ['matches the empty string'] : [])),
          ),
      },
    ],
  },
  {
    /**
     * #40 round 9, D1. What the cold world says instead of crashing.
     */
    check: 'absentDeployment',
    definedIn: 'scripts/ci/stack-client.mjs',
    fn: absentDeployment,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'three stack assertions used to die at module scope with an unhandled `ENOENT` or `ECONNREFUSED`, and their positive controls matched the script name in the stack trace rather than anything either script said. This is the sentence that made the cold world a recorded failure instead of a crash, so a version of it that returns `undefined` puts all three controls back to proving nothing — and, worse, lets the real assertions run against a target they never confirmed exists',
    contract: (absent) => {
      const target = {
        origin: 'https://atrium.localhost',
        address: '127.0.0.1',
        httpsPort: 443,
        domain: 'atrium.localhost',
      };
      return [
        ...expectProblem(
          absent(target, { response: { status: 200 } }) === undefined,
          'it calls a deployment that answered with a status absent',
        ),
        ...expectProblem(
          /nothing is serving this deployment/.test(
            String(absent(target, { error: { code: 'ECONNREFUSED' } })),
          ),
          'it says nothing about a connection nothing accepted, which is the whole cold world',
        ),
        ...expectProblem(
          /ATRIUM_STACK_CA/.test(
            String(absent({ ...target, caProblem: 'ATRIUM_STACK_CA points at x' }, {})),
          ),
          "it ignores a certificate authority that could not be read — the state the deploy job is in at step 4, and the one round 8's controls were accidentally matching",
        ),
        ...expectProblem(
          absent(target, { response: {} }) !== undefined,
          'it treats an answer with no status as a deployment that is there, so anything that resolves at all would satisfy the precondition',
        ),
      ];
    },
    mutants: [
      { name: 'always says the deployment is there', fn: () => undefined },
      { name: 'always says it is absent', fn: () => 'gone' },
      {
        name: 'ignores an unreadable certificate authority',
        fn: (target, outcome) => absentDeployment({ ...target, caProblem: undefined }, outcome),
      },
    ],
  },
  {
    /**
     * ── A DEBT ENTRY WHOSE REASON WAS FALSE (#40 round 9) ────────────────────
     * `mailpit` sat in `UNCONTRACTED` under "it talks to the mail catcher the
     * overlay adds; with no overlay there is nothing to talk to". A blind critic
     * read the function: it does no I/O at all. It resolves one environment
     * variable to a base URL and returns an object of closures — which is
     * exactly the shape the `composeArgs` row eleven lines away already
     * contracts. Its stated witness was worse than the reason: it cited a ledger
     * case in which the stack never boots, so `mailpit()` is provably never
     * called on that path.
     *
     * An exemption list is only honest if every entry in it is true. This one
     * was the entry that made the list an excuse, so it is a row instead.
     */
    check: 'mailpit',
    definedIn: 'scripts/ci/stack-client.mjs',
    fn: mailpit,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'three assertions reach the mail relay through it, and the address it resolves is the difference between reading the message this run sent and waiting for one that went somewhere else. `ATRIUM_MAILPIT_URL` unset must mean the published port on this box, not a silent empty base that turns every fetch into a relative URL',
    contract: (relay) => [
      ...expectProblem(
        relay({}).base === 'http://127.0.0.1:8025',
        'with no ATRIUM_MAILPIT_URL it does not resolve the published mail port, so every assertion that reads the mail is asking a URL nobody serves',
      ),
      ...expectProblem(
        relay({ ATRIUM_MAILPIT_URL: 'http://relay:8025' }).base === 'http://relay:8025',
        'it ignores ATRIUM_MAILPIT_URL, so the overlay cannot move the relay',
      ),
      ...expectProblem(
        relay({ ATRIUM_MAILPIT_URL: '   ' }).base === 'http://127.0.0.1:8025',
        'it takes a blank ATRIUM_MAILPIT_URL as an address, which is the value-vs-presence defect this repository has now made four times',
      ),
      ...expectProblem(
        typeof relay({}).get === 'function' && typeof relay({}).deleteAll === 'function',
        'it does not hand back both of the operations the signup assertion needs',
      ),
    ],
    mutants: [
      { name: 'a silent empty base', fn: () => ({ base: '', get: () => {}, deleteAll: () => {} }) },
      {
        name: 'ignores the environment',
        fn: () => ({ base: 'http://127.0.0.1:8025', get: () => {}, deleteAll: () => {} }),
      },
      {
        name: 'trims nothing, so a blank variable becomes the address',
        fn: (env = process.env) => ({
          base: env.ATRIUM_MAILPIT_URL ?? 'http://127.0.0.1:8025',
          get: () => {},
          deleteAll: () => {},
        }),
      },
    ],
  },
  {
    // #40 round 8, D3. The only check here whose subject is the other checks'
    // *behaviour* rather than their text.
    check: 'controlProblems',
    definedIn: 'scripts/ci/positive-control.mjs',
    fn: controlProblems,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'no rule about the text of a file can tell an assertion from a shape that looks like one — `assert-page-serves.mjs` replaced by `report(…)` printed "passed." and exited 0 with no stack running, and every syntactic gate here stayed green. This is the one thing that says no, so a version of it that accepts an exit of 0 puts the whole deploy job back to being a list of scripts nobody ran',
    contract: (grade) => {
      const control = {
        id: 'assert-x',
        world: 'nothing is running',
        expect: /assert-x: \d+ assertion\(s\) failed\./,
        because: 'a probe',
      };
      const red = { status: 1, output: 'assert-x: 3 assertion(s) failed.\n' };
      return [
        ...expectProblem(
          grade(control, red).length === 0,
          'it reports a control that failed, visibly, for the reason it planted',
        ),
        ...expectProblem(
          grade(control, { status: 0, output: 'assert-x: passed.\n' }).some((problem) =>
            /exited 0 when/.test(problem),
          ),
          'it accepts an entry point that exits 0 in a world it cannot have checked — the measured D3 exploit exactly, and the one thing this check exists for',
        ),
        ...expectProblem(
          grade(control, { status: 1, output: 'command not found: docker\n' }).some((problem) =>
            /did not visibly fail for the reason this control planted/.test(problem),
          ),
          'it accepts any red at all, so a runner with no docker would read as every assertion working',
        ),
        ...expectProblem(
          grade(control, {
            status: undefined,
            output: '',
            error: { code: 'ETIMEDOUT', killed: true },
          }).some((problem) => /did not reach a verdict/.test(problem)),
          "it reads a child killed by its own timeout as a control that came back red — the ledger's CAUGHT-vs-crashed defect, one file over",
        ),
      ];
    },
    mutants: [
      { name: 'grades everything as satisfied', fn: () => [] },
      { name: 'grades everything as broken', fn: () => ['a problem'] },
      {
        name: 'accepts an exit of 0 — the D3 exploit, unopposed',
        fn: (control, outcome) => (outcome.status === 0 ? [] : controlProblems(control, outcome)),
      },
    ],
  },
  {
    /**
     * #40 round 9. The half of the anti-gutting argument the cold control
     * cannot reach: a script cut down to its `requireDeployment` precondition
     * goes red in a world with no deployment exactly like the real one.
     */
    check: 'assertionFloorProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (root, read, list) => assertionFloorProblems(root, read, list),
    subjects: ['scripts/', '.github/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'the measured exploit is twenty lines that keep every import and every `report(…)` and delete the forty-eight `check(…)` calls between them. The positive control proves the script is a function of the world; this is what proves it still makes the assertions it is credited with, and it is the only thing that does',
    contract: (floors, { root, read }) => {
      const bare = (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({ vitest: { workspaces: {} } })
          : read(path, encoding);
      const impossible = (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({
              assertions: { scripts: { 'scripts/ci/assert-page-serves.mjs': { minChecks: 9999 } } },
            })
          : read(path, encoding);
      const departed = (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({
              assertions: { scripts: { 'scripts/ci/assert-gone.mjs': { minChecks: 1 } } },
            })
          : read(path, encoding);
      return [
        ...expectProblem(
          floors(root, read).length === 0,
          'it reports a problem against the real tree, where every script that records assertions has a floor it meets',
        ),
        ...expectProblem(
          floors(root, bare).some((problem) => /no `assertions.scripts` object/.test(problem)),
          'a manifest with the whole table deleted reads as every script being held to a floor',
        ),
        ...expectProblem(
          floors(root, impossible).some((problem) =>
            /recorded assertion\(s\) and .* declares a floor of/.test(problem),
          ),
          'a script that makes fewer assertions than its floor is not reported, which is the gutting itself',
        ),
        ...expectProblem(
          floors(root, departed).some((problem) =>
            /does not record assertions through `check`/.test(problem),
          ),
          'a floor over a script that no longer records anything reads as protection',
        ),
      ];
    },
    mutants: [
      { name: 'every floor is met', fn: () => [] },
      { name: 'no floor is ever met', fn: () => ['a floor'] },
      {
        name: 'only checks the table exists, never the counts',
        fn: (root, read) => {
          try {
            const manifest = JSON.parse(String(read(join(root, MANIFEST), 'utf8')));
            return manifest?.assertions?.scripts === undefined ? ['no table'] : [];
          } catch {
            return ['unreadable'];
          }
        },
      },
    ],
  },
  {
    /**
     * #40 round 10, D3. The half neither the cold control nor a count can
     * reach: an assertion script that satisfies its precondition and then
     * asserts nothing, by asserting constants.
     */
    check: 'assertionConditionProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (root, read, list) => assertionConditionProblems(root, read, list),
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'the measured exploit keeps the imports, keeps `requireDeployment`, keeps `report(…)` and makes twenty-three assertions about the constant `true` — which prints "assert-page-serves: passed." against the live stack and satisfies every floor exactly, because a floor counts assertions and cannot tell a claim from a constant',
    contract: (conditions, { root, read, list }) => {
      const planted = (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, report } from './stack-client.mjs';\ncheck(true, 'x');\nreport('assert-page-serves');\n"
          : read(path, encoding);
      const named = (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, report } from './stack-client.mjs';\nconst FINE = true;\ncheck(FINE, 'x');\nreport('assert-page-serves');\n"
          : read(path, encoding);
      const folded = (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, report } from './stack-client.mjs';\nfor (const problem of []) check(false, problem);\nreport('assert-page-serves');\n"
          : read(path, encoding);
      return [
        ...expectProblem(
          conditions(root, read, list).length === 0,
          'it reports a problem against the real tree, where every recorded assertion reads something',
        ),
        ...expectProblem(
          conditions(root, planted, list).some((problem) => /reads no value/.test(problem)),
          'the measured D3 exploit — `check(true, …)` — is not reported, which is the whole rule',
        ),
        ...expectProblem(
          conditions(root, named, list).some((problem) => /reads no value/.test(problem)),
          'the same tautology with a module-scope constant in front of it walks through, which is one extra line',
        ),
        ...expectProblem(
          conditions(root, folded, list).length === 0,
          '`check(false, problem)` is reported — the form every fold over an already-computed problem list uses, which cannot make a script pass and must not be refused',
        ),
        ...expectProblem(
          conditions(
            root,
            (path, encoding) =>
              String(path).endsWith('assert-page-serves.mjs')
                ? "import { check, compared, report } from './stack-client.mjs';\ncompared(40, 'nothing at all');\nreport('assert-page-serves');\n"
                : read(path, encoding),
            list,
          ).some((problem) => /reads no value/.test(problem)),
          "a fold that reports a literal count of comparisons walks through, which is the run floor's own version of `check(true, …)` and the exact plant the `selfcheck` group uses to make a control come back green",
        ),
      ];
    },
    mutants: [
      { name: 'every condition reads something', fn: () => [] },
      { name: 'no condition ever reads anything', fn: () => ['a condition'] },
      {
        name: 'refuses only the literal `true`, so any other constant walks through',
        fn: (root, read, list) =>
          assertionConditionProblems(root, read, list).filter((problem) =>
            /\(`true`\)/.test(problem),
          ),
      },
    ],
  },
  {
    // The attack on `controlProblems`'s own scope sentence: take a script out of
    // the table and the control step still passes, with the script back to being
    // unproven. Found attacking this round's own fix.
    check: 'controlCoverageProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    fn: (root, read, controls) => controlCoverageProblems(root, read, controls),
    subjects: ['scripts/', '.github/workflows/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'the positive controls are a table in the same commit as the scripts they control, so a one-line deletion puts an assertion back to being unproven with every gate green. The set that has to be covered is read out of the workflow instead — and this found a real gap the moment it was written: assert-migration-image.mjs had no control at all',
    contract: (coverage, { root, read }) => [
      ...expectProblem(
        coverage(root, read).length === 0,
        'it reports a gap against the real workflow, where every assertion the deploy job runs is controlled or exempted with a reason',
      ),
      ...expectProblem(
        coverage(root, read, { deploy: [] }).some((problem) =>
          /no positive control .* ever requires it to fail/.test(problem),
        ),
        'it says nothing when the control table is emptied, which is the one-line edit that puts every stack assertion back to being unproven',
      ),
    ],
    mutants: [
      { name: 'sees no gaps', fn: () => [] },
      { name: 'sees nothing but gaps', fn: () => ['a gap'] },
    ],
  },
  {
    // #40 round 8, D5. Two importers and no row, and its `notAVerdict` is the
    // whole CAUGHT-vs-crashed distinction for the deploy mutation ledger — the
    // round-5 defect's own fix, whose only witness was gate-selftest.mjs, inside
    // scripts/. `positive-control.mjs` is the third importer, so the threshold
    // rule below now demands this row rather than a person remembering it.
    check: 'notAVerdict',
    definedIn: 'scripts/ci/child-verdict.mjs',
    fn: notAVerdict,
    subjects: ['scripts/'],
    // Not `positive-control.mjs`, which *calls* it: presence is not use, and a
    // call inside a function this file never asserts on is the round-6 defect
    // this rule was written for.
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      "the ledger reads `!ok` as 'this stage went red', so a child killed by a timeout, an out-of-memory kill, or a binary that was not on PATH is written down as CAUGHT — an assertion credited with a verdict it never reached. A version of this that returns undefined turns every crash into agreement, in the file whose whole subject is telling those apart",
    contract: (why) => {
      const cases = [
        ['a child that exited by itself', { status: 7 }, undefined],
        [
          'a child killed by the caller’s own timeout',
          { status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' },
          /killed by this ledger's own/,
        ],
        [
          'a child the kernel killed',
          { status: null, signal: 'SIGKILL' },
          /killed by SIGKILL rather than exiting on its own/,
        ],
        [
          'a binary that does not exist',
          { status: null, signal: null, code: 'ENOENT' },
          /never started/,
        ],
      ];
      return cases.flatMap(([what, error, expected]) => {
        const answer = why(error, 420_000);
        if (expected === undefined) {
          return expectProblem(
            answer === undefined,
            `it calls ${what} something other than a verdict, so a real disagreement would be reported as a crash`,
          );
        }
        return expectProblem(
          typeof answer === 'string' && expected.test(answer),
          `it reads ${what} as the child's verdict, which credits an assertion with an answer nothing observed`,
        );
      });
    },
    mutants: [
      { name: 'every failure is a verdict', fn: () => undefined },
      { name: 'no failure is ever a verdict', fn: () => 'not a verdict' },
      {
        name: 'the documented-but-wrong reading: `killed` as the timeout flag',
        fn: (error) => (error?.killed === true ? 'timed out' : undefined),
      },
    ],
  },
  {
    check: 'repoRoot',
    definedIn: 'scripts/ci/repo-root.mjs',
    fn: repoRoot,
    subjects: ['scripts/'],
    invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
    because:
      'every path these scripts read is resolved against what this returns, so a version that answers `/` makes every scan read an empty tree and report it clean — and `checkReadmeClaims` used to catch its own `readFileSync` and return `[]`, which is that failure already having happened once, quietly, from the wrong working directory',
    contract: (root, { workspace }) => {
      const tree = join(workspace, 'repo-root-probe');
      const nested = join(tree, 'packages', 'x', 'src');
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(tree, '.github', 'workflows'), { recursive: true });
      mkdirSync(join(tree, 'scripts', 'ci'), { recursive: true });
      writeFileSync(join(tree, 'pnpm-workspace.yaml'), 'packages:\n');
      let threw = false;
      try {
        root(join(workspace, 'nowhere-near-a-repository'));
      } catch {
        threw = true;
      }
      return [
        ...expectProblem(
          root(nested) === tree,
          'it does not walk up from a nested directory to the root that holds every marker',
        ),
        ...expectProblem(root(tree) === tree, 'it does not recognise the root when handed it'),
        ...expectProblem(
          threw,
          'a directory with no repository above it resolves to something anyway, so every scan below it reads an empty tree and calls it clean',
        ),
      ];
    },
    mutants: [
      { name: 'always the filesystem root', fn: () => '/' },
      { name: 'always whatever it was handed', fn: (from) => from },
    ],
  },
  {
    check: 'requireFrom',
    definedIn: 'scripts/ci/import-from.mjs',
    fn: requireFrom,
    subjects: ['scripts/'],
    invokers: ['packages/ci-guard/test/checkers.test.ts'],
    because:
      "the schema reflection and the Playwright gates load their dependencies through this so that the instance doing the work is the workspace's own; a version that resolved from the repo root would reflect one drizzle against a schema built by another and call the mismatch a clean run",
    contract: (from, { root }) => {
      let threw = false;
      try {
        from(root, './nothing-of-this-name-exists.cjs');
      } catch {
        threw = true;
      }
      return [
        ...expectProblem(
          typeof from(root, 'node:path').join === 'function',
          'it cannot resolve a module that certainly exists',
        ),
        ...expectProblem(threw, 'a specifier that resolves to nothing comes back as something'),
      ];
    },
    mutants: [
      { name: 'resolves everything to an empty object', fn: () => ({}) },
      {
        name: 'resolves nothing',
        fn: () => {
          throw new Error('no');
        },
      },
    ],
  },
];

/** The name every `assertedNames` fixture below asks about. */
const CHECK = 'mainGuardProblems';

/**
 * Call positions that cannot assert anything, as fixtures.
 *
 * Round 6 refused four of these by name and a blind critic counted twenty-one
 * more that walked past — `while (false)`, `describe.each([])`, `xit`, an
 * aliased `const t = it; t.skip(…)`, a never-called function, a labelled break.
 * They are all here, and none of them is refused by a rule of its own:
 * `assertedNames` recognises three assertion shapes and everything else is
 * simply not one of them. The list is a *test* of an allowlist, not the
 * allowlist itself, which is the difference this round is about.
 */
const DEAD_POSITIONS = [
  ['inside `if (false)`', `it('x', () => { if (false) { expect(${CHECK}('s')).toEqual([]); } });`],
  [
    'inside `if (false && true)`',
    `it('x', () => { if (false && true) { expect(${CHECK}('s')); } });`,
  ],
  ['inside `if (1 === 2)`', `it('x', () => { if (1 === 2) { expect(${CHECK}('s')); } });`],
  ['inside `while (false)`', `it('x', () => { while (false) { expect(${CHECK}('s')); } });`],
  ['inside `for (;false;)`', `it('x', () => { for (;false;) { expect(${CHECK}('s')); } });`],
  [
    'inside `for (const x of [])`',
    `for (const x of []) { it('x', () => { expect(${CHECK}('s')); }); }`,
  ],
  ['inside a `catch`', `it('x', () => { try {} catch { expect(${CHECK}('s')); } });`],
  ['in a skipped test', `it.skip('x', () => { expect(${CHECK}('s')).toEqual([]); });`],
  ['in an `xit`', `xit('x', () => { expect(${CHECK}('s')).toEqual([]); });`],
  ['in an `xdescribe`', `xdescribe('x', () => { it('y', () => { expect(${CHECK}('s')); }); });`],
  ['through an aliased runner', `const t = it; t.skip('x', () => { expect(${CHECK}('s')); });`],
  [
    'in a `describe.each([])`',
    `describe.each([])('x', () => { it('y', () => { expect(${CHECK}('s')); }); });`,
  ],
  ['in an `it.each([])`', `it.each([])('x', () => { expect(${CHECK}('s')); });`],
  ['after a `return`', `it('x', () => { return; expect(${CHECK}('s')).toEqual([]); });`],
  ['after a `throw`', `it('x', () => { throw new Error('a'); expect(${CHECK}('s')); });`],
  ['after `process.exit()`', `it('x', () => { process.exit(1); expect(${CHECK}('s')); });`],
  [
    'in the false arm of a ternary',
    `it('x', () => { const y = false ? expect(${CHECK}('s')) : 1; });`,
  ],
  ['in a function nobody calls', `function f() { expect(${CHECK}('s')).toEqual([]); }`],
  ['in an arrow const nobody calls', `const f = () => { expect(${CHECK}('s')).toEqual([]); };`],
  [
    'in a `.then` callback',
    `it('x', () => { Promise.resolve().then(() => expect(${CHECK}('s'))); });`,
  ],
  ['after a labelled break', `it('x', () => { a: { break a; expect(${CHECK}('s')); } });`],
  // The one that matters most: every call counted, zero tests run.
  ['called but never asserted on', `it('x', () => { ${CHECK}('s'); });`],
];

/**
 * A row that satisfies every rule in this file, as a fixture.
 *
 * Self-contained on purpose: its `fn` is a stub and its contract reads only that
 * stub, so running it does not run anything else in the registry. The witnesses
 * are the real ones for `mainGuardProblems`, because the row still has to pass
 * the graph half — "declared witnesses must actually assert on it, and CI must
 * run them" is what makes this a control rather than a tautology.
 *
 * Its `check` therefore names a real function while its `fn` is a stub, which is
 * the very mismatch D3 is about. That is deliberate and it is safe for exactly
 * one reason: this row never reaches the real registry. It is passed to
 * `checkerGraphProblems` as an injected `registry`, so the two halves it
 * exercises are the graph rules (which need a name with real witnesses) and the
 * effect rules (which only ever see `fn`). A row in `ENFORCEMENT` cannot do this
 * — `definedIn` must export `check`, and the contract must call what it is
 * handed.
 */
const HEALTHY_ROW = {
  check: 'mainGuardProblems',
  definedIn: 'scripts/ci/guard-scan.mjs',
  fn: () => ['a problem'],
  subjects: ['scripts/'],
  invokers: [
    'scripts/ci/gate-selftest.mjs',
    'scripts/ci/workflow-policy-selftest.mjs',
    'packages/ci-guard/test/checkers.test.ts',
  ],
  because: 'a healthy row, as a control',
  contract: (scan) => expectProblem(scan().length > 0, 'the fixture check reports nothing'),
  mutants: [{ name: 'gutted', fn: () => [] }],
};

/** The round-5 graph, as a row: one witness, and it is one of the subjects. */
const SELF_ENFORCING_ROW = {
  ...HEALTHY_ROW,
  invokers: ['scripts/ci/gate-selftest.mjs'],
  because: 'the round-5 graph, restored as a fixture',
};

/**
 * `isMainModule`'s whole contract, including the things that are not about its
 * arguments at all.
 *
 * The founding defect of this ticket is in here as a fixture — a checkout path
 * with a space in it, and an invocation through a symlink, both of which the
 * round-4 `import.meta.url === \`file://${process.argv[1]}\`` comparison got
 * wrong and exited 0 over. So is round 7's: the answer must be a function of
 * `(url, argv)` and of nothing else, so the environment is poisoned with the
 * variables GitHub sets and every answer must be unchanged. That case is what a
 * `GITHUB_JOB === 'verify'` early return fails, and it is the only reason this
 * row exists.
 */
function mainModuleContract(isMain, workspace) {
  const plain = join(workspace, 'entry.mjs');
  const spaced = join(workspace, 'with space', 'entry.mjs');
  const linked = join(workspace, 'link.mjs');
  mkdirSync(join(workspace, 'with space'), { recursive: true });
  writeFileSync(plain, '\n');
  writeFileSync(spaced, '\n');
  try {
    symlinkSync(plain, linked);
  } catch {
    // Already there from an earlier row in the same workspace.
  }
  const url = (path) => pathToFileURL(path).href;
  const cases = [
    ['the entry point is this file', () => isMain(url(plain), ['node', plain]) === true],
    ['a different file was the entry point', () => isMain(url(plain), ['node', spaced]) === false],
    ['no entry point at all', () => isMain(url(plain), ['node']) === false],
    ['an empty entry point', () => isMain(url(plain), ['node', '']) === false],
    [
      'a checkout path with a space in it — the founding defect',
      () => isMain(url(spaced), ['node', spaced]) === true,
    ],
    [
      'an invocation through a symlink — the founding defect',
      () => isMain(url(plain), ['node', linked]) === true,
    ],
    [
      'an entry point that is not on disk',
      () => isMain(url(plain), ['node', join(workspace, 'gone.mjs')]) === false,
    ],
  ];
  const problems = cases.flatMap(([what, run]) =>
    expectProblem(run(), `it gets the wrong answer when ${what}`),
  );

  // And the half no argument can express: the answer must not depend on where it
  // is running. This is the round-7 critical finding, as a fixture.
  const POISON = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_JOB: 'verify',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_RUN_ID: '1',
    NODE_ENV: 'production',
  };
  const before = { ...process.env };
  const answers = () => cases.map(([, run]) => run());
  const honest = answers();
  let poisoned;
  try {
    Object.assign(process.env, POISON);
    poisoned = answers();
  } finally {
    // Restored even when a mutant throws. Without the `finally` a fixture that
    // failed halfway would leave this process running under a forged
    // `GITHUB_JOB` for every later row — a probe editing the world it measures,
    // which is the class of thing this file exists to refuse.
    for (const key of Object.keys(POISON)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
  problems.push(
    ...expectProblem(
      honest.every((answer, index) => answer === poisoned[index]),
      "its answer changes when CI's own environment variables are set. `if (process.env.GITHUB_JOB === 'verify') return false;` is one statement in one file, it kills the whole verify job while leaving deploy working, and it was measured to take 176 gate cases and 182 policy mutations out of a completely green build",
    ),
  );
  return problems;
}

/**
 * Every check must behave, and must stop behaving when you replace it.
 *
 * ── WHY THE CHECK IS HANDED IN RATHER THAN REACHED FOR (#40 round 7) ────────
 * Round 6 gave each row a `violate` fixture: an input the check must report on.
 * That closes "a perfect graph over a gutted check" and nothing else, and a
 * blind critic found what it left. `ENFORCEMENT[0]` was `check:
 * 'mainGuardProblems'` with `violate: () => guardProblems(…)` — a fixture for a
 * *different function than the row named*. Gutting `mainGuardProblems` to
 * `return []` left ci-guard at 49 passed; only a subject caught it.
 *
 * The row cannot name one function and probe another now, because it does not
 * get to say which function to probe: `contract` is *handed* `entry.fn`. And a
 * contract that ignores what it is handed and calls the module binding directly
 * is caught too, from the other side — every contract is run again against each
 * declared `mutant`, and a contract that is not reading its argument reports the
 * same `[]` for the mutant as for the real one, which is the failure below.
 *
 * That is this campaign's standing synthesis, one turn further: **provenance is
 * checked by construction, use is checked by mutation, and the thing being
 * mutated has to be the thing the row names.**
 */
function effectProblems(registry, context) {
  const problems = [];
  for (const entry of registry) {
    if (typeof entry.contract !== 'function') {
      problems.push(
        `${entry.check} has no \`contract\` in the registry, so nothing here proves it still does anything. A check rewritten to \`return []\` satisfies every other rule in this file: defined where the registry says, witnessed from three places, one of them outside its subjects, all of them run by CI — a perfect graph over a rule that is gone.`,
      );
      continue;
    }
    if (entry.fn === undefined || entry.fn === null) {
      problems.push(
        `${entry.check} has no \`fn\` in the registry, so its contract has nothing to be handed and would have to reach for the implementation by name — which is how a row came to name one function and probe another.`,
      );
      continue;
    }
    if (!Array.isArray(entry.mutants) || entry.mutants.length === 0) {
      problems.push(
        `${entry.check} has no mutants declared, so its contract is prose: nothing here shows the contract would notice the check being replaced. Declare at least one deliberate replacement it must reject.`,
      );
      continue;
    }

    // ── AND THE CONTRACT HAS TO *CALL* WHAT IT WAS HANDED ──────────────────
    // Found attacking this round's own fix, which is where D1 came from and is
    // therefore where this round's checklist starts. `contract: (fn) => fn ===
    // mainGuardProblems ? [] : ['not the real one']` satisfies both runs above
    // — clean for the implementation, loud for every mutant — while asserting
    // nothing whatsoever about behaviour. A row is *handed* the check precisely
    // so that it exercises it, so the handing is counted.
    const counted = { calls: 0 };
    let honest;
    try {
      honest = entry.contract(countingProxy(entry.fn, counted), context);
    } catch (error) {
      problems.push(
        `${entry.check}'s contract threw against the real implementation: ${error.stack}`,
      );
      continue;
    }
    if (!Array.isArray(honest)) {
      problems.push(`${entry.check}'s contract did not return a list of problems.`);
      continue;
    }
    if (honest.length > 0) {
      problems.push(
        `${entry.check} does not satisfy its own contract: ${honest.join(' | ')}. Either the implementation regressed or the contract is wrong; both are this file's business.`,
      );
      continue;
    }
    if (counted.calls === 0) {
      problems.push(
        `${entry.check}'s contract never called the implementation it was handed. A contract that only inspects its argument — comparing it against the module binding, say — is clean for the real one and loud for every mutant while asserting nothing about behaviour at all, which passes every other rule in this file.`,
      );
      continue;
    }

    let rejectedByReport = 0;
    for (const mutant of entry.mutants) {
      let reported;
      try {
        reported = entry.contract(mutant.fn, context);
      } catch {
        // A mutant that makes the contract throw is a mutant the contract
        // noticed, in the loudest way available. That counts as rejected — but
        // not towards the requirement below, because a mutant that throws the
        // moment it is called is rejected by its own shape rather than by
        // anything the contract asserts.
        continue;
      }
      if (!Array.isArray(reported) || reported.length === 0) {
        problems.push(
          `${entry.check}'s contract does not reject the mutant "${mutant.name}" — it reported nothing about an implementation that is deliberately wrong. Either the contract asserts nothing about the behaviour that mutant changes, or it is ignoring the implementation it was handed and calling ${entry.check} by name instead, which is how a row came to probe a different function than the one it names.`,
        );
        continue;
      }
      rejectedByReport += 1;
    }
    if (rejectedByReport === 0) {
      problems.push(
        `${entry.check}'s mutants are all rejected by throwing rather than by anything the contract checked. \`fn: () => { throw }\` is refused by its own shape whatever the contract says; declare at least one replacement that returns a plausible wrong answer, which is the shape a real regression takes.`,
      );
    }
  }
  return problems;
}

/**
 * The implementation, wrapped so that "did the contract use it?" is a fact.
 *
 * A row's `fn` is either a function or an object of them (`stack-client.mjs`
 * hands over `check`, `verdict` and the failure list together, because its
 * decision is spread across the three). Both are wrapped the same way, and
 * non-function properties — the `failures` array — are passed through, since a
 * contract reading one of those is reading state the functions produced.
 */
function countingProxy(fn, counted) {
  if (typeof fn === 'function') {
    return (...args) => {
      counted.calls += 1;
      return fn(...args);
    };
  }
  if (typeof fn !== 'object' || fn === null) return fn;
  const wrapped = {};
  for (const [name, value] of Object.entries(fn)) {
    wrapped[name] = typeof value === 'function' ? countingProxy(value, counted) : value;
  }
  return wrapped;
}

const toPosix = (path) => path.split(sep).join(posix.sep);

/** Every source file under the roots, repo-relative and POSIX-spelled. */
export function sourceFiles(root = process.cwd(), list = readdirSync) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = list(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(next);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(next);
    }
  };
  for (const rootDirectory of SOURCE_ROOTS) walk(rootDirectory);
  return found.map(toPosix);
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** The runners whose callback this file will step into, spelled exactly. */
const RUNNERS = new Set(['it', 'test', 'describe', 'suite']);
/** The assertion this file recognises, spelled exactly. */
const ASSERT = 'expect';

/**
 * The names this file *asserts on*, as a set.
 *
 * ── WHY THIS REPLACED `calledNames` (#40 round 7) ───────────────────────────
 * Round 6 asked whether a check is called. A blind critic stripped four
 * `expect(…)` wrappers from `packages/ci-guard` while keeping every call, put
 * round 4's broken guard back into `assert-tables.mjs`, and got **ci-guard 0 →
 * 49 passed** with `assert-vitest-report` reporting "both reports agree test for
 * test". Every count claim stayed true and the main-module rule was gone. The
 * campaign's own lesson — presence is not use — had been applied to the check
 * and not to the witness.
 *
 * ── THREE SHAPES, AND THE COMPLEMENT IS REFUSED ─────────────────────────────
 * A result is asserted on when it reaches one of exactly these:
 *
 *   A. `expect(f(…))` — or `const x = f(…); … expect(x)` in the same block —
 *      inside the callback of `it`/`test`/`describe`/`suite` called by that
 *      bare identifier. Not `it.skip`, not `it.each`, not `xit`, not an alias:
 *      a property access is a different callee and this asks for an identifier.
 *   B. `{ run: () => f(…), expect: … }` — the case-table shape both self-tests
 *      use, where the table's driver compares `run()` against `expect`.
 *   C. `for (const problem of f(…)) { … }` — draining a problem list into
 *      failures, which is what `workflow-policy-selftest.mjs` does.
 *
 * and it is refused everywhere else, by not being one of the three rather than
 * by a rule naming the evasion. That is the same allowlist argument
 * `guard-scan.mjs` makes about the guard itself, applied here because round 6
 * made it there and then wrote a four-shape denylist in this file.
 *
 * Statements after `return`/`throw`/`process.exit()` are not live, and a branch,
 * a loop, a `try` and an uninvoked function body are not entered — so a call
 * needs no rule of its own to be refused for sitting in one. A function is
 * entered only when it is *named and called* from a live position, which is what
 * lets `main()` and `scannerCases()` count while `function f() { … }` that
 * nothing calls does not.
 */
export function assertedNames(path, source) {
  const key = `${path}\u0000${source}`;
  const remembered = ASSERTED_CACHE.get(key);
  if (remembered !== undefined) return remembered;
  const found = assertedNamesUncached(path, source);
  ASSERTED_CACHE.set(key, found);
  return found;
}

/**
 * Content-addressed, because this file reads the same tree several times over.
 *
 * `checkerGraphProblems`'s own contract calls it five more times with fixture
 * registries, and each call parsed every source file under `scripts/`,
 * `packages/` and `apps/` — six full passes over ~190 files. That took the
 * `packages/ci-guard` suite past Vitest's 5s default timeout roughly one run in
 * five on a loaded machine. Found by running the whole suite in a loop rather
 * than by reading it, and worth writing down: the failure was a *timeout*
 * wearing an assertion's clothes, and a gate that goes red one run in five is a
 * gate people rerun until it is green, which is a gate that has stopped being
 * one.
 *
 * Keyed by path *and* content, so a file that changed on disk between calls is a
 * different entry and never a stale answer.
 */
const ASSERTED_CACHE = new Map();

/** The same memo, for the scans that only read a file's declarations. */
const PARSE_CACHE = new Map();

function parseOnce(path, source) {
  const key = `${path}\u0000${source}`;
  let parsed = PARSE_CACHE.get(key);
  if (parsed === undefined) {
    parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, scriptKind(path));
    PARSE_CACHE.set(key, parsed);
  }
  return parsed;
}

function assertedNamesUncached(path, source) {
  const parsed = parseOnce(path, source);
  const names = new Set();

  /** Top-level `function f(){}` and `const f = () => {}`, by name. */
  const declaredFunctions = new Map();
  const collect = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      declaredFunctions.set(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      declaredFunctions.set(node.name.text, node.initializer.body);
    }
    node.forEachChild(collect);
  };
  parsed.forEachChild(collect);
  const entered = new Set();

  /** Statements up to the first one that ends the block. */
  const live = (statements) => {
    const out = [];
    for (const statement of statements) {
      out.push(statement);
      if (terminates(statement)) break;
    }
    return out;
  };

  /** Every name called in `node` without passing through a gate. */
  const calls = (node, into) => {
    const visit = (current) => {
      if (current === undefined) return;
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return;
      if (ts.isConditionalExpression(current)) {
        visit(current.condition);
        return;
      }
      if (ts.isBinaryExpression(current) && LOGICAL.has(current.operatorToken.kind)) {
        visit(current.left);
        return;
      }
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
        into.add(current.expression.text);
      }
      current.forEachChild(visit);
    };
    visit(node);
  };

  /**
   * Every name called on the way to a value, following local helpers.
   *
   * `run: () => scanFixture(files)` asserts on whatever `scanFixture` calls, and
   * `expect(guardScanWith('x', …))` on whatever that wrapper does — the two
   * self-tests and `packages/ci-guard` all reach their checks through one-line
   * helpers, and a rule that stopped at the helper's name would call every one
   * of them a non-witness. The widening is real and stated: a helper's *other*
   * calls are counted too. What closes it is the other half of this file — a row
   * whose check is replaced must make its contract fail, and no amount of
   * incidental call-counting satisfies that.
   */
  const transitiveCalls = (node, into, seen = new Set()) => {
    const local = new Set();
    calls(node, local);
    for (const name of local) {
      into.add(name);
      if (!declaredFunctions.has(name) || seen.has(name)) continue;
      seen.add(name);
      const body = declaredFunctions.get(name);
      if (body === undefined) continue;
      if (ts.isBlock(body)) {
        for (const statement of live(body.statements)) transitiveCalls(statement, into, seen);
      } else {
        transitiveCalls(body, into, seen);
      }
    }
  };

  const walkBody = (body, bindings) => {
    if (body === undefined) return;
    if (!ts.isBlock(body)) {
      walkExpression(body, bindings);
      return;
    }
    walkStatements(body.statements, bindings);
  };

  const walkStatements = (statements, outer) => {
    const bindings = new Map(outer);
    for (const statement of live(statements)) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const bound = new Set();
        calls(declaration.initializer, bound);
        bindings.set(declaration.name.text, { calls: bound, initializer: declaration.initializer });
      }
    }
    for (const statement of live(statements)) walkStatement(statement, bindings);
  };

  const walkStatement = (statement, bindings) => {
    if (ts.isExpressionStatement(statement)) {
      walkExpression(statement.expression, bindings);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        walkExpression(declaration.initializer, bindings);
      }
      return;
    }
    if (ts.isReturnStatement(statement)) {
      walkExpression(statement.expression, bindings);
      return;
    }
    if (ts.isBlock(statement)) {
      walkStatements(statement.statements, bindings);
      return;
    }
    // Shape C: draining a problem list. The loop body has to do something with
    // it — an empty body is a call whose result is thrown away.
    if (ts.isForOfStatement(statement)) {
      const iterated = statement.expression;
      if (
        ts.isCallExpression(iterated) &&
        ts.isIdentifier(iterated.expression) &&
        doesSomething(statement.statement)
      ) {
        names.add(iterated.expression.text);
        return;
      }
      // Shape E: a table driven over a literal list. `for (const [name, source]
      // of evasions) { it(name, …) }` is how both self-tests and
      // `packages/ci-guard` register most of their cases, and a rule that could
      // not see through it would call all of them non-witnesses. The list has to
      // be a *non-empty* array literal, written here or bound at this block's
      // own top level — which is exactly what refuses `for (const x of []) { it(…) }`
      // and, one shape over, `describe.each([])`: zero tests run, and round 6
      // counted every call inside them.
      const table = nonEmptyArray(iterated, bindings);
      if (table) {
        const body = statement.statement;
        walkStatements(ts.isBlock(body) ? body.statements : [body], bindings);
      }
      return;
    }
    // Shape D: the main-module guard's body. An `if` is a gate and this file
    // enters none of them — except this one, whose exact spelling
    // `guard-scan.mjs` enforces over every file under `scripts/` and whose
    // condition is true precisely when the script is the one node was given. A
    // `.mjs` entry point keeps its whole body in here, so without this shape the
    // two self-tests witness nothing at all; with it, they witness what runs
    // when CI runs them and nothing else. It is an allowlist entry that another
    // rule pins the spelling of, which is the only reason it is safe — and the
    // lean is explicit: `guard-scan.mjs` refuses a locally declared or foreign
    // `isMainModule` for every file under `scripts/`, so inside that directory
    // this shape cannot be forged. Outside it, a file could write the same three
    // tokens over a predicate of its own — which buys a *witness*, not the loss
    // of one, and still requires a real assertion inside the body.
    if (ts.isIfStatement(statement) && isMainModuleGuard(statement)) {
      const body = statement.thenStatement;
      walkStatements(ts.isBlock(body) ? body.statements : [body], bindings);
      return;
    }
    // Everything else — `if`, `while`, `for`, `try`, `switch`, a label, a
    // declaration — is a gate, a loop or an uninvoked body. Not entered.
  };

  const walkExpression = (node, bindings) => {
    if (node === undefined) return;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
      walkExpression(node.expression, bindings);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) walkExpression(element, bindings);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      walkObjectLiteral(node, bindings);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === ASSERT) {
        // Shape A's payload: whatever is inside `expect(…)` is asserted on, and
        // so is anything a name in there was bound to in this block.
        for (const argument of node.arguments) {
          transitiveCalls(argument, names);
          const mentioned = new Set();
          collectIdentifiers(argument, mentioned);
          for (const name of mentioned) {
            for (const bound of bindings.get(name)?.calls ?? []) names.add(bound);
          }
        }
        return;
      }
      if (ts.isIdentifier(callee) && RUNNERS.has(callee.text)) {
        for (const argument of node.arguments) {
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            walkBody(argument.body, bindings);
          }
        }
        return;
      }
      if (ts.isIdentifier(callee) && declaredFunctions.has(callee.text)) {
        if (!entered.has(callee.text)) {
          entered.add(callee.text);
          walkBody(declaredFunctions.get(callee.text), new Map());
        }
      }
      // `expect(f()).toEqual([])` is a call on a call, so the receiver of a
      // member call is walked as well as the arguments. That is also why
      // `Promise.resolve().then(() => f())` is *not* an assertion: the receiver
      // is walked, and the arrow it is handed is a body nothing here enters.
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        walkExpression(callee.expression, bindings);
      }
      for (const argument of node.arguments) walkExpression(argument, bindings);
      return;
    }
    // A literal, a template, an uninvoked function — nothing this recognises.
  };

  /** Shape B: `{ run: () => f(…), expect: … }`. */
  const walkObjectLiteral = (node, bindings) => {
    const property = (name) =>
      node.properties.find(
        (one) =>
          (ts.isPropertyAssignment(one) || ts.isMethodDeclaration(one)) &&
          ts.isIdentifier(one.name) &&
          one.name.text === name,
      );
    const run = property('run');
    const compared = property('expect');
    if (run !== undefined && compared !== undefined) {
      const body = ts.isMethodDeclaration(run)
        ? run.body
        : ts.isArrowFunction(run.initializer) || ts.isFunctionExpression(run.initializer)
          ? run.initializer.body
          : undefined;
      if (body !== undefined) {
        if (ts.isBlock(body)) {
          for (const statement of live(body.statements)) transitiveCalls(statement, names);
        } else {
          transitiveCalls(body, names);
        }
      }
    }
    for (const one of node.properties) {
      if (ts.isPropertyAssignment(one)) walkExpression(one.initializer, bindings);
    }
  };

  walkStatements(parsed.statements, new Map());
  return names;
}

const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** A non-empty array literal, written out or bound to a name in this block. */
function nonEmptyArray(node, bindings) {
  if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0;
  if (ts.isIdentifier(node)) {
    const bound = bindings.get(node.text);
    const initializer = bound?.initializer;
    return (
      initializer !== undefined &&
      ts.isArrayLiteralExpression(initializer) &&
      initializer.elements.length > 0
    );
  }
  return false;
}

/**
 * A loop body that does something with what it was handed.
 *
 * `for (const problem of check()) {}` calls the check and throws the answer
 * away, which is the "presence is not use" defect wearing a loop. Any call, any
 * assignment or any `throw` counts; an empty body does not.
 */
function doesSomething(node) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isThrowStatement(current) ||
      (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** `if (isMainModule(import.meta.url))`, exactly — the shape guard-scan pins. */
function isMainModuleGuard(statement) {
  const condition = statement.expression;
  return (
    ts.isCallExpression(condition) &&
    condition.questionDotToken === undefined &&
    ts.isIdentifier(condition.expression) &&
    condition.expression.text === 'isMainModule' &&
    condition.arguments.length === 1 &&
    ts.isPropertyAccessExpression(condition.arguments[0]) &&
    condition.arguments[0].name.text === 'url' &&
    ts.isMetaProperty(condition.arguments[0].expression) &&
    statement.elseStatement === undefined
  );
}

/**
 * Every name a module exports.
 *
 * `export function f`, `export const f =`, `export class f`, and
 * `export { a, b as c }`. A re-export from elsewhere still counts as this
 * module's surface, which is the honest answer: `definedIn` is about where the
 * binding a caller reaches for comes from.
 */
export function exportedNames(path, source) {
  const parsed = parseOnce(path, source);
  const names = new Set();
  const exported = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((one) => one.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      exported(statement) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function collectIdentifiers(node, into) {
  if (ts.isIdentifier(node)) into.add(node.text);
  node.forEachChild((child) => collectIdentifiers(child, into));
}

function terminates(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'process' &&
    call.expression.name.text === 'exit'
  );
}

/**
 * Every step's `run:` script in every workflow file.
 *
 * Parsed, not scanned. The first draft of this read the raw text and, to catch
 * block scalars without re-implementing YAML indentation, threw the whole file
 * in as an extra haystack — which makes a *comment* that quotes a command read
 * as a step that runs it. That is the round-4 `echo`-the-fetch defect and the
 * round-6 fixture-literal defect wearing a third hat, written by the same hand
 * that had just fixed both. Two parsers are already in this repository. Use
 * them: `yaml` for the document, `shell-command.mjs` for the script.
 *
 * `.yaml` as well as `.yml`, for the same reason the policy engine now
 * enumerates the directory.
 */
export function workflowRunScripts(root = process.cwd(), read = readFileSync, list = readdirSync) {
  const scripts = [];
  let entries;
  try {
    entries = list(join(root, WORKFLOW_DIRECTORY), { withFileTypes: true });
  } catch {
    return scripts;
  }
  for (const entry of entries) {
    if (!(entry.isFile() || entry.isSymbolicLink()) || !/\.ya?ml$/.test(entry.name)) continue;
    let document;
    try {
      document = parseYaml(String(read(join(root, WORKFLOW_DIRECTORY, entry.name), 'utf8')));
    } catch {
      continue;
    }
    for (const job of Object.values(document?.jobs ?? {})) {
      for (const step of Array.isArray(job?.steps) ? job.steps : []) {
        if (typeof step?.run === 'string') scripts.push(step.run);
      }
    }
  }
  return scripts;
}

/** True when some workflow step runs `path` as a command rather than naming it. */
function runByWorkflow(path, scripts) {
  for (const script of scripts) {
    let commands;
    try {
      commands = completedCommands(script);
    } catch {
      continue;
    }
    for (const command of commands) {
      if (command.argv.includes(path)) return true;
    }
  }
  return false;
}

/** The workspaces `.github/ci-manifest.json` gives a floor to. */
function enrolledWorkspaces(root, read) {
  try {
    const manifest = JSON.parse(String(read(join(root, MANIFEST), 'utf8')));
    return Object.entries(manifest.vitest?.workspaces ?? {})
      .filter(([, entry]) => typeof entry?.minTests === 'number' && entry.minTests >= 1)
      .map(([workspace]) => `${toPosix(workspace)}/`);
  } catch {
    return [];
  }
}

const isTestFile = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * How many other scripts must import a shared decision before it needs a row.
 *
 * Three, because two callers is a pair and three is a habit — and because the
 * three-caller line is where the arithmetic in `sharedModuleProblems` starts
 * being about a *class* of failure rather than about one file. `main-module.mjs`
 * has nineteen.
 *
 * The number is a judgement and the edge is occupied: a blind critic measured
 * `child-verdict.mjs` at two importers, no row, sole enforcer of the entire
 * CAUGHT-vs-crashed distinction and witnessed only from inside `scripts/`. That
 * is not an argument for a different number — at two, `checker-graph.mjs` itself
 * would need a row in its own registry — it is an argument that the threshold
 * cannot be the only thing that puts a decision in the table. What actually
 * closed it was a third importer arriving (`positive-control.mjs`) and the rule
 * then demanding the row, which is the rule working; and the row exists now
 * whatever the count does next.
 */
const SHARED_MODULE_THRESHOLD = 3;

/**
 * Shared bindings that no contract in this file can reach, and why, and who
 * witnesses them instead.
 *
 * ── THE UNIT OF APPLICATION WAS WRONG (#40 round 8, D5) ─────────────────────
 * `described` was a set of `definedIn` paths, so a module cleared the rule with
 * a row for *any one* of its exports. A new shared decision added to
 * `main-module.mjs` — nineteen importers, the file whose one-statement mutation
 * cost 358 assertions — needed no row at all, because `isMainModule` already had
 * one. The rule counted files and meant decisions.
 *
 * It counts bindings now: `module#export`, one row per decision, declared by
 * each row's `covers` (which defaults to the single name the row already
 * names). That immediately exposed a set of bindings over the threshold whose
 * behaviour no in-process contract can assert, and pretending otherwise would be
 * worse than saying so. Each is written down here with the reason no contract is
 * possible *and* the thing that exercises it instead — because "no test" and "no
 * test in this file" are different claims, and the first one is the one that
 * should be expensive to write.
 *
 * ── AND THE REASONS HAVE TO BE TRUE (#40 round 9) ───────────────────────────
 * Round 8 wrote "eight bindings" over a table holding seven, and one of the
 * seven was `mailpit`, excused as "it talks to the mail catcher" by a function
 * that does no I/O whatsoever — it resolves one environment variable and returns
 * closures, which is the shape the `composeArgs` row eleven lines away already
 * contracts. Its stated witness cited a ledger case in which the stack never
 * boots, so the function is provably never called on it. A count nobody checked
 * guarding entries nobody re-read is the exemption list this repository keeps
 * deleting, wearing a different hat. `mailpit` has a row now; the count is gone
 * from this comment, because the number that matters is the one the rule prints
 * beside the entries when it fires.
 *
 * This is an exemption list, which this repository refuses elsewhere and for
 * good reason. The difference is what it is a list *of*: the lists this
 * campaign deleted were lists of files a rule would skip, invisible at the point
 * of the skip. This one is enumerated against the live import graph — an entry
 * for a binding that stopped being shared is an error, a binding that becomes
 * shared and is in neither table is an error, and both are printed with the
 * count. It is a written debt, not a silence.
 */
const UNCONTRACTED = {
  'scripts/ci/stack-client.mjs#report': {
    why: 'it is `process.exit(verdict(what))` and nothing else, so a contract that called it would end the process running the contract. `verdict` — the decision it acts on — has a row above with three mutants.',
    witness:
      'packages/ci-guard/test/checkers.test.ts runs it in a real child process and requires exit 1 for a recorded failure and 0 for a clean run; and every deploy control in positive-control.mjs requires a script that ends on it to come back red.',
  },
  'scripts/ci/compose.mjs#docker': {
    why: 'it is `execFileSync("docker", args)`. A contract in the verify job would either need a docker daemon with this stack running, or would assert that a shell-out wrapper shells out, which is a test of node.',
    witness:
      'the deploy job, where the health, config, identity and origin assertions all read the stack through it — and the positive control, which requires each of them to fail when there is nothing to read.',
  },
  'scripts/ci/compose.mjs#psAll': {
    why: 'same: `docker compose ps` and a JSON parse of what came back.',
    witness:
      'assert-stack-health.mjs, whose positive control requires it to report "the compose project has no containers at all" when none are running — which is this function returning an honest empty list.',
  },
  'scripts/ci/compose.mjs#inspect': {
    why: 'same: `docker inspect` and a JSON parse.',
    witness:
      'assert-stack-config.mjs reads the production configuration back out of the containers through it, and its positive control requires that to fail with nothing to inspect.',
  },
  'scripts/ci/compose.mjs#queryDatabase': {
    why: 'it runs `psql` inside the deployment’s own postgres container, with credentials read out of that container.',
    witness:
      'assert-stack-schema.mjs and assert-page-serves.mjs, which compare the rendered page against what the database holds; the positive control requires both to fail with no database.',
  },
  'scripts/ci/stack-client.mjs#establishSession': {
    why: 'it signs an account up through the real form, reads the mail out of the real relay and follows the link in it. There is no half of that which is not a live stack.',
    witness:
      'assert-signup-verifies.mjs is exactly this path as an assertion, and assert-page-serves.mjs and assert-ws-upgrade.mjs both depend on the session it produces.',
  },
  'scripts/ci/stack-client.mjs#requireDeployment': {
    why: 'it ends on `report`, which is `process.exit(verdict(what))`, so a contract that reached the failing branch would end the process running the contract. `absentDeployment` — the decision it acts on — has a row above with three mutants, and this function is `check(absentDeployment(…))` plus that exit.',
    witness:
      'packages/ci-guard/test/checkers.test.ts drives it with an injected request function and an injected reporter, and requires it to report exactly once for a refused connection and not at all for a deployment that answered; and every deploy control in positive-control.mjs matches the sentence it records.',
  },
};

/**
 * Every binding `import * as name` depends on, or `undefined` for "all of them".
 *
 * ── AND THE THIRD SPELLING (#40 round 9, D4, found attacking the fix) ────────
 * Counting `ns.member` closed the measured rewrite and not the one line past it:
 * `const { queryDatabase } = composeModule;` reaches the same binding through a
 * destructuring, which is not a property access, so the count went back to zero
 * and the debt table went stale again. Enumerating the ways to read a property
 * off an object is a denylist, and this file's whole argument is that denylists
 * are unbounded — so the enumeration is only an *optimisation*: any use of the
 * namespace this function does not recognise makes the answer "every export of
 * that module", which is the true and conservative reading of what a namespace
 * import depends on.
 */
function namespaceMembers(sourceFile, name) {
  const used = new Set();
  let opaque = false;
  const visit = (node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      if (ts.isPropertyAccessExpression(node)) used.add(node.name.text);
      else if (
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        used.add(node.argumentExpression.text);
      } else opaque = true;
      return;
    }
    // `const { a, b } = ns;` — a read of two properties with no member access
    // anywhere in it.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === name
    ) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key)) used.add(key.text);
          else opaque = true;
        }
        return;
      }
      opaque = true;
      return;
    }
    if (ts.isIdentifier(node) && node.text === name && !ts.isNamespaceImport(node.parent)) {
      // The namespace itself, changing hands: passed to a function, spread,
      // re-exported. Whatever happens to it, every export is reachable.
      opaque = true;
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return opaque ? undefined : used;
}

/**
 * Every module many scripts depend on that nothing in the registry describes.
 *
 * ── THE RULE THE ROUND-7 CRITICAL FINDING GENERALISES TO ────────────────────
 * Round 6 replaced fifteen copies of the main-module guard with one shared
 * predicate, and the tests written for the fifteen copies did not transfer: they
 * checked the *shape of the guard in the callers*, and the thing that now made
 * the decision was a function nothing outside `scripts/` ever ran. One statement
 * in `main-module.mjs` was measured to take 358 assertions out of a green build.
 *
 * **Every refactor that replaces N copies with one shared implementation
 * converts N independent failures into one total failure.** That sentence is
 * true of every future centralisation too, and a sweep done once by hand is a
 * sweep that is wrong the next time somebody extracts a helper. So it is a rule:
 * a module under `scripts/ci/` imported by three or more other scripts is a
 * single point of failure for all of them and must appear in `ENFORCEMENT` —
 * where the machinery above then forces it to have a behavioural contract, a
 * mutant that contract rejects, and a witness outside `scripts/`.
 *
 * The honest boundary: this counts *import specifiers*, so a module reached some
 * other way is not seen, and the threshold is a judgement rather than a
 * derivation. What it removes is the possibility of the next extraction landing
 * with no outside test and nobody noticing, which is exactly what happened here.
 */
export function sharedModuleProblems(
  root = process.cwd(),
  read = readFileSync,
  list = readdirSync,
  registry = ENFORCEMENT,
) {
  const problems = [];
  const importers = new Map();
  /** `module#export` → the scripts that import that binding by name. */
  const bindingImporters = new Map();
  for (const file of sourceFiles(root, list)) {
    if (!file.startsWith('scripts/')) continue;
    let source;
    try {
      source = String(read(join(root, file), 'utf8'));
    } catch {
      continue;
    }
    const parsed = parseOnce(file, source);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith('.') || !specifier.text.endsWith('.mjs')) continue;
      // Every *name* this file takes out of that module, which is the unit the
      // rule is about: a module clears with one row, a decision does not.
      const bindings = statement.importClause?.namedBindings;
      const target = toPosix(posix.join(posix.dirname(file), specifier.text));
      const dependsOn = (imported) => {
        const key = `${target}#${imported}`;
        if (!bindingImporters.has(key)) bindingImporters.set(key, new Set());
        bindingImporters.get(key).add(file);
      };
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          // The *imported* name, not the local alias: `import { check as c }`
          // depends on `check`.
          dependsOn((element.propertyName ?? element.name).text);
        }
      }
      // ── AND THE OTHER SPELLING OF THE SAME DEPENDENCY (#40 round 9, D4) ───
      // This counted `ts.isNamedImports` and nothing else, so `import * as
      // composeModule from './compose.mjs'` made every binding it uses
      // invisible. Measured by a blind critic: rewriting three importers that
      // way dropped a still-shared binding below the threshold and made the
      // *staleness* half of this rule instruct the reader to delete its debt
      // entry — a gate arguing for the removal of the acknowledgement of a
      // decision three files still depend on. A namespace import is a
      // dependency on every property of the namespace that is read, so those
      // are the names counted.
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        const used = namespaceMembers(parsed, bindings.name.text);
        // `undefined` is "this rule could not enumerate what it reads", and the
        // conservative answer to that is every export the module has: a
        // namespace import is a dependency on all of them until something proves
        // otherwise, and proving otherwise is what the enumeration above is for.
        for (const name of used ?? exportsOf(root, read, target)) dependsOn(name);
      }
      // `import defaultName from './x.mjs'` is a dependency on `default`.
      if (statement.importClause?.name !== undefined) dependsOn('default');
      // `target` above is resolved against the *importing file's* directory, not
      // assumed to be `scripts/ci/`. `scripts/ci` is flat today and "the
      // directory happens to be flat today" is this ticket's own founding
      // assumption: a script at `scripts/other/x.mjs` importing `./y.mjs` means
      // `scripts/other/y.mjs`, and reading that as `scripts/ci/y.mjs` would
      // credit one module with another's importers and miss the real one
      // entirely. Found attacking round 8's own fix.
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  const described = new Set(registry.map((entry) => entry.definedIn));
  for (const [module, files] of [...importers].sort()) {
    if (files.size < SHARED_MODULE_THRESHOLD || described.has(module)) continue;
    problems.push(
      `${module} is imported by ${files.size} other scripts (${[...files].sort().join(', ')}) and has no row in the registry in ${REGISTRY_FILE}. A module this many scripts depend on decides something on behalf of all of them: replacing N copies of a decision with one shared implementation converts N independent failures into one total failure, and the tests written for the N copies do not transfer. Round 6 learned that by centralising the main-module guard and leaving its predicate untested, which one statement then took 358 assertions out of CI over. Give it a row with a behavioural contract, a mutant that contract rejects, and a witness outside scripts/.`,
    );
  }

  // ── And the same question about each *decision*, not each file (D5) ────────
  const covered = new Set(
    registry.flatMap((entry) =>
      (entry.covers ?? [entry.check]).map((name) => `${entry.definedIn}#${name}`),
    ),
  );
  // ── AND `covers` HAS TO NAME SOMETHING THAT EXISTS (#40 round 9, D4) ──────
  // `check` is validated against `exportedNames(definedIn)` — a row that names a
  // module it does not come from is refused, and has been since round 7. `covers`
  // was read straight into the set above with no validation at all, which makes
  // it the same defect in the field that *silences* the rule rather than the one
  // that states it. Measured by a blind critic: delete four entries from
  // UNCONTRACTED, add them plus a name that does not exist anywhere to the
  // `composeArgs` row's `covers` — a two-line contract about splitting an
  // environment variable — and `sharedModuleProblems` reports **0**. Four shared
  // decisions cleared by one row asserting nothing about any of them, and a
  // typo cleared nothing while looking like it had.
  for (const entry of registry) {
    if (entry.covers === undefined) continue;
    let exports;
    try {
      exports = exportedNames(entry.definedIn, String(read(join(root, entry.definedIn), 'utf8')));
    } catch (error) {
      problems.push(
        `${entry.definedIn} could not be read to confirm what ${entry.check}'s \`covers\` names: ${error.message}`,
      );
      continue;
    }
    for (const name of entry.covers) {
      if (exports.has(name)) continue;
      problems.push(
        `the row for ${entry.check} claims to cover \`${name}\` in ${entry.definedIn}, which exports no such name (it exports ${[...exports].sort().join(', ') || 'nothing'}). \`covers\` is how a row clears a *decision* rather than a file, so an unvalidated one clears whatever it is spelled like: a name with a typo in it silences nothing and reads as though it silenced something, and a list of real names on a row whose contract never touches them silences four.`,
      );
    }
  }
  const shared = new Set();
  for (const [key, files] of [...bindingImporters].sort()) {
    if (files.size < SHARED_MODULE_THRESHOLD) continue;
    shared.add(key);
    if (covered.has(key) || Object.hasOwn(UNCONTRACTED, key)) continue;
    const [module, name] = key.split('#');
    problems.push(
      `\`${name}\` from ${module} is imported by ${files.size} scripts (${[...files].sort().join(', ')}) and no row in ${REGISTRY_FILE} covers it. ${module} having a row for some *other* export is not this decision being tested: the registry keyed coverage on the file until round 8, so a new shared decision could land in an already-described module — main-module.mjs, say, whose one-statement mutation cost 358 assertions — with nothing anywhere running it. Give it a row, add it to an existing row's \`covers\` if that row's contract really does exercise it, or put it in UNCONTRACTED with the reason no contract can reach it and the thing that exercises it instead.`,
    );
  }
  for (const [key, entry] of Object.entries(UNCONTRACTED)) {
    if (!shared.has(key)) {
      problems.push(
        `UNCONTRACTED names \`${key}\`, which fewer than ${SHARED_MODULE_THRESHOLD} scripts import any more. A stale acknowledged debt is a debt nobody re-read — which is the failure mode of every exemption list this campaign has deleted. Take it out, or write down why it is still shared.`,
      );
    }
    if (covered.has(key)) {
      problems.push(
        `\`${key}\` is both covered by a registry row and listed in UNCONTRACTED as untestable. One of the two is out of date, and the debt entry is the one that reads as an excuse.`,
      );
    }
    if (typeof entry?.why !== 'string' || typeof entry?.witness !== 'string') {
      problems.push(
        `UNCONTRACTED's entry for \`${key}\` does not say both why no contract can reach it and what exercises it instead. An entry with only the first half is a list of things nobody tests.`,
      );
    }
  }
  return problems;
}

/**
 * How many recorded assertions each stack assertion still makes.
 *
 * ── THE HOLE THE COLD CONTROL CANNOT REACH (#40 round 9) ────────────────────
 * `positive-control.mjs` proves an assertion is a function of the world by
 * running it in a world where it must fail. That catches a script that checks
 * *nothing*. It does not catch one that checks *less than it claims*: since
 * round 9 every stack assertion opens with `requireDeployment`, and a script cut
 * down to nothing but that precondition goes red in the cold world exactly like
 * the real one. A blind critic put the number on it — **48 `check()` calls
 * (24 + 15 + 9) are uncontrolled**, and the gutting that removes them was
 * measured to leave every gate green.
 *
 * No behavioural control run before the stack exists can distinguish those two
 * scripts, so this half is syntactic and blunt on purpose: each of them declares
 * a floor of recorded assertions in `.github/ci-manifest.json`, and the floors
 * are read by `floorsOf` — which means `assert-floor-ratchet.mjs` compares them
 * against `origin/main` like every other floor, and the README fingerprint moves
 * when one does. Deleting twenty-three of `assert-page-serves`'s twenty-four
 * checks is now three files that have to agree about it.
 *
 * The subject set is derived, not declared: any script under `scripts/` that
 * imports `check` from `./stack-client.mjs` is recording assertions and must
 * have a floor, and a floor for a script that stopped importing it is stale and
 * says so. What this is *not* is a claim that the assertions are good — a
 * `check(true, …)` counts. It is a claim that they are still there, which is the
 * one thing the twenty-line gutting removes.
 *
 * @param {string} [root]
 * @param {typeof readFileSync} [read]
 * @param {typeof readdirSync} [list]
 * @returns {string[]}
 */
export function assertionFloorProblems(
  root = process.cwd(),
  read = readFileSync,
  list = readdirSync,
) {
  const problems = [];
  let floors;
  try {
    floors = JSON.parse(String(read(join(root, MANIFEST), 'utf8')))?.assertions?.scripts;
  } catch (error) {
    return [
      `${MANIFEST} could not be read to check the assertion floors: ${error.message}. A floor nobody could read is a floor nobody is held to.`,
    ];
  }
  if (!isPlainObject(floors)) {
    return [
      `${MANIFEST} has no \`assertions.scripts\` object, so no script is held to a floor of recorded assertions at all. That table is the only thing standing between a stack assertion and the twenty-line rewrite that keeps its imports, keeps its \`report(…)\` and deletes every \`check(…)\` between them.`,
    ];
  }
  const counted = new Map();
  for (const file of sourceFiles(root, list)) {
    if (!file.startsWith('scripts/')) continue;
    let source;
    try {
      source = String(read(join(root, file), 'utf8'));
    } catch {
      continue;
    }
    const parsed = parseOnce(file, source);
    if (!importsCheck(parsed)) continue;
    const calls = countCalls(parsed, 'check');
    // Importing `check` and never calling it is what this file itself does — it
    // hands the binding to a contract as data. A file with no call sites is not
    // recording assertions, so it needs no floor; and a file that *had* one and
    // dropped to zero is caught by the staleness half below, which is the shape
    // the gutting takes.
    if (calls > 0) counted.set(file, calls);
  }
  for (const [file, calls] of [...counted].sort()) {
    const floor = floors[file]?.minChecks;
    if (typeof floor !== 'number') {
      problems.push(
        `${file} records assertions through \`check\` from stack-client.mjs and has no \`minChecks\` floor in ${MANIFEST}. Without one, every one of its ${calls} assertion(s) can be deleted in a single commit and nothing anywhere will say so: the positive control only proves the script goes red in a world with no deployment, which a script consisting of nothing but its precondition also does.`,
      );
      continue;
    }
    // ── AND A FLOOR OVER A LOOP IS A FLOOR OVER NOTHING (#40 round 10, D2) ──
    // Four scripts record every problem through one `check(…)` call site over a
    // computed list, so their source-level floor was 1 and a version of the
    // caller that computes an empty list satisfied it while comparing nothing.
    // Measured against the live migrated stack as "assert-stack-schema:
    // passed." with zero schema compared. The count that cannot be arranged
    // that way is the one the run itself produces, which `verdict` in
    // stack-client.mjs compares against `minRun` — so every script with a
    // source floor must declare a run floor too, and it may not be smaller.
    if (typeof floors[file]?.minRun !== 'number') {
      problems.push(
        `${file} declares a \`minChecks\` floor and no \`minRun\` floor in ${MANIFEST}. \`minChecks\` counts *call sites in the source*: a script whose assertions are a fold over a computed population has one of those and makes as many assertions as the population is big, so a rewrite that computes an empty population passes a source floor of ${floor} while asserting nothing at all. \`minRun\` is the count the run reports through \`compared(…)\` and \`check(…)\`, and \`verdict\` enforces it against the live deployment.`,
      );
    } else if (!Number.isInteger(floors[file].minRun) || floors[file].minRun < 1) {
      problems.push(
        `${file} declares \`minRun\` ${JSON.stringify(floors[file].minRun)} in ${MANIFEST}, which is not a count of assertions. A script allowed to make none is a script with no run floor written a longer way. (It is deliberately *not* required to be at least \`minChecks\`: a call site inside a loop over the problems a healthy comparison did not find runs zero times, so the two counts measure different things and the run count is the one that cannot be arranged.)`,
      );
    }
    if (calls < floor) {
      problems.push(
        `${file} makes ${calls} recorded assertion(s) and ${MANIFEST} declares a floor of ${floor}. A suite that shrank is the thing every floor in this manifest exists to catch, and this is the one whose shrinking the deploy job cannot see — lowering it is a decision that belongs in the ratchet's justifications, beside the number.`,
      );
    }
  }
  for (const file of Object.keys(floors)) {
    if (counted.has(file)) continue;
    problems.push(
      `${MANIFEST} declares an assertion floor for ${file}, which does not record assertions through \`check\` from stack-client.mjs any more (it may have been deleted, renamed, or rewritten to report some other way). A floor over nothing is a floor that reads as protection and is not.`,
    );
  }
  return problems;
}

/**
 * Recorded assertions whose condition reads nothing.
 *
 * ── SATISFY THE PRECONDITION AND ASSERT NOTHING (#40 round 10, D3) ──────────
 * A blind critic rewrote `assert-page-serves.mjs` as its imports, `stackTarget()`,
 * `await requireDeployment(…)`, a `void kept` referencing every import so the
 * shared-module staleness rule still counted it, **twenty-three `check(true, …)`
 * calls** and `report(…)`. Against the live stack: `assert-page-serves: passed.`
 * Every gate green, including the positive control, the source-level assertion
 * floor and the coverage rule. The manifest's own comment conceded it: "a
 * `check(true, …)` counts".
 *
 * The repository's standing rule is that denylists of evasions are unbounded and
 * the compliant forms get allowlisted, so this is not a list of tautologies to
 * refuse. It is the one thing a recorded assertion must do: **read a value**.
 * A condition must contain at least one identifier, property access, element
 * access or call — and that identifier must not be a module-scope constant bound
 * to a literal, because `const OK = true; check(OK, …)` is the same assertion
 * written with an extra line. `check(x === x, …)` still walks through, and the
 * run floors on `minRequests` are the half that costs: an assertion that reads
 * nothing asks the deployment nothing, and this repository's page assertion asks
 * it a dozen questions.
 *
 * Deliberately scoped to `check` from stack-client.mjs, which is what `verdict`
 * turns into an exit status. `compared(n, …)` is not covered: its argument is a
 * population size produced *inside* a comparison function, and a literal there —
 * `record(1, 'checkMigrationImage')` — is the honest spelling of "this branch is
 * one comparison".
 *
 * @param {string} [root]
 * @param {typeof readFileSync} [read]
 * @param {typeof readdirSync} [list]
 * @returns {string[]}
 */
export function assertionConditionProblems(
  root = process.cwd(),
  read = readFileSync,
  list = readdirSync,
) {
  const problems = [];
  for (const file of sourceFiles(root, list)) {
    if (!file.startsWith('scripts/')) continue;
    let source;
    try {
      source = String(read(join(root, file), 'utf8'));
    } catch {
      continue;
    }
    const parsed = parseOnce(file, source);
    if (!importsCheck(parsed)) continue;
    const constants = literalConstants(parsed);
    for (const call of callsTo(parsed, 'check')) {
      const condition = call.arguments[0];
      if (condition === undefined) {
        problems.push(
          `${file}:${lineOf(parsed, call)} calls \`check()\` with no condition, so it records an assertion about nothing. A recorded assertion is a claim, and a claim with no subject is a line that makes a floor go up.`,
        );
        continue;
      }
      const reads = valuesRead(condition).filter((name) => !constants.has(name));
      if (reads.length > 0) continue;
      // `check(false, problem)` is the *other* compliant form and the one every
      // fold uses: the comparison already happened, this records its answer, and
      // no arrangement of it can make a script report `passed`. Only a condition
      // that is constantly *true* buys a green — so the allowlist is "reads a
      // value, or is a constant that cannot pass".
      if (isFalsyLiteral(condition)) continue;
      problems.push(
        `${file}:${lineOf(parsed, call)} records an assertion whose condition (\`${condition.getText(parsed).slice(0, 80)}\`) reads no value: every leaf of it is a literal or a module-scope constant bound to one. That is the measured r10 D3 exploit — twenty-three \`check(true, …)\` calls after the precondition printed "assert-page-serves: passed." against the live stack with every gate green, and satisfied the assertion floors exactly, because a floor counts assertions and cannot tell a claim from a constant. A recorded assertion has to read something the deployment produced.`,
      );
    }
    // And the same rule over the number a fold reports about itself. `compared`
    // is what satisfies the `minRun` floor without a `check` per subject, so a
    // literal there — `compared(40, 'nothing at all')` — is the run floor's own
    // version of `check(true, …)`, and it is exactly the plant the `selfcheck`
    // group now uses to produce a green control on purpose. The count has to be
    // computed from the population; every legitimate caller in this tree either
    // reads one (`scanned * FORBIDDEN.length`, `new Set([…]).size`) or passes it
    // through the injected `record` parameter from inside the comparison, which
    // is a different identifier and not this rule's subject.
    for (const call of callsTo(parsed, 'compared')) {
      const count = call.arguments[0];
      if (count === undefined) continue;
      if (valuesRead(count).filter((name) => !constants.has(name)).length > 0) continue;
      problems.push(
        `${file}:${lineOf(parsed, call)} reports \`compared(${count.getText(parsed).slice(0, 40)}, …)\` — a count of comparisons that reads no value. The run floor exists because a floor over \`check(…)\` call sites is a floor over nothing when every problem reaches one site through a loop; a literal handed to \`compared\` is that same defect one layer up, and it is how a script that examines nothing reports having examined a population.`,
      );
    }
  }
  return problems;
}

/** A constant this repository's `check` can only ever record a failure for. */
function isFalsyLiteral(node) {
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text) === 0;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === '';
  return false;
}

/** Module-scope `const NAME = <literal>` bindings — a tautology with a name. */
function literalConstants(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const value = declaration.initializer;
      if (value === undefined) continue;
      if (isLiteralValue(value)) names.add(declaration.name.text);
    }
  }
  return names;
}

function isLiteralValue(node) {
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) && isLiteralValue(node.operand))
  );
}

/**
 * The identifiers a condition actually reads.
 *
 * Property *names* are not reads — `x.status` reads `x` — so the walk takes the
 * expression side of a property access and skips the name side. A call's callee
 * counts, because `regionsIn(body)` reads both.
 */
function valuesRead(node) {
  const names = [];
  const visit = (current) => {
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression);
      return;
    }
    if (ts.isIdentifier(current)) {
      names.push(current.text);
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return names;
}

/** Every call site of a plain identifier, as nodes. */
function callsTo(sourceFile, name) {
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Every name a module exports, for the conservative namespace-import answer. */
function exportsOf(root, read, module) {
  try {
    return exportedNames(module, String(read(join(root, module), 'utf8')));
  } catch {
    return new Set();
  }
}

/** True when this file imports `check` by name from the shared client. */
function importsCheck(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!/(?:^\.\/|^(?:\.\.\/)+)stack-client\.mjs$/.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'check') return true;
    }
  }
  return false;
}

/** Call sites of a plain identifier, at any depth. */
function countCalls(sourceFile, name) {
  let found = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found += 1;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/**
 * Assertions the deploy job runs that no positive control ever breaks.
 *
 * ── FOUND ATTACKING THIS ROUND'S OWN FIX (#40 round 8) ──────────────────────
 * `positive-control.mjs` closes D3 — an assertion script that asserts nothing —
 * by running each script in a world where it must fail. Its scope sentence is
 * "the entry points named in `CONTROLS`", and the attack on that sentence is one
 * line long: take a script out of `CONTROLS`. The control step still passes, the
 * script is still in the workflow, and it is back to being unproven. That is the
 * registry's own failure mode (a row is data in the same commit) and it gets the
 * registry's own answer, one turn stronger than a count in the README: the
 * required set is *derived from the workflow* rather than declared, so the
 * question is not "is the table the right size" but "does the table cover what
 * the job actually runs".
 *
 * Two assertions are exempt and both would be *false* controls rather than
 * missing ones, which is why the exemption is a reason rather than a name in a
 * list: with nothing deployed, `assert-stack-teardown` legitimately passes —
 * that is precisely what it asserts — and `assert-deploy-preflight` is about the
 * host, which is there whether or not anything is running.
 */
const CONTROL_EXEMPT = {
  // ── AN EXEMPTION MAY NOT CITE MACHINERY NOTHING RUNS (#40 round 10, D7) ────
  // All three reasons here used to be justified by cases in
  // deploy-mutation-ledger.mjs — 1382 lines that **no job runs**; all four
  // mentions of it in ci.yml are comments. A reason that points at a witness the
  // pipeline never executes is an excuse with a citation on it, which is exactly
  // the shape this repository deletes exemption lists for. `citedWitnesses`
  // below now refuses one, so the reasons name what CI actually does.
  'assert-stack-teardown':
    'it asserts that nothing of this project is left running, which is *true* before anything is brought up. A cold control for it would require it to fail at telling the truth: its world is the other one, after `down`, and the deploy job runs it there as the negative half of its pair.',
  'assert-deploy-preflight':
    'it is the only check in the job about the *machine* rather than the deployment, so "no stack is up" is not a broken world for it — the engine, its default bridge and the resolved port publications are all there whether or not anything is running. Its comparisons are exercised from outside a stack by gate-selftest.mjs, which puts a pre-28 engine, both unsafe gateway modes and an undeclared publication through `checkHostNetworkPolicy` and `publishedPortProblems`.',
  // Reached the moment round 9 widened this rule from the deploy job's
  // `assert-*.mjs` steps to every entry point every job runs (D3/D5).
  'compose-stack':
    'it is the verb, not the assertion: `build`, `up`, `trust-ca` and `down` are how a world is *made*, and a positive control over a world-maker would be a requirement that making a world fails. The argv it builds for all four verbs is asserted in gate-selftest.mjs from `composeStackArgv`, which is the code that runs rather than a copy of the text beside it.',
  // Reached the moment round 10 keyed this rule on where a word *resolves*
  // rather than on how it is spelled (D4): the workflow names it as
  // `--reporter=./scripts/ci/vitest-ci-reporter.mjs`, and the leading `./` made
  // it invisible to the anchored pattern this rule used to match with.
  'vitest-ci-reporter':
    'it is not a program this job runs, it is a module Vitest loads: executing it as an entry point constructs nothing and reports nothing, so "it must fail with no stack up" would be a requirement that a class definition fails. What it writes is `vitest-ci-report.json`, and assert-vitest-report.mjs — which *is* controlled, in a world where no report was written — refuses to pass without it, so a gutted reporter is a red gate one step later rather than an unnoticed one.',
};

/**
 * @param {string} [root]
 * @param {typeof readFileSync} [read]
 * @param {object} [controls] injectable so the self-tests can hand in a table
 *   with a known hole
 * @returns {string[]}
 */
export function controlCoverageProblems(
  root = process.cwd(),
  read = readFileSync,
  controls = CONTROLS,
) {
  const problems = [];
  let document;
  try {
    document = parseYaml(String(read(join(root, `${WORKFLOW_DIRECTORY}/ci.yml`), 'utf8')));
  } catch (error) {
    return [
      `${WORKFLOW_DIRECTORY}/ci.yml could not be read to check control coverage: ${error.message}`,
    ];
  }
  const jobs = document?.jobs;
  if (!isPlainObject(jobs) || Object.keys(jobs).length === 0) {
    return [
      `${WORKFLOW_DIRECTORY}/ci.yml has no jobs, so "every entry point it runs has a control" is true of nothing. A rule whose subject set is empty is satisfied by anything.`,
    ];
  }
  // Every group, not just `deploy`: a control's job is to prove one entry point,
  // and which group it lives in is an ordering detail of when the world it needs
  // exists. Round 8 read `controls.deploy` and the deploy job's steps, and the
  // five entry points the round-9 D3 bypass was weaponised on were all in the
  // *verify* job.
  const controlled = new Set(
    Object.values(controls).flatMap((rows) => rows.map((control) => control.entry ?? control.id)),
  );
  const run = new Map();
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.run !== 'string') continue;
      let commands;
      try {
        commands = completedCommands(step.run);
      } catch {
        continue;
      }
      for (const command of commands) {
        for (const word of command.argv) {
          // ── THE NAME WAS THE RULE, AND THE RULE WAS THE NAME (r9, D5) ─────
          // This matched `assert-[a-z0-9-]+\.mjs`, and the entrypoint allowlist
          // in workflow-policy.mjs permits any `scripts/ci/([a-z0-9-]+)\.mjs`.
          // Measured: adding `run: node scripts/ci/check-invented-thing.mjs` to
          // the deploy job left coverage reporting 0 problems and the policy
          // exiting 0 — a brand-new, entirely uncontrolled entry point, admitted
          // by spelling. Same for `verify-`. A coverage rule keyed on a filename
          // convention covers whatever the convention happens to be called.
          //
          // ── AND THEN IT WAS KEYED ON A SPELLING (#40 round 10, D4) ────────
          // The replacement convention was `CI_SCRIPT_PATH`, which is anchored,
          // so `node ./scripts/ci/invented-thing.mjs` — two characters — was
          // invisible again: measured as coverage 0, policy clean, every gate
          // green. `ciScriptName` asks where the word *resolves* instead.
          const name = ciScriptName(word);
          if (name === null) continue;
          if (!run.has(name)) run.set(name, new Set());
          run.get(name).add(jobId);
        }
      }
    }
  }
  if (run.size === 0) {
    return [
      "no entry point could be read out of any job at all, so this check has nothing to be about. Either the workflow stopped running this repository's own scripts or the parse stopped working; both are worse than a missing control.",
    ];
  }
  for (const [name, where] of [...run].sort()) {
    if (controlled.has(name) || Object.hasOwn(CONTROL_EXEMPT, name)) continue;
    problems.push(
      `${[...where].sort().join(' and ')} runs scripts/ci/${name}.mjs and no positive control in scripts/ci/positive-control.mjs ever requires it to fail. Nothing else in this repository can tell that script apart from one gutted to \`report('${name}')\`, which was measured to print "passed." and exit 0 with no stack running while every other gate stayed green — and from one whose exit status was moved into a named ternary, which round 9 measured on exactly the entry points this rule used not to reach. Give it a control, or exempt it with the reason a broken world for it would be a false red.`,
    );
  }
  for (const [name, why] of Object.entries(CONTROL_EXEMPT)) {
    if (!run.has(name)) {
      problems.push(
        `${name} is exempted from the positive controls and no job runs it any more. A stale exemption is one nobody re-read: ${why}`,
      );
    }
    if (controlled.has(name)) {
      problems.push(
        `${name} is both controlled and exempted from control. One of the two is out of date, and the exemption is the one that reads as an excuse.`,
      );
    }
    // ── A REASON THAT CITES SOMETHING NOTHING RUNS (#40 round 10, D7) ────────
    // Three of these reasons were justified by cases in
    // deploy-mutation-ledger.mjs, a 1382-line file **no job runs** — every
    // mention of it in ci.yml is a comment. A witness the pipeline never
    // executes cannot be the reason a control is unnecessary, and a citation
    // reads as one until somebody checks. This checks.
    for (const cited of citedWitnesses(why)) {
      if (run.has(cited) || controlled.has(cited)) continue;
      problems.push(
        `${name}'s exemption from the positive controls is justified by scripts/ci/${cited}.mjs, and no job in ${WORKFLOW_DIRECTORY}/ci.yml runs it. The reason a control would be a false red has to rest on something this pipeline actually does; a citation to machinery nobody executes is an excuse with a filename in it, and it is how deploy-mutation-ledger.mjs came to justify three exemptions while never running.`,
      );
    }
  }
  // And a control for something the workflow does not run is a control whose
  // subject left: it costs a child process per gate run and proves nothing about
  // this pipeline. `selfcheck` is the one group whose caller is a control rather
  // than a step, so its entries are excused from having a step of their own.
  for (const [group, rows] of Object.entries(controls)) {
    if (group === 'selfcheck') continue;
    for (const control of rows) {
      const name = control.entry ?? control.id;
      if (run.has(name)) continue;
      problems.push(
        `the \`${group}\` group controls scripts/ci/${name}.mjs and no job in ${WORKFLOW_DIRECTORY}/ci.yml runs it. A control over a script the pipeline does not run proves something about a file rather than about this build.`,
      );
    }
  }
  return problems;
}

/** Every `scripts/ci/<name>.mjs` a written reason leans on. */
function citedWitnesses(why) {
  return [...String(why ?? '').matchAll(/([a-z0-9-]+)\.mjs/g)].map((found) => found[1]);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every way the invocation graph is not what the registry says it is.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root
 * @param {typeof ENFORCEMENT} [options.registry] injectable so the self-tests can
 *   feed this a graph with a known hole without editing the real one
 * @param {(path: string, encoding: string) => string} [options.read]
 * @param {typeof readdirSync} [options.list]
 * @returns {string[]} human-readable problems; empty means every check has a
 *   witness outside its own subjects and CI runs all of them
 */
export function checkerGraphProblems({
  root = process.cwd(),
  registry = ENFORCEMENT,
  read = readFileSync,
  list = readdirSync,
} = {}) {
  const problems = [];
  const files = sourceFiles(root, list);
  const witnesses = new Map();
  for (const file of files) {
    let names;
    try {
      names = assertedNames(file, String(read(join(root, file), 'utf8')));
    } catch (error) {
      problems.push(`${file} could not be read for the invocation graph: ${error.message}`);
      continue;
    }
    witnesses.set(file, names);
  }

  const runScripts = workflowRunScripts(root, read, list);
  const workspaces = enrolledWorkspaces(root, read);

  for (const entry of registry) {
    const { check, definedIn, subjects, invokers } = entry;
    if (!files.includes(definedIn)) {
      problems.push(
        `${check} is declared as living in ${definedIn}, which is not a source file this scan found. The registry in ${REGISTRY_FILE} and the tree have drifted.`,
      );
      continue;
    }

    // ── AND `definedIn` HAS TO ACTUALLY DEFINE IT (#40 round 7) ─────────────
    // Found attacking this round's own fix, with D1's class as the checklist.
    // `definedIn` was checked only for *existing*. Nothing tied it to `check`,
    // and nothing tied either of them to the `fn` the contract is handed — so a
    // row could name `scripts/ci/compose.mjs`, satisfy `sharedModuleProblems`
    // for it, and hand its contract a function from somewhere else entirely.
    // That is D3 — a row naming one thing and probing another — moved up from
    // the function to the module, written inside the commit that fixes D3.
    let exports;
    try {
      exports = exportedNames(definedIn, String(read(join(root, definedIn), 'utf8')));
    } catch (error) {
      problems.push(
        `${definedIn} could not be read to confirm it defines ${check}: ${error.message}`,
      );
      continue;
    }
    if (!exports.has(check)) {
      problems.push(
        `the registry says ${check} lives in ${definedIn}, and ${definedIn} exports no such name (it exports ${[...exports].sort().join(', ') || 'nothing'}). \`definedIn\` is what makes a row a claim about a real module — it is what \`sharedModuleProblems\` counts, and what the graph excludes from the witness set — so a row naming a module it does not come from is D3 one level up: a row that names one thing and probes another.`,
      );
      continue;
    }

    // --- who actually asserts on it, excluding the module that defines it -----
    // And excluding this file: every assertion here is a contract probe, which is
    // a test of the check rather than a use of it. Counting a probe as a witness
    // would let the registry satisfy itself.
    const found = [...witnesses]
      .filter(([file, names]) => file !== definedIn && file !== REGISTRY_FILE && names.has(check))
      .map(([file]) => file)
      .sort();
    const declared = [...invokers].sort();
    for (const file of found) {
      if (!declared.includes(file)) {
        problems.push(
          `${file} asserts on ${check}, which the registry in ${REGISTRY_FILE} does not list as one of its witnesses. Add it — the list is how "who runs this check" stays a fact rather than a memory.`,
        );
      }
    }
    for (const file of declared) {
      if (!found.includes(file)) {
        problems.push(
          `the registry says ${file} witnesses ${check}, and it does not (any more): it either never calls it, or calls it in a position that cannot assert anything — a dead branch, an uninvoked function, or a call whose result is discarded. ${entry.because}. Restore the assertion, or explain in the registry why the graph is allowed to be thinner.`,
        );
      }
    }

    // --- the property the whole file exists for ------------------------------
    // An empty `subjects` would make "at least one witness outside the subjects"
    // trivially true for every row, which is the cheapest way to satisfy this
    // file without satisfying anything it is about. A check that reads nothing
    // is not a check.
    if (!Array.isArray(subjects) || subjects.length === 0) {
      problems.push(
        `${check} is in the registry with no subjects. "At least one witness outside the files it reads" is satisfied by anything when the set of files it reads is empty — declare what it actually reads, or take the row out.`,
      );
      continue;
    }
    const outside = declared.filter(
      (file) => !subjects.some((prefix) => file.startsWith(toPosix(prefix))),
    );
    if (outside.length === 0) {
      problems.push(
        `every witness of ${check} (${declared.join(', ') || 'none at all'}) is itself among the files it checks (${subjects.join(', ')}). Sole enforcer, sole exception: an edit to the subject disarms the only thing that would have noticed the edit. Give it a call site outside those paths — packages/ci-guard exists for exactly this.`,
      );
    }

    // --- and CI has to run them ----------------------------------------------
    for (const file of declared) {
      if (runByWorkflow(file, runScripts)) continue;
      const workspace = workspaces.find((prefix) => file.startsWith(prefix));
      if (workspace !== undefined && isTestFile(file)) continue;
      problems.push(
        `nothing in ${WORKFLOW_DIRECTORY} runs ${file}, and it is not a test file in a workspace enrolled in ${MANIFEST}. It is listed as a witness of ${check}, so if CI never reaches it the check has one fewer witness than the registry claims.`,
      );
    }
  }

  // Every shared decision has to be in the table at all.
  // The real registry, not the injected one: this asks "is every shared module
  // described *at all*", which is a question about the repository rather than
  // about whatever fixture registry a self-test happened to hand in. Passing the
  // fixture here would make every one-row fixture report twelve missing modules.
  problems.push(...sharedModuleProblems(root, read, list));

  // And every stack assertion still has to *make* its assertions: the cold
  // control proves a script is a function of the world, and a script cut down to
  // its precondition is a function of the world too.
  problems.push(...assertionFloorProblems(root, read, list));
  problems.push(...assertionConditionProblems(root, read, list));

  // And every assertion the deploy job runs has to have a world in which it
  // must fail. `CONTROLS` is data in this same commit; the set it has to cover
  // is read out of the workflow.
  problems.push(...controlCoverageProblems(root, read));

  // And the half none of the above can reach: does each check still *do*
  // anything, and would its own fixture notice if it stopped? A perfect graph
  // over a gutted rule is the failure this whole file is about, one level up.
  // Created on demand rather than per call: this function runs six more times
  // inside its own contract, and a scratch directory per invocation is fifty of
  // them per test run for the two rows that want one.
  let scratch;
  const context = {
    root,
    read,
    get workspace() {
      scratch ??= mkdtempSync(join(tmpdir(), 'atrium-checker-graph-'));
      return scratch;
    },
  };
  problems.push(...effectProblems(registry, context));
  return problems;
}
