/**
 * Floors ratchet up. Lowering one is allowed, but never silently.
 *
 * `.github/ci-manifest.json` is the only thing standing between "the suite got
 * smaller" and "the suite is fine". It is also a JSON file any pull request can
 * edit, and the cheapest way to make a failing gate pass is to lower the number
 * it compares against. So every floor is compared against the same file on
 * `origin/main`: raising one is free, holding one is free, and lowering one —
 * or moving an enrolled workspace to `exempt`, which is a floor of zero wearing
 * a different hat — requires a written justification keyed to exactly what was
 * lowered.
 *
 * Justifications are checked in both directions. One that does not correspond
 * to an actual decrease fails too, so a pull request cannot pre-authorise next
 * month's cut by landing a blanket reason today.
 *
 * NO BASELINE. If `origin/main` has no manifest — which is true until the
 * branch introducing this file merges — there is nothing to ratchet against.
 * That case is reported loudly and the run continues with the floors still
 * required to be sane (every enrolled workspace ≥ 1, every total ≥ 1). It
 * becomes a real ratchet the moment a manifest exists on main.
 *
 * Read the baseline with git rather than the network: the workflow fetches
 * `origin/main` to depth 1 in the step before this one.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMainModule } from './main-module.mjs';

const MANIFEST = process.env.CI_MANIFEST ?? '.github/ci-manifest.json';
const BASELINE_REF = process.env.CI_MANIFEST_BASELINE_REF ?? 'origin/main';
/**
 * Where the manifest lives *in git*, which is not necessarily where it is being
 * read from on disk: CI_MANIFEST exists so this can be pointed at a fixture,
 * and a fixture path resolved against a git ref would silently find nothing and
 * report "no baseline" — a fail-open dressed as a configuration option.
 */
const BASELINE_PATH = '.github/ci-manifest.json';
const LABEL = 'Floor ratchet';
/** A justification shorter than this is not a justification. */
const MIN_REASON = 30;

/**
 * Reads `<ref>:<path>` out of git history.
 *
 * @returns {{ present: boolean, json?: unknown, reason?: string }}
 */
export function readBaseline(ref, path, run = spawnSync) {
  const result = run('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
  if (result.error) {
    return { present: false, reason: `git is not runnable here (${result.error.message})` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    return {
      present: false,
      reason: `\`git show ${ref}:${path}\` failed: ${stderr || `exit ${result.status}`}`,
    };
  }
  try {
    return { present: true, json: JSON.parse(result.stdout) };
  } catch (error) {
    return { present: false, reason: `${ref}:${path} is not readable JSON (${error.message})` };
  }
}

/** Every floor in a manifest, flattened to `key -> number`, plus the exempt set. */
export function floorsOf(manifest) {
  const floors = new Map();
  const vitest = manifest?.vitest ?? {};
  for (const [workspace, entry] of Object.entries(vitest.workspaces ?? {})) {
    if (typeof entry?.minTests === 'number') {
      floors.set(`vitest.workspaces.${workspace}.minTests`, entry.minTests);
    }
  }
  if (typeof vitest.minTotalTests === 'number') {
    floors.set('vitest.minTotalTests', vitest.minTotalTests);
  }
  const playwright = manifest?.playwright ?? {};
  for (const [project, entry] of Object.entries(playwright.projects ?? {})) {
    if (typeof entry?.minTests === 'number') {
      floors.set(`playwright.projects.${project}.minTests`, entry.minTests);
    }
  }
  if (typeof playwright.minTotalTests === 'number') {
    floors.set('playwright.minTotalTests', playwright.minTotalTests);
  }
  return floors;
}

/**
 * @param {object} current the manifest in this revision
 * @param {object|undefined} baseline the manifest on the baseline ref, if any
 * @returns {string[]} problems
 */
export function checkRatchet(current, baseline) {
  const problems = [];
  const currentFloors = floorsOf(current);
  const justifications = current?.ratchet?.justifications ?? {};

  // --- floors must be sane regardless of whether a baseline exists ---------
  for (const [key, value] of currentFloors) {
    if (!Number.isInteger(value) || value < 1) {
      problems.push(
        `${key} is ${JSON.stringify(value)}. A floor is a whole number of at least 1 — an enrolled workspace that is allowed to contribute zero tests is not enrolled.`,
      );
    }
  }
  for (const [key, reason] of Object.entries(justifications)) {
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
      problems.push(
        `the ratchet justification for ${key} is not a written reason (needs at least ${MIN_REASON} characters saying why the floor came down).`,
      );
    }
  }

  if (baseline === undefined) {
    // No ratchet to enforce. Any justification present is unattached, and an
    // unattached justification is a pre-authorised future cut.
    for (const key of Object.keys(justifications)) {
      problems.push(
        `there is a ratchet justification for ${key}, but there is no baseline manifest to have lowered anything from. Remove it: a justification is written when the cut is made, not before.`,
      );
    }
    return problems;
  }

  const baselineFloors = floorsOf(baseline);
  const used = new Set();

  for (const [key, was] of baselineFloors) {
    const now = currentFloors.get(key);
    if (now === undefined) {
      // The floor is gone. Legitimate when the workspace itself is gone —
      // assert-workspace-enrollment.mjs proves that separately — but moving an
      // enrolled workspace into `exempt` lands here too, and that is a cut.
      const workspace = key.match(/^vitest\.workspaces\.(.+)\.minTests$/)?.[1];
      const nowExempt =
        workspace !== undefined && current?.vitest?.exempt?.[workspace] !== undefined;
      if (nowExempt) {
        problems.push(
          `${workspace} was enrolled with a floor of ${was} on the baseline and is now merely exempt. An exemption is a floor of zero; ${describeRequirement(key)}`,
        );
        if (justifications[key] !== undefined) used.add(key);
      }
      continue;
    }
    if (now < was) {
      if (justifications[key] === undefined) {
        problems.push(`${key} was lowered from ${was} to ${now}. ${describeRequirement(key)}`);
      } else {
        used.add(key);
      }
    }
  }

  for (const key of Object.keys(justifications)) {
    if (!used.has(key)) {
      problems.push(
        `the ratchet justification for ${key} does not correspond to any floor that actually came down against the baseline. Remove it rather than leaving a standing permission behind.`,
      );
    }
  }

  return problems;
}

function describeRequirement(key) {
  return `Lowering a floor is allowed, but not quietly: add \`ratchet.justifications["${key}"]\` to ${MANIFEST} with at least ${MIN_REASON} characters saying why the suite is smaller.`;
}

function main() {
  const current = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const baseline = readBaseline(BASELINE_REF, BASELINE_PATH);

  if (!baseline.present) {
    console.info(
      `${LABEL}: no baseline manifest at ${BASELINE_REF}:${BASELINE_PATH} (${baseline.reason}). The ratchet is inactive until one exists there — floors are only checked for sanity on this run, and start ratcheting the moment this branch merges.`,
    );
  }

  const problems = checkRatchet(current, baseline.present ? baseline.json : undefined);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error file=${MANIFEST}::${LABEL}: ${problem}`);
    console.error(`::error::${LABEL} failed: ${problems.length} problem(s).`);
    return 1;
  }

  const floors = [...floorsOf(current)].map(([key, value]) => `${key}=${value}`).join(', ');
  console.info(
    baseline.present
      ? `${LABEL} passed: every floor is at or above ${BASELINE_REF} (${floors}).`
      : `${LABEL} passed (no baseline, sanity only): ${floors}.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
