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
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { checkHostNetworkPolicy, publishedPortProblems } from './assert-deploy-preflight.mjs';
import { checkRatchet, floorFingerprint, floorsOf, readBaseline } from './assert-floor-ratchet.mjs';
import { checkImageIdentity } from './assert-image-identity.mjs';
import { checkMigrationImage } from './assert-migration-image.mjs';
import { checkPlaywrightReport } from './assert-playwright-report.mjs';
import { checkSchema, readSchema } from './assert-stack-schema.mjs';
import { checkVitestReports } from './assert-vitest-report.mjs';
import { checkEnrollment } from './assert-workspace-enrollment.mjs';
import {
  assertedNames,
  assertionConditionProblems,
  assertionFloorProblems,
  checkerGraphProblems,
  controlCoverageProblems,
  ENFORCEMENT,
  sharedModuleProblems,
} from './checker-graph.mjs';
import { notAVerdict } from './child-verdict.mjs';
import { composeArgs } from './compose.mjs';
import { composeStackArgv, VERBS } from './compose-stack.mjs';
import { entryDecisionProblems, mainGuardProblems } from './guard-scan.mjs';
import { isMainModule } from './main-module.mjs';
import {
  controlProblems,
  distinguishProblems,
  expectationProblems,
  preconditionReds,
  runControls,
  WRONG_REDS,
} from './positive-control.mjs';
import { repoRoot } from './repo-root.mjs';
import { fail, readFreshReport } from './report-file.mjs';
import { checkExpectedFailureWitness, scanForExpectedFailures } from './scan-expected-failures.mjs';
import {
  absentDeployment,
  buildAssetProblems,
  buildAssets,
  forgeLike,
  mailpit,
  runtimeFloorProblems,
  servableAssets,
  stackTarget,
} from './stack-client.mjs';

/** A target shaped like `stackTarget()`, for the precondition cases. */
const PROBE_TARGET = {
  origin: 'https://atrium.localhost',
  address: '127.0.0.1',
  httpsPort: 443,
  domain: 'atrium.localhost',
};

import { ciScriptName, workflowFiles } from './workflow-policy.mjs';

/**
 * The repository, found by walking up rather than by trusting the cwd.
 *
 * ── WHY (#40 round 8, D7) ───────────────────────────────────────────────────
 * Every path below used to be relative to the working directory. CI runs from
 * the root so it all worked, and from anywhere else `checkReadmeClaims` caught
 * its own `readFileSync`, returned `[]`, and reported nothing — the readback
 * that keeps every count in the prose honest, silently not running. A check that
 * skips what it cannot find is a check with a hole shaped like a directory.
 *
 * `repoRoot()` still starts from the cwd, deliberately: that is how
 * `positive-control.mjs` points this file at a copy of the tree with a defect
 * planted in it, without an environment variable that could point it anywhere.
 */
const ROOT = repoRoot();
const at = (relative) => join(ROOT, relative);
const WORKFLOW = process.env.CI_WORKFLOW ?? at('.github/workflows/ci.yml');

/**
 * The `services` block of the shipped compose files, merged the shallow way.
 *
 * Read out of the YAML rather than out of `docker compose config`, because the
 * verify job has no `.env` and compose refuses to interpolate without one — and
 * the assertion this feeds is about the *shipped* files, which is what a reader
 * of docker-compose.yml sees. `assert-deploy-preflight.mjs` asks the resolved
 * configuration the same question in the deploy job, where an overlay could have
 * changed the answer; these two readers are the point, not a duplication.
 */
function resolvedComposeServices() {
  const files = (
    process.env.ATRIUM_COMPOSE_FILES ?? 'docker-compose.yml:docker-compose.mailpit.yml'
  )
    .split(/[:,]/)
    .map((file) => file.trim())
    .filter(Boolean);
  const services = {};
  for (const file of files) {
    const document = parse(readFileSync(at(file), 'utf8'));
    for (const [name, definition] of Object.entries(document?.services ?? {})) {
      services[name] = { ...services[name], ...definition };
    }
  }
  return services;
}

/** A synthetic control, for the cases about how outcomes are graded. */
const PROBE_CONTROL = {
  id: 'assert-x',
  world: 'nothing is running',
  expect: /assert-x: \d+ assertion\(s\) failed\./,
  because: 'a probe',
};

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

  // ---- an assertion that asserts nothing (#40 round 8, D3) ----------------
  // Nothing in this repository required an assertion script to contain an
  // assertion. Measured on r7: `assert-page-serves.mjs` replaced by two lines
  // that import the reporter and call it printed "passed." and exited 0 with no
  // stack running at all, with every gate here green. No rule about the text of
  // a file can catch that; only running it in a world where it must fail can.
  {
    name: 'an entry point that exits 0 in a world it cannot have checked',
    run: () => controlProblems(PROBE_CONTROL, { status: 0, output: 'assert-x: passed.\n' }),
    expect: /exited 0 when/,
  },
  {
    name: 'a red for an unrelated reason is not the control working',
    run: () => controlProblems(PROBE_CONTROL, { status: 1, output: 'command not found: docker\n' }),
    expect: /did not visibly fail for the reason this control planted/,
  },
  {
    name: 'a child killed by the control’s own timeout is not a red either',
    run: () =>
      controlProblems(PROBE_CONTROL, {
        status: undefined,
        output: '',
        error: { code: 'ETIMEDOUT', killed: true },
      }),
    expect: /did not reach a verdict/,
  },
  {
    name: 'a control that failed, visibly, for the reason it planted',
    run: () =>
      controlProblems(PROBE_CONTROL, { status: 1, output: 'assert-x: 3 assertion(s) failed.\n' }),
    expect: 'clean',
  },
  {
    // The whole mechanism, end to end, against the exploit as the critic wrote
    // it. No stack and no network: a script gutted to `report(…)` exits
    // immediately, which is precisely what makes it invisible to everything
    // else and instant to catch here.
    name: 'the shipped control, run against a gutted copy of an assertion script',
    run: () => {
      const workspace = mkdtempSync(join(tmpdir(), 'atrium-gutted-'));
      const script = join(workspace, 'assert-gutted.mjs');
      writeFileSync(
        script,
        `import { report } from ${JSON.stringify(pathToFileURL(at('scripts/ci/stack-client.mjs')).href)};\nreport('assert-gutted');\n`,
      );
      return runControls(
        [
          {
            id: 'assert-gutted',
            entry: 'assert-gutted',
            argv: [script],
            world: 'nothing is listening on the deployment’s port',
            expect: /assert-gutted: \d+ assertion\(s\) failed\./,
            because: 'the D3 exploit, verbatim',
          },
        ],
        ROOT,
      ).problems;
    },
    expect: /exited 0 when/,
  },
  {
    // ── AND THE NAMES IT REPORTS ARE THE CHILDREN IT SPAWNED (#40 round 9, D2)
    // `main` used to print `${CONTROLS[group].length} entry point(s) each
    // failed` — the table's size. `if (process.env.CI !== undefined) return [];`
    // at the top of `runGroup` then produced "10 entry point(s) each failed"
    // with no child process spawned at all, and every other gate clean. What
    // `runControls` returns now is the list of ids it actually ran, and that is
    // the list `main` prints and `runGroup` cross-checks.
    name: 'the control mechanism reports the controls it ran, not the size of its table',
    run: () => {
      const workspace = mkdtempSync(join(tmpdir(), 'atrium-ran-'));
      const script = join(workspace, 'assert-ran.mjs');
      writeFileSync(
        script,
        "console.error('assert-ran: 1 assertion(s) failed.');\nprocess.exit(1);\n",
      );
      const { ran, problems } = runControls(
        [
          {
            id: 'assert-ran',
            entry: 'assert-ran',
            argv: [script],
            world: 'a child that always fails, so only the bookkeeping is under test',
            expect: /assert-ran: \d+ assertion\(s\) failed\./,
            because: 'the bookkeeping',
          },
        ],
        ROOT,
      );
      return problems.length === 0 && ran.join(',') === 'assert-ran'
        ? []
        : [`runControls reported ran=[${ran.join(', ')}] problems=[${problems.join(' | ')}]`];
    },
    expect: 'clean',
  },
  {
    // The round-9 D1 rule, on the shipped table: an expectation any unrelated
    // red would satisfy is an expectation that proves nothing.
    name: 'every shipped control expectation is about a behaviour, not an identity',
    run: () => expectationProblems(),
    expect: 'clean',
  },

  // ---- the assertions themselves have to still be there (r9) --------------
  {
    name: 'every script that records assertions meets its floor in the CI manifest',
    run: () => assertionFloorProblems(ROOT),
    expect: 'clean',
  },
  {
    name: 'a stack assertion gutted below its declared floor',
    run: () =>
      assertionFloorProblems(ROOT, (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({
              assertions: {
                scripts: { 'scripts/ci/assert-page-serves.mjs': { minChecks: 9999 } },
              },
            })
          : readFileSync(path, encoding),
      ),
    expect: /recorded assertion\(s\) and .* declares a floor of/,
  },
  {
    name: 'the whole assertion-floor table deleted',
    run: () =>
      assertionFloorProblems(ROOT, (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({ vitest: {} })
          : readFileSync(path, encoding),
      ),
    expect: /no `assertions\.scripts` object/,
  },
  {
    name: 'a floor left behind by a script that stopped recording anything',
    run: () =>
      assertionFloorProblems(ROOT, (path, encoding) =>
        String(path).endsWith('ci-manifest.json')
          ? JSON.stringify({
              assertions: { scripts: { 'scripts/ci/assert-gone.mjs': { minChecks: 1 } } },
            })
          : readFileSync(path, encoding),
      ),
    expect: /does not record assertions through `check`/,
  },

  // ---- the sentence the cold world says instead of crashing (r9, D1) -------
  {
    name: 'a deployment that answered with a status is not absent',
    run: () =>
      absentDeployment(PROBE_TARGET, { response: { status: 200 } }) === undefined
        ? []
        : ['absentDeployment called a live deployment absent'],
    expect: 'clean',
  },
  {
    name: 'a refused connection is a sentence, not a stack trace',
    run: () => [String(absentDeployment(PROBE_TARGET, { error: { code: 'ECONNREFUSED' } }))],
    expect: /nothing is serving this deployment/,
  },
  {
    name: 'a certificate authority that could not be read is its own sentence',
    run: () => [
      String(absentDeployment({ ...PROBE_TARGET, caProblem: 'ATRIUM_STACK_CA points at x' }, {})),
    ],
    expect: /ATRIUM_STACK_CA/,
  },
  {
    name: 'an answer with no status is not an answer this may assume was fine',
    run: () => [String(absentDeployment(PROBE_TARGET, { response: {} }))],
    expect: /came back without a status/,
  },

  // ---- and the two worlds have to be told apart (#40 round 10, D1) ---------
  {
    /**
     * The defect, as a case. Round 9 answered the certificate-authority problem
     * before making any request, and `ATRIUM_STACK_CA` names a file the job
     * writes six steps after the control runs — so with the CA unreadable, a
     * refused connection and a peer that accepts and resets produced the *same*
     * sentence, and the control was scoring a red about a missing file as
     * evidence that a deployment was missing. This fails on r9 as committed.
     */
    name: 'a refused connection and a peer that answers are different sentences, CA or no CA',
    run: () => {
      const withoutCa = { ...PROBE_TARGET, caProblem: 'ATRIUM_STACK_CA points at x' };
      const problems = [];
      for (const [world, target] of [
        ['with the certificate authority the job has not written yet', withoutCa],
        ['with the certificate authority present', PROBE_TARGET],
      ]) {
        const refused = String(absentDeployment(target, { error: { code: 'ECONNREFUSED' } }));
        const answered = String(absentDeployment(target, { error: { code: 'ECONNRESET' } }));
        if (refused === answered) {
          problems.push(
            `${world}, a refused connection and a peer that accepted one and reset it produce identical output: ${refused}`,
          );
        }
        if (!/nothing is serving this deployment/.test(refused)) {
          problems.push(`${world}, a refused connection does not say the deployment is absent`);
        }
        if (/nothing is serving this deployment/.test(answered)) {
          problems.push(`${world}, a peer that answered is being called an absent deployment`);
        }
      }
      return problems;
    },
    expect: 'clean',
  },
  {
    name: 'the corpus of wrong reds is generated from the precondition, not written down',
    run: () => {
      const reds = preconditionReds();
      if (reds.length === 0)
        return ['preconditionReds() produced nothing to test a pattern against'];
      const missing = reds.filter(
        (red) => !/ATRIUM_STACK_CA|answering on|without a status/.test(red.text),
      );
      return missing.length === 0
        ? []
        : [`a generated wrong red says none of the things it is generated for: ${missing[0].text}`];
    },
    expect: 'clean',
  },
  {
    name: 'an expectation that admits the certificate-authority sentence is refused',
    run: () =>
      expectationProblems(
        {
          deploy: [
            {
              id: 'assert-page-serves',
              entry: 'assert-page-serves',
              // Round 9's own pattern, verbatim: the alternation that made the
              // control pass on a file the job had not written yet.
              expect:
                /assert-page-serves: (?:nothing is serving this deployment|ATRIUM_STACK_CA points at)/,
              world: 'nothing is listening',
              because: 'the r9 defect',
            },
          ],
        },
        [
          ...WRONG_REDS,
          {
            what: 'the certificate authority not being written yet',
            text: '::error::%s: ATRIUM_STACK_CA points at /w/caddy-root.crt, which could not be read\n',
          },
        ],
      ),
    expect: /is satisfied by/,
  },
  {
    name: 'two runs of a control that produced identical bytes are not a control',
    run: () =>
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        { status: 1, output: 'assert-page-serves: 1 assertion(s) failed.\n' },
        { status: 1, output: 'assert-page-serves: 1 assertion(s) failed.\n' },
      ),
    expect: /byte-identical output/,
  },
  {
    name: 'a control whose expectation is also satisfied by the decoy is refused',
    run: () =>
      distinguishProblems(
        { id: 'assert-page-serves', expect: /assert-page-serves/ },
        { status: 1, output: 'assert-page-serves: nothing is serving this deployment\n' },
        { status: 1, output: 'assert-page-serves: something is answering\n' },
      ),
    expect: /satisfied by its run against a decoy/,
  },
  {
    name: 'a control that passes against a decoy that is not a deployment is refused',
    run: () =>
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        { status: 1, output: 'assert-page-serves: nothing is serving this deployment\n' },
        { status: 0, output: 'assert-page-serves: passed.\n' },
      ),
    expect: /exited 0 against a peer/,
  },
  {
    name: 'two runs that said different things are the control working',
    run: () =>
      distinguishProblems(
        { id: 'assert-page-serves', expect: /nothing is serving this deployment/ },
        {
          status: 1,
          output: 'assert-page-serves: nothing is serving this deployment (ECONNREFUSED)\n',
        },
        {
          status: 1,
          output: 'assert-page-serves: something is answering on 127.0.0.1:1 (ECONNRESET)\n',
        },
      ),
    expect: 'clean',
  },

  // ---- and the work has to have actually been done (#40 round 10, D2/D3) ---
  {
    name: 'a run that made fewer assertions than the manifest says it makes',
    run: () =>
      runtimeFloorProblems('assert-stack-schema', { assertions: 0, requests: 0 }, () => ({
        floors: { minRun: 200 },
      })),
    expect: /recorded 0 assertion\(s\) in this run/,
  },
  {
    name: 'a run that asked the deployment nothing',
    run: () =>
      runtimeFloorProblems('assert-page-serves', { assertions: 99, requests: 1 }, () => ({
        floors: { minRun: 20, minRequests: 12 },
      })),
    expect: /put 1 request\(s\) to the deployment/,
  },
  {
    name: 'a run that did the work is not reported',
    run: () =>
      runtimeFloorProblems('assert-page-serves', { assertions: 99, requests: 40 }, () => ({
        floors: { minRun: 20, minRequests: 12 },
      })),
    expect: 'clean',
  },
  {
    name: 'a manifest nobody could read is a floor nobody is held to',
    run: () =>
      runtimeFloorProblems('assert-page-serves', { assertions: 99, requests: 40 }, () => ({
        problem: 'could not read .github/ci-manifest.json',
      })),
    expect: /could not read/,
  },
  {
    name: 'the schema comparison counts what it compared',
    run: () => {
      let counted = 0;
      const problems = checkSchema(schemaFixture(), deployedFixture(), (n) => {
        counted = n;
        return n;
      });
      if (problems.length > 0) return [`the fixture drifted: ${problems.join(' | ')}`];
      // The population, counted here from the fixture rather than taken on
      // trust: every table, every column, every constraint, every index, and the
      // migration ledger. A `checkSchema` that reported a number unrelated to
      // what it was handed would be the r10 D2 defect written the other way up.
      const expected = schemaFixture();
      let subjects = expected.tables.size + 1;
      for (const table of expected.tables.values()) {
        subjects += table.columns.size + table.constraints.size + table.indexes.size;
      }
      return counted === subjects
        ? []
        : [
            `checkSchema reported ${counted} comparisons over a schema holding ${subjects} of them. The count has to be the population the comparison walked, or it is a number a rewrite can produce without comparing anything.`,
          ];
    },
    expect: 'clean',
  },
  {
    name: 'a comparison that compared nothing reports nothing',
    run: () => {
      let counted = -1;
      checkSchema(
        { tables: new Map(), migrations: 0 },
        { tables: new Map(), migrations: 0 },
        (n) => {
          counted = n;
          return n;
        },
      );
      // One: the migration ledger. Nothing else was there to compare.
      return counted === 1 ? [] : [`an empty comparison reported ${counted} comparisons`];
    },
    expect: 'clean',
  },
  {
    name: 'every recorded assertion in this repository reads a value',
    run: () => assertionConditionProblems(ROOT),
    expect: 'clean',
  },
  {
    name: 'the measured D3 exploit: twenty-three assertions about the constant `true`',
    run: () =>
      assertionConditionProblems(ROOT, (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, report } from './stack-client.mjs';\ncheck(true, 'x');\nreport('assert-page-serves');\n"
          : readFileSync(path, encoding),
      ),
    expect: /reads no value/,
  },
  {
    name: 'a fold that reports a literal count of comparisons it never made',
    run: () =>
      assertionConditionProblems(ROOT, (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, compared, report } from './stack-client.mjs';\ncompared(40, 'nothing at all');\nreport('assert-page-serves');\n"
          : readFileSync(path, encoding),
      ),
    expect: /reads no value/,
  },
  {
    name: 'the same tautology behind a module-scope constant',
    run: () =>
      assertionConditionProblems(ROOT, (path, encoding) =>
        String(path).endsWith('assert-page-serves.mjs')
          ? "import { check, report } from './stack-client.mjs';\nconst FINE = true;\ncheck(FINE, 'x');\nreport('assert-page-serves');\n"
          : readFileSync(path, encoding),
      ),
    expect: /reads no value/,
  },

  // ---- an entry point is where it resolves, not how it is spelled (r10, D4) -
  {
    name: 'a `./`-prefixed entry point is the same entry point',
    run: () => {
      const spellings = [
        'scripts/ci/assert-page-serves.mjs',
        './scripts/ci/assert-page-serves.mjs',
        '../../scripts/ci/assert-page-serves.mjs',
        'scripts/./ci/assert-page-serves.mjs',
        '/home/runner/work/atrium/atrium/scripts/ci/assert-page-serves.mjs',
      ];
      const wrong = spellings.filter((word) => ciScriptName(word) !== 'assert-page-serves');
      return wrong.length === 0
        ? []
        : [`these spellings of one entry point were not read as one: ${wrong.join(', ')}`];
    },
    expect: 'clean',
  },
  {
    name: 'a word that is not one of this repository’s entry points is not read as one',
    run: () => {
      const notOurs = ['node', 'pnpm', 'assert-page-serves.mjs', 'scripts/ci/Assert.mjs'];
      const wrong = notOurs.filter((word) => ciScriptName(word) !== null);
      return wrong.length === 0 ? [] : [`read as entry points: ${wrong.join(', ')}`];
    },
    expect: 'clean',
  },
  {
    name: 'an uncontrolled entry point written with a leading `./` is still uncontrolled',
    run: () =>
      controlCoverageProblems(ROOT, (path, encoding) =>
        String(path).endsWith('ci.yml')
          ? readFileSync(path, encoding)
              .toString()
              .replace(
                '      - name: Build the images',
                '      - name: An invented thing\n        run: node ./scripts/ci/invented-thing.mjs\n\n      - name: Build the images',
              )
          : readFileSync(path, encoding),
      ),
    expect: /runs scripts\/ci\/invented-thing\.mjs and no positive control/,
  },

  // ---- the mail relay's address, which was a false debt entry (r9) ---------
  {
    name: 'an unset ATRIUM_MAILPIT_URL resolves the published mail port',
    run: () =>
      mailpit({}).base === 'http://127.0.0.1:8025'
        ? []
        : [`mailpit({}).base is ${mailpit({}).base}`],
    expect: 'clean',
  },
  {
    name: 'a blank ATRIUM_MAILPIT_URL is not an address',
    run: () =>
      mailpit({ ATRIUM_MAILPIT_URL: '  ' }).base === 'http://127.0.0.1:8025'
        ? []
        : ['a blank ATRIUM_MAILPIT_URL was taken as the relay address'],
    expect: 'clean',
  },

  // ---- the exit status of both report gates (r9) ---------------------------
  {
    name: 'a list of problems is a failing status',
    run: () => {
      const said = console.error;
      console.error = () => {};
      const status = fail(['a problem'], 'the probe');
      console.error = said;
      return status === 1 ? [] : [`fail() returned ${status}`];
    },
    expect: 'clean',
  },

  // ---- the round-4 entry decision, asked of the whole repository (r9, D7) --
  {
    name: 'no file in this repository decides whether it was run by comparing a URL to a path',
    run: () => [
      ...entryDecisionProblems(at('scripts')),
      ...entryDecisionProblems(at('packages')),
      ...entryDecisionProblems(at('apps')),
    ],
    expect: 'clean',
  },
  {
    name: 'the round-4 comparison, planted in a real file',
    run: () =>
      entryDecisionProblems(at('scripts'), (path) =>
        path.endsWith('assert-tables.mjs')
          ? 'if (import.meta.url === `file://${process.argv[1]}`) { main(); }'
          : readFileSync(path, 'utf8'),
      ),
    expect: /comparing `import\.meta\.url` against a path/,
  },
  {
    // The same decision written the way `packages/ingest/src/cli.ts` wrote it:
    // `import.meta.url` on one side of one comparison and `process.argv[1]` on
    // the other side of another, so neither line names both halves.
    name: 'the two-line spelling, where one comparison names argv and the other names import.meta',
    run: () =>
      entryDecisionProblems(at('scripts'), (path) =>
        path.endsWith('assert-tables.mjs')
          ? "const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);\nif (entry === fileURLToPath(import.meta.url)) { main(); }"
          : readFileSync(path, 'utf8'),
      ),
    expect: /round-4 guard with the other half renamed/,
  },
  {
    name: "round 8's expectation, which a stack trace naming the script satisfies",
    run: () =>
      expectationProblems({
        deploy: [
          {
            id: 'assert-page-serves',
            entry: 'assert-page-serves',
            expect: /assert-page-serves/,
            world: 'w',
            because: 'b',
          },
        ],
      }),
    expect: /is satisfied by a Node stack trace/,
  },
  {
    name: 'an expectation with no pattern at all',
    run: () =>
      expectationProblems({
        deploy: [{ id: 'assert-x', entry: 'assert-x', world: 'w', because: 'b' }],
      }),
    expect: /has no `expect` regular expression/,
  },
  {
    name: 'an expectation that matches the empty string',
    run: () =>
      expectationProblems({
        deploy: [
          {
            id: 'assert-x',
            entry: 'assert-x',
            expect: /x?/,
            world: 'w',
            because: 'b',
          },
        ],
      }),
    expect: /matches the empty string/,
  },

  // ---- a premise in a comment is not a check (#40 round 8, D6) -------------
  // The deploy job's own step comment said "a runner with no published database
  // port". Nothing asserted it and it was false: Postgres and MinIO are
  // published with no interface prefix, and a blind critic connected from a
  // non-loopback address with the credentials from .env and dumped the schema.
  // The exposure is #51; what these cases hold is that the *claim* is now a
  // table that has to keep matching the resolved configuration.
  {
    name: 'the real compose files publish exactly the ports the preflight writes down',
    run: () => publishedPortProblems(resolvedComposeServices()),
    expect: 'clean',
  },
  {
    name: 'a service that publishes a port nobody declared',
    run: () =>
      publishedPortProblems({
        redis: { ports: [{ target: 6379, published: '6379', mode: 'ingress' }] },
      }),
    expect: /nothing in this file says it does/,
  },
  {
    name: 'a declared port that moves off loopback onto every interface',
    run: () =>
      publishedPortProblems(
        { mailpit: { ports: [{ target: 8025, published: '8025', mode: 'ingress' }] } },
        { 'mailpit:8025': { interface: '127.0.0.1', why: 'a store of live sign-in links' } },
      ),
    expect: /publishes its port 8025 on every interface this host answers on/,
  },
  {
    name: 'a written entry that has stopped describing anything',
    run: () => publishedPortProblems({}, { 'postgres:5432': { interface: '', why: 'issue #51' } }),
    expect: /has stopped describing anything/,
  },
  {
    // The host port is `${HTTPS_PORT}` on purpose — a machine with 443 taken
    // has to be able to run this stack — so a remap must not be a red.
    name: 'a host-port remap is not a change to which interface a port is on',
    run: () =>
      publishedPortProblems(
        { proxy: { ports: [{ target: 443, published: '8443', mode: 'ingress' }] } },
        { 'proxy:443': { interface: '', why: 'the deployment is a web server' } },
      ),
    expect: 'clean',
  },

  // ---- and the attack on the control table's own scope sentence -----------
  // "The entry points named in CONTROLS" is a scope, and taking a script out of
  // the table is a one-line way past it. The required set is read out of the
  // workflow rather than out of the table.
  {
    name: 'every assertion the deploy job runs is controlled or exempted with a reason',
    run: () => controlCoverageProblems(ROOT),
    expect: 'clean',
  },
  {
    name: 'the control table emptied, with the deploy job still running its assertions',
    run: () => controlCoverageProblems(ROOT, readFileSync, { deploy: [] }),
    expect: /no positive control .* ever requires it to fail/,
  },

  // ---- where the repository is, asked from anywhere (#40 round 8, D7) ------
  {
    name: 'the root is found by walking up rather than by trusting the working directory',
    run: () => {
      const workspace = mkdtempSync(join(tmpdir(), 'atrium-root-'));
      const nested = join(workspace, 'packages', 'x', 'src');
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true });
      mkdirSync(join(workspace, 'scripts', 'ci'), { recursive: true });
      writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n');
      return repoRoot(nested) === workspace ? [] : ['it did not walk up to the marked root'];
    },
    expect: 'clean',
  },
  {
    name: 'a directory with no repository above it is an error, not an empty tree',
    run: () => {
      try {
        repoRoot(tmpdir());
        return ['it invented a root'];
      } catch (error) {
        return [error.message];
      }
    },
    expect: /no repository root at or above/,
  },

  // ---- where every request in the deploy job is aimed ----------------------
  {
    name: 'the stack target is the configured domain over TLS, with the deployment’s own CA',
    run: () => {
      const workspace = mkdtempSync(join(tmpdir(), 'atrium-target-'));
      const ca = join(workspace, 'ca.pem');
      writeFileSync(ca, 'a certificate\n');
      const target = stackTarget({
        ATRIUM_STACK_DOMAIN: 'atrium.localhost',
        ATRIUM_STACK_CA: ca,
        ATRIUM_STACK_HTTPS_PORT: '8443',
      });
      const problems = [];
      if (target.origin !== 'https://atrium.localhost') problems.push(`aimed at ${target.origin}`);
      if (target.httpsPort !== 8443) problems.push('ignored ATRIUM_STACK_HTTPS_PORT');
      if (!String(target.ca ?? '').includes('a certificate')) problems.push('read no CA');
      return problems;
    },
    expect: 'clean',
  },

  // ---- the main-module guard, in every file that has one ------------------
  // Fifteen scripts decided "was I run?" by comparing `import.meta.url` against
  // `file://` + `process.argv[1]`. Measured: with a space anywhere in the path,
  // or through a symlink, the comparison is false and the script exits 0 having
  // asserted nothing — including both self-tests, so the thing that would have
  // noticed was disarmed by the same line.
  {
    name: 'every guard under scripts/ is the sound one',
    run: () => mainGuardProblems(at('scripts')),
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
  // ---- the same conjunct, moved one line further in ------------------------
  // A condition-shape rule is defeated by putting the second gate in the body,
  // and that is a *smaller* edit than the one that started this ticket. Named by
  // a blind review of this round's own fix; all three were accepted when it was.
  {
    name: 'the round-5 conjunct relocated from the condition into the body',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  if (${CI_CONJUNCT}) {\n    process.exit(main());\n  }\n}\n`,
      ),
    expect: /never reaches an unconditional exit/,
  },
  {
    name: 'the whole body behind `if (false)`',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  if (false) {\n    process.exit(main());\n  }\n}\n`,
      ),
    expect: /never reaches an unconditional exit/,
  },
  {
    name: 'the work swallowed by an empty catch, so failure exits 0',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  const code = main();\n  try {\n    process.exit(code);\n  } catch {}\n}\n`,
      ),
    expect: /never reaches an unconditional exit/,
  },
  {
    // The other polarity, because a body rule that refuses real entry points is
    // a body rule somebody deletes: six of the fifteen scripts here do their
    // whole job inside the guard, and a conditional exit *after* unconditional
    // work is exactly what argument validation looks like.
    name: 'work first and a conditional exit after it, which is what real scripts do',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  const verb = parse(process.argv.slice(2));\n  if (verb === undefined) {\n    process.exit(2);\n  }\n  process.exit(main(verb));\n}\n`,
      ),
    expect: 'clean',
  },
  // ---- one line ABOVE the guard, which was outside every rule (#40 round 8) -
  // Round 7's allowlist over the exit value governed the guard body. The twelve
  // lines above it were governed by nothing at all, and the statement below was
  // measured on r7 as committed: `CI=true node gate-selftest.mjs` → exit 0, 0
  // bytes; the same insertion in workflow-policy-selftest.mjs → exit 0, 0 bytes;
  // scanner 0 problems, policy 0, biome 0. 184 cases and 197 mutations gone for
  // two files and one insertion each. The first two cases plant it in the two
  // files that are each other's only witness, which is where it costs the most.
  {
    name: 'a top-level exit above this file’s own guard, silent exactly under CI',
    run: () =>
      guardScanWith('gate-selftest.mjs', (source) =>
        source.replace(
          `\n${CANONICAL_GUARD_LINE}`,
          `\nif (process.env.CI !== undefined) process.exit(0);\n${CANONICAL_GUARD_LINE}`,
        ),
      ),
    expect: /exits with the literal `0`/,
  },
  {
    name: 'the same insertion in the other self-test, which is the file that would notice',
    run: () =>
      guardScanWith('workflow-policy-selftest.mjs', (source) =>
        source.replace(
          `\n${CANONICAL_GUARD_LINE}`,
          `\nif (process.env.CI !== undefined) process.exit(0);\n${CANONICAL_GUARD_LINE}`,
        ),
      ),
    expect: /exits with the literal `0`/,
  },
  {
    name: 'an `exit` listener that resets the status the terminator chose',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  process.on('exit', () => {\n    process.exitCode = 0;\n  });\n  process.exit(await main());\n}\n`,
      ),
    expect: /registers a `process\.on` listener/,
  },
  {
    name: 'a block-scoped shadow of the name the exit reads',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}${CANONICAL_GUARD_LINE}\n  const code = await main();\n  if (process.env.CI !== undefined) { const code = 0; process.exit(code); }\n  process.exit(code);\n}\n`,
      ),
    expect: /declares `code` a second time/,
  },
  {
    name: 'the exit machinery reached through a second name for `process`',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}const p = process;\np.exit(0);\n${CANONICAL_GUARD_LINE}\n  process.exit(await main());\n}\n`,
      ),
    expect: /names `process` as a value/,
  },
  {
    name: 'the guard’s only input rewritten above it',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          `${GUARD_IMPORT}process.argv[1] = '/nope';\n${CANONICAL_GUARD_LINE}\n  process.exit(await main());\n}\n`,
      ),
    expect: /assigns to `process\.argv`/,
  },
  {
    // The other polarity for the file-wide rule: the three entry points that
    // have no guard at all do their work at module scope and exit with it, and
    // a rule that refused them would be a rule somebody deletes.
    name: 'a guardless script that runs its work at module scope and exits with it',
    run: () =>
      guardScanWith(
        'assert-tables.mjs',
        () =>
          "import { existsSync } from 'node:fs';\nfunction main() {\n  return existsSync('x') ? 0 : 1;\n}\nprocess.exit(main());\n",
      ),
    expect: 'clean',
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
    run: () => checkerGraphProblems({ root: ROOT }),
    expect: 'clean',
  },
  {
    name: "the round-5 graph, restored: this file as mainGuardProblems' only caller",
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [{ ...ENFORCEMENT[0], invokers: ['scripts/ci/gate-selftest.mjs'] }],
      }),
    expect: /Sole enforcer, sole exception/,
  },
  // ---- presence is not use, applied to the WITNESS (#40 round 7) ----------
  // Round 6 asked whether a check is *called*. A blind critic stripped four
  // `expect(…)` wrappers from packages/ci-guard while keeping every call, put
  // round 4's broken guard back into assert-tables.mjs, and got ci-guard 0 → 49
  // passed with every count claim still true and the rule entirely gone. And its
  // four-shape dead-code denylist had eighteen more shapes walking past it.
  // `assertedNames` names the assertion shapes and refuses the complement; the
  // full table of twenty-six refused positions lives in packages/ci-guard, which
  // is not one of this scanner's subjects.
  {
    name: 'a call whose result is discarded is not a witness',
    run: () =>
      assertedNames('f.test.ts', 'it("x", () => { mainGuardProblems("scripts"); });').has(
        'mainGuardProblems',
      )
        ? ['a call with no assertion counted as a witness']
        : [],
    expect: 'clean',
  },
  {
    name: 'nor is one in a dead branch, a skipped test, an alias or a never-called function',
    run: () => {
      const dead = {
        'if (false)': 'it("x", () => { if (false) { expect(mainGuardProblems("s")); } });',
        'while (false)': 'it("x", () => { while (false) { expect(mainGuardProblems("s")); } });',
        'it.skip': 'it.skip("x", () => { expect(mainGuardProblems("s")); });',
        xit: 'xit("x", () => { expect(mainGuardProblems("s")); });',
        'describe.each([])':
          'describe.each([])("x", () => { it("y", () => { expect(mainGuardProblems("s")); }); });',
        'an aliased runner':
          'const t = it; t.skip("x", () => { expect(mainGuardProblems("s")); });',
        'after return': 'it("x", () => { return; expect(mainGuardProblems("s")); });',
        'a never-called function': 'function f() { expect(mainGuardProblems("s")); }',
        'a .then callback':
          'it("x", () => { Promise.resolve().then(() => expect(mainGuardProblems("s"))); });',
      };
      return Object.entries(dead)
        .filter(([, source]) => assertedNames('f.test.ts', source).has('mainGuardProblems'))
        .map(([what]) => `${what} counted as a witness`);
    },
    expect: 'clean',
  },
  {
    name: 'an assertion in a real test still counts, or the rule is a ban on witnesses',
    run: () =>
      assertedNames(
        'f.test.ts',
        'it("x", () => { expect(mainGuardProblems("scripts")).toEqual([]); });',
      ).has('mainGuardProblems')
        ? []
        : ['an `expect` over a live call was not counted'],
    expect: 'clean',
  },
  {
    // The general form, and the one that closes what dead-code analysis cannot:
    // a check gutted to `return []` has a *perfect* invocation graph.
    name: 'a check with a flawless graph that no longer does anything',
    run: () =>
      checkerGraphProblems({ root: ROOT, registry: [{ ...ENFORCEMENT[0], fn: () => [] }] }),
    expect: /does not satisfy its own contract/,
  },
  {
    // #40 round 7's D3. The row named `mainGuardProblems` and its fixture called
    // `guardProblems`, so gutting the named function left ci-guard at 49 passed.
    // A contract that reaches for the module binding instead of using what it
    // was handed answers the same for a mutant as for the real one.
    name: 'a contract that runs the check and asserts nothing about the answer',
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [
          {
            ...ENFORCEMENT[0],
            contract: (scan) => {
              scan('scripts');
              return [];
            },
          },
        ],
      }),
    expect: /does not reject the mutant/,
  },
  {
    // Found attacking this round's own fix. `(fn) => fn === mainGuardProblems ?
    // [] : ['wrong']` is clean for the implementation and loud for every mutant
    // while asserting nothing about behaviour — it proves the two runs
    // referenced the same thing, not that the thing did anything. So the handing
    // is counted, and a contract that never calls what it was given is refused.
    name: 'a contract that never calls the implementation it was handed',
    run: () =>
      checkerGraphProblems({ root: ROOT, registry: [{ ...ENFORCEMENT[0], contract: () => [] }] }),
    expect: /never called the implementation it was handed/,
  },
  {
    name: 'a row whose only mutant is rejected by throwing rather than by the contract',
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [
          {
            ...ENFORCEMENT[0],
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
      }),
    expect: /rejected by throwing rather than by anything the contract checked/,
  },
  {
    // Found attacking this round's own fix. `definedIn` was checked only for
    // existing, so a row could name a module it does not come from — which is
    // what `sharedModuleProblems` counts and what the witness set excludes.
    name: 'a registry row whose module does not export the check it names',
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [{ ...ENFORCEMENT[0], definedIn: 'scripts/ci/compose.mjs' }],
      }),
    expect: /exports no such name/,
  },
  {
    name: 'a registry row with no contract at all',
    run: () =>
      checkerGraphProblems({ root: ROOT, registry: [{ ...ENFORCEMENT[0], contract: undefined }] }),
    expect: /has no `contract`/,
  },
  {
    name: 'a registry row whose contract nothing could fail',
    run: () => checkerGraphProblems({ root: ROOT, registry: [{ ...ENFORCEMENT[0], mutants: [] }] }),
    expect: /has no mutants declared/,
  },
  // ---- the shared predicate itself (#40 round 7's critical finding) ---------
  // One statement in scripts/ci/main-module.mjs, `if (process.env.GITHUB_JOB ===
  // 'verify') return false;`, killed 176 gate cases and 182 policy mutations in a
  // completely green build. These are its behaviour, from inside scripts/; the
  // outside witness carries the same table plus a real child-process run.
  {
    name: 'isMainModule answers only from its arguments, not from the environment',
    run: () => {
      // A real file, reached by a path rather than by `import.meta` — which
      // this file may not say outside its own guard, by its own rule.
      const entry = at('scripts/ci/main-module.mjs');
      const url = pathToFileURL(entry).href;
      const ask = () => [
        isMainModule(url, ['node', entry]),
        isMainModule(url, ['node', `${entry}x`]),
        isMainModule(url, ['node']),
        isMainModule(url, ['node', '']),
      ];
      const honest = ask();
      const before = { ...process.env };
      Object.assign(process.env, { CI: 'true', GITHUB_JOB: 'verify', GITHUB_ACTIONS: 'true' });
      let poisoned;
      try {
        poisoned = ask();
      } finally {
        for (const key of ['CI', 'GITHUB_JOB', 'GITHUB_ACTIONS']) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
      }
      const problems = [];
      if (honest.join() !== [true, false, false, false].join()) {
        problems.push(`isMainModule got the wrong answers from plain argv: ${honest.join()}`);
      }
      if (honest.join() !== poisoned.join()) {
        problems.push(
          `isMainModule changed its answer under CI's own environment: ${honest.join()} became ${poisoned.join()}`,
        );
      }
      return problems;
    },
    expect: 'clean',
  },
  {
    name: 'every shared module under scripts/ci is described by the registry',
    run: () => sharedModuleProblems(ROOT),
    expect: 'clean',
  },
  {
    name: 'the shared predicate with its registry row removed',
    run: () =>
      sharedModuleProblems(
        process.cwd(),
        undefined,
        undefined,
        ENFORCEMENT.filter((entry) => entry.definedIn !== 'scripts/ci/main-module.mjs'),
      ),
    expect: /main-module\.mjs is imported by \d+ other scripts/,
  },
  {
    // The cheapest way to satisfy checker-graph.mjs without satisfying anything
    // it is about: declare that the check reads nothing, and "an invoker outside
    // the files it reads" is true of every invoker. Found attacking this round's
    // own fix.
    name: 'a registry row that declares no subjects at all',
    run: () =>
      checkerGraphProblems({ root: ROOT, registry: [{ ...ENFORCEMENT[0], subjects: [] }] }),
    expect: /is in the registry with no subjects/,
  },
  {
    name: 'an invoker CI never runs is not a witness',
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [{ ...ENFORCEMENT[0], invokers: ['packages/ci-guard/vitest.config.ts'] }],
      }),
    expect: /nothing in \.github\/workflows runs/,
  },
  {
    name: 'a call site the registry has forgotten',
    run: () =>
      checkerGraphProblems({
        root: ROOT,
        registry: [
          {
            ...ENFORCEMENT[0],
            invokers: ENFORCEMENT[0].invokers.filter(
              (file) => !file.endsWith('workflow-policy-selftest.mjs'),
            ),
          },
        ],
      }),
    expect: /asserts on mainGuardProblems, which the registry/,
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
  return mainGuardProblems(at('scripts'), (path) => {
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

/**
 * The deploy job's own compose environment, read out of `ci.yml`.
 *
 * ── WHY THIS IS A READBACK NOW (#40 round 7) ────────────────────────────────
 * It used to be a hard-coded object with the same three values written out. A
 * blind critic measured what that costs: drop `docker-compose.mailpit.yml` from
 * the job's `env:` and the policy engine was clean — it checked only that
 * `ATRIUM_COMPOSE_FILES` was a non-empty string — *and* every case below was
 * clean, because they were comparing the workflow's file list against a copy of
 * the workflow's file list that no longer came from the workflow. Two halves of
 * one verification stack agreeing with each other about a third thing neither
 * was reading.
 *
 * So the value comes from the file, and `workflow-policy.mjs` now pins what the
 * file may say. A fixture that quotes the thing it is checking is this ticket's
 * oldest defect — it is why `gate-selftest.mjs` satisfied round 5's substring
 * scanner with a string literal — and it does not stop being that defect because
 * the quoted thing is an environment variable.
 */
function composeEnv() {
  const job = parse(readFileSync(WORKFLOW, 'utf8'))?.jobs?.deploy;
  const env = job?.env ?? {};
  for (const name of ['ATRIUM_COMPOSE_PROJECT', 'ATRIUM_COMPOSE_FILES']) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') {
      throw new Error(
        `${WORKFLOW} does not declare \`${name}\` on the deploy job, so these cases have nothing to compare the compose argv against. The policy engine's \`compose-through-one-entrypoint\` rule owns whether that is allowed; this is the readback that keeps this file from inventing a value it should be reading.`,
      );
    }
  }
  return {
    ATRIUM_COMPOSE_PROJECT: env.ATRIUM_COMPOSE_PROJECT.trim(),
    ATRIUM_COMPOSE_FILES: env.ATRIUM_COMPOSE_FILES.trim(),
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
  // ── WHAT RAN, NOT WHAT THE TABLE HOLDS (#40 round 10, D8) ─────────────────
  // The success line printed `CASES.length + scanner` — the size of the table,
  // which is the same number whether or not the loop below ever executed. That
  // is the exact shape this repository fixed in `positive-control.mjs`'s `main`
  // one round earlier ("10 entry point(s) each failed" with no child process
  // spawned), left standing in the file that checks everything else. So the
  // names are collected as they are reached and cross-checked against the table
  // afterwards: whatever silences the loop — an early return, a filter that
  // selects nothing, a `break` — the names are what it has to have produced.
  const ran = [];
  for (const { name, run, expect } of [...CASES, ...scannerCases()]) {
    ran.push(name);
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

  const expected = CASES.length + scannerCases().length;
  if (ran.length !== expected) {
    failures.push(
      `${expected} case(s) are declared and ${ran.length} ran. A case that did not run is not a case that passed, and a self-test that reports its table's size rather than the names it reached is one \`return\` away from announcing a full run it never made — measured on r8 as "10 entry point(s) each failed" with no child process spawned, in the file this one checks.`,
    );
  }
  const duplicated = ran.filter((name, index) => ran.indexOf(name) !== index);
  if (duplicated.length > 0) {
    failures.push(
      `${duplicated.length} case name(s) appear more than once (${[...new Set(duplicated)].join(', ')}). Two cases with one name make the count above satisfiable by a copy, and make a failure impossible to find.`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::Gate self-test: ${failure}`);
    return 1;
  }
  console.info(
    `Gate self-test passed: ${ran.length} cases ran of ${expected} declared, every fail-open shape rejected and every clean report accepted — including ${Object.keys(EVADED_FORMS).length + Object.keys(HELPER_FORMS).length} spellings of \`it.fails\` the source scanner must see, ${Object.keys(NOT_ANNOTATIONS).length} lookalikes it must not, and ${Object.keys(BLIND_SPOTS).length} stated blind spots proved to fail closed through the reporter instead.`,
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
    readme = readFileSync(at('README.md'), 'utf8');
  } catch (error) {
    // ── THE HOLE, NOW SHAPED LIKE A MISSING FILE (#40 round 9, D6) ──────────
    // Round 7 converted this read to `at(…)` so it could not miss the file by
    // standing in the wrong directory, and left the `catch { return []; }`
    // behind it. Measured by a blind critic on r8 as committed: `rm README.md`
    // and this self-test exits **0** announcing "206 cases", with every count
    // claim below — cases, spellings, lookalikes, blind spots, floors, registry
    // rows — unchecked. Round 7's own sentence was "a check that skips what it
    // cannot find is a check with a hole shaped like a working directory"; the
    // sentence generalises past the directory, and the swallow did not.
    return [
      `README.md could not be read (${error.message}), so none of the counts it states about these gates were checked. That file is where four of this ticket's wrong numbers lived, and this readback is the only thing that reads them: a missing README is a failure of this check, not an excuse to skip it.`,
    ];
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
      /**
       * The floors, as a number in prose (#40 round 8, D8).
       *
       * `assert-floor-ratchet.mjs` compares every floor against `origin/main`,
       * and `origin/main` carries no manifest until this work merges — so today
       * the ratchet says "no baseline" loudly, checks only that each floor is a
       * whole number ≥ 1, and exits 0. In that window `packages/ci-guard`'s
       * floor of 115 could be set to 1 and nothing anywhere would object: the
       * suite would still pass, and seventy tests could then be deleted.
       *
       * Nothing in a single commit can *prove* a floor was not lowered — the
       * checker and the checked come out of the same revision, which this
       * repository says out loud at the top of ci.yml. What it can do is make
       * the edit cost two files that have to agree. So the sum of every floor is
       * prose that is read back, exactly like the rule and case counts: lowering
       * one now means editing a sentence that says the floors got smaller. This
       * is a loudness measure, not a proof, and it keeps working after the
       * ratchet activates.
       */
      what: 'the sum of every floor in the CI manifest',
      pattern: phrase('floors totalling (\\d+)'),
      actual: [...floorsOf(manifest())].reduce((total, [, floor]) => total + floor, 0),
    },
    {
      /**
       * And *which* floors they are (#40 round 9).
       *
       * The sum above is one scalar over ten keys, and a blind critic did the
       * arithmetic a scalar invites: `packages/ci-guard` 115 → 95 with
       * `packages/auth` 200 → 220 leaves the total at 1441, the sentence
       * untouched and the gate green — twenty tests deletable from the one
       * workspace that exists to witness `scripts/` from outside. A total is a
       * loudness measure with a null space, and the null space is exactly the
       * trade somebody lowering a floor wants to make.
       *
       * So the identity of every floor is in the sentence too, as a digest over
       * the sorted `key=value` pairs. It is not a proof — the checker and the
       * checked still come out of one revision, which the paragraph beside it
       * says — and it is not readable prose. It is the property the sum was
       * meant to have: *any* edit to *any* floor, in either direction and
       * however compensated, changes a string a human has to retype.
       */
      what: 'the fingerprint of the CI manifest’s floors',
      pattern: phrase('floors fingerprint `([0-9a-f]{12})`'),
      actual: floorFingerprint(manifest()),
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
    // Compared as text, so a claim whose value is a digest rather than a count
    // is compared at all: `Number('4b21…')` is NaN and `NaN !== NaN`, which
    // would have made the fingerprint above fire on every run — or, with the
    // comparison the other way round, never.
    if (found[1] !== String(actual)) {
      failures.push(
        `README.md says ${found[1]} ${what}; the code says ${actual}. The prose is wrong, or the code is.`,
      );
    }
  }
  return failures;
}

/** The CI manifest, read once per claim set. */
function manifest() {
  return JSON.parse(readFileSync(at('.github/ci-manifest.json'), 'utf8'));
}

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}
