/**
 * Reading a machine-readable test report, paranoid about staleness.
 *
 * A report file left behind by an earlier step, an earlier run, or a restored
 * cache is the quietest way for a gate to pass without a suite running: the
 * counts are all there, they are just from last time. So every runner step is
 * preceded by a delete + a recorded start timestamp, and this asserts the file
 * on disk was written after that timestamp.
 */

import { readFileSync, statSync } from 'node:fs';

/** Filesystems and clocks disagree at the millisecond; a second of slack costs nothing. */
const CLOCK_SLACK_MS = 1000;

export function readFreshReport(path, runStartMs, label) {
  const problems = [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return {
      json: undefined,
      problems: [
        `${path} was never written — ${label} did not complete. A missing report is a failed run, not an empty one.`,
      ],
    };
  }

  if (!Number.isFinite(runStartMs)) {
    problems.push(
      `no run-start timestamp was recorded for ${label}, so ${path} cannot be proven fresh. The step that deletes the report must export it.`,
    );
  } else if (stat.mtimeMs + CLOCK_SLACK_MS < runStartMs) {
    const age = Math.round((runStartMs - stat.mtimeMs) / 1000);
    problems.push(
      `${path} is stale: last written ${age}s before ${label} started. This report is from an earlier run and proves nothing about this one.`,
    );
  }

  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(
      `${path} is not readable JSON (${error.message}) — the runner did not finish writing it.`,
    );
  }

  return { json, problems };
}

export function fail(problems, label) {
  for (const problem of problems) console.error(`::error::${label}: ${problem}`);
  console.error(`::error::${label} failed: ${problems.length} problem(s).`);
  return 1;
}
