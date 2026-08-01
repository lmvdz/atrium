/**
 * Every workspace pnpm resolves must be enrolled in .github/ci-manifest.json.
 *
 * The gap this closes: a new package lands, has no tests, and CI stays green
 * because the global count never moved. Enrollment makes the omission explicit —
 * either the package declares a floor, or it declares in writing why it has no
 * unit tests. Silence is not an option the file admits.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isMainModule } from './main-module.mjs';

const MANIFEST = process.env.CI_MANIFEST ?? '.github/ci-manifest.json';
const WORKSPACE_FILE = process.env.PNPM_WORKSPACE_FILE ?? 'pnpm-workspace.yaml';

/** Expands the subset of glob shapes pnpm-workspace.yaml actually uses here. */
export function resolveWorkspaces(patterns, exists = existsSync, readdir = readdirSync) {
  const found = new Set();
  for (const raw of patterns) {
    const pattern = String(raw).replace(/^\.\//, '');
    if (!pattern.includes('*')) {
      if (exists(join(pattern, 'package.json'))) found.add(pattern);
      continue;
    }
    const [prefix, rest] = pattern.split('*');
    if (rest !== '' || prefix.endsWith('**')) {
      throw new Error(
        `Unsupported workspace glob "${pattern}". Teach scripts/ci/assert-workspace-enrollment.mjs about it rather than letting a package escape enrollment.`,
      );
    }
    const dir = prefix.replace(/\/$/, '');
    if (!exists(dir)) continue;
    for (const entry of readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = `${dir}/${entry.name}`;
      if (exists(join(candidate, 'package.json'))) found.add(candidate);
    }
  }
  return [...found].sort();
}

export function checkEnrollment(workspaces, manifest) {
  const problems = [];
  const enrolled = Object.keys(manifest.vitest?.workspaces ?? {});
  const exempt = Object.keys(manifest.vitest?.exempt ?? {});
  const declared = new Set([...enrolled, ...exempt]);

  for (const workspace of workspaces) {
    if (!declared.has(workspace)) {
      problems.push(
        `${workspace} is a pnpm workspace but is absent from .github/ci-manifest.json. Give it a vitest floor, or an exempt entry saying why it has no unit tests.`,
      );
    }
  }
  for (const workspace of declared) {
    if (!workspaces.includes(workspace)) {
      problems.push(
        `${workspace} is enrolled in .github/ci-manifest.json but is not a pnpm workspace any more.`,
      );
    }
  }
  for (const [workspace, entry] of Object.entries(manifest.vitest?.workspaces ?? {})) {
    if (typeof entry?.project !== 'string' || typeof entry?.minTests !== 'number') {
      problems.push(`${workspace} needs both a \`project\` name and a numeric \`minTests\` floor.`);
    } else if (entry.minTests < 1) {
      problems.push(
        `${workspace} has a floor of ${entry.minTests}; an enrolled workspace must contribute at least 1 test.`,
      );
    }
  }
  for (const [workspace, reason] of Object.entries(manifest.vitest?.exempt ?? {})) {
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      problems.push(`${workspace} is exempt without a real reason written down.`);
    }
  }
  return problems;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const pnpmWorkspace = parse(readFileSync(WORKSPACE_FILE, 'utf8')) ?? {};
  const workspaces = resolveWorkspaces(pnpmWorkspace.packages ?? []);
  const problems = checkEnrollment(workspaces, manifest);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error file=${MANIFEST}::${problem}`);
    return 1;
  }
  console.info(
    `Workspace enrollment: ${workspaces.length} workspaces, all accounted for (${workspaces.join(', ')}).`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
