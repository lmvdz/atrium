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
import { checkHostNetworkPolicy } from './assert-deploy-preflight.mjs';
import { checkRatchet, readBaseline } from './assert-floor-ratchet.mjs';
import { checkImageIdentity } from './assert-image-identity.mjs';
import { checkMigrationImage } from './assert-migration-image.mjs';
import { checkPlaywrightReport } from './assert-playwright-report.mjs';
import { checkSchema, readSchema } from './assert-stack-schema.mjs';
import { checkVitestReports } from './assert-vitest-report.mjs';
import { checkEnrollment } from './assert-workspace-enrollment.mjs';
import { checkerGraphProblems, ENFORCEMENT } from './checker-graph.mjs';
import { notAVerdict } from './child-verdict.mjs';
import { composeArgs } from './compose.mjs';
import { composeStackArgv, VERBS } from './compose-stack.mjs';
import { mainGuardProblems } from './guard-scan.mjs';
import { isMainModule } from './main-module.mjs';
import { readFreshReport } from './report-file.mjs';
import { checkExpectedFailureWitness, scanForExpectedFailures } from './scan-expected-failures.mjs';
import { buildAssetProblems, buildAssets, forgeLike, servableAssets } from './stack-client.mjs';
import { workflowFiles } from './workflow-policy.mjs';

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
  // The two forms that make the *narrowed* taint (round 5) still have to work:
  // the annotation is written in the test file, and the only thing that makes it
  // one is that the name it roots at came out of `vitest` through a helper.
  // Round 4 caught these by tainting every export of any module that reached
  // vitest; round 5 has to know that this particular name is runner-derived.
  'the runner renamed inside a helper and re-exported under the new name': {
    'x.test.ts':
      "import { runner } from './helpers';\nrunner.fails('via a renamed re-export', () => {});\n",
    'helpers.ts': "export { it as runner } from 'vitest';\n",
  },
  'a helper that re-exports the whole runner with `export *`': {
    'x.test.ts':
      "import { it as sanity } from './helpers';\nsanity.fails('through a star re-export', () => {});\n",
    'helpers.ts': "export * from 'vitest';\n",
  },
  // Round 6: the member-level namespace taint must not cost a catch. The module
  // behind this namespace exports one runner and one piece of domain code, and
  // the annotation is written on the runner member in the test file.
  'a runner reached through a namespace whose module also exports domain code': {
    'x.test.ts':
      "import * as helpers from './helpers';\nhelpers.runner.fails('through a mixed namespace', () => {});\n",
    'helpers.ts':
      "import { it } from 'vitest';\nexport const runner = it;\nexport const validate = () => ({ fails: 0 });\n",
  },
};

/**
 * A real annotation and a domain object with a `fails` property, in one module.
 *
 * The round-4 gauntlet's second major. Round 4's taint was per *module* — any
 * name imported from anything that transitively reached `vitest` was treated as
 * a possible runner — so this fixture produced two findings: the genuine
 * `it.fails` in `lib.ts`, and `validate().fails` in the test, which is a count
 * of failures in a domain object and nothing to do with Vitest. Verified against
 * round 4's scanner before the narrowing: two findings, the second at
 * `x.test.ts:3`.
 *
 * It needs its own case rather than a row in a table because both versions
 * report *an* annotation here; only the identity of the findings tells them
 * apart, and a fixture that cannot fail the thing it was written for is the
 * defect this whole ticket keeps rediscovering.
 */
const CO_LOCATED = {
  'x.test.ts':
    "import { it, expect } from 'vitest';\nimport { knownBroken, validate } from './lib';\nit('counts failures', () => { expect(validate().fails).toBe(0); });\nknownBroken('and this one really is broken', () => {});\n",
  'lib.ts':
    "import { it } from 'vitest';\nexport const knownBroken = it.fails;\nexport const validate = () => ({ fails: 0 });\n",
};

/**
 * The same module, imported as a namespace — the round-5 gauntlet's second major.
 *
 * Round 5 narrowed the taint to individual names and then handed it all back for
 * `import * as helpers`, because a namespace was still one binding: if anything
 * behind it was runner-derived, the whole namespace joined the root set and
 * `helpers.validate().fails` was a finding again. The existing namespace fixture
 * could not catch that — it imports `vitest` itself, where every member really is
 * a runner — so the regression sat behind a green test.
 *
 * Verified against the round-5 scanner directly: two findings, `lib.ts:2` and
 * `x.test.ts:3`. Like CO_LOCATED this needs its own case rather than a table
 * row, because both versions report *an* annotation and only the identity of the
 * findings tells them apart.
 */
const MIXED_NAMESPACE = {
  'x.test.ts':
    "import { it, expect } from 'vitest';\nimport * as helpers from './lib';\nit('counts failures', () => { expect(helpers.validate().fails).toBe(0); });\nhelpers.knownBroken('and this one really is broken', () => {});\n",
  'lib.ts':
    "import { it } from 'vitest';\nexport const knownBroken = it.fails;\nexport const validate = () => ({ fails: 0 });\n",
};

/**
 * Spellings this scanner genuinely cannot see, kept honest by proving the *other*
 * witness catches them.
 *
 * Round 4's receipt called the source scan an "independent witness" and the
 * round-4 gauntlet adjudicated the word "complete" out of that claim: bare and
 * aliased import specifiers, non-literal computed keys, `globalThis` roots and
 * setup-file registration are all invisible here. The design answer is that they
 * fail *closed* through the reporter, which reads `options.fails` off the live
 * task object — so each case below asserts both halves: this scanner sees
 * nothing, and the moment the reporter says one ran, the two witnesses disagree
 * and the gate goes red. A limitation with a test on it is a boundary; a
 * limitation with a sentence on it is a hope.
 */
const BLIND_SPOTS = {
  'a helper reached by a bare specifier, which the relative-import walk never follows':
    "import { knownBroken } from '@atrium/test-utils';\nknownBroken('via a workspace package', () => {});\n",
  'a computed key this pass will not constant-fold':
    "import { it } from 'vitest';\nconst KEY = 'fails';\nit[KEY]('spelled through a variable', () => {});\n",
  'the runner reached through globalThis, which is not and must not be a root':
    "globalThis.it.fails('through the global object', () => {});\n",
  'an annotation applied by something a setup file registered, outside every import graph':
    "it.brokenByOurSetupFile('registered elsewhere', () => {});\n",
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
  // The round-4 gauntlet's second major, as a regression guard. Round 4 tainted
  // every export of any module that reached `vitest`, so a helper that imports
  // `expect` for its own assertions turned every `.fails` on anything it exports
  // into a finding. Verified red against round 4's scanner, clean against this
  // one — the taint is now per binding, not per module.
  'a domain helper living in a module that imports the runner for its own use': {
    'x.test.ts':
      "import { it, expect } from 'vitest';\nimport { validate } from './lib';\nit('counts failures', () => { expect(validate().fails).toBe(0); });\n",
    'lib.ts':
      "import { expect } from 'vitest';\nexport const validate = () => ({ fails: 0 });\nexport const check = (value) => expect(value).toBeTruthy();\n",
  },
  // Round 6, the round-5 gauntlet's second major as a table row: a namespace
  // import of a module with mixed exports, where nothing in it is an annotation
  // at all. Round 5 tainted the namespace wholesale, so the domain member's
  // `.fails` was a finding; nothing here is one.
  'a domain member taken off a namespace whose module also exports the runner': {
    'x.test.ts':
      "import { it, expect } from 'vitest';\nimport * as helpers from './lib';\nit('counts failures', () => { expect(helpers.validate().fails).toBe(0); });\n",
    'lib.ts':
      "import { it } from 'vitest';\nexport const runner = it;\nexport const validate = () => ({ fails: 0 });\n",
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
  // ---- and the timestamp as a *value* (#40 round 6) ------------------------
  // `run: echo "VITEST_RUN_START=0" >> "$GITHUB_ENV"` was policy-clean on r5,
  // and `Number.isFinite(0)` is true, so the freshness comparison became
  // `mtime + 1000 < 0` — false for every file that has ever existed. Every
  // report fresh, the whole stale-report class off, with the `rm -f` step the
  // only thing still in the way. The policy engine now requires the value to
  // come from `date`; this is the other half, and neither is satisfied by
  // satisfying the other.
  {
    name: 'a run-start timestamp of 0, which makes a month-old report fresh',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      const monthAgo = Date.now() / 1000 - 30 * 86400;
      utimesSync(path, monthAgo, monthAgo);
      return readFreshReport(path, 0, 'the test runner').problems;
    },
    expect: /not this run.s start/,
  },
  {
    name: '`date +%s` instead of `date +%s%3N`, which is seconds and lands in 1970',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      return readFreshReport(path, Math.floor(Date.now() / 1000), 'the test runner').problems;
    },
    expect: /not this run.s start/,
  },
  {
    // The one a blind cross-lineage review measured against round 6's first
    // draft, which bounded the timestamp by the calendar (after 2025-01-01, not
    // in the future) rather than by recency. `$(date --date=@1748736000 +%s%3N)`
    // is policy-clean — it does read a clock — and mid-2025 sat inside that
    // window, so every report on disk post-dated it and every report was fresh.
    // A calendar bound is a constant, and a constant is what this refuses.
    name: 'a timestamp from a `date` that was told which date to print',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      return readFreshReport(path, 1_748_736_000_000, 'the test runner').problems;
    },
    expect: /not this run.s start/,
  },
  {
    name: 'a clock a week ahead of this one, which would accept anything',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify({ success: true }));
      return readFreshReport(path, Date.now() + 7 * 86400_000, 'the test runner').problems;
    },
    expect: /not this run.s start/,
  },
  {
    name: 'the real thing: a fresh report and a timestamp from this second',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'atrium-gate-'));
      const path = join(dir, 'report.json');
      const started = Date.now();
      writeFileSync(path, JSON.stringify({ success: true }));
      return readFreshReport(path, started, 'the test runner').problems;
    },
    expect: 'clean',
  },

  // ---- the ratchet's baseline ref, which had two meanings (#40 round 6) ----
  // `git show origin/main:.github/ci-manifest.json` fails both when the file is
  // absent — legitimate, until the branch introducing the manifest merges — and
  // when the *ref* is absent, which is what a deleted `git fetch` step looks
  // like. Round 5 answered "no baseline, sanity only" and exited 0 to both.
  {
    name: 'a baseline ref that does not exist, which is what a missing fetch looks like',
    run: () => {
      const result = readBaseline('origin/mainbaseline', '.github/ci-manifest.json', (_, args) =>
        args[0] === 'rev-parse'
          ? { status: 1, stdout: '', stderr: '' }
          : { status: 128, stdout: '', stderr: "fatal: invalid object name 'origin/mainbaseline'" },
      );
      return result.fatal === true ? [result.reason] : ['treated as a plain absent baseline'];
    },
    expect: /there is no ref `origin\/mainbaseline`/,
  },
  {
    name: 'a ref that exists with no manifest on it, which stays the quiet legitimate path',
    run: () => {
      const result = readBaseline('origin/main', '.github/ci-manifest.json', (_, args) =>
        args[0] === 'rev-parse'
          ? { status: 0, stdout: 'deadbeef\n', stderr: '' }
          : { status: 128, stdout: '', stderr: "fatal: path '…' does not exist in 'origin/main'" },
      );
      return result.fatal === true ? ['a missing manifest was treated as a missing ref'] : [];
    },
    expect: 'clean',
  },
  {
    name: 'a ref that exists carrying a manifest, which is the ratchet doing its job',
    run: () => {
      const result = readBaseline('origin/main', '.github/ci-manifest.json', (_, args) =>
        args[0] === 'rev-parse'
          ? { status: 0, stdout: 'deadbeef\n', stderr: '' }
          : { status: 0, stdout: JSON.stringify(ratchetManifest()), stderr: '' },
      );
      return result.present === true ? [] : [`baseline not read: ${result.reason}`];
    },
    expect: 'clean',
  },

  // ---- every workflow file, not every file one glob named (#40 round 6) ----
  {
    name: 'the workflow directory enumerates `.yaml` as well as `.yml`',
    run: () => {
      const file = (name) => ({ name, isFile: () => true, isSymbolicLink: () => false });
      const entries = [
        file('ci.yml'),
        // A symlinked workflow counts: GitHub reads what the checkout
        // materialises, and `isFile()` is false for the link itself.
        { name: 'release.yaml', isFile: () => false, isSymbolicLink: () => true },
        file('notes.md'),
        { name: 'archive', isFile: () => false, isSymbolicLink: () => false },
      ];
      const found = workflowFiles(
        '.github/workflows',
        () => ({ isDirectory: () => true }),
        () => entries,
      );
      return found.join(',') === '.github/workflows/ci.yml,.github/workflows/release.yaml'
        ? []
        : [`enumerated ${found.join(', ') || 'nothing'}`];
    },
    expect: 'clean',
  },
  {
    name: 'the round-5 glob, which would have left release.yaml unchecked',
    run: () => {
      const globbed = ['ci.yml', 'release.yaml', 'notes.md'].filter((name) =>
        name.endsWith('.yml'),
      );
      return globbed.includes('release.yaml')
        ? []
        : ['`.github/workflows/*.yml` does not name release.yaml, which GitHub runs'];
    },
    expect: /does not name release\.yaml/,
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
  {
    name: 'a runner helper and a domain `.fails` in one module: only the helper is an annotation',
    run: () => {
      const found = scanFixture(CO_LOCATED)
        .findings.map((finding) => `${finding.file}:${finding.line}`)
        .sort();
      if (found.join(', ') === 'lib.ts:2') return [];
      return [
        `the scanner reported ${found.join(', ') || '(nothing)'}; the only annotation in this fixture is lib.ts:2. \`validate().fails\` is a domain object exported beside a runner helper, and a witness that calls that an expected failure is a witness somebody turns off.`,
      ];
    },
    expect: 'clean',
  },
  {
    name: 'the same module reached as a namespace: the member decides, not the namespace',
    run: () => {
      const found = scanFixture(MIXED_NAMESPACE)
        .findings.map((finding) => `${finding.file}:${finding.line}`)
        .sort();
      if (found.join(', ') === 'lib.ts:2') return [];
      return [
        `the scanner reported ${found.join(', ') || '(nothing)'}; the only annotation in this fixture is lib.ts:2. \`helpers.validate().fails\` takes a domain member off a namespace, and round 5 reported it because a namespace import tainted every member at once — the per-binding narrowing undone by one syntax.`,
      ];
    },
    expect: 'clean',
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

  // ---- the deployment preflight (#40 r2, routed from #26 r6) --------------
  //
  // The verdict is separated from the observing precisely so it can be put
  // through engines this runner does not have. An engine cannot be downgraded on
  // a GitHub runner, and "we could not test it" is how a prerequisite becomes a
  // paragraph nobody has ever seen fail.
  {
    name: 'a Docker engine old enough to publish loopback ports off-box',
    run: () => checkHostNetworkPolicy({ engineVersion: '27.5.1' }),
    expect: /27\.5\.1/,
  },
  {
    name: 'the last engine before the fix, which is still before the fix',
    run: () => checkHostNetworkPolicy({ engineVersion: '27.99.99' }),
    expect: /publishes loopback-bound ports/,
  },
  {
    name: 'the first engine that filters is accepted',
    run: () => checkHostNetworkPolicy({ engineVersion: '28.0.0' }),
    expect: 'clean',
  },
  {
    name: 'a prerelease of a new-enough engine is accepted',
    run: () => checkHostNetworkPolicy({ engineVersion: '29.3.0-rc.1' }),
    expect: 'clean',
  },
  {
    name: 'an engine that will not say what it is',
    run: () => checkHostNetworkPolicy({ engineVersion: '' }),
    expect: /not a version/,
  },
  {
    name: 'a new engine with the daemon default bridge switched to routed',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        defaultBridge: {
          present: true,
          options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'routed' },
        },
      }),
    expect: /default bridge runs with .*gateway_mode_ipv4=routed/,
  },
  {
    name: 'NAT with the filtering explicitly turned off is not NAT',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        defaultBridge: {
          present: true,
          options: { 'com.docker.network.bridge.gateway_mode_ipv6': 'nat-unprotected' },
        },
      }),
    expect: /gateway_mode_ipv6=nat-unprotected/,
  },
  {
    name: "this project's own network switched to routed by an overlay",
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        composeNetworks: {
          default: { driver_opts: { 'com.docker.network.bridge.gateway_mode_ipv4': 'routed' } },
        },
      }),
    expect: /compose network `default`/,
  },
  {
    name: 'a stack that simply took the default gateway mode is accepted',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        defaultBridge: {
          present: true,
          options: { 'com.docker.network.bridge.enable_icc': 'true' },
        },
        composeNetworks: { default: { ipam: { config: [{ subnet: '172.28.0.0/16' }] } } },
      }),
    expect: 'clean',
  },
  // Round 2's gauntlet: a failed inspection used to become `{}` and be accepted
  // while the success line went on claiming "default NAT". Absence and failure
  // are two answers now, and only one of them is safe.
  {
    name: 'a default bridge that could not be inspected at all',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        defaultBridge: { present: true, error: 'permission denied' },
      }),
    expect: /could not be inspected .*permission denied.*whether it runs in NAT mode is unknown/s,
  },
  {
    name: 'a daemon that cannot even be asked what networks it has',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        defaultBridge: { present: false, error: 'docker network ls failed: no such host' },
      }),
    expect: /could not be inspected/,
  },
  {
    name: 'a rootless daemon with no default bridge, which has no default to be wrong',
    run: () =>
      checkHostNetworkPolicy({ engineVersion: '29.3.0', defaultBridge: { present: false } }),
    expect: 'clean',
  },
  {
    name: 'a gateway mode written out as `nat` is the default written out',
    run: () =>
      checkHostNetworkPolicy({
        engineVersion: '29.3.0',
        composeNetworks: {
          default: { driver_opts: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat' } },
        },
      }),
    expect: 'clean',
  },

  // ---- built, scanned and running are one object (#40 r2) -----------------
  {
    name: 'a container running an image this run did not build',
    run: () =>
      checkImageIdentity(builtManifest(), {
        ...runningImages(),
        app: { id: `sha256:${'b'.repeat(64)}`, image: 'atrium-ci-app' },
      }),
    expect: /`app` is running image/,
  },
  {
    name: 'the one-shot that applies the schema, running last week’s image',
    run: () =>
      checkImageIdentity(builtManifest(), {
        ...runningImages(),
        migrate: { id: `sha256:${'c'.repeat(64)}`, image: 'atrium-ci-migrate' },
      }),
    expect: /`migrate` is running image/,
  },
  {
    name: 'a service the manifest never recorded',
    run: () => {
      const manifest = builtManifest();
      delete manifest.server;
      return checkImageIdentity(manifest, runningImages());
    },
    expect: /records no image for `server`/,
  },
  {
    name: 'a service that is not running at all',
    run: () => {
      const running = runningImages();
      delete running.app;
      return checkImageIdentity(builtManifest(), running);
    },
    expect: /no `app` container to compare/,
  },
  {
    name: 'an image recorded but never asserted on',
    run: () =>
      checkImageIdentity(
        {
          ...builtManifest(),
          worker: { id: `sha256:${'d'.repeat(64)}`, image: 'atrium-ci-worker' },
        },
        runningImages(),
      ),
    expect: /which is not one of the services whose image identity is asserted/,
  },
  {
    name: 'the stack running exactly what was built',
    run: () => checkImageIdentity(builtManifest(), runningImages()),
    expect: 'clean',
  },

  // ---- the migration image, checked before it can write (#40 r3) ----------
  {
    name: 'the migration container pointed at an image this run did not build',
    run: () =>
      checkMigrationImage(
        builtManifest().migrate,
        'atrium-ledger-doppelganger:x',
        `sha256:${'e'.repeat(64)}`,
      ),
    expect: /runs `migrate` from `atrium-ledger-doppelganger:x`/,
  },
  {
    name: 'a migration image name that resolves to nothing',
    run: () => checkMigrationImage(builtManifest().migrate, 'atrium-ci-migrate', '(no such image)'),
    expect: /which is not an image ID/,
  },
  {
    name: 'a manifest with no `migrate` entry at all',
    run: () => checkMigrationImage(undefined, 'atrium-ci-migrate', `sha256:${'3'.repeat(64)}`),
    expect: /records nothing for `migrate`/,
  },
  {
    name: 'the migration image that is the one this run built',
    run: () =>
      checkMigrationImage(builtManifest().migrate, 'atrium-ci-migrate', `sha256:${'3'.repeat(64)}`),
    expect: 'clean',
  },

  // ---- migration success is not the same claim as the schema (#40 r3) -----
  {
    name: 'a deployed database missing a table the migrations create',
    run: () => {
      const actual = deployedFixture();
      actual.tables.delete('corrections');
      return checkSchema(schemaFixture(), actual);
    },
    expect: /missing 1 table\(s\) the migrations create: corrections/,
  },
  {
    name: 'a deployed database carrying a table no migration in this tree makes',
    run: () => {
      const actual = deployedFixture();
      actual.tables.set('leftovers', {
        columns: new Map(),
        constraints: new Set(),
        indexes: new Set(),
      });
      return checkSchema(schemaFixture(), actual);
    },
    expect: /table\(s\) no migration in this tree creates: leftovers/,
  },
  {
    name: 'a table with the right name and a column short',
    run: () =>
      checkSchema(schemaFixture(), deployedFixture(drift('columns', 'users|email_verified|'))),
    expect: /`users` does not match the migrations: missing email_verified/,
  },

  // ---- what "every column" has to mean, if the copy is going to say it -----
  // Round 3 compared column *names* while its success line said "every column";
  // the round-3 gauntlet's second major. Each of these is one field of one psql
  // row, so a case that goes green for the wrong reason has nowhere to hide.
  {
    name: 'a column widened from `text` to `jsonb` by a migration that reported success',
    run: () =>
      checkSchema(
        schemaFixture(),
        deployedFixture(drift('columns', 'users|email|', 'users|email|jsonb|t|f')),
      ),
    expect: /`users\.email` is `jsonb` and the migrations say `text`/,
  },
  {
    name: 'a `not null` dropped, so the application may now store nothing there',
    run: () =>
      checkSchema(
        schemaFixture(),
        deployedFixture(drift('columns', 'users|display_name|', 'users|display_name|text|f|f')),
      ),
    expect: /`users\.display_name` is nullable and the migrations say `not null`/,
  },
  {
    name: 'a default that is not there any more',
    run: () =>
      checkSchema(
        schemaFixture(),
        deployedFixture(
          drift('columns', 'users|email_verified|', 'users|email_verified|boolean|t|f'),
        ),
      ),
    expect: /`users\.email_verified` has no default and the migrations give it one/,
  },
  {
    name: 'a foreign key that lost its `on delete cascade`',
    run: () =>
      checkSchema(
        schemaFixture(),
        deployedFixture(
          drift(
            'constraints',
            'auth_sessions|f|',
            'auth_sessions|f|auth_sessions_user_id_users_id_fk|user_id|users|id|n',
          ),
        ),
      ),
    expect: /is missing 1 constraint\(s\).*on delete cascade/s,
  },
  {
    name: 'a check constraint the migrations create and the database does not have',
    run: () => checkSchema(schemaFixture(), deployedFixture(drift('constraints', 'users|c|'))),
    expect: /`users` is missing 1 constraint\(s\).*users_email_present/s,
  },
  {
    name: 'a unique index that stopped being unique',
    run: () =>
      checkSchema(
        schemaFixture(),
        deployedFixture(
          drift('indexes', 'auth_sessions|', 'auth_sessions|auth_sessions_token_idx|f|token'),
        ),
      ),
    expect: /is missing 1 index\(s\).*unique index/s,
  },
  {
    name: 'a migration folder that never reached the image, so nothing was applied',
    run: () => checkSchema(schemaFixture(), { ...deployedFixture(), migrations: 0 }),
    expect: /records 0 applied migration\(s\)/,
  },
  {
    name: 'the deployed database that matches the migrations exactly',
    run: () => checkSchema(schemaFixture(), deployedFixture()),
    expect: 'clean',
  },

  // ---- the compose verbs' argv, built rather than read (#40 r3) -----------
  //
  // `--wait` and `-v` used to be words in ci.yml, where workflow-policy.mjs
  // matched them. They moved into compose-stack.mjs with the file list, so this
  // is what replaces that check — and it is stronger, because it runs the code
  // that builds the argv instead of matching the text beside it.
  {
    name: 'the boot waits for the stack to settle rather than returning at creation',
    run: () =>
      composeStackArgv('up', composeEnv()).includes('--wait') ? [] : ['`up` lost `--wait`'],
    expect: 'clean',
  },
  {
    name: 'the teardown removes the named volumes',
    run: () => (composeStackArgv('down', composeEnv()).includes('-v') ? [] : ['`down` lost `-v`']),
    expect: 'clean',
  },
  {
    name: 'every verb, and the assertions, resolve one file list from the one variable',
    run: () => {
      const env = composeEnv();
      // `composeArgs` is what every assertion in the job uses — the preflight's
      // `docker compose config` included — so it is the other side of the
      // comparison rather than a second copy of the expectation. The first
      // version of this case compared the four verbs against each other, which
      // is a claim about four call sites that all read the same constant, and a
      // blind review said so.
      const assertions = fileList(composeArgs(env));
      const verbs = Object.keys(VERBS).map((verb) => fileList(composeStackArgv(verb, env)));
      const all = new Set([assertions, ...verbs]);
      return all.size === 1 && assertions === env.ATRIUM_COMPOSE_FILES
        ? []
        : [
            `the assertions resolve ${JSON.stringify(assertions)} and the verbs resolve ${JSON.stringify(verbs)}; they must be one list, equal to ATRIUM_COMPOSE_FILES`,
          ];
    },
    expect: 'clean',
  },
  {
    name: 'an overlay added to the variable reaches every verb and the assertions alike',
    run: () => {
      const env = { ...composeEnv(), ATRIUM_COMPOSE_FILES: 'docker-compose.yml:overlay.yml' };
      const missing = Object.keys(VERBS).filter(
        (verb) => !composeStackArgv(verb, env).includes('overlay.yml'),
      );
      if (!composeArgs(env).includes('overlay.yml')) missing.push('the assertions (composeArgs)');
      return missing.length === 0 ? [] : [`${missing.join(', ')} did not see the overlay`];
    },
    expect: 'clean',
  },
  {
    name: 'a compose verb nobody reviewed',
    run: () => {
      try {
        composeStackArgv('exec', composeEnv());
        return ['an unknown verb was accepted'];
      } catch (error) {
        return [error.message];
      }
    },
    expect: /unknown compose verb "exec"/,
  },

  // ---- the ledger refuses a workflow it cannot honestly execute (#40 r3) ---
  //
  // The round-2 gauntlet's blocking finding, from the ledger's end: CI skipped
  // `assert-page-serves` and the ledger certified that it caught its mutation,
  // because the ledger recovered a filename by regular expression and ran it
  // itself. These run the real ledger against mutated copies of the real
  // workflow, with `--pipeline`, which reads and classifies every step without
  // starting anything.
  {
    name: 'a deploy assertion CI would skip, handed to the ledger',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/assert-page-serves.mjs',
          'run: false && node scripts/ci/assert-page-serves.mjs; true',
        ),
      ),
    expect: /is not a single unconditional command/,
  },
  {
    name: 'a deploy step whose exit status something after it swallows',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/assert-ws-upgrade.mjs',
          'run: node scripts/ci/assert-ws-upgrade.mjs; true',
        ),
      ),
    expect: /is not a single unconditional command/,
  },
  {
    name: 'a deploy step whose command word the shell would have to expand',
    run: () =>
      ledgerRefuses((source) =>
        source.replace('run: node scripts/ci/assert-rate-limit.mjs', 'run: node "$ASSERTION"'),
      ),
    expect: /which the shell would expand/,
  },
  {
    name: 'a deploy step that compiles the assertion instead of running it',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/assert-stack-config.mjs',
          'run: node --check scripts/ci/assert-stack-config.mjs',
        ),
      ),
    // The ledger's version of the `node --check` bypass: the policy reads it as
    // a missing step, and this file must not go on running the script anyway —
    // which is exactly what round 2's regex-recovered filename did.
    expect: /cannot classify/,
  },
  {
    name: 'a deploy step whose assertion `xargs` may run zero times',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/assert-stack-health.mjs',
          'run: xargs -r node scripts/ci/assert-stack-health.mjs',
        ),
      ),
    expect: /is not a single unconditional command/,
  },
  {
    name: 'a deploy step re-pointing the compose file list for one command',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/compose-stack.mjs up',
          'run: ATRIUM_COMPOSE_FILES=docker-compose.yml node scripts/ci/compose-stack.mjs up',
        ),
      ),
    expect: /sets `ATRIUM_COMPOSE_FILES` for the command/,
  },
  {
    name: 'a second `cat` step, which used to become a second "deployment environment"',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          '      - name: Assert every container is healthy\n',
          '      - name: Dump the host release\n        run: cat /etc/os-release\n\n      - name: Assert every container is healthy\n',
        ),
      ),
    // Round 3's first version classified *any* `cat` as the .env writer, which
    // is an EXEMPT stage and is skipped — so an added step became a stage the
    // ledger silently never ran, which is the coverage invariant defeating
    // itself. The classification reads what the command writes now.
    expect: /cannot classify/,
  },
  {
    name: 'a deploy stage the ledger has never heard of',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          'run: node scripts/ci/assert-stack-health.mjs',
          'run: node scripts/ci/assert-something-new.mjs',
        ),
      ),
    expect: /no case in this ledger names it/,
  },
  {
    name: 'the real workflow, which the ledger reads and covers',
    run: () => ledgerRefuses((source) => source),
    expect: 'clean',
  },

  // ---- the ledger and CI must agree about *where*, not only about what -----
  // Round 4 checked `shell:` in three positions and stopped. `container:` puts
  // every stage inside somebody's image on the runner while this file runs the
  // same scripts on the host with `bash -e`; `working-directory:` moves them.
  // Both were accepted, and both make the receipt a description of an execution
  // that never happened — which is the exact defect the ledger exists to find.
  {
    name: 'a deploy job that would run every stage inside an author-chosen image',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          '    name: the deployment serves (not the product works)\n',
          `    name: the deployment serves (not the product works)\n    container:\n      image: ghcr.io/example/builder@sha256:${'a'.repeat(64)}\n`,
        ),
      ),
    expect: /changes the execution context at jobs\.deploy\.container/,
  },
  {
    name: 'a deploy step that would run from a directory the ledger does not replay it in',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          '      - name: Assert every container is healthy\n',
          '      - name: Assert every container is healthy\n        working-directory: apps/web\n',
        ),
      ),
    expect: /changes the execution context at jobs\.deploy\.steps\.\d+\.working-directory/,
  },
  {
    name: 'a deploy job on a runner whose bash, node and PATH this repository has never seen',
    run: () =>
      ledgerRefuses((source) =>
        source.replace(
          '  deploy:\n    name: the deployment serves (not the product works)\n    runs-on: ubuntu-latest',
          '  deploy:\n    name: the deployment serves (not the product works)\n    runs-on: self-hosted',
        ),
      ),
    expect: /changes the execution context at jobs\.deploy\.runs-on/,
  },

  // ---- a stage that did not exit on its own has not decided anything -------
  // `attempt()` caught the 420-second timeout throw, returned `{ok:false}` and
  // never asked why, so a slow stage — or ENOENT, or an OOM kill — was written
  // down as CAUGHT. The four shapes below are measured, not assumed: node
  // v24.5.0 leaves `error.killed` undefined for a timeout, so a fix written
  // from that field's name would have been another silent pass.
  {
    name: 'a child that exits 7 on its own is a verdict',
    run: () =>
      notAVerdict({ status: 7, signal: null }, 420_000) === undefined
        ? []
        : ['it was treated as inconclusive'],
    expect: 'clean',
  },
  {
    name: 'a child killed by the ledger’s own timeout is not a verdict',
    run: () => [
      notAVerdict({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' }, 420_000) ??
        'treated as a verdict',
    ],
    expect: /killed by this ledger's own 420s timeout/,
  },
  {
    name: 'a child the kernel killed (an OOM looks exactly like this) is not a verdict',
    run: () => [
      notAVerdict({ status: null, signal: 'SIGKILL' }, 420_000) ?? 'treated as a verdict',
    ],
    expect: /killed by SIGKILL/,
  },
  {
    name: 'a child that never started is not a verdict',
    run: () => [
      notAVerdict({ status: null, signal: null, code: 'ENOENT' }, 420_000) ??
        'treated as a verdict',
    ],
    expect: /never started: ENOENT/,
  },

  // ---- the main-module guard, in every file that has one ------------------
  // Fifteen scripts decided "was I run?" by comparing `import.meta.url` against
  // `file://` + `process.argv[1]`. Measured: with a space anywhere in the path,
  // or through a symlink, the comparison is false and the script exits 0 having
  // asserted nothing — including both self-tests, so the thing that would have
  // noticed was disarmed by the same line.
  {
    name: 'every guard under scripts/ is the sound one',
    run: () => mainGuardProblems('scripts'),
    expect: 'clean',
  },
  {
    name: 'the round-4 guard, re-introduced in one file',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () => `if (${BROKEN_GUARD_HALVES.join(' ')}) { process.exit(main()); }\n`,
      ),
    expect: /percent-encodes/,
  },
  {
    name: 'the sound predicate wired so it can never be true',
    // Refusing only the broken comparison is a denylist. `isMainModule(…) &&
    // false` uses the right predicate, passes that test, and exits 0 having
    // asserted nothing. Found by a blind review of the first version.
    run: () =>
      guardScanWith('assert-tables.mjs', (source) =>
        source.replace(CANONICAL_GUARD_LINE, conjoin('false')),
      ),
    expect: /condition is not exactly/,
  },
  {
    name: 'the same written with a loose equality and single quotes',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () => `if (${LOOSE_GUARD_HALVES.join(' ')}) { main(); }\n`,
      ),
    expect: /percent-encodes/,
  },
  // ---- and the round-6 defect: the file holding the fixture (#40 round 6) ---
  // The round-5 rule was `source.includes('if (isMainModule(import.meta.url)) {')`
  // over the whole file. THIS file stores that exact string as a fixture, forty
  // lines below, so it satisfied the rule whatever its own guard said — and it
  // was the only place in the repository `mainGuardProblems` was called from.
  // Measured on r5 as committed: `&& process.env.CI === undefined` on line 1951,
  // scanner 0 problems, biome clean, policy clean, `CI=true node
  // gate-selftest.mjs` exit 0 with no output. The scanner parses now, so the
  // fixture is a string and the guard is a statement, and the two cases below
  // are the standing proof of both halves.
  {
    name: 'the guard of the file that holds the canonical spelling as a fixture',
    run: () =>
      guardScanWith('gate-selftest.mjs', (source) =>
        source.replace(
          `${CANONICAL_GUARD_LINE}\n  process.exit(await main());`,
          `${conjoin(CI_CONJUNCT)}\n  process.exit(await main());`,
        ),
      ),
    expect: /condition is not exactly/,
  },
  {
    name: 'the same edit to the other self-test, which is the file that would notice',
    run: () =>
      guardScanWith('workflow-policy-selftest.mjs', (source) =>
        source.replace(
          `${CANONICAL_GUARD_LINE}\n  process.exit(main());`,
          `${conjoin(CI_CONJUNCT)}\n  process.exit(main());`,
        ),
      ),
    expect: /condition is not exactly/,
  },
  {
    name: 'a guard that establishes it was run and then does nothing',
    run: () =>
      guardScanWith('assert-tables.mjs', () => `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n}\n`),
    expect: /body is empty/,
  },
  {
    name: 'the guard nested inside a branch that is never taken',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}if (false) {\n  ${CANONICAL_GUARD_LINE}\n    process.exit(main());\n  }\n}\n`,
      ),
    expect: /outside the one place a script here may/,
  },
  {
    name: 'the same comparison with `import.meta.url` renamed out of it',
    run: () =>
      guardScanWith('assert-tables.mjs', () => "if (process.argv[1] === '/x/y.mjs') { main(); }\n"),
    expect: /compares an `argv` element for equality/,
  },
  {
    name: 'a file the scanner cannot parse is a failure, not a skip',
    run: () => guardScanWith('assert-tables.mjs', () => 'if (isMainModule(import.meta.url) {\n'),
    expect: /does not parse as JavaScript/,
  },

  // ---- who runs the checks (#40 round 6) -----------------------------------
  // `mainGuardProblems` was invoked in exactly one place: line 1407 of this
  // file, which is one of the files it scans. Sole enforcer, sole exception.
  // The registry in checker-graph.mjs now pins the invocation graph of every
  // check here, and requires each one to have a caller outside its own
  // subjects — `packages/ci-guard`, which is a Vitest project rather than
  // anything under scripts/.
  {
    name: 'every check has an invoker that is not one of its own subjects',
    run: () => checkerGraphProblems(),
    expect: 'clean',
  },
  {
    name: "the round-5 graph, restored: this file as mainGuardProblems' only caller",
    run: () =>
      checkerGraphProblems({
        registry: [{ ...ENFORCEMENT[0], invokers: ['scripts/ci/gate-selftest.mjs'] }],
      }),
    expect: /Sole enforcer, sole exception/,
  },
  {
    // The cheapest way to satisfy checker-graph.mjs without satisfying anything
    // it is about: declare that the check reads nothing, and "an invoker outside
    // the files it reads" is true of every invoker. Found attacking this round's
    // own fix.
    name: 'a registry row that declares no subjects at all',
    run: () => checkerGraphProblems({ registry: [{ ...ENFORCEMENT[0], subjects: [] }] }),
    expect: /is in the registry with no subjects/,
  },
  {
    name: 'an invoker CI never runs is not a witness',
    run: () =>
      checkerGraphProblems({
        registry: [{ ...ENFORCEMENT[0], invokers: ['packages/ci-guard/vitest.config.ts'] }],
      }),
    expect: /nothing in \.github\/workflows runs/,
  },
  {
    name: 'a call site the registry has forgotten',
    run: () =>
      checkerGraphProblems({
        registry: [
          {
            ...ENFORCEMENT[0],
            invokers: ENFORCEMENT[0].invokers.filter(
              (file) => !file.endsWith('workflow-policy-selftest.mjs'),
            ),
          },
        ],
      }),
    expect: /calls mainGuardProblems, which the registry/,
  },

  // ---- the build's assets, actually fetched (#40 round 5) ------------------
  // Round 4 compared the *names* of the `/_next/static/…` chunks in two
  // responses of the same build. Delete `COPY --from=build …/.next/static` from
  // apps/web/Dockerfile and both responses name the same chunks and every one
  // of them 404s: SSR HTML with no script, no stylesheet and no hydration, and
  // the job green end to end. No script in scripts/ci ever fetched one.
  {
    name: 'a page whose chunks are all served',
    run: () => servedAssets(PAGE_WITH_ASSETS, () => ({ status: 200, body: 'chunk' })),
    expect: 'clean',
  },
  {
    name: 'the missing `static` directory: every chunk named, every chunk 404',
    run: () => servedAssets(PAGE_WITH_ASSETS, () => ({ status: 404, body: '' })),
    expect: /returned 404, not 200/,
  },
  {
    name: 'one stylesheet missing, which is a page that renders unstyled',
    run: () =>
      servedAssets(PAGE_WITH_ASSETS, (path) =>
        path.endsWith('.css') ? { status: 404, body: '' } : { status: 200, body: 'chunk' },
      ),
    expect: /\/_next\/static\/css\/[^ ]* returned 404/,
  },
  {
    name: 'a chunk served as 200 with nothing in it',
    run: () => servedAssets(PAGE_WITH_ASSETS, () => ({ status: 200, body: '' })),
    expect: /200 with an empty body/,
  },
  {
    name: 'a catch-all answering every chunk with the page, which is a 200 the browser cannot run',
    run: () =>
      servedAssets(PAGE_WITH_ASSETS, () => ({
        status: 200,
        body: '<!DOCTYPE html><html><body>the app shell</body></html>',
      })),
    expect: /200 with an HTML document in it/,
  },
  {
    name: 'four lines of `respond` in the Caddyfile, which name no chunk at all',
    run: () =>
      servedAssets('<html><body><p>the page</p></body></html>', () => ({ status: 200, body: 'x' })),
    expect: /none of them is a file this deployment could serve/,
  },
  // ---- and per body, which the union does not cover (#40 round 6) ----------
  // `assert-page-serves.mjs` hands `buildAssetProblems` all four responses
  // joined, so the "names nothing servable" branch above is satisfied by one
  // chunk *anywhere in the union*. Round 4 asserted it per response; round 5
  // deleted that and said the fetch loop stood in for it. These two cases are
  // the measurement a blind review made: same input, opposite verdicts.
  {
    name: 'an asset-free signed-out page, joined with three pages that have assets',
    run: () =>
      servedAssets(
        [ASSET_FREE_PAGE, PAGE_WITH_ASSETS, PAGE_WITH_ASSETS, PAGE_WITH_ASSETS].join('\n'),
        () => ({
          status: 200,
          body: 'chunk',
        }),
      ),
    // Deliberately clean: this is what the union check says, and why it is not
    // the whole answer.
    expect: 'clean',
  },
  {
    name: 'the same signed-out page, asked about on its own',
    run: () =>
      servableAssets(ASSET_FREE_PAGE).length === 0
        ? ['GET / signed out names no `/_next/static/…` file this deployment could serve']
        : [],
    expect: /names no `\/_next\/static\/…` file/,
  },
  {
    name: 'a page whose only `/_next/static/…` path is a route, not a file',
    run: () =>
      servableAssets('<a href="/_next/static/chunks/app/app">go</a>').length === 0
        ? ['names no file this deployment could serve']
        : [],
    expect: /names no file/,
  },
  {
    name: 'a real page names files, so the per-body check is not vacuous',
    run: () => (servableAssets(PAGE_WITH_ASSETS).length > 0 ? [] : ['found no servable asset']),
    expect: 'clean',
  },
  {
    name: 'the escaped copies Next embeds in its RSC payload are not fetched as-is',
    run: () => {
      const named = buildAssets(PAGE_WITH_ASSETS);
      const bad = named.filter((path) => /[\\"']/.test(path));
      return bad.length > 0
        ? [
            `buildAssets returned ${bad.join(', ')} — the escaping around the RSC payload's copy of the path was captured too, and the deployment is right to 404 that URL. A false red here is a reason to delete the check.`,
          ]
        : [];
    },
    expect: 'clean',
  },
  // The other direction, and the one this round's first draft got wrong.
  // `apps/web/app` has `(auth)/sign-in`, `app/[workspace]/[room]` and
  // `api/auth/[...all]`; Next puts those segments in the chunk path, the
  // parentheses literally and the brackets percent-encoded. An allowlist of
  // filename characters truncates every one at the first bracket, and the
  // truncated prefix silently fails the extension test — assets unchecked,
  // check reporting clean. Each shape below must come back whole.
  {
    name: 'a chunk stamped with a query string, which must still be classified and fetched',
    // Classified on the path, requested whole. An anchored extension test on
    // the whole URL skips `page.js?dpl=abc` *silently* — stylesheets checked,
    // every script 404ing, report clean — and calls a page whose only asset is
    // stamped "nothing servable here". Wrong in both directions from one
    // anchor, found by a blind review.
    run: () =>
      servedAssets('<script src="/_next/static/chunks/app/page-a.js?dpl=abc"></script>', () => ({
        status: 404,
        body: '',
      })),
    expect: /page-a\.js\?dpl=abc returned 404/,
  },
  ...Object.entries({
    'a route group, which this app has three of': [
      '<script src="/_next/static/chunks/app/(auth)/sign-in/page-9f8e7d.js"></script>',
      '/_next/static/chunks/app/(auth)/sign-in/page-9f8e7d.js',
    ],
    'a dynamic segment, percent-encoded by Next': [
      '<script src="/_next/static/chunks/app/app/%5Bworkspace%5D/%5Broom%5D/page-1a2b.js"></script>',
      '/_next/static/chunks/app/app/%5Bworkspace%5D/%5Broom%5D/page-1a2b.js',
    ],
    'a font inside a css url(), whose closing paren is not part of the name': [
      '<style>@font-face{src:url(/_next/static/media/inter-abc.woff2) format("woff2")}</style>',
      '/_next/static/media/inter-abc.woff2',
    ],
  }).map(([name, [html, wanted]]) => ({
    name: `a chunk path this repo really produces: ${name}`,
    run: () => {
      const found = buildAssets(html);
      return found.includes(wanted)
        ? []
        : [`buildAssets returned ${JSON.stringify(found)}; the page names ${wanted}`];
    },
    expect: 'clean',
  })),

  // ---- the forged cookie is not separable from a real one -----------------
  {
    name: 'a forged session cookie has the real one’s length and alphabet',
    run: () => {
      const real = 'qXsD2p8kLmN4vT0wYzB6.aF3hJ9rQ7uE1iO5cV8n';
      const problems = [];
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const forged = forgeLike(real);
        if (forged === real) problems.push('the forgery equalled the real value');
        if (forged.length !== real.length) {
          problems.push(
            `length ${forged.length} rather than ${real.length}: a proxy separates them with one \`header_regexp\``,
          );
        }
        for (const character of forged) {
          if (!real.includes(character)) {
            problems.push(
              `the forgery uses \`${character}\`, which the real cookie does not: an alphabet test tells them apart`,
            );
          }
        }
      }
      return [...new Set(problems)];
    },
    expect: 'clean',
  },
  {
    name: 'the round-3 constant, measured against the same two tests',
    run: () => {
      const real = 'qXsD2p8kLmN4vT0wYzB6.aF3hJ9rQ7uE1iO5cV8n';
      const constant = `${'0'.repeat(24)}.${'f'.repeat(24)}`;
      const problems = [];
      if (constant.length !== real.length) {
        problems.push(`length ${constant.length} rather than ${real.length}`);
      }
      if ([...constant].some((character) => !real.includes(character))) {
        problems.push('it uses characters the real cookie does not');
      }
      return problems;
    },
    // This case asserts the *old* fixture fails the test the new one passes —
    // otherwise "drawn from the real cookie" is a claim with nothing behind it.
    expect: /length 49 rather than 40/,
  },
];

/**
 * The broken guard, in halves.
 *
 * Round 5 wrote it this way out of necessity: `mainGuardProblems` was a
 * substring scan over each file's source, so a fixture spelled out in one
 * literal would have made the scanner report *this* file. That discipline is no
 * longer load-bearing — the scanner parses, and a string literal is a string
 * literal — but the halves stay, because the round-5 defect was the *other*
 * half of the same fact and it is worth keeping both in view.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the broken guard, quoted verbatim as a fixture
const BROKEN_GUARD_HALVES = ['import.meta.url', '===', '`file://${process.argv[1]}`'];
/**
 * The canonical guard — deliberately a plain literal, which under round 5 was
 * the hole.
 *
 * `source.includes(CANONICAL_GUARD)` found *this line* and stopped looking, so
 * this file passed the guard check no matter what its real guard said, and this
 * file was the only caller of the guard check in the repository. Left spelled
 * out on purpose: it is the standing witness that the parser does not care,
 * and two cases above mutate the real guard of this file and of
 * workflow-policy-selftest.mjs to prove it.
 */
const CANONICAL_GUARD_LINE = 'if (isMainModule(import.meta.url)) {';
const LOOSE_GUARD_HALVES = ['import.meta.url', '==', "'file://' + process.argv[1]"];
/** What a guarded file has to import for the guard to be the shared predicate. */
const GUARD_IMPORT = "import { isMainModule } from './main-module.mjs';\n";
/**
 * The canonical guard with something conjoined to the sound predicate.
 *
 * Every one of these keeps `isMainModule(import.meta.url)` intact, so every text
 * test ever written for this accepts them, and every one of them can be false on
 * a machine where nobody is looking.
 */
const conjoin = (extra) => `${CANONICAL_GUARD_LINE.slice(0, -3)} && ${extra}) {`;
/** The one a blind review actually landed on r5: silent exactly under CI. */
const CI_CONJUNCT = 'process.env.CI === undefined';

/**
 * `mainGuardProblems` over the real `scripts/` tree with one file rewritten.
 *
 * The rest of the tree is read from disk, so every case also re-asserts that
 * nothing *else* trips the scanner — a fixture that fires for the right reason
 * in a tree that fires for six other reasons is not a test.
 */
function guardScanWith(target, rewrite) {
  return mainGuardProblems('scripts', (path) => {
    const source = readFileSync(path, 'utf8');
    return path.endsWith(target) ? rewrite(source) : source;
  });
}

/**
 * A 200 that is a page and names no build asset at all.
 *
 * What four lines of `respond` in a Caddyfile produce, and what an image whose
 * `.next/static` never made it in produces for a route Next could not render.
 */
const ASSET_FREE_PAGE = '<html><body><p data-region="conversation">the page</p></body></html>';

/** A rendered page naming the chunks a Next build produces, escaping and all. */
const PAGE_WITH_ASSETS = [
  '<link rel="stylesheet" href="/_next/static/css/a1b2c3d4.css"/>',
  '<script src="/_next/static/chunks/main-app-9f8e7d.js" async=""></script>',
  '<script src="/_next/static/chunks/webpack-1a2b3c.js" async=""></script>',
  '<script>self.__next_f.push([1,"3:HL[\\"/_next/static/css/a1b2c3d4.css\\",\\"style\\"]\\n"])</script>',
].join('');

/**
 * `buildAssetProblems` with the fetch replaced, so no stack has to be up.
 *
 * Returns a promise; `main()` awaits every case's result for this reason. The
 * alternative was a synchronous variant of the checker used only by the tests,
 * which is a second implementation of the thing under test.
 */
function servedAssets(html, respond) {
  return buildAssetProblems(null, html, async (path) => respond(path));
}

/** The `-f` values of a compose argv, in order, as a colon-joined list. */
function fileList(argv) {
  return argv.filter((_word, index) => argv[index - 1] === '-f').join(':');
}

/** The deploy job's own compose environment, as ci.yml declares it. */
function composeEnv() {
  return {
    ATRIUM_COMPOSE_PROJECT: 'atrium-ci',
    ATRIUM_COMPOSE_FILES: 'docker-compose.yml:docker-compose.mailpit.yml',
    ATRIUM_STACK_CA: '/tmp/caddy-root.crt',
  };
}

/**
 * A three-table schema, the way `expectedSchema()` reads one out of drizzle's
 * snapshot.
 *
 * `t|f` per column is not-null and has-a-default, in that order — the two facts
 * round 4 added beside the type, after the round-3 gauntlet pointed out that the
 * success line said "every column" over a comparison of column *names*.
 */
function schemaFixture() {
  const table = (columns, constraints, indexes = []) => ({
    columns: new Map(
      Object.entries(columns).map(([name, spec]) => {
        const [type, notNull, hasDefault] = spec.split('|');
        return [name, { type, notNull: notNull === 't', hasDefault: hasDefault === 't' }];
      }),
    ),
    constraints: new Set(constraints),
    indexes: new Set(indexes),
  });
  return {
    migrations: 1,
    snapshot: '0000_snapshot.json',
    tables: new Map([
      [
        'users',
        table(
          {
            id: 'uuid|t|t',
            email: 'text|t|f',
            display_name: 'text|t|f',
            email_verified: 'boolean|t|t',
          },
          ['primary key (id)', 'check `users_email_present`'],
        ),
      ],
      [
        'auth_sessions',
        table(
          {
            id: 'uuid|t|t',
            user_id: 'uuid|t|f',
            token: 'text|t|f',
            expires_at: 'timestamp with time zone|t|f',
          },
          ['primary key (id)', 'foreign key (user_id) references users (id) on delete cascade'],
          ['unique index `auth_sessions_token_idx` (token)'],
        ),
      ],
      [
        'corrections',
        table({ id: 'uuid|t|t', message_id: 'uuid|t|f', action: 'correction_action|t|f' }, [
          'primary key (id)',
        ]),
      ],
    ]),
  };
}

/**
 * The same schema as psql hands it back, through the real parser.
 *
 * Deliberately not a copy of the fixture above: these are `pg_catalog` rows in
 * Postgres's vocabulary, folded by `readSchema()` — the function the deployed
 * side really uses. So a case that passes here has exercised the translation
 * (`confdeltype` `c` → `on delete cascade`, `format_type` → the snapshot's type
 * spelling) rather than asserting that a Map equals itself, which is what the
 * round-3 fixture did.
 */
const DEPLOYED_ROWS = {
  columns: [
    'users|id|uuid|t|t',
    'users|email|text|t|f',
    'users|display_name|text|t|f',
    'users|email_verified|boolean|t|t',
    'auth_sessions|id|uuid|t|t',
    'auth_sessions|user_id|uuid|t|f',
    'auth_sessions|token|text|t|f',
    'auth_sessions|expires_at|timestamp with time zone|t|f',
    'corrections|id|uuid|t|t',
    'corrections|message_id|uuid|t|f',
    'corrections|action|correction_action|t|f',
  ],
  constraints: [
    'users|p|users_pkey|id|||a',
    'users|c|users_email_present|email|||a',
    'auth_sessions|p|auth_sessions_pkey|id|||a',
    'auth_sessions|f|auth_sessions_user_id_users_id_fk|user_id|users|id|c',
    'corrections|p|corrections_pkey|id|||a',
  ],
  indexes: ['auth_sessions|auth_sessions_token_idx|t|token'],
};

function deployedFixture(edit = (rows) => rows) {
  const rows = edit({
    columns: [...DEPLOYED_ROWS.columns],
    constraints: [...DEPLOYED_ROWS.constraints],
    indexes: [...DEPLOYED_ROWS.indexes],
  });
  return readSchema({
    columns: rows.columns.join('\n'),
    constraints: rows.constraints.join('\n'),
    indexes: rows.indexes.join('\n'),
    migrations: '1',
  });
}

/** One psql row rewritten, so a case is one field of one line. */
function drift(kind, match, replacement) {
  return (rows) => {
    const index = rows[kind].findIndex((row) => row.startsWith(match));
    if (index === -1) {
      throw new Error(`no ${kind} row starting ${match} — the fixture moved under the case`);
    }
    if (replacement === undefined) rows[kind].splice(index, 1);
    else rows[kind][index] = replacement;
    return rows;
  };
}

/**
 * Runs `deploy-mutation-ledger.mjs --pipeline` against a mutated copy of the
 * real workflow and reports what it said.
 *
 * `--pipeline` reads `ci.yml`, classifies every deploy step and checks coverage
 * without starting a container, so this is a few milliseconds and needs no
 * docker. Returns the ledger's own complaint, or nothing when it accepted the
 * workflow — the same shape every other case here returns.
 */
function ledgerRefuses(mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'atrium-ledger-selftest-'));
  const file = join(directory, 'ci.yml');
  writeFileSync(file, mutate(readFileSync(WORKFLOW, 'utf8')));
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/deploy-mutation-ledger.mjs', '--pipeline'],
    {
      encoding: 'utf8',
      env: { ...process.env, CI_WORKFLOW: file },
    },
  );
  if (result.status === 0) return [];
  return [`${result.stdout ?? ''}${result.stderr ?? ''}`];
}

/** Three built images, by ID, the way `record-built-images.mjs` writes them. */
function builtManifest() {
  return {
    app: { id: `sha256:${'1'.repeat(64)}`, image: 'atrium-ci-app' },
    server: { id: `sha256:${'2'.repeat(64)}`, image: 'atrium-ci-server' },
    migrate: { id: `sha256:${'3'.repeat(64)}`, image: 'atrium-ci-migrate' },
  };
}

/** The same three, as `docker inspect` reports the running containers. */
function runningImages() {
  return builtManifest();
}

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
  for (const [name, source] of Object.entries(BLIND_SPOTS)) {
    cases.push({
      name: `a stated blind spot, caught by the other witness instead: ${name}`,
      run: () => {
        const scan = scanFixture({ 'x.test.ts': source });
        const problems = [];
        // Half one: this witness really is blind here. If it stops being blind,
        // that is good news and the scope statement in scan-expected-failures.mjs
        // is now overcautious — say so rather than let the claim rot.
        if (scan.findings.length > 0) {
          problems.push(
            `the scanner now sees "${name}" (${scan.findings.map((f) => `${f.file}:${f.line}`).join(', ')}). That is an improvement, and the WHAT THIS PASS IS NOT block in scan-expected-failures.mjs still lists it as invisible. Update the claim.`,
          );
        }
        // Half two: and the pair still fails closed, because the reporter counts
        // what actually ran.
        if (checkExpectedFailureWitness(scan, 1).length === 0) {
          problems.push(
            `the scanner cannot see "${name}" and the gate stayed green while the reporter said one expected failure ran. That is the dual-witness design not working, which makes the blind spot a hole.`,
          );
        }
        return problems;
      },
      expect: 'clean',
    });
  }
  return cases;
}

async function main() {
  const failures = [];
  for (const { name, run, expect } of [...CASES, ...scannerCases()]) {
    let problems;
    try {
      // Awaited, because `buildAssetProblems` is async: the real fetch is, and a
      // synchronous copy of the checker written for the tests would be a second
      // implementation of the thing under test.
      problems = await run();
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

  failures.push(...checkReadmeClaims());

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::Gate self-test: ${failure}`);
    return 1;
  }
  const scanner = scannerCases().length;
  console.info(
    `Gate self-test passed: ${CASES.length + scanner} cases, every fail-open shape rejected and every clean report accepted — including ${Object.keys(EVADED_FORMS).length + Object.keys(HELPER_FORMS).length} spellings of \`it.fails\` the source scanner must see, ${Object.keys(NOT_ANNOTATIONS).length} lookalikes it must not, and ${Object.keys(BLIND_SPOTS).length} stated blind spots proved to fail closed through the reporter instead.`,
  );
  return 0;
}

/**
 * The README's numbers about these gates must be these gates' numbers.
 *
 * Round 4's README said "four lookalikes" over a table holding five, in the same
 * paragraph that explains why round 2's hand-counted rule total was wrong. The
 * derived-at-the-point-of-printing fix does nothing for a copy of the number
 * living in prose, so the prose is read back and compared. Same check as the one
 * in workflow-policy-selftest.mjs, for the counts this file owns.
 */
function checkReadmeClaims() {
  let readme;
  try {
    readme = readFileSync('README.md', 'utf8');
  } catch {
    return [];
  }
  const phrase = (words) => new RegExp(words.split(' ').join(String.raw`\s+`));
  const claims = [
    {
      what: 'gate self-test cases',
      pattern: phrase('runs (\\d+) cases'),
      actual: CASES.length + scannerCases().length,
    },
    {
      what: '`it.fails` spellings',
      pattern: phrase('(\\d+) spellings'),
      actual: Object.keys(EVADED_FORMS).length + Object.keys(HELPER_FORMS).length,
    },
    {
      what: 'lookalikes',
      pattern: phrase('(\\d+) lookalikes'),
      actual: Object.keys(NOT_ANNOTATIONS).length,
    },
    {
      what: 'stated blind spots',
      pattern: phrase('(\\d+) stated blind spots'),
      actual: Object.keys(BLIND_SPOTS).length,
    },
    {
      // Found by attacking round 6's own fix. `checkerGraphProblems` asserts a
      // property of every row in `ENFORCEMENT` — and says nothing at all about a
      // row that is *deleted*, which is one line and restores exactly the state
      // the file exists to prevent. The size of the registry is therefore prose
      // that is read back, the same technique that keeps the rule and mutation
      // counts honest. Removing a check from the graph now costs a README edit
      // that says out loud that the graph got smaller.
      what: 'enforcement checks in the invocation graph',
      pattern: phrase('invocation graph of (\\d+) enforcement checks'),
      actual: ENFORCEMENT.length,
    },
  ];
  const failures = [];
  for (const { what, pattern, actual } of claims) {
    const found = pattern.exec(readme);
    if (found === null) {
      failures.push(
        `README.md no longer states the number of ${what} in a form this check can read (${pattern}). Restore the sentence or update the pattern — an unchecked number in prose is how this ticket got three counts wrong.`,
      );
      continue;
    }
    if (Number(found[1]) !== actual) {
      failures.push(
        `README.md says ${found[1]} ${what}; the code says ${actual}. The prose is wrong, or the code is.`,
      );
    }
  }
  return failures;
}

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}
