/**
 * A Vitest reporter that writes the facts the CI gate needs and the stock JSON
 * reporter throws away.
 *
 * Two of them specifically:
 *
 *   1. `it.fails()` / `test.fails()`. Vitest's json reporter records such a test
 *      as `status: "passed"` — an expected failure is indistinguishable from a
 *      real pass once it reaches that file. A test that is *asserted to fail* is
 *      not coverage; it is a hole with a green tick over it. This reporter
 *      records `options.fails` per test so the gate can refuse the whole run.
 *   2. Which project each test belongs to. The stock report is a flat list of
 *      absolute file paths, so a workspace that silently stopped contributing
 *      tests hides inside a global count that other workspaces keep above the
 *      floor. This reporter counts per project and per workspace directory.
 *
 * Written to VITEST_CI_REPORT (default `vitest-ci-report.json`). The gate
 * cross-checks this file against the stock json report and fails if the two
 * disagree — so a bug in this file cannot quietly relax the gate.
 *
 * That cross-check is why every module below also records the *identity* of
 * every test it ran, not just how many. Matching totals prove very little: a
 * gutted version of this reporter that emitted the right four numbers and no
 * real data would pass a totals-only comparison. It cannot invent 3,026 test
 * names that agree, file for file, with the ones Vitest's own reporter wrote.
 * The names use Vitest's ` > ` separator; the gate rebuilds the same string
 * from the stock report's `ancestorTitles` + `title`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const OUTPUT = process.env.VITEST_CI_REPORT ?? 'vitest-ci-report.json';
const ROOT = process.cwd();

function emptyCounts() {
  return { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, expectedFailure: 0 };
}

function bucket(map, key) {
  let entry = map.get(key);
  if (entry === undefined) {
    entry = emptyCounts();
    map.set(key, entry);
  }
  return entry;
}

/**
 * `packages/core/test/x.test.ts` -> `packages/core`; root-level enrolled test
 * lanes such as `mutants/inflight.test.ts` -> `mutants`. The latter used to be
 * reported as one workspace per test filename, so the CI gate could not enroll
 * the mutation ledger without lying about its pnpm workspace.
 */
function workspaceOf(moduleId) {
  const rel = relative(ROOT, moduleId).split('\\').join('/');
  const parts = rel.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? rel;
}

export default class CiReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const totals = emptyCounts();
    const projects = new Map();
    const workspaces = new Map();
    const expectedFailures = [];
    const modules = [];

    for (const testModule of testModules) {
      const projectName = testModule.project?.name || '(unnamed)';
      const workspace = workspaceOf(testModule.moduleId);
      const project = bucket(projects, projectName);
      const ws = bucket(workspaces, workspace);
      const testNames = [];
      let moduleTests = 0;

      for (const test of testModule.children.allTests()) {
        testNames.push(test.fullName);
        const state = test.result().state;
        const mode = test.options?.mode;
        const fails = test.options?.fails === true;
        moduleTests += 1;

        for (const counts of [totals, project, ws]) {
          counts.tests += 1;
          if (fails) counts.expectedFailure += 1;
          if (mode === 'todo') counts.todo += 1;
          else if (state === 'skipped') counts.skipped += 1;
          else if (state === 'passed') counts.passed += 1;
          else if (state === 'failed') counts.failed += 1;
        }

        if (fails) {
          expectedFailures.push(
            `${projectName} › ${relative(ROOT, testModule.moduleId)} › ${test.fullName}`,
          );
        }
      }

      modules.push({
        project: projectName,
        workspace,
        moduleId: relative(ROOT, testModule.moduleId),
        state: testModule.state(),
        tests: moduleTests,
        testNames,
      });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      reason,
      unhandledErrors: unhandledErrors.length,
      totals,
      projects: Object.fromEntries([...projects].sort(([a], [b]) => a.localeCompare(b))),
      workspaces: Object.fromEntries([...workspaces].sort(([a], [b]) => a.localeCompare(b))),
      expectedFailures,
      modules,
    };

    const target = resolve(ROOT, OUTPUT);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    console.info(`CI reporter wrote ${OUTPUT} (${totals.tests} tests, ${projects.size} projects).`);
  }
}
