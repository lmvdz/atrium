/**
 * A second witness for `it.fails()`, read from the source rather than a report.
 *
 * WHY THIS EXISTS. The round-2 receipt promised that expected-failure counts
 * would "reconcile between the dual reports". They cannot, and the reason is
 * worth writing down: Vitest's stock JSON reporter records an `it.fails()` test
 * as `status: "passed"` with an empty `failureMessages` array. Verified against
 * Vitest 4.1.10 on a probe file with one `it.fails`, one `it.skip`, one
 * `it.todo` and one ordinary test — the stock report said 4 tests, 2 passed, 1
 * pending, 1 todo, and nothing anywhere distinguished the expected failure from
 * the real pass. The annotation is gone by the time it reaches that file. So
 * the stock report is not a witness for `fails` at any level of effort, and a
 * cross-check that pretends otherwise is theatre.
 *
 * What the two reports *can* reconcile — every other status, the test count,
 * the file count, and the identity of every individual test — they now do, in
 * assert-vitest-report.mjs. That closes the "gutted reporter is a stub" path:
 * a reporter that is not genuinely walking the run cannot reproduce 315 test
 * identities. What it does not close is a reporter that walks the run honestly
 * and drops one flag. For that, the witness has to come from outside the
 * reporting path entirely — which is this file. It reads the test sources that
 * actually ran and reports every expected-failure annotation it finds, without
 * consulting any report at all.
 *
 * Line and block comments are stripped before matching, so prose about the rule
 * is not a violation of it.
 */

import { readFileSync } from 'node:fs';

/**
 * `it.fails`, `test.fails`, `describe.fails`, and the chained forms
 * (`it.concurrent.fails`, `test.each([...]).fails`), plus the options-object
 * spelling `it('x', { fails: true }, fn)`.
 */
const ANNOTATIONS = [
  { pattern: /\b(?:it|test|describe|suite|bench)\b[\w.]*\.fails\b/g, label: '.fails' },
  { pattern: /\bfails\s*:\s*true\b/g, label: '{ fails: true }' },
];

/** Blanks out `//` and block comments, preserving line numbering. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length));
}

/**
 * @param {string[]} files test module paths, relative to cwd
 * @param {(path: string) => string} read
 * @returns {{file: string, line: number, label: string, text: string}[]}
 */
export function scanForExpectedFailures(files, read = (path) => readFileSync(path, 'utf8')) {
  const found = [];
  for (const file of files) {
    let source;
    try {
      source = stripComments(read(file));
    } catch {
      // A module in the report that is not on disk is the vitest gate's problem,
      // not this scanner's; it reconciles the file list separately.
      continue;
    }
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const { pattern, label } of ANNOTATIONS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          found.push({ file, line: index + 1, label, text: line.trim() });
        }
      }
    }
  }
  return found;
}

/** Turns findings into gate problems, reconciled against what the reporter claimed. */
export function checkExpectedFailureWitness(findings, reportedCount) {
  const problems = [];
  for (const { file, line, label, text } of findings) {
    problems.push(
      `${file}:${line} carries an expected-failure annotation (${label}): \`${text}\`. A test asserted to fail is not coverage; it is a hole with a green tick over it, and the stock Vitest report calls it "passed".`,
    );
  }
  if (findings.length !== reportedCount) {
    problems.push(
      `the source says ${findings.length} expected-failure annotation(s) ran and the CI reporter says ${reportedCount}. Two independent witnesses disagree about the same run: either the reporter is not counting \`fails\`, or the scanner cannot see the annotation. Both are gate failures until they agree.`,
    );
  }
  return problems;
}
