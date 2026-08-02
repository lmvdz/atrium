/**
 * The CI checkers, checked from outside `scripts/`.
 *
 * ── WHY THIS PACKAGE EXISTS (#40 round 6) ───────────────────────────────────
 * `mainGuardProblems` enforced the main-module guard over every file in
 * `scripts/`. It was called from exactly one place in the repository:
 * `scripts/ci/gate-selftest.mjs` — a file in `scripts/`, and therefore one of
 * its own subjects. A blind review measured the consequence on
 * `fix/deploy-serves-r5`: change that file's guard to
 *
 *     if (isMainModule(import.meta.url) && process.env.CI === undefined) {
 *
 * and the scanner reports zero problems, biome is clean, the workflow policy is
 * clean, and under `CI=true` the file exits 0 having asserted nothing. Two `&&`
 * insertions, 316 assertions gone, every gate green.
 *
 * ── AND WHY IT WAS NOT ENOUGH (#40 round 7) ─────────────────────────────────
 * Round 6 built this witness and then walked past it three ways, each measured
 * by a blind critic on the real stack:
 *
 *  1. It fixed the fifteen copies of the guard by centralising the predicate,
 *     and then tested the *shape of the guard in the callers* — never the
 *     predicate. One statement in `scripts/ci/main-module.mjs`,
 *     `if (process.env.GITHUB_JOB === 'verify') return false;`, killed the whole
 *     `verify` job and left `deploy` working: 176 gate cases plus 182 policy
 *     mutations, and this file still reported **0, 49 passed**. Every shared
 *     decision under `scripts/ci/` has a behavioural test here now, and
 *     `sharedModuleProblems` fails the build if a new one arrives without one.
 *  2. Its guard-body rule was about statement *kind*, so moving the gate into
 *     the exit's argument walked through it. The whole family is below.
 *  3. Its graph asked whether a check is *called*. Stripping four `expect(…)`
 *     wrappers here while keeping every call left this suite at 49 passed with
 *     the main-module rule entirely gone. `assertedNames` asks about assertions
 *     now, and this file is the thing it is asking about.
 *
 * Everything here runs in the `verify` job's Vitest step and carries a floor in
 * `.github/ci-manifest.json` that ratchets against `origin/main`, so deleting it
 * is a red build in three different places rather than a silence.
 */

import { execFileSync } from 'node:child_process';
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
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  assertedNames,
  assertionConditionProblems,
  assertionFloorProblems,
  checkerGraphProblems,
  controlCoverageProblems,
  ENFORCEMENT,
  exportedNames,
  sharedModuleProblems,
} from '../../../scripts/ci/checker-graph.mjs';
import { notAVerdict } from '../../../scripts/ci/child-verdict.mjs';
import { composeArgs } from '../../../scripts/ci/compose.mjs';
import {
  entryDecisionProblems,
  guardProblems,
  mainGuardProblems,
} from '../../../scripts/ci/guard-scan.mjs';
import { requireFrom } from '../../../scripts/ci/import-from.mjs';
import { isMainModule } from '../../../scripts/ci/main-module.mjs';
import {
  CONTROLS,
  controlProblems,
  distinguishProblems,
  expectationProblems,
  preconditionReds,
  WRONG_REDS,
} from '../../../scripts/ci/positive-control.mjs';
import { manifestPath } from '../../../scripts/ci/record-built-images.mjs';
import { repoRoot } from '../../../scripts/ci/repo-root.mjs';
import { fail, readFreshReport } from '../../../scripts/ci/report-file.mjs';
import { scanForExpectedFailures } from '../../../scripts/ci/scan-expected-failures.mjs';
import { completedCommands } from '../../../scripts/ci/shell-command.mjs';
import {
  absentDeployment,
  check,
  compared,
  failures,
  mailpit,
  observations,
  requireDeployment,
  resetFailures,
  runtimeFloorProblems,
  stackTarget,
  verdict,
} from '../../../scripts/ci/stack-client.mjs';
import {
  checkWorkflowFile,
  ciScriptName,
  protectedCommandCoverage,
} from '../../../scripts/ci/workflow-policy.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const at = (relative: string) => `${REPO}${relative}`;
/** A synthetic control, for the cases about how an outcome is graded. */
const PROBE_CONTROL = {
  id: 'assert-x',
  world: 'nothing is running',
  expect: /assert-x: \d+ assertion\(s\) failed\./,
  because: 'a probe',
};
const IMPORT = "import { isMainModule } from './main-module.mjs';\n";
const REPORTS = "import { report } from './stack-client.mjs';\n";
const SOUND = `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n`;

describe('the main-module guard, over the real tree', () => {
  it('every .mjs under scripts/ decides "was I run?" the sound way', () => {
    expect(mainGuardProblems(at('scripts'))).toEqual([]);
  });

  it('accepts the canonical guard', () => {
    expect(guardProblems('fixture.mjs', SOUND)).toEqual([]);
  });
});

/**
 * The evasions, each one a spelling something earlier accepted.
 *
 * The first is the one a blind review landed on r5 and measured green end to
 * end; the rest are the neighbours it opens. They are here rather than only in
 * `gate-selftest.mjs` because `gate-selftest.mjs` is a subject of the scanner
 * and this file is not.
 */
describe('the evasions round 5 accepted', () => {
  const evasions: Array<[string, string, RegExp]> = [
    [
      'the measured one: a conjunct that is false exactly under CI',
      `${IMPORT}if (isMainModule(import.meta.url) && process.env.CI === undefined) {\n  process.exit(main());\n}\n`,
      /condition is not exactly/,
    ],
    [
      'the sound predicate wired so it can never be true',
      `${IMPORT}if (isMainModule(import.meta.url) && false) {\n  process.exit(main());\n}\n`,
      /condition is not exactly/,
    ],
    [
      'a guard that runs and does nothing',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n}\n`,
      /body is empty/,
    ],
    [
      'the guard nested inside a branch that is never taken',
      `${IMPORT}if (false) {\n  if (isMainModule(import.meta.url)) {\n    process.exit(main());\n  }\n}\n`,
      /outside the one place a script here may/,
    ],
    [
      'the guard as a ternary, so it is an expression rather than a statement',
      `${IMPORT}isMainModule(import.meta.url) ? process.exit(main()) : undefined;\n`,
      /outside the one place a script here may/,
    ],
    [
      'an `else` branch that runs the script when it was imported',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(main());\n} else {\n  process.exit(0);\n}\n`,
      /has an `else` branch/,
    ],
    [
      'the predicate replaced by a local function of the same name',
      'function isMainModule() {\n  return false;\n}\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n',
      /declares its own `isMainModule`/,
    ],
    [
      'the predicate imported from somewhere else entirely',
      "import { isMainModule } from './evil.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared module/,
    ],
    // A blind cross-lineage review of round 6's first draft measured these four.
    // The rule said "from scripts/ci/main-module.mjs" and the code compared the
    // *basename*, so a lookalike beside it — or in /tmp — was accepted, and a
    // lookalike that returns `false` restores the whole defect with the scanner
    // green. A name was checked where a location was meant.
    [
      'a lookalike predicate in a subdirectory',
      "import { isMainModule } from './vendor/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared module/,
    ],
    [
      'a lookalike predicate by absolute path',
      "import { isMainModule } from '/tmp/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared module/,
    ],
    [
      'a lookalike predicate one directory sideways',
      "import { isMainModule } from '../attacker/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared module/,
    ],
    [
      'a bare specifier, which in ESM is a package name and not this file at all',
      "import { isMainModule } from 'main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared module/,
    ],
    [
      'the predicate called with `?.`, which is `undefined` if it is ever not a function',
      `${IMPORT}if (isMainModule?.(import.meta.url)) {\n  process.exit(main());\n}\n`,
      /condition is not exactly/,
    ],
    [
      'a body that is punctuation: `void 0`',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  void 0;\n}\n`,
      /body is empty/,
    ],
    [
      'a body that is punctuation: `debugger`',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  debugger;\n}\n`,
      /body is empty/,
    ],
    [
      'the argv comparison with a computed property',
      "if (process['argv'][1] === '/x/y.mjs') {\n  main();\n}\n",
      /compares an `argv` element for equality/,
    ],
    [
      'the argv comparison with an index that is an expression',
      "if (process.argv[1 + 0] === '/x/y.mjs') {\n  main();\n}\n",
      /compares an `argv` element for equality/,
    ],
    [
      'the argv comparison rooted at globalThis',
      "if (globalThis.process.argv[1] === '/x/y.mjs') {\n  main();\n}\n",
      /compares an `argv` element for equality/,
    ],
    [
      'the round-4 comparison, re-introduced verbatim',
      'if (import.meta.url === `file://${process.argv[1]}`) {\n  process.exit(main());\n}\n',
      /percent-encodes/,
    ],
    [
      'the same with loose equality, single quotes and concatenation',
      "if (import.meta.url == 'file://' + process.argv[1]) {\n  main();\n}\n",
      /percent-encodes/,
    ],
    [
      'the same with the operands the other way round',
      'if (`file://${process.argv[1]}` === import.meta.url) {\n  main();\n}\n',
      /percent-encodes/,
    ],
    [
      'the same without naming `import.meta` at all',
      "if (process.argv[1] === '/x/y.mjs') {\n  main();\n}\n",
      /compares an `argv` element for equality/,
    ],
    [
      'a file the scanner cannot parse is a failure, not a skip',
      'if (isMainModule(import.meta.url) {\n',
      /does not parse as JavaScript/,
    ],
  ];

  for (const [name, source, expected] of evasions) {
    it(`rejects ${name}`, () => {
      const problems = guardProblems('fixture.mjs', source);
      expect(problems.join(' | ')).toMatch(expected);
    });
  }
});

/**
 * The exit status, which is what round 6's body rule was not about.
 *
 * A blind critic moved the round-5 conjunct out of the condition and into the
 * *argument of the exit*, and every one of these was accepted by the engine as
 * committed. Applied to `gate-selftest.mjs` and `workflow-policy-selftest.mjs`
 * that is two files and one insertion each, and it is the same price round 5
 * paid for the same two files — because a rule about the shape of a statement is
 * satisfied by an unconditional decoy written beside a fully gated body.
 */
describe('the exit status of an entry point', () => {
  const family: Array<[string, string, RegExp]> = [
    [
      'the gate moved into the exit argument as a ternary',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(process.env.CI === undefined ? await main() : 0);\n}\n`,
      /decided by something other than the work/,
    ],
    [
      'the same as a `&&` short-circuit',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(process.env.CI === undefined && (await main()));\n}\n`,
      /decided by something other than the work/,
    ],
    [
      'the gate moved into the assignment the exit reads',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  const code = process.env.CI ? 0 : await main();\n  process.exit(code);\n}\n`,
      /binds `code` to something other than the result of the work/,
    ],
    [
      'the status reassigned between the work and the exit',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  let code = await main();\n  if (process.env.CI) code = 0;\n  process.exit(code);\n}\n`,
      /reassigns `code` after binding it/,
    ],
    [
      'the cheapest one: an unconditional decoy above a fully gated body',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  console.info('starting');\n  if (process.env.CI === undefined) {\n    process.exit(await main());\n  }\n}\n`,
      /never reaches an unconditional exit/,
    ],
    [
      'the work handed to a `.catch` that swallows it',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  main().catch(() => {});\n}\n`,
      /never reaches an unconditional exit/,
    ],
    [
      'a `.catch` that turns every failure into a status of its own choosing',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(await main().catch(() => 0));\n}\n`,
      /decided by something other than the work/,
    ],
    [
      'a body that is just `process.exit(0)`',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(0);\n}\n`,
      /exits with the literal `0`/,
    ],
    [
      'an exit with no status at all',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  main();\n  process.exit();\n}\n`,
      /with no status at all/,
    ],
    [
      'an exit 0 buried in a branch further in',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  if (process.env.CI) {\n    process.exit(0);\n  }\n  process.exit(main());\n}\n`,
      /exits with the literal `0`/,
    ],
    [
      'a status this rule cannot follow back to any work',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  work();\n  process.exit(status);\n}\n`,
      /cannot follow to the work/,
    ],
    [
      'the reporter imported from somewhere else entirely',
      `${IMPORT}import { report } from './evil.mjs';\nif (isMainModule(import.meta.url)) {\n  work();\n  report('assert-x');\n}\n`,
      /imports `report` from \.\/evil\.mjs, which is not the shared module/,
    ],
    [
      'a locally declared reporter, shadowing the one that exits',
      `${IMPORT}${REPORTS}function report() {}\nif (isMainModule(import.meta.url)) {\n  work();\n  report('assert-x');\n}\n`,
      /declares its own `report`/,
    ],
  ];

  for (const [name, source, expected] of family) {
    it(`rejects ${name}`, () => {
      expect(guardProblems('fixture.mjs', source).join(' | ')).toMatch(expected);
    });
  }

  const legitimate: Array<[string, string]> = [
    ['the canonical guard', SOUND],
    [
      'an awaited main',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  process.exit(await main());\n}\n`,
    ],
    [
      'work, a usage exit, then the real exit — what real scripts do',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  const verb = parse(process.argv.slice(2));\n  if (verb === undefined) {\n    process.exit(2);\n  }\n  process.exit(main(verb));\n}\n`,
    ],
    [
      'the status bound and then exited with',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  const code = await main();\n  process.exit(code);\n}\n`,
    ],
    [
      'the reporter terminator the stack assertions use',
      `${IMPORT}${REPORTS}if (isMainModule(import.meta.url)) {\n  const problems = work();\n  for (const problem of problems) check(false, problem);\n  report('assert-x');\n}\n`,
    ],
  ];

  for (const [name, source] of legitimate) {
    it(`accepts ${name}`, () => {
      expect(guardProblems('fixture.mjs', source)).toEqual([]);
    });
  }
});

/**
 * The predicate itself, which is what round 6 centralised and nobody tested.
 *
 * Fifteen copies of a four-line decision became one shared function, and the
 * tests written for the fifteen copies checked the *shape of the guard in the
 * callers*. So one statement in `main-module.mjs` — `if (process.env.GITHUB_JOB
 * === 'verify') return false;` — turned 176 gate cases and 182 policy mutations
 * off in a completely green build. These are the cases that make that statement
 * red: synthetic `argv`, and an environment poisoned with everything GitHub sets.
 */
describe('isMainModule, with synthetic argv', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'atrium-main-module-'));
  const entry = join(workspace, 'entry.mjs');
  const spaced = join(workspace, 'with space', 'entry.mjs');
  const linked = join(workspace, 'link.mjs');
  mkdirSync(join(workspace, 'with space'), { recursive: true });
  writeFileSync(entry, '\n');
  writeFileSync(spaced, '\n');
  symlinkSync(entry, linked);
  const url = (path: string) => pathToFileURL(path).href;

  it('says yes when the entry point is this file', () => {
    expect(isMainModule(url(entry), ['node', entry])).toBe(true);
  });

  it('says no when a different file was the entry point', () => {
    expect(isMainModule(url(entry), ['node', spaced])).toBe(false);
  });

  it('says no when there is no entry point at all', () => {
    expect(isMainModule(url(entry), ['node'])).toBe(false);
  });

  it('says no when the entry point is the empty string', () => {
    expect(isMainModule(url(entry), ['node', ''])).toBe(false);
  });

  it('says yes through a checkout path with a space in it — the founding defect', () => {
    expect(isMainModule(url(spaced), ['node', spaced])).toBe(true);
  });

  it('says yes through a symlink — the founding defect', () => {
    expect(isMainModule(url(entry), ['node', linked])).toBe(true);
  });

  it('says no when the entry point is not on disk', () => {
    expect(isMainModule(url(entry), ['node', join(workspace, 'gone.mjs')])).toBe(false);
  });

  /**
   * The round-7 critical finding, as an assertion.
   *
   * The answer must be a function of `(url, argv)` and of nothing else. Every
   * variable GitHub sets is set here, including the one the measured exploit
   * read, and every answer must be the answer it was without them.
   */
  it("gives the same answers with CI's own environment set", () => {
    const poison = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_JOB: 'verify',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_RUN_ID: '1',
      NODE_ENV: 'production',
    };
    const ask = () => [
      isMainModule(url(entry), ['node', entry]),
      isMainModule(url(entry), ['node', spaced]),
      isMainModule(url(spaced), ['node', spaced]),
      isMainModule(url(entry), ['node', linked]),
      isMainModule(url(entry), ['node']),
    ];
    const honest = ask();
    const before = { ...process.env };
    Object.assign(process.env, poison);
    try {
      expect(ask()).toEqual(honest);
    } finally {
      for (const key of Object.keys(poison)) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
    expect(honest).toEqual([true, false, true, true, false]);
  });

  /**
   * And the same question asked of a real process, because everything above
   * runs in one that already decided.
   *
   * `node <script>` must run the body; `node -e "import(<script>)"` must not.
   * That is the whole contract, end to end, in the only place it can be observed
   * rather than reasoned about.
   */
  it('runs the body when node is given the file, and not when it is imported', () => {
    const script = join(workspace, 'probe.mjs');
    const predicate = at('scripts/ci/main-module.mjs');
    writeFileSync(
      script,
      `import { isMainModule } from ${JSON.stringify(pathToFileURL(predicate).href)};\n` +
        'if (isMainModule(import.meta.url)) {\n  console.log("ran");\n  process.exit(3);\n}\n',
    );
    const run = (argv: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, argv, { encoding: 'utf8' }) };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string };
        return { code: failure.status ?? -1, out: failure.stdout ?? '' };
      }
    };
    const direct = run([script]);
    const imported = run(['-e', `import(${JSON.stringify(pathToFileURL(script).href)})`]);
    expect([direct.code, direct.out.trim()]).toEqual([3, 'ran']);
    expect([imported.code, imported.out.trim()]).toEqual([0, '']);
  });
});

/**
 * The route that made the round-5 scanner useless: the canonical guard stored as
 * a string.
 */
describe('a fixture is not a guard', () => {
  it('a file that only quotes the guard in a string is not thereby guarded', () => {
    expect(
      guardProblems(
        'fixture.mjs',
        "export const CANONICAL = 'if (isMainModule(import.meta.url)) {';\n",
      ),
    ).toEqual([]);
  });

  it('a file that quotes it AND breaks its real guard is caught', () => {
    const source = `${IMPORT}export const CANONICAL = 'if (isMainModule(import.meta.url)) {';\nif (isMainModule(import.meta.url) && process.env.CI === undefined) {\n  process.exit(main());\n}\n`;
    expect(guardProblems('fixture.mjs', source).join(' | ')).toMatch(/condition is not exactly/);
  });

  it('the guard quoted in a comment is a comment', () => {
    expect(
      guardProblems(
        'fixture.mjs',
        '// if (isMainModule(import.meta.url)) { process.exit(main()); }\nexport const x = 1;\n',
      ),
    ).toEqual([]);
  });

  it('a module with no entry-point decision needs no guard and gets no exemption', () => {
    expect(guardProblems('fixture.mjs', 'export function f() {\n  return 1;\n}\n')).toEqual([]);
  });
});

/**
 * Presence is not use — applied to the witness, which is where round 6 did not
 * apply it.
 *
 * `calledNames` asked whether a check is called. A blind critic stripped four
 * `expect(…)` wrappers from this file while keeping every call, put round 4's
 * broken guard back into `assert-tables.mjs`, and got **0, 49 passed** with
 * `assert-vitest-report` reporting "both reports agree test for test". Every
 * count claim stayed true and the rule was gone.
 *
 * The twenty-two positions below are the four round 6 refused plus the eighteen
 * the critic counted walking past them. None of them is refused by a rule of its
 * own: `assertedNames` recognises four assertion shapes and everything else is
 * simply not one of them, which is the allowlist argument this repository makes
 * about the guard itself and had not made here.
 */
describe('a call that cannot assert is not a witness', () => {
  const CHECK = 'mainGuardProblems';
  const dead: Array<[string, string]> = [
    [
      'inside `if (false)`',
      `it('x', () => { if (false) { expect(${CHECK}('s')).toEqual([]); } });`,
    ],
    [
      'inside `if (false && true)`',
      `it('x', () => { if (false && true) { expect(${CHECK}('s')); } });`,
    ],
    [
      'inside `if (false || false)`',
      `it('x', () => { if (false || false) { expect(${CHECK}('s')); } });`,
    ],
    ['inside `if (1 === 2)`', `it('x', () => { if (1 === 2) { expect(${CHECK}('s')); } });`],
    ['inside `while (false)`', `it('x', () => { while (false) { expect(${CHECK}('s')); } });`],
    ['inside `for (;false;)`', `it('x', () => { for (;false;) { expect(${CHECK}('s')); } });`],
    [
      'inside `switch (1) { case 2: }`',
      `it('x', () => { switch (1) { case 2: expect(${CHECK}('s')); } });`,
    ],
    [
      'inside `for (const x of [])`',
      `for (const x of []) { it('x', () => { expect(${CHECK}('s')); }); }`,
    ],
    ['inside a `catch`', `it('x', () => { try {} catch { expect(${CHECK}('s')); } });`],
    ['in a skipped test', `it.skip('x', () => { expect(${CHECK}('s')).toEqual([]); });`],
    ['in a todo test', `it.todo('x', () => { expect(${CHECK}('s')).toEqual([]); });`],
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
    // The one that matters most, and the one the critic actually ran: every call
    // present, every count true, nothing asserted.
    ['called with its result discarded', `it('x', () => { ${CHECK}('s'); });`],
    ['drained into a loop that does nothing with it', `for (const p of ${CHECK}('s')) {}`],
  ];

  for (const [where, source] of dead) {
    it(`does not count a call ${where}`, () => {
      expect(assertedNames('f.test.ts', source).has(CHECK)).toBe(false);
    });
  }

  const alive: Array<[string, string]> = [
    ['an `expect` in a real test', `it('x', () => { expect(${CHECK}('s')).toEqual([]); });`],
    [
      'an `expect` inside a `describe`',
      `describe('d', () => { it('x', () => { expect(${CHECK}('s')).toEqual([]); }); });`,
    ],
    [
      'a binding asserted on afterwards',
      `it('x', () => { const p = ${CHECK}('s'); expect(p).toEqual([]); });`,
    ],
    [
      'a helper the assertion reaches through',
      `function via() { return ${CHECK}('s'); }\nit('x', () => { expect(via()).toEqual([]); });`,
    ],
    [
      'a `run`/`expect` case table',
      `const CASES = [{ name: 'a', run: () => ${CHECK}('s'), expect: 'clean' }];`,
    ],
    [
      'a problem list drained into failures',
      `for (const p of ${CHECK}('s')) { failures.push(p); }`,
    ],
  ];

  for (const [what, source] of alive) {
    it(`counts ${what}`, () => {
      expect(assertedNames('f.test.ts', source).has(CHECK)).toBe(true);
    });
  }
});

/**
 * The registry's own machinery: a contract that proves nothing, a fixture that
 * probes a different function than its row names, and a row with no mutants.
 */
describe('the registry proves the check still does something', () => {
  const row = () =>
    ENFORCEMENT.find((entry: { check: string }) => entry.check === 'mainGuardProblems');

  it('reports a check with a flawless graph that no longer does anything', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...row(), fn: () => [] }],
    });
    expect(problems.join(' | ')).toMatch(/does not satisfy its own contract/);
  });

  it('reports a row whose contract nothing could fail', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      // Runs the check and asserts nothing about what came back.
      //
      // `at('scripts')`, not `'scripts'` (#40 round 8, D7): a relative path here
      // resolves against the working directory, so `pnpm --filter
      // @atrium/ci-guard test` — which runs from `packages/ci-guard` — made this
      // contract throw ENOENT instead of reporting nothing, and the suite failed
      // with a message about a directory rather than about the rule. Measured on
      // r7: exit 1 from the package directory, exit 0 from the root. CI runs
      // from the root, so it was a hazard rather than a live break, and a gate
      // that only works from one directory is a gate that will be run from
      // another one.
      registry: [
        {
          ...row(),
          contract: (scan: (directory: string) => string[]) => {
            scan(at('scripts'));
            return [];
          },
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(/does not reject the mutant/);
  });

  it('reports a row with no mutants declared at all', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...row(), mutants: [] }],
    });
    expect(problems.join(' | ')).toMatch(/has no mutants declared/);
  });

  /**
   * Found attacking this round's own fix, with D1's class as the checklist.
   * `definedIn` was checked only for existing — nothing tied it to `check`, and
   * it is what `sharedModuleProblems` counts and what the witness set excludes.
   * A row naming a module it does not come from is D3 one level up.
   */
  it('reports a row whose module does not export the check it names', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...row(), definedIn: 'scripts/ci/compose.mjs' }],
    });
    expect(problems.join(' | ')).toMatch(/exports no such name/);
  });

  it('every row in the real registry is exported by the module it names', () => {
    const missing = ENFORCEMENT.filter((entry: { check: string; definedIn: string }) => {
      const exports = exportedNames(entry.definedIn, readFileSync(at(entry.definedIn), 'utf8'));
      return !exports.has(entry.check);
    }).map((entry: { check: string; definedIn: string }) => `${entry.check} in ${entry.definedIn}`);
    expect(missing).toEqual([]);
  });

  it('reports a row with no contract at all', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...row(), contract: undefined }],
    });
    expect(problems.join(' | ')).toMatch(/has no `contract`/);
  });

  /**
   * D3, by construction. A fixture that reaches for the module binding by name
   * instead of using the implementation it was handed produces the same answer
   * for a gutted check as for the real one — so the mutant run reports nothing,
   * and that is what fails.
   */
  it('reports a contract that ignores the implementation it was handed', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          ...row(),
          contract: () =>
            mainGuardProblems(at('scripts')).length === 0 ? [] : ['the real tree is not clean'],
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(/never called the implementation it was handed/);
  });

  /**
   * The evasion found by attacking this round's own fix, which is the same class
   * as D3 one turn further in. `(fn) => fn === theRealOne ? [] : ['wrong']` is
   * clean for the implementation and loud for every mutant — it proves the two
   * runs referenced the same thing, not that the thing did anything, and it
   * passes every other rule in the file. So the handing is counted.
   */
  it('reports a contract that compares identity instead of behaviour', () => {
    const real = row()?.fn;
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        { ...row(), contract: (scan: unknown) => (scan === real ? [] : ['not the real one']) },
      ],
    });
    expect(problems.join(' | ')).toMatch(
      /does not satisfy its own contract|never called the implementation it was handed/,
    );
  });

  it('reports a row whose only mutant refuses to run at all', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          ...row(),
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
    });
    expect(problems.join(' | ')).toMatch(
      /rejected by throwing rather than by anything the contract checked/,
    );
  });
});

describe('the invocation graph', () => {
  it('every check has a witness that is not one of its own subjects', () => {
    expect(checkerGraphProblems({ root: REPO })).toEqual([]);
  });

  it('this file is one of them', () => {
    const mine = 'packages/ci-guard/test/checkers.test.ts';
    const rows = ENFORCEMENT.filter((entry: { invokers: string[] }) =>
      entry.invokers.includes(mine),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reports a check whose only witness is one of its subjects', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          check: 'mainGuardProblems',
          definedIn: 'scripts/ci/guard-scan.mjs',
          fn: () => ['a problem'],
          subjects: ['scripts/'],
          invokers: ['scripts/ci/gate-selftest.mjs'],
          because: 'the round-5 graph, restored as a fixture',
          contract: (scan: () => string[]) => (scan().length > 0 ? [] : ['gutted']),
          mutants: [{ name: 'gutted', fn: () => [] }],
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(/Sole enforcer, sole exception/);
  });

  it('reports a witness nothing in CI runs', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...ENFORCEMENT[0], invokers: ['packages/ci-guard/vitest.config.ts'] }],
    });
    expect(problems.join(' | ')).toMatch(/nothing in \.github\/workflows runs/);
  });

  it('reports a witness the registry has forgotten', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          ...ENFORCEMENT[0],
          invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(
      /workflow-policy-selftest\.mjs asserts on mainGuardProblems, which the registry/,
    );
  });

  /**
   * The generalisation of the round-7 critical finding: the next helper someone
   * extracts must arrive with a registry row, or the build says so.
   */
  /**
   * The attack on the positive control's own scope sentence (#40 round 8).
   *
   * "The entry points named in `CONTROLS`" is a scope, and a one-line deletion
   * from that table puts an assertion back to being unproven with every gate
   * green. The set that has to be covered is read out of the workflow instead —
   * which found a real gap the moment it was written: `assert-migration-image`
   * had no control at all.
   */
  it('every assertion the deploy job runs is controlled or exempted with a reason', () => {
    expect(controlCoverageProblems(REPO)).toEqual([]);
  });

  it('reports the control table emptied while the deploy job still asserts', () => {
    expect(controlCoverageProblems(REPO, readFileSync, { deploy: [] }).join(' | ')).toMatch(
      /no positive control .* ever requires it to fail/,
    );
  });

  it('every shared module under scripts/ci has a row', () => {
    expect(sharedModuleProblems(REPO)).toEqual([]);
  });

  it('reports the shared predicate the round-7 finding was about if its row goes', () => {
    const withoutMainModule = ENFORCEMENT.filter(
      (entry: { definedIn: string }) => entry.definedIn !== 'scripts/ci/main-module.mjs',
    );
    const problems = sharedModuleProblems(REPO, readFileSync, readdirSync, withoutMainModule);
    expect(problems.join(' | ')).toMatch(
      /scripts\/ci\/main-module\.mjs is imported by \d+ other scripts .* and has no row in the registry/,
    );
  });
});

/**
 * Every shared decision under `scripts/ci/`, asserted from outside it.
 *
 * These are the sweep the round-7 critical finding demanded. Each one is a
 * function many scripts route a decision through, which is the shape that turns
 * N independent failures into one total failure — and each one had no test
 * outside `scripts/` before this round.
 */
describe('the shared decisions many scripts depend on', () => {
  it('`check` records a failed assertion and returns what it was given', () => {
    resetFailures();
    expect(check(false, 'a planted failure')).toBe(false);
    expect(failures.length).toBe(1);
    resetFailures();
  });

  it('`check` records nothing for a satisfied assertion', () => {
    resetFailures();
    expect(check(true, 'a satisfied assertion')).toBe(true);
    expect(failures.length).toBe(0);
    resetFailures();
  });

  // `verdict` prints its findings, which is its job and is noise here. Muted
  // around the call and restored before the assertion, rather than wrapped in a
  // helper — a call reached only through a callback is not a witness by this
  // repository's own rule, and this file is that rule's subject as much as
  // anything under scripts/ is.
  const speech = { error: console.error, info: console.info };
  const mute = () => {
    console.error = () => {};
    console.info = () => {};
  };
  const unmute = () => {
    console.error = speech.error;
    console.info = speech.info;
  };

  it('the verdict over a recorded failure is a failing exit status', () => {
    resetFailures();
    check(false, 'a planted failure');
    mute();
    const status = verdict('probe');
    unmute();
    resetFailures();
    expect(status).toBe(1);
  });

  it('the verdict over a clean run is a passing exit status', () => {
    resetFailures();
    mute();
    const status = verdict('probe');
    unmute();
    expect(status).toBe(0);
  });

  /**
   * `report` cannot be tested in the process that calls it, so it is tested in
   * another one.
   *
   * Splitting it into `verdict` and `process.exit(verdict(…))` is this round's
   * own refactor, and it opened exactly the hole this round is about: `verdict`
   * got a contract and the one line that acts on it got nothing. A `report`
   * rewritten to `process.exit(0)` turns six deploy assertions green with every
   * other test here still passing. So: a real child process, a recorded failure,
   * and an exit status that has to be 1.
   */
  it('report exits non-zero for a recorded failure and zero for a clean run', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atrium-report-'));
    const client = pathToFileURL(at('scripts/ci/stack-client.mjs')).href;
    const write = (name: string, body: string) => {
      const path = join(workspace, name);
      writeFileSync(path, `import { check, report } from ${JSON.stringify(client)};\n${body}`);
      return path;
    };
    const failing = write('failing.mjs', "check(false, 'a planted failure');\nreport('probe');\n");
    const passing = write(
      'passing.mjs',
      "check(true, 'a satisfied assertion');\nreport('probe');\n",
    );
    const status = (script: string) => {
      try {
        execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };
    expect([status(failing), status(passing)]).toEqual([1, 0]);
  });

  it("composeArgs resolves the deploy job's whole file list, overlay included", () => {
    expect(
      composeArgs({
        ATRIUM_COMPOSE_PROJECT: 'atrium-ci',
        ATRIUM_COMPOSE_FILES: 'docker-compose.yml:docker-compose.mailpit.yml',
      }),
    ).toEqual(['-p', 'atrium-ci', '-f', 'docker-compose.yml', '-f', 'docker-compose.mailpit.yml']);
  });

  it('composeArgs falls back to the single base file when nothing is set', () => {
    expect(composeArgs({})).toEqual(['-p', 'atrium', '-f', 'docker-compose.yml']);
  });

  it('completedCommands reads an `echo` of a command as an echo', () => {
    const commands = completedCommands('echo exec node scripts/ci/x.mjs') as Array<{
      argv: string[];
    }>;
    expect(commands.map((command) => command.argv)) //
      .toEqual([['echo', 'exec', 'node', 'scripts/ci/x.mjs']]);
  });

  it('completedCommands does not treat a backgrounded command as completed', () => {
    expect(completedCommands('git fetch origin &')).toEqual([]);
  });

  it('completedCommands does not read a comment as a command', () => {
    expect(completedCommands('# node scripts/ci/x.mjs')).toEqual([]);
  });

  it('readFreshReport calls a report older than the run that made it stale', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atrium-report-'));
    const path = join(workspace, 'report.json');
    writeFileSync(path, '{"ok":true}\n');
    const now = Date.now();
    expect(readFreshReport(path, now - 60_000, 'the probe').problems).toEqual([]);
    const twoHoursAgo = (now - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(path, twoHoursAgo, twoHoursAgo);
    expect(readFreshReport(path, now - 60_000, 'the probe').problems.join(' | ')) //
      .toMatch(/is stale: last written/);
  });

  it('readFreshReport calls a report that was never written a failed run', () => {
    expect(
      readFreshReport(join(tmpdir(), 'atrium-absent-report.json'), Date.now(), 'the probe').problems
        .length,
    ) //
      .toBeGreaterThan(0);
  });

  it('manifestPath refuses to invent a default', () => {
    expect(() => manifestPath({})).toThrow(/ATRIUM_IMAGE_MANIFEST/);
    expect(manifestPath({ ATRIUM_IMAGE_MANIFEST: '/tmp/probe.json' })).toBe('/tmp/probe.json');
  });

  it('requireFrom resolves from the directory it is given, and fails when it cannot', () => {
    expect(typeof requireFrom(REPO, 'node:path').join).toBe('function');
    expect(() => requireFrom(REPO, './nothing-of-this-name-exists.cjs')).toThrow();
  });

  /**
   * The positive control, from outside `scripts/` (#40 round 8, D3).
   *
   * Nothing in this repository required an assertion script to contain an
   * assertion. `assert-page-serves.mjs` replaced with two lines that import the
   * reporter and call it printed `assert-page-serves: passed.` and exited 0 with
   * no stack running at all — and the guard scanner, the registry, both
   * self-tests, vitest and biome were every one of them green. No rule about the
   * *text* of a file can catch that, which is why this one runs the file.
   */
  it('controlProblems reports an entry point that exits 0 in a world it cannot have checked', () => {
    expect(
      controlProblems(PROBE_CONTROL, { status: 0, output: 'assert-x: passed.\n' }).join(' | '),
    ).toMatch(/exited 0 when/);
  });

  it('controlProblems does not accept a red for an unrelated reason', () => {
    expect(
      controlProblems(PROBE_CONTROL, { status: 1, output: 'command not found: docker\n' }).join(
        ' | ',
      ),
    ).toMatch(/did not visibly fail for the reason this control planted/);
  });

  it('controlProblems does not accept a child killed by its own timeout', () => {
    expect(
      controlProblems(PROBE_CONTROL, {
        status: undefined,
        output: '',
        error: { code: 'ETIMEDOUT', killed: true },
      }).join(' | '),
    ).toMatch(/did not reach a verdict/);
  });

  it('controlProblems accepts a control that failed visibly for the reason it planted', () => {
    expect(
      controlProblems(PROBE_CONTROL, { status: 1, output: 'assert-x: 3 assertion(s) failed.\n' }),
    ).toEqual([]);
  });

  /**
   * The round-9 D1 rule, from outside `scripts/`.
   *
   * Round 8's three deploy controls expected the script's own name, and a Node
   * stack trace supplies that for free — so the control was scored "red as
   * required" against an `ENOENT` for a certificate authority the deploy job
   * does not write until six steps after the control runs.
   */
  it('expectationProblems accepts the shipped table', () => {
    expect(expectationProblems()).toEqual([]);
  });

  it("expectationProblems refuses an expectation that is the script's own name", () => {
    expect(
      expectationProblems({
        deploy: [
          { id: 'assert-x', entry: 'assert-x', expect: /assert-x/, world: 'w', because: 'b' },
        ],
      }).join(' | '),
    ).toMatch(/satisfied by a Node stack trace/);
  });

  it('expectationProblems refuses an expectation an ENOENT naming the script would satisfy', () => {
    expect(
      expectationProblems({
        deploy: [
          {
            id: 'assert-x',
            entry: 'assert-x',
            expect: /scripts\/ci\/assert-x\.mjs/,
            world: 'w',
            because: 'b',
          },
        ],
      }).join(' | '),
    ).toMatch(/a red this control did not plant/);
  });

  it('expectationProblems refuses a control with no expectation at all', () => {
    expect(
      expectationProblems({
        deploy: [{ id: 'assert-x', entry: 'assert-x', world: 'w', because: 'b' }],
      }).join(' | '),
    ).toMatch(/no `expect` regular expression/);
  });

  it('expectationProblems accepts an expectation about the sentence an assertion records', () => {
    expect(
      expectationProblems({
        deploy: [
          {
            id: 'assert-x',
            entry: 'assert-x',
            // The sentence the *planted* world produces, and nothing else. This
            // used to be `/assert-x: \d+ assertion\(s\) failed\./`, which #40
            // round 10's D6 finding is about: that is the line `verdict` prints
            // for any recorded failure whatever, so it was a pattern about the
            // file rather than about the world. The corpus now generates it.
            expect: /assert-x: nothing is serving this deployment/,
            world: 'w',
            because: 'b',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('every control names a group, an expectation and why the entry point matters', () => {
    const thin = Object.entries(CONTROLS).flatMap(([group, controls]) =>
      (controls as Array<Record<string, unknown>>)
        .filter(
          (control) =>
            typeof control.id !== 'string' ||
            typeof control.world !== 'string' ||
            typeof control.because !== 'string' ||
            !(control.expect instanceof RegExp),
        )
        .map((control) => `${group}: ${String(control.id)}`),
    );
    expect(thin).toEqual([]);
  });

  /**
   * The CAUGHT-vs-crashed distinction, which is round 5's own fix and had two
   * importers, no registry row and no witness outside `scripts/`.
   */
  it('notAVerdict calls a child that exited on its own a verdict', () => {
    expect(notAVerdict({ status: 7, signal: null }, 420_000)).toBeUndefined();
  });

  it('notAVerdict refuses to credit a timeout, a kernel kill or a missing binary', () => {
    expect(notAVerdict({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' }, 420_000)).toMatch(
      /killed by this ledger's own/,
    );
    expect(notAVerdict({ status: null, signal: 'SIGKILL' }, 420_000)).toMatch(/killed by SIGKILL/);
    expect(notAVerdict({ status: null, signal: null, code: 'ENOENT' }, 420_000)).toMatch(
      /never started/,
    );
  });

  it('repoRoot walks up to the marked root and refuses to invent one', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atrium-root-'));
    const nested = join(workspace, 'packages', 'x', 'src');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(workspace, 'scripts', 'ci'), { recursive: true });
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n');
    expect(repoRoot(nested)).toBe(workspace);
    expect(() => repoRoot(tmpdir())).toThrow(/no repository root at or above/);
  });

  it('repoRoot finds this repository from a package directory rather than from the cwd', () => {
    expect(repoRoot(at('packages/ci-guard'))).toBe(REPO.replace(/\/$/, ''));
  });

  it('stackTarget aims at the configured domain over TLS with the deployment’s own CA', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atrium-target-'));
    const ca = join(workspace, 'ca.pem');
    writeFileSync(ca, 'a certificate\n');
    const target = stackTarget({
      ATRIUM_STACK_DOMAIN: 'atrium.localhost',
      ATRIUM_STACK_CA: ca,
      ATRIUM_STACK_HTTPS_PORT: '8443',
    });
    expect(target.origin).toBe('https://atrium.localhost');
    expect(target.httpsPort).toBe(8443);
    expect(String(target.ca)).toContain('a certificate');
  });

  it('stackTarget falls back to the published loopback port with no CA', () => {
    const bare = stackTarget({});
    expect([bare.address, bare.httpsPort, bare.ca]).toEqual(['127.0.0.1', 443, undefined]);
  });

  it('scanForExpectedFailures sees a literal `it.fails` and nothing in a clean file', () => {
    const clean = scanForExpectedFailures(
      ['x.test.ts'],
      () => "import { it } from 'vitest';\nit('a', () => {});\n",
    );
    const annotated = scanForExpectedFailures(
      ['x.test.ts'],
      () => "import { it } from 'vitest';\nit.fails('a', () => {});\n",
    );
    expect(clean.findings).toEqual([]);
    expect(annotated.findings.length).toBeGreaterThan(0);
  });
});

/**
 * Every workflow GitHub would run, not every workflow one glob happened to name.
 */
describe('the workflow policy covers every workflow', () => {
  const workflows = readdirSync(at('.github/workflows'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  it('there is at least one workflow to check', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const name of workflows) {
    it(`${name} is clean under the policy`, () => {
      const path = `.github/workflows/${name}`;
      const violations = checkWorkflowFile(readFileSync(at(path), 'utf8'), path);
      expect(violations.map((v: { rule: string; message: string }) => `[${v.rule}] ${v.message}`)) //
        .toEqual([]);
    });

    it(`${name} keeps every protected verb covered`, () => {
      const jobs = parse(readFileSync(at(`.github/workflows/${name}`), 'utf8'))?.jobs ?? {};
      expect(protectedCommandCoverage(jobs)).toEqual([]);
    });
  }

  it('the policy engine objects to a job that may fail without failing', () => {
    const violations = checkWorkflowFile(
      'name: probe\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n    steps:\n      - run: echo hi\n',
      'probe.yml',
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('the coverage rule objects when the protected set is emptied', () => {
    const jobs = parse(readFileSync(at('.github/workflows/ci.yml'), 'utf8'))?.jobs ?? {};
    expect(protectedCommandCoverage(jobs, []).length).toBeGreaterThan(0);
  });
});

/**
 * The precondition the deploy assertions now run first (#40 round 9, D1).
 *
 * `stackTarget()` used to read `ATRIUM_STACK_CA` with a bare `readFileSync` at
 * module scope, and every stack assertion calls it at module scope, so the world
 * the positive control actually runs in — six steps before `trust-ca` writes
 * that file — killed all three with an `ENOENT` whose stack frame named the
 * script. The control matched the name and called it evidence. These are the two
 * answers that replaced the crash, checked from outside `scripts/`.
 */
describe('the deployment precondition', () => {
  const target = {
    origin: 'https://atrium.localhost',
    address: '127.0.0.1',
    httpsPort: 443,
    domain: 'atrium.localhost',
  };

  it('calls a deployment that answered with a status present', () => {
    expect(absentDeployment(target, { response: { status: 200 } })).toBeUndefined();
  });

  it('turns a refused connection into a sentence rather than a stack trace', () => {
    expect(String(absentDeployment(target, { error: { code: 'ECONNREFUSED' } }))).toMatch(
      /nothing is serving this deployment/,
    );
  });

  it('reads an unreadable certificate authority as its own sentence', () => {
    expect(
      String(absentDeployment({ ...target, caProblem: 'ATRIUM_STACK_CA points at x' }, {})),
    ).toMatch(/ATRIUM_STACK_CA/);
  });

  it('refuses to treat an answer with no status as a deployment', () => {
    expect(String(absentDeployment(target, { response: {} }))).toMatch(
      /came back without a status/,
    );
  });

  it('requireDeployment reports exactly once when nothing is listening', async () => {
    resetFailures();
    const reported: string[] = [];
    await requireDeployment(
      'assert-probe',
      target,
      () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      (what: string) => reported.push(what),
    );
    expect(reported).toEqual(['assert-probe']);
    expect(failures.join(' | ')).toMatch(/nothing is serving this deployment/);
    resetFailures();
  });

  it('requireDeployment says nothing when the deployment answered', async () => {
    resetFailures();
    const reported: string[] = [];
    await requireDeployment(
      'assert-probe',
      target,
      () => Promise.resolve({ status: 200 }),
      (what: string) => reported.push(what),
    );
    expect(reported).toEqual([]);
    expect(failures).toEqual([]);
  });

  /**
   * ── THE ROUND-10 D1 DEFECT, WITNESSED FROM OUTSIDE `scripts/` ──────────────
   * Round 9 answered the certificate-authority problem on `absentDeployment`'s
   * first line, before any request. `ATRIUM_STACK_CA` is set at job level and
   * the file it names is written six steps after the positive control runs, so
   * in the only world that control ever ran in the CA branch fired and the
   * deployment branch was dead code: a live server on one port and nothing on
   * another produced byte-identical output. These four fail on
   * `fix/deploy-serves-r9` as committed.
   */
  describe('and it can tell the two worlds apart', () => {
    const cold = (t: object) => String(absentDeployment(t, { error: { code: 'ECONNREFUSED' } }));
    const answered = (t: object) => String(absentDeployment(t, { error: { code: 'ECONNRESET' } }));
    const noCa = { ...target, caProblem: 'ATRIUM_STACK_CA points at x, which could not be read' };

    it('a refused connection says the deployment is absent even with no certificate authority', () => {
      expect(cold(noCa)).toMatch(/nothing is serving this deployment/);
    });

    it('a peer that answered is not called an absent deployment', () => {
      expect(answered(noCa)).not.toMatch(/nothing is serving this deployment/);
      expect(answered(target)).not.toMatch(/nothing is serving this deployment/);
    });

    it('the two worlds do not produce the same sentence, with the CA missing', () => {
      expect(cold(noCa)).not.toEqual(answered(noCa));
    });

    it('the two worlds do not produce the same sentence, with the CA present', () => {
      expect(cold(target)).not.toEqual(answered(target));
    });
  });
});

/**
 * The corpus of wrong reds, and the two-world measurement (#40 round 10, D1).
 *
 * Round 9's mechanism was a *denylist* of spellings, and the fix changed the
 * shape of the red out from under it: converting a thrown `ENOENT` into a
 * recorded assertion — the right change — produced a sentence no corpus entry
 * held, so `expectationProblems` returned 0 while three controls' `expect`
 * consisted of exactly that message.
 */
describe('the corpus of reds a control did not plant', () => {
  it('is generated by running the precondition, not written down', () => {
    const reds = preconditionReds();
    expect(reds.length).toBeGreaterThan(0);
    for (const red of reds) {
      expect(red.text).toContain('%s');
      expect(red.what.length).toBeGreaterThan(10);
    }
  });

  it('holds the certificate-authority sentence the shipped code produces', () => {
    expect(preconditionReds().some((red) => /ATRIUM_STACK_CA/.test(red.text))).toBe(true);
  });

  it('holds the summary line any recorded failure produces', () => {
    expect(WRONG_REDS.some((red) => /assertion\(s\) failed/.test(red.text))).toBe(true);
  });

  it('refuses an expectation the certificate-authority sentence satisfies', () => {
    expect(
      expectationProblems({
        deploy: [
          {
            id: 'assert-page-serves',
            entry: 'assert-page-serves',
            // r9's own pattern, verbatim.
            expect:
              /assert-page-serves: (?:nothing is serving this deployment|ATRIUM_STACK_CA points at)/,
            world: 'nothing is listening',
            because: 'the r9 defect',
          },
        ],
      }),
    ).toEqual([]);
    // …and with the r9 spelling of that sentence in the corpus, which is what a
    // revert of absentDeployment's ordering would put back:
    expect(
      expectationProblems(
        {
          deploy: [
            {
              id: 'assert-page-serves',
              entry: 'assert-page-serves',
              expect:
                /assert-page-serves: (?:nothing is serving this deployment|ATRIUM_STACK_CA points at)/,
              world: 'nothing is listening',
              because: 'the r9 defect',
            },
          ],
        },
        [
          {
            what: 'the certificate authority not being written yet',
            text: '::error::%s: ATRIUM_STACK_CA points at /w/caddy-root.crt\n',
          },
        ],
      ).join(' '),
    ).toMatch(/is satisfied by/);
  });

  it('refuses an expectation that is only a count of failures', () => {
    expect(
      expectationProblems({
        deploy: [
          {
            id: 'assert-stack-config',
            entry: 'assert-stack-config',
            expect: /assert-stack-config: \d+ assertion\(s\) failed\./,
            world: 'no stack has been brought up',
            because: 'the r9 spelling',
          },
        ],
      }).join(' '),
    ).toMatch(/is satisfied by/);
  });

  it('calls two identical outputs a control that measured nothing', () => {
    expect(
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        { status: 1, output: 'same\n' },
        { status: 1, output: 'same\n' },
      ).join(' '),
    ).toMatch(/byte-identical output/);
  });

  it('accepts two outputs that differ', () => {
    expect(
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        { status: 1, output: 'assert-page-serves: nothing is serving this deployment\n' },
        { status: 1, output: 'assert-page-serves: something is answering\n' },
      ),
    ).toEqual([]);
  });

  it('refuses an expectation the decoy world also satisfies', () => {
    expect(
      distinguishProblems(
        { id: 'assert-page-serves', expect: /assert-page-serves/ },
        { status: 1, output: 'assert-page-serves: a\n' },
        { status: 1, output: 'assert-page-serves: b\n' },
      ).join(' '),
    ).toMatch(/satisfied by its run against a decoy/);
  });

  it('refuses a control that passes against a peer that is not a deployment', () => {
    expect(
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        { status: 1, output: 'assert-page-serves: nothing is serving this deployment\n' },
        { status: 0, output: 'assert-page-serves: passed.\n' },
      ).join(' '),
    ).toMatch(/exited 0 against a peer/);
  });
});

/**
 * The run has to have done the work (#40 round 10, D2 and D3).
 *
 * A floor over `check()` *call sites* is a floor over nothing when every problem
 * reaches one site through a loop: the measured exploit replaced 529 lines of
 * schema comparison with an empty list and printed `assert-stack-schema:
 * passed.` against the live migrated stack with the floor satisfied.
 */
describe('the runtime assertion floors', () => {
  const floors = (entry: object) => () => ({ floors: entry });

  it('reports a run that made fewer assertions than the manifest says it makes', () => {
    expect(
      runtimeFloorProblems(
        'assert-stack-schema',
        { assertions: 1, requests: 0 },
        floors({ minRun: 230 }),
      ).join(' '),
    ).toMatch(/recorded 1 assertion\(s\) in this run/);
  });

  it('reports a run that asked the deployment nothing', () => {
    expect(
      runtimeFloorProblems(
        'assert-page-serves',
        { assertions: 99, requests: 1 },
        floors({ minRun: 24, minRequests: 18 }),
      ).join(' '),
    ).toMatch(/put 1 request\(s\) to the deployment/);
  });

  it('says nothing about a run that did the work', () => {
    expect(
      runtimeFloorProblems(
        'assert-page-serves',
        { assertions: 29, requests: 25 },
        floors({ minRun: 24, minRequests: 18 }),
      ),
    ).toEqual([]);
  });

  it('treats a manifest it could not read as a failure rather than as a pass', () => {
    expect(
      runtimeFloorProblems('assert-page-serves', { assertions: 99, requests: 99 }, () => ({
        problem: 'the manifest could not be read',
      })).join(' '),
    ).toMatch(/could not be read/);
  });

  it('reads the real manifest and finds the floor for a real script', () => {
    expect(
      runtimeFloorProblems('assert-page-serves', { assertions: 0, requests: 0 }).join(' '),
    ).toMatch(/recorded 0 assertion\(s\)/);
  });

  it('counts a recorded assertion and a fold of comparisons alike', () => {
    resetFailures();
    check(observations.assertions === 0, 'the tally starts at zero');
    compared(40, 'a comparison over forty subjects');
    expect(observations.assertions).toBe(41);
    resetFailures();
    expect(observations.assertions).toBe(0);
  });

  it('refuses a comparison that reports something which is not a count', () => {
    resetFailures();
    compared(Number.NaN, 'a comparison');
    expect(failures.join(' ')).toMatch(/which is not a count of anything/);
    resetFailures();
  });

  it('a verdict fails a run that did the work but recorded nothing about it', () => {
    resetFailures();
    // `assert-page-serves` has a floor in the shipped manifest; a run that made
    // no assertions at all is the gutting, and `verdict` is where it is caught.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = verdict('assert-page-serves');
    quiet.mockRestore();
    expect(status).toBe(1);
    resetFailures();
  });
});

/**
 * A recorded assertion has to read something (#40 round 10, D3).
 *
 * The measured exploit satisfied the precondition and then made twenty-three
 * assertions about the constant `true`, which prints `passed.` against the live
 * stack and satisfies every floor exactly — a floor counts assertions and cannot
 * tell a claim from a constant.
 */
describe('the conditions of recorded assertions', () => {
  const withPageServes = (source: string) => (path: string, encoding: string) =>
    String(path).endsWith('assert-page-serves.mjs')
      ? source
      : (readFileSync as never as (p: string, e: string) => string)(path, encoding);

  it('accepts this repository, where every recorded assertion reads a value', () => {
    expect(assertionConditionProblems(REPO)).toEqual([]);
  });

  it('refuses `check(true, …)` — the measured exploit', () => {
    expect(
      assertionConditionProblems(
        REPO,
        withPageServes(
          "import { check, report } from './stack-client.mjs';\ncheck(true, 'x');\nreport('assert-page-serves');\n",
        ) as never,
      ).join(' '),
    ).toMatch(/reads no value/);
  });

  it('refuses the same tautology hidden behind a module-scope constant', () => {
    expect(
      assertionConditionProblems(
        REPO,
        withPageServes(
          "import { check, report } from './stack-client.mjs';\nconst FINE = true;\ncheck(FINE, 'x');\nreport('assert-page-serves');\n",
        ) as never,
      ).join(' '),
    ).toMatch(/reads no value/);
  });

  it('refuses a fold that reports a literal count of comparisons it never made', () => {
    expect(
      assertionConditionProblems(
        REPO,
        withPageServes(
          "import { check, compared, report } from './stack-client.mjs';\ncompared(40, 'nothing at all');\nreport('assert-page-serves');\n",
        ) as never,
      ).join(' '),
    ).toMatch(/reads no value/);
  });

  it('accepts `check(false, problem)`, which no arrangement of can make a script pass', () => {
    expect(
      assertionConditionProblems(
        REPO,
        withPageServes(
          "import { check, report } from './stack-client.mjs';\nfor (const problem of []) check(false, problem);\nreport('assert-page-serves');\n",
        ) as never,
      ),
    ).toEqual([]);
  });
});

/**
 * An entry point is where a word resolves, not how it is spelled (r10, D4).
 *
 * Measured: `run: node ./scripts/ci/invented-thing.mjs` in the `verify` job left
 * `controlCoverageProblems` reporting 0 and every gate green — a brand-new,
 * entirely uncontrolled entry point admitted by two characters.
 */
describe('reading this repository’s entry points out of a workflow', () => {
  it('reads every spelling of one path as one entry point', () => {
    for (const spelling of [
      'scripts/ci/assert-page-serves.mjs',
      './scripts/ci/assert-page-serves.mjs',
      '../../scripts/ci/assert-page-serves.mjs',
      'scripts/./ci/assert-page-serves.mjs',
      '/home/runner/work/atrium/atrium/scripts/ci/assert-page-serves.mjs',
    ]) {
      expect(ciScriptName(spelling)).toBe('assert-page-serves');
    }
  });

  it('reads a word that is not one of them as none', () => {
    for (const word of ['node', 'pnpm', 'assert-page-serves.mjs', 'scripts/ci/Assert.mjs', '']) {
      expect(ciScriptName(word)).toBeNull();
    }
  });

  it('sees an uncontrolled entry point written with a leading `./`', () => {
    const withInvented = (path: string, encoding: string) => {
      const source = (readFileSync as never as (p: string, e: string) => string)(path, encoding);
      return String(path).endsWith('ci.yml')
        ? String(source).replace(
            '      - name: Build the images',
            '      - name: An invented thing\n        run: node ./scripts/ci/invented-thing.mjs\n\n      - name: Build the images',
          )
        : source;
    };
    expect(controlCoverageProblems(REPO, withInvented as never).join(' ')).toMatch(
      /runs scripts\/ci\/invented-thing\.mjs and no positive control/,
    );
  });
});

/**
 * The mail relay's address, which was a debt entry with a false reason (r9).
 *
 * `mailpit` sat in `UNCONTRACTED` as "it talks to the mail catcher the overlay
 * adds". It does no I/O: it resolves one environment variable and returns
 * closures. It has a registry row now, and these are its outside witnesses.
 */
describe('the mail relay address', () => {
  it('resolves the published port when nothing says otherwise', () => {
    expect(mailpit({}).base).toBe('http://127.0.0.1:8025');
  });

  it('lets the overlay move the relay', () => {
    expect(mailpit({ ATRIUM_MAILPIT_URL: 'http://relay:8025' }).base).toBe('http://relay:8025');
  });

  it('does not take a blank variable as an address', () => {
    expect(mailpit({ ATRIUM_MAILPIT_URL: '   ' }).base).toBe('http://127.0.0.1:8025');
  });

  it('hands back both operations the signup assertion needs', () => {
    expect(typeof mailpit({}).get).toBe('function');
    expect(typeof mailpit({}).deleteAll).toBe('function');
  });
});

/**
 * The exit status of both report gates (#40 round 9).
 *
 * `fail` has two importers, which is under `SHARED_MODULE_THRESHOLD` and over
 * the stake: `return 1` to `return 0` and both report assertions print every
 * problem they found as a GitHub annotation and exit 0.
 */
describe('the report gates’ exit status', () => {
  it('turns a list of problems into a failing status', () => {
    // Silenced without a `try`: `assertedNames` deliberately does not enter one,
    // so an assertion inside a `try` block is an assertion the invocation graph
    // cannot see — which would make this file a declared witness that witnesses
    // nothing, the exact shape checkerGraphProblems exists to report.
    const said = console.error;
    console.error = () => {};
    const one = fail(['a problem'], 'the probe');
    const two = fail(['a', 'b'], 'the probe');
    console.error = said;
    expect(one).toBe(1);
    expect(two).toBe(1);
  });
});

/**
 * The round-4 entry decision, asked of the whole repository (#40 round 9, D7).
 *
 * `mainGuardProblems` is only ever pointed at `scripts/`. A blind critic pointed
 * the shipped scanner at `packages/ingest/src` and got five problems, including
 * the round-4 comparison in a published CLI: `node dist/cli.js` printed usage,
 * and the same file through a symlink printed nothing and exited 0.
 */
describe('how anything in this repository decides it was run', () => {
  it('no file under scripts/, packages/ or apps/ compares a URL against a path', () => {
    expect(entryDecisionProblems(at('scripts'))).toEqual([]);
    expect(entryDecisionProblems(at('packages'))).toEqual([]);
    expect(entryDecisionProblems(at('apps'))).toEqual([]);
  });

  it('reports the comparison the ingest CLI used to ship', () => {
    expect(
      entryDecisionProblems(at('scripts'), (path: string) =>
        String(path).endsWith('assert-tables.mjs')
          ? "const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);\nif (entry === fileURLToPath(import.meta.url)) { main(); }"
          : readFileSync(path, 'utf8'),
      ).join(' | '),
    ).toMatch(/round-4 guard with the other half renamed/);
  });

  it('follows a symlinked directory rather than skipping it in silence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atrium-symlink-scan-'));
    const real = join(workspace, 'real');
    mkdirSync(real);
    writeFileSync(
      join(real, 'entry.mjs'),
      'if (import.meta.url === `file://${process.argv[1]}`) { main(); }\n',
    );
    const root = join(workspace, 'root');
    mkdirSync(root);
    symlinkSync(real, join(root, 'linked'), 'dir');
    expect(entryDecisionProblems(root).join(' | ')).toMatch(/comparing `import\.meta\.url`/);
  });
});

/**
 * The floors on how many assertions each stack assertion still records (r9).
 *
 * The positive control proves a script's answer is a function of the deployment
 * by running it where there is none. It cannot tell that script apart from one
 * cut down to its `requireDeployment` precondition, which goes red in exactly
 * the same world — 48 `check()` calls' worth of difference, measured.
 */
describe('the assertion floors', () => {
  const manifestOf = (json: unknown) =>
    ((path: string, encoding: string) =>
      String(path).endsWith('ci-manifest.json')
        ? JSON.stringify(json)
        : readFileSync(path, encoding as BufferEncoding)) as unknown as typeof readFileSync;

  it('every script that records assertions meets its floor', () => {
    expect(assertionFloorProblems(REPO)).toEqual([]);
  });

  it('reports a stack assertion gutted below its floor', () => {
    expect(
      assertionFloorProblems(
        REPO,
        manifestOf({
          assertions: { scripts: { 'scripts/ci/assert-page-serves.mjs': { minChecks: 9999 } } },
        }),
      ).join(' | '),
    ).toMatch(/recorded assertion\(s\) and .* declares a floor of/);
  });

  it('refuses a manifest with the whole table deleted', () => {
    expect(assertionFloorProblems(REPO, manifestOf({ vitest: {} })).join(' | ')).toMatch(
      /no `assertions\.scripts` object/,
    );
  });

  it('reports a floor left behind by a script that records nothing', () => {
    expect(
      assertionFloorProblems(
        REPO,
        manifestOf({ assertions: { scripts: { 'scripts/ci/assert-gone.mjs': { minChecks: 1 } } } }),
      ).join(' | '),
    ).toMatch(/does not record assertions through `check`/);
  });
});
