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
 * and the scanner reports zero problems (the canonical spelling is still in the
 * file — as a *string literal*, on line 1607, where it was stored as a fixture),
 * biome is clean, the workflow policy is clean, `node gate-selftest.mjs` prints
 * "142 cases", and under `CI=true` the file exits 0 having asserted nothing.
 * `workflow-policy-selftest.mjs` then takes the same edit unopposed, because the
 * only thing that would have objected has just been silenced. Two `&&`
 * insertions, 316 assertions gone, every gate green.
 *
 * Two fixes. `scripts/ci/guard-scan.mjs` parses instead of scanning text, so a
 * quoted guard is a string and a real one is a statement. And this file: a
 * caller that is *not* under `scripts/`, cannot be disarmed by editing anything
 * under `scripts/`, runs in the `verify` job's Vitest step, and carries a floor
 * in `.github/ci-manifest.json` that ratchets against `origin/main` — so
 * deleting it is a red build in three different places rather than a silence.
 *
 * `checkerGraphProblems` asserts that this arrangement keeps holding, for every
 * check in the registry rather than only for this one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  calledNames,
  checkerGraphProblems,
  ENFORCEMENT,
} from '../../../scripts/ci/checker-graph.mjs';
import { guardProblems, mainGuardProblems } from '../../../scripts/ci/guard-scan.mjs';
import {
  checkWorkflowFile,
  protectedCommandCoverage,
} from '../../../scripts/ci/workflow-policy.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const at = (relative: string) => `${REPO}${relative}`;
const IMPORT = "import { isMainModule } from './main-module.mjs';\n";
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
 * The evasions, each one a spelling that `String.includes` accepted.
 *
 * The first is the one a blind review actually landed on r5 and measured green
 * end to end; the rest are the neighbours it opens. They are here rather than
 * only in `gate-selftest.mjs` because `gate-selftest.mjs` is a subject of the
 * scanner and this file is not.
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
      /which is not the shared predicate/,
    ],
    // A blind cross-lineage review of round 6's first draft measured these four.
    // The rule said "from scripts/ci/main-module.mjs" and the code compared the
    // *basename*, so a lookalike beside it — or in /tmp — was accepted, and a
    // lookalike that returns `false` restores the whole defect with the scanner
    // green. A name was checked where a location was meant, which is the same
    // class as `VITEST_RUN_START=` two files over.
    [
      'a lookalike predicate in a subdirectory',
      "import { isMainModule } from './vendor/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared predicate/,
    ],
    [
      'a lookalike predicate by absolute path',
      "import { isMainModule } from '/tmp/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared predicate/,
    ],
    [
      'a lookalike predicate one directory sideways',
      "import { isMainModule } from '../attacker/main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared predicate/,
    ],
    [
      'a bare specifier, which in ESM is a package name and not this file at all',
      "import { isMainModule } from 'main-module.mjs';\nif (isMainModule(import.meta.url)) {\n  process.exit(main());\n}\n",
      /which is not the shared predicate/,
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
    // A blind review named this one before its run ended: a rule about the
    // *condition* is defeated by moving the second gate into the *body*, and
    // that is a smaller edit than the one that started this ticket.
    [
      'the round-5 conjunct relocated from the condition into the body',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  if (process.env.CI === undefined) {\n    process.exit(main());\n  }\n}\n`,
      /every statement in its body is a branch/,
    ],
    [
      'the whole body behind `if (false)`',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  if (false) {\n    process.exit(main());\n  }\n}\n`,
      /every statement in its body is a branch/,
    ],
    [
      'the work swallowed by an empty catch, so failure exits 0',
      `${IMPORT}if (isMainModule(import.meta.url)) {\n  const code = main();\n  try {\n    process.exit(code);\n  } catch {}\n}\n`,
      /empty `catch` in its body/,
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
 * The route that made the round-5 scanner useless: the canonical guard stored as
 * a string.
 *
 * `gate-selftest.mjs` held it as `CANONICAL_GUARD_LINE`, eight lines below two
 * comments explaining that the *broken* guard had to be built from concatenated
 * halves for exactly this reason. A parser needs no such discipline, and these
 * two cases are what says so: quoting the guard is not having one, and having a
 * quoted one does not excuse a broken real one.
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

  it('work first and a conditional exit after it is what real scripts do', () => {
    const source = `${IMPORT}if (isMainModule(import.meta.url)) {\n  const verb = parse(process.argv.slice(2));\n  if (verb === undefined) {\n    process.exit(2);\n  }\n  process.exit(main(verb));\n}\n`;
    expect(guardProblems('fixture.mjs', source)).toEqual([]);
  });
});

/**
 * Presence is not use.
 *
 * The graph above proves who calls what. None of it proves the check still does
 * anything — `mainGuardProblems` rewritten to `return []` has a *perfect*
 * invocation graph. And a call site is only an invocation if it can run: a blind
 * review pointed out that putting this file's two calls inside `if (false)` left
 * both self-tests exit 0, which defeats the fix for the critical finding with
 * four characters. Both halves are checked, from outside `scripts/`.
 */
describe('a call that cannot run is not an invocation', () => {
  const dead: Array<[string, string]> = [
    ['inside `if (false)`', 'if (false) { mainGuardProblems("scripts"); }'],
    ['in a skipped test', 'it.skip("x", () => { mainGuardProblems("scripts"); });'],
    ['after a `return`', 'function f() { return 1; mainGuardProblems("scripts"); }'],
    ['after `process.exit()`', '{ process.exit(1); mainGuardProblems("scripts"); }'],
    ['in the false arm of a ternary', 'const x = false ? mainGuardProblems("scripts") : 1;'],
  ];

  for (const [where, source] of dead) {
    it(`does not count a call ${where}`, () => {
      expect(calledNames('f.test.ts', source).has('mainGuardProblems')).toBe(false);
    });
  }

  it('still counts a live call in a real test, or the rule is a ban on calls', () => {
    const source = 'it("x", () => { mainGuardProblems("scripts"); });';
    expect(calledNames('f.test.ts', source).has('mainGuardProblems')).toBe(true);
  });

  it('reports a check with a flawless graph that no longer does anything', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...ENFORCEMENT[0], violate: () => [] }],
    });
    expect(problems.join(' | ')).toMatch(/reported nothing about an input that violates it/);
  });

  it('reports a row with no violation fixture at all', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [{ ...ENFORCEMENT[0], violate: undefined }],
    });
    expect(problems.join(' | ')).toMatch(/has no `violate` fixture/);
  });
});

describe('the invocation graph', () => {
  it('every check has an invoker that is not one of its own subjects', () => {
    expect(checkerGraphProblems({ root: REPO })).toEqual([]);
  });

  it('this file is one of them', () => {
    const mine = 'packages/ci-guard/test/checkers.test.ts';
    const rows = ENFORCEMENT.filter((entry: { invokers: string[] }) =>
      entry.invokers.includes(mine),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reports a check whose only invoker is one of its subjects', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          check: 'mainGuardProblems',
          definedIn: 'scripts/ci/guard-scan.mjs',
          subjects: ['scripts/'],
          invokers: ['scripts/ci/gate-selftest.mjs'],
          because: 'the round-5 graph, restored as a fixture',
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(/Sole enforcer, sole exception/);
  });

  it('reports an invoker nothing in CI runs', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          check: 'mainGuardProblems',
          definedIn: 'scripts/ci/guard-scan.mjs',
          subjects: ['scripts/'],
          invokers: ['packages/ci-guard/vitest.config.ts'],
          because: 'a file CI never executes is not a witness',
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(/nothing in \.github\/workflows runs/);
  });

  it('reports a call site the registry has forgotten', () => {
    const problems = checkerGraphProblems({
      root: REPO,
      registry: [
        {
          check: 'mainGuardProblems',
          definedIn: 'scripts/ci/guard-scan.mjs',
          subjects: ['scripts/'],
          invokers: ['scripts/ci/gate-selftest.mjs', 'packages/ci-guard/test/checkers.test.ts'],
          because: 'drift in the other direction',
        },
      ],
    });
    expect(problems.join(' | ')).toMatch(
      /workflow-policy-selftest\.mjs calls mainGuardProblems, which the registry/,
    );
  });
});

/**
 * Every workflow GitHub would run, not every workflow one glob happened to name.
 *
 * `.github/workflows/*.yml` misses `.yaml`, which GitHub runs just as happily —
 * so a `.github/workflows/x.yaml` was invisible to every rule in the engine.
 * The `verify` job now hands the policy the directory. This is the independent
 * witness for that: the directory is enumerated here, from outside `scripts/`,
 * and every file in it must pass.
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
});
