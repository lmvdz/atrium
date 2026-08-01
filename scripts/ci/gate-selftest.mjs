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
 *   node scripts/ci/gate-selftest.mjs
 */

import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPlaywrightReport } from './assert-playwright-report.mjs';
import { checkVitestReports } from './assert-vitest-report.mjs';
import { checkEnrollment } from './assert-workspace-enrollment.mjs';
import { readFreshReport } from './report-file.mjs';

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

/** A clean pair of vitest reports: 12 core tests, 6 db tests, nothing amiss. */
function vitestReports() {
  const stock = {
    success: true,
    numTotalTests: 18,
    numPassedTests: 18,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 2,
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
    modules: [
      {
        project: 'core',
        workspace: 'packages/core',
        moduleId: 'packages/core/test/a.test.ts',
        tests: 12,
      },
      { project: 'db', workspace: 'packages/db', moduleId: 'packages/db/test/b.test.ts', tests: 6 },
    ],
  };
  return { stock, detailed };
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
];

function main() {
  const failures = [];
  for (const { name, run, expect } of CASES) {
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
  console.info(
    `Gate self-test passed: ${CASES.length} cases, every fail-open shape rejected and every clean report accepted.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
