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
 * (scripts/ci/vitest-ci-reporter.mjs). Cross-checking against Vitest's stock
 * JSON report means a bug in our reporter fails the gate instead of quietly
 * relaxing it. Round 2 compared one number — the test total — which a gutted
 * reporter emitting four plausible integers would have satisfied. The
 * comparison now covers every status Vitest reports, the file count, and the
 * identity of every individual test.
 *
 * The one thing the stock report cannot corroborate is `it.fails()`, because it
 * launders it into "passed" (see scripts/ci/scan-expected-failures.mjs for the
 * measurement and for the second witness that closes it).
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fail, readFreshReport } from './report-file.mjs';
import {
  checkExpectedFailureWitness,
  collectTestFiles,
  scanForExpectedFailures,
} from './scan-expected-failures.mjs';

const STOCK = process.env.VITEST_REPORT ?? 'vitest-report.json';
const DETAILED = process.env.VITEST_CI_REPORT ?? 'vitest-ci-report.json';
const MANIFEST = process.env.CI_MANIFEST ?? '.github/ci-manifest.json';
const LABEL = 'Vitest gate';

/**
 * Every test in one report must appear, once, in the other.
 *
 * Both reports name tests; they spell the name differently. The stock report
 * gives `ancestorTitles` and `title` separately, our reporter gives Vitest's
 * own `fullName`, which joins the same parts with ` > `. Rebuilding the stock
 * side that way makes the two directly comparable, keyed by file so that two
 * identically-named tests in different files stay distinct. Counted rather than
 * set-compared, because a parameterised suite legitimately produces repeats.
 */
export function reconcileTestIdentities(stock, detailed, root = process.cwd()) {
  const problems = [];
  const modules = detailed.modules ?? [];
  const missingNames = modules.filter((module) => !Array.isArray(module.testNames));
  if (missingNames.length > 0) {
    problems.push(
      `the CI reporter recorded no test identities for ${missingNames.length} module(s) (e.g. ${missingNames[0].moduleId}). Without them its counts cannot be corroborated, and an uncorroborated count is the thing this gate exists to refuse.`,
    );
    return problems;
  }

  const tally = (entries) => {
    const counts = new Map();
    for (const key of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };

  const mine = tally(
    modules.flatMap((module) =>
      (module.testNames ?? []).map((name) => `${module.moduleId} › ${name}`),
    ),
  );
  const theirs = tally(
    (stock.testResults ?? []).flatMap((file) => {
      const relPath = relative(root, file.name).split('\\').join('/');
      return (file.assertionResults ?? []).map(
        (assertion) =>
          `${relPath} › ${[...(assertion.ancestorTitles ?? []), assertion.title].join(' > ')}`,
      );
    }),
  );

  const differences = [];
  for (const [key, count] of theirs) {
    if ((mine.get(key) ?? 0) !== count) {
      differences.push(`${key} (stock ×${count}, CI reporter ×${mine.get(key) ?? 0})`);
    }
  }
  for (const [key, count] of mine) {
    if (!theirs.has(key)) differences.push(`${key} (CI reporter ×${count}, stock ×0)`);
  }
  if (differences.length > 0) {
    problems.push(
      `${differences.length} test(s) appear in one report and not the other, so the two are not describing the same run: ${differences.slice(0, 5).join('; ')}${differences.length > 5 ? `; …and ${differences.length - 5} more` : ''}`,
    );
  }
  return problems;
}

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
  for (const [label, mine, theirs] of [
    ['tests', totals.tests, stock.numTotalTests],
    ['passing tests', totals.passed, stock.numPassedTests],
    ['failing tests', totals.failed, stock.numFailedTests],
    ['skipped tests', totals.skipped, stock.numPendingTests],
    ['todo tests', totals.todo, stock.numTodoTests],
    ['test files', (detailed.modules ?? []).length, (stock.testResults ?? []).length],
  ]) {
    if (mine !== theirs) {
      problems.push(
        `the two reports disagree on ${label}: stock JSON counted ${theirs}, the CI reporter counted ${mine}. One of them is not describing this run.`,
      );
    }
  }
  problems.push(...reconcileTestIdentities(stock, detailed));
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
  let scan;

  if (stock.json && detailed.json) {
    problems.push(...checkVitestReports(stock.json, detailed.json, manifest));

    // The second, reporter-independent witness for `it.fails()`. It starts from
    // every test file on disk rather than from the modules the reporter chose to
    // name — a witness whose field of view is set by the thing it is checking is
    // not independent of it — and follows relative imports so a helper carrying
    // the annotation is read even though no report will ever mention it.
    const modules = (detailed.json.modules ?? []).map((module) => module.moduleId);
    scan = scanForExpectedFailures([...new Set([...collectTestFiles(), ...modules])]);
    problems.push(...checkExpectedFailureWitness(scan, detailed.json.totals?.expectedFailure ?? 0));
  }
  if (problems.length > 0) return fail(problems, LABEL);

  const perProject = Object.entries(detailed.json.projects)
    .map(([name, counts]) => `${name} ${counts.tests}`)
    .join(', ');
  console.info(
    `${LABEL} passed: ${stock.json.numPassedTests}/${stock.json.numTotalTests} tests across ${stock.json.numTotalTestSuites} suites (${perProject}); 0 skipped, 0 todo, and both reports agree test for test. Expected failures: 0 by the reporter and 0 by an independent parse of ${scan.scanned.length} source file(s).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
