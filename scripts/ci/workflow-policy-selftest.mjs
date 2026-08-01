/**
 * Proves the workflow policy rejects what it claims to reject.
 *
 * A policy engine that has only ever been run against a clean file is a policy
 * engine with an unknown pass rate. Each case below mutates the *real* workflow
 * — including `if: ${{ false }}` on `verify`, the exact bypass that failed
 * round 1 of this ticket — and asserts the named rule fires. The unmutated file
 * must come back clean, so the suite also fails if the policy becomes
 * trigger-happy.
 *
 * And every rule the engine declares must have at least one mutation here. That
 * check is the fix for a real round-2 miss: four rules — yaml-parse,
 * no-yaml-anchor, least-privilege, no-stray-condition — had never been mutated,
 * and nothing said so, because coverage was something a human counted. It is
 * now derived from workflow-policy.mjs's own RULES list, so a new rule without
 * a mutation fails this suite on the commit that adds it.
 *
 *   node scripts/ci/workflow-policy-selftest.mjs [workflow.yml]
 */

// The `${{ ... }}` sequences below are GitHub Actions expression syntax inside
// plain strings, not JavaScript template placeholders. Biome cannot tell the two
// apart, and these mutations have to reproduce the workflow text byte for byte.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, quoted verbatim

import { readFileSync } from 'node:fs';
import { checkWorkflowFile, RULES } from './workflow-policy.mjs';

const WORKFLOW = process.argv[2] ?? '.github/workflows/ci.yml';

/** Inserts `lines` immediately after the first line containing `anchor`. */
function insertAfter(source, anchor, lines) {
  const rows = source.split('\n');
  const index = rows.findIndex((row) => row.includes(anchor));
  if (index === -1) throw new Error(`mutation anchor not found: ${anchor}`);
  rows.splice(index + 1, 0, ...lines);
  return rows.join('\n');
}

function replaceOnce(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation target not found: ${from}`);
  return source.replace(from, to);
}

/**
 * The line range of one `- name: …` step, comments above the next step excluded.
 *
 * Prerequisite mutations are about whole steps rather than single lines: the
 * accident being modelled is a rebase dropping a step, or a reorder putting a
 * setup after the thing it sets up, and neither is expressible as a substring
 * edit.
 */
function stepRange(rows, name) {
  const start = rows.findIndex((row) => row.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`mutation step not found: ${name}`);
  const indent = rows[start].slice(0, rows[start].indexOf('-'));
  let end = start + 1;
  while (end < rows.length) {
    const row = rows[end];
    const isNextStep = row.startsWith(`${indent}- `);
    const isComment = row.startsWith(`${indent}#`);
    const isDedent = row.trim() !== '' && !row.startsWith(indent);
    if (isNextStep || isComment || isDedent) break;
    end += 1;
  }
  // Trailing blank lines belong to the gap, not to the step.
  while (end > start + 1 && rows[end - 1].trim() === '') end -= 1;
  return { start, end };
}

/** Removes a whole step from the workflow, the way a bad rebase would. */
function deleteStep(source, name) {
  const rows = source.split('\n');
  const { start, end } = stepRange(rows, name);
  rows.splice(start, end - start);
  return rows.join('\n');
}

/** Moves a whole step to sit immediately after another one, preserving both. */
function moveStepAfter(source, name, anchor) {
  const rows = source.split('\n');
  const { start, end } = stepRange(rows, name);
  const block = rows.splice(start, end - start);
  const target = stepRange(rows, anchor);
  rows.splice(target.end, 0, ...block);
  return rows.join('\n');
}

const MUTATIONS = [
  {
    name: 'a step allowed to fail',
    rule: 'no-continue-on-error',
    mutate: (s) => insertAfter(s, '      - name: Lint', ['        continue-on-error: true']),
  },
  {
    name: 'the round-1 bypass: if: ${{ false }} on the verify job',
    rule: 'no-job-condition',
    mutate: (s) => replaceOnce(s, '  verify:\n', '  verify:\n    if: ${{ false }}\n'),
  },
  {
    name: 'a job condition dressed up as an event check',
    rule: 'no-job-condition',
    mutate: (s) =>
      replaceOnce(s, '  e2e:\n', "  e2e:\n    if: github.event_name != 'pull_request'\n"),
  },
  {
    name: 'a quoted key, which grep reads as a different key',
    rule: 'no-continue-on-error',
    mutate: (s) => insertAfter(s, '      - name: Typecheck', ['        "continue-on-error": true']),
  },
  {
    name: 'a shell override that can drop -e',
    rule: 'no-shell-override',
    mutate: (s) => insertAfter(s, '      - name: Build', ['        shell: bash {0}']),
  },
  {
    name: 'a step-level timeout that can mask a hung suite',
    rule: 'no-step-timeout',
    mutate: (s) =>
      insertAfter(s, '      - name: Unit + integration tests', ['        timeout-minutes: 1']),
  },
  {
    name: 'a condition on a step that is not an artifact upload',
    rule: 'no-step-condition',
    mutate: (s) => insertAfter(s, '      - name: Build', ['        if: success()']),
  },
  {
    name: 'an always() condition smuggled onto a gate step',
    rule: 'no-step-condition',
    mutate: (s) =>
      insertAfter(s, '      - name: Assert the suite actually ran', ['        if: always()']),
  },
  {
    name: 'a swallowed exit code',
    rule: 'no-fail-open-shell',
    mutate: (s) => replaceOnce(s, '        run: pnpm lint\n', '        run: pnpm lint || true\n'),
  },
  {
    name: 'an action unpinned back to a mutable tag',
    rule: 'pin-actions-to-sha',
    mutate: (s) =>
      replaceOnce(
        s,
        'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        'uses: actions/checkout@v7',
      ),
  },
  {
    name: 'a SHA pin with no record of which release it is',
    rule: 'pin-actions-to-sha',
    mutate: (s) =>
      replaceOnce(
        s,
        'uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
        'uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
      ),
  },
  {
    name: 'a new job the gate does not cover',
    rule: 'gate-covers-all-jobs',
    mutate: (s) =>
      `${s}\n  publish:\n    name: publish\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - name: Ship it\n        run: echo shipping\n`,
  },
  {
    name: 'the gate losing always()',
    rule: 'gate-runs-always',
    mutate: (s) =>
      replaceOnce(s, '    needs: [verify, e2e]\n    if: always()\n', '    needs: [verify, e2e]\n'),
  },
  {
    name: 'the gate quietly dropping a job from needs',
    rule: 'gate-covers-all-jobs',
    mutate: (s) => replaceOnce(s, '    needs: [verify, e2e]', '    needs: [verify]'),
  },
  {
    name: 'the gate no longer reading the results it needs',
    rule: 'gate-inspects-needs',
    mutate: (s) => replaceOnce(s, 'NEEDS: ${{ toJSON(needs) }}', 'NEEDS: nothing-to-see-here'),
  },
  {
    name: 'the merge_group trigger removed, so a merge queue never reports',
    rule: 'required-triggers',
    mutate: (s) => replaceOnce(s, '  merge_group:\n', ''),
  },
  {
    name: 'a job with no timeout, which can hang forever without reporting',
    rule: 'job-timeout-required',
    mutate: (s) =>
      replaceOnce(
        s,
        '    runs-on: ubuntu-latest\n    timeout-minutes: 20\n',
        '    runs-on: ubuntu-latest\n',
      ),
  },
  {
    name: 'untrusted PR text interpolated into a shell script',
    rule: 'no-untrusted-interpolation',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: pnpm build\n',
        '        run: echo "${{ github.event.pull_request.title }}" && pnpm build\n',
      ),
  },
  {
    name: 'a YAML alias hiding a construct from a line-oriented reader',
    rule: 'no-yaml-alias',
    mutate: (s) =>
      replaceOnce(
        replaceOnce(s, 'permissions:\n  contents: read', 'permissions: &perms\n  contents: read'),
        '  verify:\n',
        '  verify:\n    permissions: *perms\n',
      ),
  },

  // ---- the four rules round 2 never mutated -------------------------------
  {
    name: 'a workflow that is not valid YAML at all',
    rule: 'yaml-parse',
    mutate: (s) => replaceOnce(s, 'name: CI\n', 'name: [CI\n'),
  },
  {
    name: 'a YAML anchor, whose expansion a human reading the file never sees',
    rule: 'no-yaml-anchor',
    mutate: (s) =>
      replaceOnce(s, 'permissions:\n  contents: read', 'permissions: &perms\n  contents: read'),
  },
  {
    name: 'the workflow handing every job write access it never asked for',
    rule: 'least-privilege',
    mutate: (s) =>
      replaceOnce(s, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
  },
  {
    name: 'a condition somewhere a condition does not belong',
    rule: 'no-stray-condition',
    mutate: (s) =>
      replaceOnce(
        s,
        'permissions:\n  contents: read',
        'if: always()\npermissions:\n  contents: read',
      ),
  },

  // ---- the rules round 3 adds ---------------------------------------------
  {
    name: 'the policy step deleted, so the policy stops objecting to anything',
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: node scripts/ci/workflow-policy.mjs .github/workflows/*.yml\n',
        '',
      ),
  },
  {
    name: "the policy's own self-test deleted, so a policy that stopped firing looks fine",
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(s, '        run: node scripts/ci/workflow-policy-selftest.mjs\n', ''),
  },
  {
    name: 'actionlint quietly dropped',
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(
        s,
        `        run: '"$RUNNER_TEMP/actionlint" -color'\n`,
        '        run: echo skipped\n',
      ),
  },
  {
    name: 'the gate self-test deleted, so a gate that stopped catching things looks fine',
    rule: 'policy-steps-present',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/gate-selftest.mjs\n', ''),
  },
  {
    name: 'the test suite removed from verify, leaving a job that lints and calls it a day',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '          pnpm vitest run\n', '          echo no tests today\n'),
  },
  {
    name: 'the vitest report gate removed while the suite still runs',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/assert-vitest-report.mjs\n', ''),
  },
  {
    name: 'the floor ratchet removed, so lowering a floor becomes free again',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/assert-floor-ratchet.mjs\n', ''),
  },
  {
    name: 'the e2e job hollowed out — the browser gate gone, the job still green',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(s, '        run: node scripts/ci/assert-playwright-report.mjs\n', ''),
  },
  {
    name: 'the whole verify job replaced by a call to a workflow in someone else’s repository',
    rule: 'no-remote-reusable-workflow',
    mutate: (s) =>
      replaceOnce(
        s,
        '  verify:\n    name: lint · typecheck · test · build\n',
        '  verify:\n    uses: some-org/shared-workflows/.github/workflows/verify.yml@main\n    name: lint · typecheck · test · build\n',
      ),
  },
  {
    name: 'secrets handed to a called workflow',
    rule: 'no-remote-reusable-workflow',
    mutate: (s) =>
      replaceOnce(
        s,
        '  gate:\n    name: gate\n',
        '  gate:\n    secrets: inherit\n    name: gate\n',
      ),
  },
  {
    name: 'the gate no longer comparing results against the literal "success"',
    rule: 'gate-inspects-needs',
    mutate: (s) => replaceOnce(s, 'value.result !== "success"', 'value.result !== "anything"'),
  },
  {
    name: 'the gate losing its empty-needs guard, so an emptied gate passes vacuously',
    rule: 'gate-inspects-needs',
    mutate: (s) =>
      replaceOnce(
        s,
        '            if (entries.length === 0) {',
        '            if (entries.length === -1) {',
      ),
  },
  {
    name: 'the gate keeping every incriminating word but losing its exit — round 2 passed this',
    rule: 'gate-inspects-needs',
    mutate: (s) => {
      if (!s.includes('process.exit(1);'))
        throw new Error('mutation target not found: process.exit(1);');
      return s.split('process.exit(1);').join('console.info("would have failed");');
    },
  },

  // ---- the rules round 4 adds ---------------------------------------------
  // Every one of these leaves the assert script in place, named, and running.
  // That is the point: round 3's presence rules all pass on each of them.
  {
    name: "the ratchet's baseline fetch deleted, sending it down its green no-baseline path",
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Fetch the baseline manifest from main'),
  },
  {
    name: 'the baseline fetch moved to after the ratchet that reads it',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Fetch the baseline manifest from main',
        'Assert the CI floors have not been ratcheted down',
      ),
  },
  {
    name: 'the vitest report reset deleted, so freshness can no longer be proven',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Reset the test reports'),
  },
  {
    name: 'the report reset moved to after the run it is supposed to precede',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Reset the test reports', 'Unit + integration tests'),
  },
  {
    name: 'migrations dropped while the schema assertion still runs against the empty database',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Apply migrations'),
  },
  {
    name: 'the wait for Postgres dropped, turning the migration into a race',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Wait for Postgres'),
  },
  {
    name: 'the e2e report reset deleted, so a leftover report can stand in for a run',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Reset the e2e report'),
  },
  {
    name: 'the browser-presence assertion moved to after the suite it guards',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Assert Chromium is present', 'Run e2e suite'),
  },
  {
    name: 'the Chromium install dropped, leaving the assertion guaranteed to fail',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Install Chromium'),
  },
  {
    name: 'an assert script demoted to something a shell merely prints',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'pnpm --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
        'echo node ../../scripts/ci/assert-tables.mjs',
      ),
  },
];

function main() {
  const pristine = readFileSync(WORKFLOW, 'utf8');
  const failures = [];

  const clean = checkWorkflowFile(pristine, WORKFLOW);
  if (clean.length > 0) {
    failures.push(
      `the unmutated ${WORKFLOW} must pass its own policy, but reported: ${clean.map((v) => `[${v.rule}] ${v.message}`).join(' | ')}`,
    );
  }

  // Coverage, derived rather than counted. A rule with no mutation is a rule
  // with an unknown pass rate; a mutation for a rule the engine cannot emit is
  // a test asserting on a typo.
  const exercised = new Set(MUTATIONS.map((mutation) => mutation.rule));
  for (const rule of RULES) {
    if (!exercised.has(rule)) {
      failures.push(
        `rule "${rule}" is declared in workflow-policy.mjs but no mutation here proves it ever fires. Add one, or delete the rule.`,
      );
    }
  }
  for (const rule of exercised) {
    if (!RULES.includes(rule)) {
      failures.push(
        `a mutation asserts on rule "${rule}", which workflow-policy.mjs does not declare. Nothing can ever satisfy it.`,
      );
    }
  }

  for (const { name, rule, mutate } of MUTATIONS) {
    let violations;
    try {
      violations = checkWorkflowFile(mutate(pristine), `${WORKFLOW}#${rule}`);
    } catch (error) {
      failures.push(`mutation "${name}" could not be applied: ${error.message}`);
      continue;
    }
    if (!violations.some((violation) => violation.rule === rule)) {
      failures.push(
        `mutation "${name}" was not caught by rule ${rule}; policy said: ${violations.map((v) => v.rule).join(', ') || '(nothing)'}`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::Workflow policy self-test: ${failure}`);
    return 1;
  }
  console.info(
    `Workflow policy self-test passed: ${MUTATIONS.length} mutations of ${WORKFLOW}, each rejected by the rule it targets; all ${RULES.length} declared rules exercised; the real file clean.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
