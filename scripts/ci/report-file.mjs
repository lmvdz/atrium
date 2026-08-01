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

/**
 * A run-start timestamp has to be a *time*, not merely a number (#40 round 6).
 *
 * `Number.isFinite` gated the missing case and nothing else, so `0` passed:
 * `stat.mtimeMs + 1000 < 0` is false for every file that has ever existed, and
 * every report is therefore fresh. Measured on r5 — `run: echo
 * "VITEST_RUN_START=0" >> "$GITHUB_ENV"` is policy-clean and turns the whole
 * stale-report class off, with the `rm -f` step the only thing still standing
 * between a restored cache and a green gate.
 *
 * So the bound is a plausible recency window rather than `> 0`. Anything before
 * this repository existed is a value somebody wrote down; `date +%s` instead of
 * `date +%s%3N` lands in 1970 and is caught by the same test, which is the
 * point — the policy engine requires the value to come from `date`, and this
 * requires it to be a *millisecond* one from roughly now. Neither half can be
 * satisfied by satisfying the other.
 */
/**
 * ── AND WHY A FIXED WINDOW WAS NOT ENOUGH (blind review of r6) ──────────────
 * The first version of this bound was "after 2025-01-01 and not in the future",
 * and a cross-lineage review measured what that still accepts:
 *
 *     run: echo "VITEST_RUN_START=$(date --date=@1748736000 +%s%3N)" >> "$GITHUB_ENV"
 *
 * — policy-clean, because the value does come from `date`, and runtime-clean,
 * because mid-2025 is inside the window. Every report on disk post-dates it, so
 * every report is fresh, which is the same hole `0` opened with a longer
 * spelling. A calendar bound is a *constant*, and a constant is exactly what
 * this is trying to refuse.
 *
 * So the bound is relative: a run this gate is reading the report of started
 * *recently*. A GitHub job cannot exceed six hours; a day is generous and still
 * refuses any timestamp somebody typed and left there, because a literal stops
 * being "within a day" a day after it is written.
 */
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
/** A runner whose clock is an hour ahead of ours is a broken runner, loudly. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;

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
  } else if (
    runStartMs < Date.now() - MAX_RUN_AGE_MS ||
    runStartMs > Date.now() + FUTURE_SLACK_MS
  ) {
    const age = Math.round((Date.now() - runStartMs) / 1000);
    problems.push(
      `the run-start timestamp recorded for ${label} is ${runStartMs}, which is ${age}s from now and therefore not this run's start (expected within ${MAX_RUN_AGE_MS / 1000}s). A constant makes every report fresh: \`0\` makes the comparison \`mtime + ${CLOCK_SLACK_MS} < 0\`, false for every file that has ever existed, and \`$(date --date=@1748736000 +%s%3N)\` does the same thing more slowly. \`date +%s\` instead of \`date +%s%3N\` lands in 1970 and fails here too. ${path} proves nothing about this run — the step must export \`$(date +%s%3N)\`.`,
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
