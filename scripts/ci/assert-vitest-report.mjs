/**
 * The unit/integration gate.
 *
 * An exit code of 0 from a test runner answers one question — "did anything
 * throw?" — and none of the questions that matter: did tests run, did *these*
 * tests run, and was any of them told in advance that failing was fine. So this
 * counts, per project, against a checked-in manifest, and refuses:
 *
 *   - a stale report (see report-file.mjs)
 *   - any skipped or todo test (a skipped test is not a passing test)
 *   - any `it.fails()` / `test.fails()` — an expected failure is a hole with a
 *     green tick over it, and the stock JSON reporter records it as "passed"
 *   - a project that vanished, appeared unenrolled, or dropped below its floor
 *   - the two reports disagreeing with each other
 *
 * That last one matters: the per-project data comes from our own reporter
 * (scripts/ci/vitest-ci-reporter.mjs). Cross-checking its totals against
 * Vitest's stock JSON report means a bug in our reporter fails the gate instead
 * of quietly relaxing it.
 */

import { readFileSync } from 'node:fs';
import { fail, readFreshReport } from './report-file.mjs';

const STOCK = process.env.VITEST_REPORT ?? 'vitest-report.json';
const DETAILED = process.env.VITEST_CI_REPORT ?? 'vitest-ci-report.json';
const MANIFEST = process.env.CI_MANIFEST ?? '.github/ci-manifest.json';
const LABEL = 'Vitest gate';

export function checkVitestReports(stock, detailed, manifest) {
  const problems = [];
  const enrolled = manifest.vitest?.workspaces ?? {};
  const minTotal = manifest.vitest?.minTotalTests ?? 1;

  // --- the stock report: the run as Vitest itself saw it -------------------
  if (stock.success !== true) problems.push('the runner did not record success');
  if (stock.numFailedTests > 0) problems.push(`${stock.numFailedTests} test(s) failed`);
  if (stock.numPendingTests > 0) {
    problems.push(
      `${stock.numPendingTests} test(s) skipped — a skipped test is not a passing test`,
    );
  }
  if (stock.numTodoTests > 0) problems.push(`${stock.numTodoTests} test(s) marked todo`);
  if (!(stock.numTotalTests >= minTotal)) {
    problems.push(
      `only ${stock.numTotalTests} tests collected across the workspace, floor is ${minTotal}`,
    );
  }

  // --- the two reports must describe the same run --------------------------
  const totals = detailed.totals ?? {};
  if (totals.tests !== stock.numTotalTests) {
    problems.push(
      `the two reports disagree: stock JSON counted ${stock.numTotalTests} tests, the CI reporter counted ${totals.tests}. One of them is not describing this run.`,
    );
  }
  if (detailed.unhandledErrors > 0)
    problems.push(`${detailed.unhandledErrors} unhandled error(s) escaped the suite`);
  if (detailed.reason !== undefined && detailed.reason !== 'passed') {
    problems.push(`the run ended with reason "${detailed.reason}"`);
  }

  // --- expected failures ---------------------------------------------------
  if (totals.expectedFailure > 0) {
    problems.push(
      `${totals.expectedFailure} test(s) are annotated as expected failures (\`it.fails\`/\`test.fails\`), which the stock report launders into "passed": ${(detailed.expectedFailures ?? []).join('; ')}`,
    );
  }

  // --- per project ---------------------------------------------------------
  const reported = detailed.projects ?? {};
  const expectedProjects = new Map(
    Object.entries(enrolled).map(([ws, entry]) => [entry.project, { ws, ...entry }]),
  );

  for (const [project, entry] of expectedProjects) {
    const counts = reported[project];
    if (counts === undefined) {
      problems.push(
        `project "${project}" (${entry.ws}) contributed no tests at all — it is enrolled in the manifest, so its absence is a failure, not a quiet zero`,
      );
      continue;
    }
    if (counts.tests < 1) problems.push(`project "${project}" ran 0 tests`);
    if (counts.tests < entry.minTests) {
      problems.push(
        `project "${project}" ran ${counts.tests} tests, below its floor of ${entry.minTests}. Either tests were lost, or the floor in .github/ci-manifest.json needs a deliberate edit.`,
      );
    }
    if (counts.skipped > 0) problems.push(`project "${project}" skipped ${counts.skipped} test(s)`);
    if (counts.todo > 0) problems.push(`project "${project}" has ${counts.todo} todo test(s)`);
    if (counts.expectedFailure > 0) {
      problems.push(`project "${project}" has ${counts.expectedFailure} expected-failure test(s)`);
    }
  }

  for (const project of Object.keys(reported)) {
    if (!expectedProjects.has(project)) {
      problems.push(
        `project "${project}" ran but is not enrolled in .github/ci-manifest.json. A project nobody declared is a project nobody has a floor for.`,
      );
    }
  }

  // --- workspace ↔ project pairing -----------------------------------------
  const pairing = new Map();
  for (const module of detailed.modules ?? []) {
    if (!pairing.has(module.workspace)) pairing.set(module.workspace, new Set());
    pairing.get(module.workspace).add(module.project);
  }
  for (const [workspace, entry] of Object.entries(enrolled)) {
    const projects = pairing.get(workspace);
    if (projects === undefined) {
      problems.push(`workspace ${workspace} contributed no test files`);
    } else if (!projects.has(entry.project)) {
      problems.push(
        `workspace ${workspace} is enrolled as project "${entry.project}" but its tests ran under ${[...projects].map((p) => `"${p}"`).join(', ')}. The manifest and vitest.config.ts have drifted.`,
      );
    }
  }

  return problems;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const runStart = Number(process.env.VITEST_RUN_START);
  const stock = readFreshReport(STOCK, runStart, 'the test runner');
  const detailed = readFreshReport(DETAILED, runStart, 'the test runner');
  const problems = [...stock.problems, ...detailed.problems];

  if (stock.json && detailed.json) {
    problems.push(...checkVitestReports(stock.json, detailed.json, manifest));
  }
  if (problems.length > 0) return fail(problems, LABEL);

  const perProject = Object.entries(detailed.json.projects)
    .map(([name, counts]) => `${name} ${counts.tests}`)
    .join(', ');
  console.info(
    `${LABEL} passed: ${stock.json.numPassedTests}/${stock.json.numTotalTests} tests across ${stock.json.numTotalTestSuites} suites (${perProject}); 0 skipped, 0 todo, 0 expected failures.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
