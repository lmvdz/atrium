/**
 * Proves the test gates reject what they claim to reject.
 *
 * The gates in this directory are the only thing standing between "the suite
 * ran and passed" and "the suite reported nothing and the exit code was 0". A
 * gate with a bug in it is worse than no gate, because it is trusted. So each
 * case below hands a gate a report shaped exactly like the real thing — the
 * Playwright fixtures are transcribed from an actual `test.fail()` /
 * `test.fixme()` run — with one thing wrong, and asserts the gate says so.
 *
 * Four families of case:
 *   - the report gates: skipped, todo, expected-failure, a vanished project, an
 *     unenrolled one, a stale or missing report, reports that disagree
 *   - the floor ratchet: a floor lowered with and without a written reason, an
 *     enrolled workspace demoted to `exempt`, a justification attached to a cut
 *     nobody made, and the no-baseline case
 *   - the second witness for `it.fails()`, read from source rather than report
 *   - the `gate` job's verdict script, extracted from the real workflow and
 *     *executed* against synthetic `needs` payloads. The policy engine parses
 *     that script; a parser reads shapes, and a shape can be right while the
 *     logic is wrong. Only running it can tell working code from convincing
 *     code, so `skipped`, `cancelled`, `failure` and an empty `needs` are each
 *     put through the real bash and the real node.
 *
 *   node scripts/ci/gate-selftest.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { checkRatchet } from './assert-floor-ratchet.mjs';
import { checkPlaywrightReport } from './assert-playwright-report.mjs';
import { checkVitestReports } from './assert-vitest-report.mjs';
import { checkEnrollment } from './assert-workspace-enrollment.mjs';
import { readFreshReport } from './report-file.mjs';
import { checkExpectedFailureWitness, scanForExpectedFailures } from './scan-expected-failures.mjs';

const WORKFLOW = process.env.CI_WORKFLOW ?? '.github/workflows/ci.yml';

const MANIFEST = {
  vitest: {
    workspaces: {
      'packages/core': { project: 'core', minTests: 10 },
      'packages/db': { project: 'db', minTests: 5 },
    },
    exempt: { 'apps/web': 'browser surface, covered by the playwright projects instead' },
    minTotalTests: 15,
  },
  playwright: { projects: { chromium: { minTests: 2 } }, minTotalTests: 2 },
};

function counts(overrides = {}) {
  return { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, expectedFailure: 0, ...overrides };
}

/**
 * A clean pair of vitest reports: 12 core tests, 6 db tests, nothing amiss.
 *
 * Both sides name every test, because the gate now reconciles identities and
 * not just totals — a fixture that carried counts alone would be exactly the
 * gutted reporter the reconciliation exists to catch.
 */
function vitestReports() {
  const files = [
    {
      project: 'core',
      workspace: 'packages/core',
      moduleId: 'packages/core/test/a.test.ts',
      n: 12,
    },
    { project: 'db', workspace: 'packages/db', moduleId: 'packages/db/test/b.test.ts', n: 6 },
  ];
  const titles = (file) => Array.from({ length: file.n }, (_, i) => `case ${i + 1}`);

  const stock = {
    success: true,
    numTotalTests: 18,
    numPassedTests: 18,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 2,
    testResults: files.map((file) => ({
      name: resolve(process.cwd(), file.moduleId),
      assertionResults: titles(file).map((title) => ({
        ancestorTitles: [file.project],
        title,
        status: 'passed',
        failureMessages: [],
      })),
    })),
  };
  const detailed = {
    reason: 'passed',
    unhandledErrors: 0,
    totals: counts({ tests: 18, passed: 18 }),
    projects: {
      core: counts({ tests: 12, passed: 12 }),
      db: counts({ tests: 6, passed: 6 }),
    },
    workspaces: {
      'packages/core': counts({ tests: 12, passed: 12 }),
      'packages/db': counts({ tests: 6, passed: 6 }),
    },
    expectedFailures: [],
    modules: files.map((file) => ({
      project: file.project,
      workspace: file.workspace,
      moduleId: file.moduleId,
      tests: file.n,
      testNames: titles(file).map((title) => `${file.project} > ${title}`),
    })),
  };
  return { stock, detailed };
}

/** A manifest shaped like the real one, for the ratchet cases. */
function ratchetManifest(overrides = {}) {
  return {
    vitest: {
      workspaces: {
        'packages/core': { project: 'core', minTests: 120 },
        'packages/db': { project: 'db', minTests: 10 },
      },
      exempt: {},
      minTotalTests: 130,
      ...overrides.vitest,
    },
    playwright: { projects: { chromium: { minTests: 2 } }, minTotalTests: 2 },
    ratchet: { justifications: {}, ...overrides.ratchet },
  };
}

/**
 * Pulls the `gate` job's verdict script straight out of the real workflow and
 * runs it, which is the only way to tell working code from convincing code.
 *
 * The policy engine parses this script and requires it to iterate `needs`,
 * compare against `success`, and exit non-zero — but a parser reads shapes, and
 * a shape can be right while the logic is wrong. So: real bash, real node, real
 * `needs` payloads, and an assertion on the exit code.
 */
function runGateScript(needs) {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
  const steps = workflow?.jobs?.gate?.steps ?? [];
  const step = steps.find((candidate) =>
    Object.values(candidate?.env ?? {}).some((value) =>
      /toJSON\s*\(\s*needs\s*\)/.test(String(value)),
    ),
  );
  if (step === undefined) throw new Error(`no gate step in ${WORKFLOW} binds toJSON(needs)`);
  const variable = Object.keys(step.env).find((key) =>
    /toJSON\s*\(\s*needs\s*\)/.test(String(step.env[key])),
  );
  const result = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, [variable]: JSON.stringify(needs) },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Turns an exit-code expectation into the problem list the harness understands. */
function expectGateExit(needs, wanted, description) {
  const { status, output } = runGateScript(needs);
  if (status === wanted) return [];
  return [
    `the gate script exited ${status} for ${description}, expected ${wanted}. It said: ${output.trim().split('\n').join(' / ')}`,
  ];
}

/** A clean Playwright report, shaped like the real json reporter's output. */
function playwrightReport() {
  const test = (title, overrides = {}) => ({
    title,
    line: 10,
    tests: [
      {
        projectName: 'chromium',
        expectedStatus: 'passed',
        status: 'expected',
        annotations: [],
        ...overrides,
      },
    ],
  });
  return {
    suites: [
      {
        title: 'smoke.spec.ts',
        file: 'e2e/smoke.spec.ts',
        specs: [test('renders'), test('toggles')],
      },
    ],
    errors: [],
    stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
  };
}

function mutate(report, fn) {
  const copy = structuredClone(report);
  fn(copy);
  return copy;
}

/** Runs the expected-failure scanner over an in-memory file set. */
function scanFixture(files, entries = ['x.test.ts']) {
  return scanForExpectedFailures(entries, (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  });
}

/**
 * Every spelling of an expected failure the scanner must see.
 *
 * The round-3 gauntlet's finding was that the line matcher missed
 * `test.each([...]).fails(...)` — a form its own comment advertised — so the
 * standing requirement is now a fixture per form rather than a claim per form.
 * Anything added to Vitest's surface that means "this test is allowed to fail"
 * belongs here with a line of its own.
 *
 * Seven of these were also written out as real test files and run under Vitest
 * 4.1.10 before being frozen here, because a fixture nobody executed proves the
 * scanner reads a string and not that the string is an evasion. All seven ran,
 * produced 8 expected failures, and Vitest exited 0. Round 3's line matcher
 * caught two of the seven. (One form below did *not* survive that check and is
 * kept deliberately: `test.each([...]).fails(...)` is what round 3's comment
 * advertised, and it is not a Vitest 4 API at all — `.each()` returns a plain
 * function, so it throws `test.each(...).fails is not a function` and fails the
 * run loudly. The real chained spelling is `test.fails.each([...])`, which is
 * here too. Covering the advertised form costs nothing and stops the claim from
 * being wrong a third time if the API ever grows it.)
 */
const EVADED_FORMS = {
  'the chained-each form round 3 advertised and could not match (not a Vitest 4 API)':
    "import { test } from 'vitest';\ntest.each([[1], [2]]).fails('parameterised and broken', () => {});\n",
  'the chained-each form Vitest actually has':
    "import { test } from 'vitest';\ntest.fails.each([[1], [2]])('parameterised and broken: %i', () => {});\n",
  'computed member access, so the characters `.fails` never appear':
    "import { it } from 'vitest';\nit['fails']('spelled as a subscript', () => {});\n",
  'optional chaining between the runner and the annotation':
    "import { it } from 'vitest';\nit?.fails('spelled with a question mark', () => {});\n",
  'the chain spread across lines, so no single line carries it':
    "import { test } from 'vitest';\ntest\n  .each([[1], [2]])\n  .fails('broken over three lines', () => {});\n",
  'the annotation bound to a name of its own before it is called':
    "import { it } from 'vitest';\nconst knownBroken = it.fails;\nknownBroken('aliased', () => {});\n",
  'the annotation destructured straight off the runner':
    "import { it } from 'vitest';\nconst { fails } = it;\nfails('destructured', () => {});\n",
  'the runner renamed at the import, so `it` never appears':
    "import { it as sanity } from 'vitest';\nsanity.fails('renamed at the import', () => {});\n",
  'the runner reached through a namespace import':
    "import * as vitest from 'vitest';\nvitest.it.fails('through the namespace', () => {});\n",
  'a chained modifier before the annotation':
    "import { it } from 'vitest';\nit.concurrent.fails('chained', () => {});\n",
  'the options-object spelling':
    "import { it } from 'vitest';\nit('sneaky', { fails: true }, () => {});\n",
  'the options object hoisted into a variable':
    "import { it } from 'vitest';\nconst options = { fails: true };\nit('sneakier', options, () => {});\n",
};

/**
 * The same, but living in a helper module no report will ever name.
 *
 * This is the form the round-3 scanner could not reach even in principle: it
 * read exactly the modules the CI reporter listed, and a helper is not a module
 * in any report. The scan now starts from the test glob and follows relative
 * imports, so the annotation is found where it physically is.
 */
const HELPER_FORMS = {
  'an annotation exported from a helper the report never names': {
    'x.test.ts':
      "import { knownBroken } from './helpers';\nknownBroken('via a helper', () => {});\n",
    'helpers.ts': "import { it } from 'vitest';\nexport const knownBroken = it.fails;\n",
  },
  'an annotation two relative hops away, behind a re-export': {
    'x.test.ts':
      "import { knownBroken } from './helpers';\nknownBroken('via a re-export', () => {});\n",
    'helpers.ts': "export { knownBroken } from './deep/broken';\n",
    'deep/broken.ts': "import { it } from 'vitest';\nexport const knownBroken = it.fails;\n",
  },
  'a helper that wraps the options-object spelling': {
    'x.test.ts': "import { brokenTest } from './helpers';\nbrokenTest('wrapped', () => {});\n",
    'helpers.ts':
      "import { it } from 'vitest';\nexport const brokenTest = (name, fn) => it(name, { fails: true }, fn);\n",
  },
};

/**
 * Shapes that merely *mention* failing and must stay clean.
 *
 * A witness that fires on prose is a witness somebody turns off. The line
 * matcher failed this too — `it('rejects it.fails …')` was a violation to it —
 * which is the same bug as the misses, seen from the other side.
 */
const NOT_ANNOTATIONS = {
  'prose about the rule in a comment': {
    'x.test.ts':
      "// never write it.fails('x') here\n/* nor { fails: true } */\nimport { it } from 'vitest';\nit('real', () => {});\n",
  },
  'the words inside a string literal, which is a test name and not a call': {
    'x.test.ts':
      "import { it } from 'vitest';\nit('rejects it.fails as coverage', () => {});\nit('fails closed when the file is missing', () => {});\n",
  },
  'a domain object that happens to have a `fails` property': {
    'x.test.ts':
      "import { it } from 'vitest';\nimport { validate } from './domain';\nit('counts', () => { expect(validate().fails).toBe(0); });\n",
    'domain.ts': 'export const validate = () => ({ fails: 0 });\n',
  },
  'an explicit `fails: false`, which is the opposite of an annotation': {
    'x.test.ts': "import { it } from 'vitest';\nit('normal', { fails: false }, () => {});\n",
  },
  // Regression guard: the import walk must not hand the parser a stylesheet and
  // then call the resulting syntax errors a blind spot. Measured against the
  // real tree — an earlier resolver reached design/tokens.css through apps/web's
  // layout — and a gate that goes red because a component test imported a
  // `.module.css` is a gate somebody deletes.
  'a relative import of something that is not source at all': {
    'x.test.ts':
      "import { it } from 'vitest';\nimport './styles.module.css';\nit('renders', () => {});\n",
    'styles.module.css': ':root { --shell-gap: 1px; }\n',
  },
};

const CASES = [
  {
    name: 'a clean vitest run passes',
    run: () => {
      const { stock, detailed } = vitestReports();
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: 'clean',
  },
  {
    name: 'a skipped test is not a passing test',
    run: () => {
      const { stock, detailed } = vitestReports();
      stock.numPendingTests = 1;
      detailed.projects.core.skipped = 1;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /skipped/i,
  },
  {
    name: 'an it.fails() test is an expected failure, not coverage',
    run: () => {
      const { stock, detailed } = vitestReports();
      detailed.totals.expectedFailure = 1;
      detailed.projects.core.expectedFailure = 1;
      detailed.expectedFailures = ['core › packages/core/test/a.test.ts › knowingly broken'];
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /expected failure/i,
  },
  {
    name: 'a project that stopped contributing tests entirely',
    run: () => {
      const { stock, detailed } = vitestReports();
      delete detailed.projects.db;
      detailed.modules = detailed.modules.filter((module) => module.project !== 'db');
      stock.numTotalTests = 12;
      detailed.totals.tests = 12;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /contributed no tests/i,
  },
  {
    name: 'a project that fell below its floor while the global count held up',
    run: () => {
      const { stock, detailed } = vitestReports();
      detailed.projects.core.tests = 15;
      detailed.projects.db.tests = 3;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /below its floor/i,
  },
  {
    name: 'a project that ran but was never enrolled',
    run: () => {
      const { stock, detailed } = vitestReports();
      detailed.projects.ingest = counts({ tests: 4, passed: 4 });
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /not enrolled/i,
  },
  {
    name: 'the two vitest reports describing different runs',
    run: () => {
      const { stock, detailed } = vitestReports();
      detailed.totals.tests = 999;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /disagree/i,
  },
  {
    name: 'a workspace absent from the manifest',
    run: () =>
      checkEnrollment(['packages/core', 'packages/db', 'apps/web', 'packages/ingest'], MANIFEST),
    expect: /absent from/i,
  },
  {
    name: 'a manifest entry for a workspace that no longer exists',
    run: () => checkEnrollment(['packages/core', 'apps/web'], MANIFEST),
    expect: /not a pnpm workspace/i,
  },
  {
    name: 'a clean playwright run passes',
    run: () => checkPlaywrightReport(playwrightReport(), MANIFEST).problems,
    expect: 'clean',
  },
  {
    name: 'a playwright test.fail() reported as expected, which is to say green',
    run: () =>
      checkPlaywrightReport(
        mutate(playwrightReport(), (report) => {
          const [test] = report.suites[0].specs[0].tests;
          test.expectedStatus = 'failed';
          test.annotations = [{ type: 'fail', location: { file: 'e2e/smoke.spec.ts', line: 8 } }];
        }),
        MANIFEST,
      ).problems,
    expect: /expectedStatus|fail. annotation/i,
  },
  {
    name: 'a playwright test.fixme(), which reports success without running',
    run: () =>
      checkPlaywrightReport(
        mutate(playwrightReport(), (report) => {
          const [test] = report.suites[0].specs[0].tests;
          test.expectedStatus = 'skipped';
          test.status = 'skipped';
          test.annotations = [{ type: 'fixme', location: { file: 'e2e/smoke.spec.ts', line: 12 } }];
          report.stats = { expected: 1, skipped: 1, unexpected: 0, flaky: 0 };
        }),
        MANIFEST,
      ).problems,
    expect: /fixme|skipped/i,
  },
  {
    name: 'a playwright project that ran but was never enrolled',
    run: () =>
      checkPlaywrightReport(
        mutate(playwrightReport(), (report) => {
          report.suites[0].specs[0].tests[0].projectName = 'firefox';
        }),
        MANIFEST,
      ).problems,
    expect: /not enrolled/i,
  },
  {
    name: 'a playwright report whose stats disagree with its own tests',
    run: () =>
      checkPlaywrightReport(
        mutate(playwrightReport(), (report) => {
          report.stats.expected = 7;
        }),
        MANIFEST,
      ).problems,
    expect: /not internally consistent/i,
  },
  {
    name: 'a report left over from an earlier run',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'stale-report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      const hourAgo = Date.now() / 1000 - 3600;
      utimesSync(path, hourAgo, hourAgo);
      return readFreshReport(path, Date.now(), 'the test runner').problems;
    },
    expect: /stale/i,
  },
  {
    name: 'a report that was never written at all',
    run: () =>
      readFreshReport(join(tmpdir(), 'atrium-does-not-exist.json'), Date.now(), 'the test runner')
        .problems,
    expect: /never written/i,
  },
  {
    name: 'a run with no recorded start time, so freshness cannot be proven',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      return readFreshReport(path, Number.NaN, 'the test runner').problems;
    },
    expect: /run-start timestamp/i,
  },

  // ---- the dual reports must describe the same run, not merely the same size
  {
    name: 'a CI reporter gutted to counts, recording no test identities at all',
    run: () => {
      const { stock, detailed } = vitestReports();
      for (const module of detailed.modules) delete module.testNames;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /no test identities/i,
  },
  {
    name: 'two reports with matching totals that name different tests',
    run: () => {
      const { stock, detailed } = vitestReports();
      detailed.modules[0].testNames[3] = 'core > a test the stock report never saw';
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /appear in one report and not the other/i,
  },
  {
    name: 'two reports agreeing on the total but not on how many passed',
    run: () => {
      const { stock, detailed } = vitestReports();
      stock.numPassedTests = 17;
      stock.numPendingTests = 1;
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /disagree on passing tests/i,
  },
  {
    name: 'two reports that disagree about how many test files ran',
    run: () => {
      const { stock, detailed } = vitestReports();
      stock.testResults.push({
        name: resolve(process.cwd(), 'packages/db/test/c.test.ts'),
        assertionResults: [],
      });
      return checkVitestReports(stock, detailed, MANIFEST);
    },
    expect: /disagree on test files/i,
  },

  // ---- the second, reporter-independent witness for it.fails() ------------
  //
  // Every EVADED_FORMS / HELPER_FORMS / NOT_ANNOTATIONS fixture below is
  // expanded into a case by `main()`. They were all run against round 3's line
  // matcher first. Written out as real test files and executed under Vitest, it
  // missed five of seven working evasions — the computed access, the optional
  // chain, the chain broken over two lines, the destructuring, and the helper
  // module — every one of which ran with the suite exiting 0. It also fired on
  // `it('rejects it.fails …')`, prose inside a string literal, which is the same
  // defect pointing the other way. That is what "parse rather than line-match"
  // bought, and these fixtures are what stops it being re-bought.
  {
    name: 'the source witness and the reporter disagreeing about the same run',
    run: () =>
      checkExpectedFailureWitness(scanFixture({ 'x.test.ts': "it.fails('a', () => {});\n" }), 2),
    expect: /two independent witnesses disagree/i,
  },
  {
    name: 'a scanner that has been pointed at nothing agrees with any report',
    run: () => checkExpectedFailureWitness(scanFixture({}, []), 0),
    expect: /read no files at all/i,
  },
  {
    name: 'a test file the parser cannot read is a blind spot, not an empty file',
    run: () => checkExpectedFailureWitness(scanFixture({ 'x.test.ts': 'it.fails(((((\n' }), 0),
    expect: /could not be parsed/i,
  },

  // ---- floors ratchet up --------------------------------------------------
  {
    name: 'a clean manifest against an identical baseline',
    run: () => checkRatchet(ratchetManifest(), ratchetManifest()),
    expect: 'clean',
  },
  {
    name: 'a floor quietly lowered to make a red count gate go green',
    run: () => {
      const current = ratchetManifest();
      current.vitest.workspaces['packages/core'].minTests = 40;
      return checkRatchet(current, ratchetManifest());
    },
    expect: /was lowered from 120 to 40/i,
  },
  {
    name: 'a floor lowered with the reason written down',
    run: () => {
      const current = ratchetManifest();
      current.vitest.workspaces['packages/core'].minTests = 40;
      current.ratchet.justifications['vitest.workspaces.packages/core.minTests'] =
        'the replay suite moved wholesale to packages/ingest in #28; core genuinely owns fewer tests now';
      return checkRatchet(current, ratchetManifest());
    },
    expect: 'clean',
  },
  {
    name: 'an enrolled workspace demoted to exempt, which is a floor of zero in disguise',
    run: () => {
      const current = ratchetManifest();
      delete current.vitest.workspaces['packages/db'];
      current.vitest.exempt['packages/db'] = 'no longer worth testing, honestly';
      return checkRatchet(current, ratchetManifest());
    },
    expect: /exempt/i,
  },
  {
    name: 'a standing justification for a cut nobody has made yet',
    run: () => {
      const current = ratchetManifest();
      current.ratchet.justifications['vitest.workspaces.packages/core.minTests'] =
        'pre-authorising a decrease we might want to make some time later on';
      return checkRatchet(current, ratchetManifest());
    },
    expect: /does not correspond to any floor that actually came down/i,
  },
  {
    name: 'a justification that is not actually a reason',
    run: () => {
      const current = ratchetManifest();
      current.vitest.workspaces['packages/core'].minTests = 40;
      current.ratchet.justifications['vitest.workspaces.packages/core.minTests'] = 'because';
      return checkRatchet(current, ratchetManifest());
    },
    expect: /not a written reason/i,
  },
  {
    name: 'the total floor lowered while every per-project floor holds',
    run: () => {
      const current = ratchetManifest();
      current.vitest.minTotalTests = 5;
      return checkRatchet(current, ratchetManifest());
    },
    expect: /vitest\.minTotalTests was lowered/i,
  },
  {
    name: 'no baseline on main: the ratchet is inactive but floors must still be sane',
    run: () => checkRatchet(ratchetManifest(), undefined),
    expect: 'clean',
  },
  {
    name: 'no baseline, and a floor of zero smuggled in behind that',
    run: () => {
      const current = ratchetManifest();
      current.vitest.workspaces['packages/db'].minTests = 0;
      return checkRatchet(current, undefined);
    },
    expect: /at least 1/i,
  },
  {
    name: 'no baseline, and a justification for a decrease that cannot have happened',
    run: () => {
      const current = ratchetManifest();
      current.ratchet.justifications['vitest.minTotalTests'] =
        'a reason long enough to pass the length check but attached to nothing at all';
      return checkRatchet(current, undefined);
    },
    expect: /no baseline manifest to have lowered anything from/i,
  },

  // ---- the gate's own verdict script, executed rather than parsed ---------
  {
    name: 'the real gate script passes when every needed job succeeded',
    run: () =>
      expectGateExit(
        { verify: { result: 'success' }, e2e: { result: 'success' } },
        0,
        'two successful jobs',
      ),
    expect: 'clean',
  },
  {
    name: 'the real gate script fails a skipped job — the round-1 bypass, executed',
    run: () =>
      expectGateExit(
        { verify: { result: 'skipped' }, e2e: { result: 'success' } },
        1,
        'a skipped verify',
      ),
    expect: 'clean',
  },
  {
    name: 'the real gate script fails a cancelled job',
    run: () =>
      expectGateExit(
        { verify: { result: 'success' }, e2e: { result: 'cancelled' } },
        1,
        'a cancelled e2e',
      ),
    expect: 'clean',
  },
  {
    name: 'the real gate script fails an outright failure',
    run: () =>
      expectGateExit({ verify: { result: 'failure' }, e2e: { result: 'success' } }, 1, 'a failure'),
    expect: 'clean',
  },
  {
    name: 'the real gate script refuses to pass a gate that needs nothing',
    run: () => expectGateExit({}, 1, 'an empty needs object'),
    expect: 'clean',
  },
];

/** The fixture tables, expanded into ordinary cases. */
function scannerCases() {
  const cases = [];
  for (const [name, source] of Object.entries(EVADED_FORMS)) {
    cases.push({
      name: `an expected failure spelled as: ${name}`,
      run: () => checkExpectedFailureWitness(scanFixture({ 'x.test.ts': source }), 0),
      expect: /expected-failure annotation/i,
    });
  }
  for (const [name, files] of Object.entries(HELPER_FORMS)) {
    cases.push({
      name: `an expected failure hidden as: ${name}`,
      run: () => checkExpectedFailureWitness(scanFixture(files), 0),
      expect: /expected-failure annotation/i,
    });
  }
  for (const [name, files] of Object.entries(NOT_ANNOTATIONS)) {
    cases.push({
      name: `not an expected failure: ${name}`,
      run: () => checkExpectedFailureWitness(scanFixture(files), 0),
      expect: 'clean',
    });
  }
  return cases;
}

function main() {
  const failures = [];
  for (const { name, run, expect } of [...CASES, ...scannerCases()]) {
    let problems;
    try {
      problems = run();
    } catch (error) {
      failures.push(`case "${name}" threw: ${error.stack}`);
      continue;
    }
    if (expect === 'clean') {
      if (problems.length > 0)
        failures.push(
          `case "${name}" should have been clean, but reported: ${problems.join(' | ')}`,
        );
      continue;
    }
    if (!problems.some((problem) => expect.test(problem))) {
      failures.push(
        `case "${name}" was not caught (expected ${expect}); the gate said: ${problems.join(' | ') || '(nothing)'}`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::Gate self-test: ${failure}`);
    return 1;
  }
  const scanner = scannerCases().length;
  console.info(
    `Gate self-test passed: ${CASES.length + scanner} cases, every fail-open shape rejected and every clean report accepted — including ${Object.keys(EVADED_FORMS).length + Object.keys(HELPER_FORMS).length} spellings of \`it.fails\` the source scanner must see and ${Object.keys(NOT_ANNOTATIONS).length} lookalikes it must not.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
