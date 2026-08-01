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
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  assertedNames,
  checkerGraphProblems,
  ENFORCEMENT,
  sharedModuleProblems,
} from '../../../scripts/ci/checker-graph.mjs';
import { composeArgs } from '../../../scripts/ci/compose.mjs';
import { guardProblems, mainGuardProblems } from '../../../scripts/ci/guard-scan.mjs';
import { requireFrom } from '../../../scripts/ci/import-from.mjs';
import { isMainModule } from '../../../scripts/ci/main-module.mjs';
import { manifestPath } from '../../../scripts/ci/record-built-images.mjs';
import { readFreshReport } from '../../../scripts/ci/report-file.mjs';
import { scanForExpectedFailures } from '../../../scripts/ci/scan-expected-failures.mjs';
import { completedCommands } from '../../../scripts/ci/shell-command.mjs';
import { check, failures, resetFailures, verdict } from '../../../scripts/ci/stack-client.mjs';
import {
  checkWorkflowFile,
  protectedCommandCoverage,
} from '../../../scripts/ci/workflow-policy.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const at = (relative: string) => `${REPO}${relative}`;
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
      registry: [{ ...row(), contract: () => [] }],
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
    expect(problems.join(' | ')).toMatch(/does not reject the mutant/);
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
