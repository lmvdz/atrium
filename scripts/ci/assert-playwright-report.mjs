/**
 * The browser gate.
 *
 * Same argument as the Vitest gate, one rung more dangerous: a browser suite
 * that declines to run looks exactly like a browser suite that passed, and the
 * usual reason it declines — no browser installed — is invisible in the exit
 * code. So this walks every test in Playwright's JSON report and refuses:
 *
 *   - a stale report (see report-file.mjs)
 *   - any skipped or fixme test, in CI
 *   - any `test.fail()` — Playwright records these as `expectedStatus: failed`
 *     and then reports the run as `expected`, i.e. green
 *   - any project that ran but is not enrolled, or is enrolled and did not run
 *   - the walked counts disagreeing with the report's own `stats`
 */

import { readFileSync } from 'node:fs';
import { isMainModule } from './main-module.mjs';
import { fail, readFreshReport } from './report-file.mjs';

const REPORT = process.env.PLAYWRIGHT_REPORT ?? 'playwright-report.json';
const MANIFEST = process.env.CI_MANIFEST ?? '.github/ci-manifest.json';
const LABEL = 'E2E gate';

/** Annotations that mean "this test is not expected to prove anything". */
const DISQUALIFYING = new Set(['fail', 'fixme', 'skip']);

function* walkSpecs(suite, file = suite.file) {
  for (const spec of suite.specs ?? []) yield { spec, file: spec.file ?? file };
  for (const child of suite.suites ?? []) yield* walkSpecs(child, child.file ?? file);
}

export function checkPlaywrightReport(report, manifest) {
  const problems = [];
  const enrolled = manifest.playwright?.projects ?? {};
  const minTotal = manifest.playwright?.minTotalTests ?? 1;

  const perProject = new Map();
  let total = 0;
  let counted = 0;

  for (const suite of report.suites ?? []) {
    for (const { spec, file } of walkSpecs(suite)) {
      for (const test of spec.tests ?? []) {
        total += 1;
        const project = test.projectName || '(unnamed)';
        const counts = perProject.get(project) ?? { tests: 0, expected: 0, skipped: 0 };
        counts.tests += 1;
        perProject.set(project, counts);
        const where = `${project} › ${file}:${spec.line ?? '?'} › ${spec.title}`;

        for (const annotation of test.annotations ?? []) {
          if (DISQUALIFYING.has(annotation.type)) {
            problems.push(
              `${where} carries a \`${annotation.type}\` annotation. In CI that is not a courtesy, it is a test that reports success without running.`,
            );
          }
        }
        if (test.expectedStatus !== undefined && test.expectedStatus !== 'passed') {
          problems.push(
            `${where} declares expectedStatus "${test.expectedStatus}". Playwright scores every test against its *expected* status, so anything but "passed" is a test that reports green without proving anything.`,
          );
        }
        if (test.status === 'skipped') {
          problems.push(`${where} was skipped`);
        } else if (test.status === 'unexpected') {
          problems.push(`${where} failed`);
        } else if (test.status === 'expected') {
          counts.expected += 1;
          counted += 1;
        } else if (test.status === 'flaky') {
          counts.expected += 1;
          counted += 1;
          console.warn(`::warning::${where} passed only on retry.`);
        }
      }
    }
  }

  const stats = report.stats ?? {};
  if (stats.unexpected > 0) problems.push(`${stats.unexpected} test(s) failed`);
  if (stats.skipped > 0) {
    problems.push(
      `${stats.skipped} test(s) skipped — in CI a skipped browser test means no browser, not a pass`,
    );
  }
  if (counted !== (stats.expected ?? 0) + (stats.flaky ?? 0)) {
    problems.push(
      `walked ${counted} passing tests but stats claims ${(stats.expected ?? 0) + (stats.flaky ?? 0)}. The report is not internally consistent.`,
    );
  }
  if (total < minTotal) problems.push(`only ${total} tests in the report, floor is ${minTotal}`);
  for (const error of report.errors ?? []) {
    problems.push(`the runner reported a global error: ${error.message ?? JSON.stringify(error)}`);
  }

  for (const [project, entry] of Object.entries(enrolled)) {
    const counts = perProject.get(project);
    if (counts === undefined) {
      problems.push(
        `project "${project}" is enrolled in .github/ci-manifest.json but ran no tests`,
      );
      continue;
    }
    if (counts.expected < Math.max(1, entry.minTests ?? 1)) {
      problems.push(
        `project "${project}" passed ${counts.expected} tests, below its floor of ${entry.minTests}. Either tests were lost, or the floor needs a deliberate edit.`,
      );
    }
  }
  for (const project of perProject.keys()) {
    if (!Object.hasOwn(enrolled, project)) {
      problems.push(`project "${project}" ran but is not enrolled in .github/ci-manifest.json`);
    }
  }

  return { problems, perProject, total };
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const runStart = Number(process.env.E2E_RUN_START);
  const { json, problems: readProblems } = readFreshReport(REPORT, runStart, 'Playwright');
  const problems = [...readProblems];
  let summary = '';

  if (json) {
    const result = checkPlaywrightReport(json, manifest);
    problems.push(...result.problems);
    summary = [...result.perProject]
      .map(([name, counts]) => `${name} ${counts.expected}/${counts.tests}`)
      .join(', ');
  }
  if (problems.length > 0) return fail(problems, LABEL);

  console.info(`${LABEL} passed: ${summary}; 0 skipped, 0 expected failures.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
