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
 *   node scripts/ci/workflow-policy-selftest.mjs [workflow.yml]
 */

// The `${{ ... }}` sequences below are GitHub Actions expression syntax inside
// plain strings, not JavaScript template placeholders. Biome cannot tell the two
// apart, and these mutations have to reproduce the workflow text byte for byte.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, quoted verbatim

import { readFileSync } from 'node:fs';
import { checkWorkflowFile } from './workflow-policy.mjs';

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
    `Workflow policy self-test passed: ${MUTATIONS.length} mutations of ${WORKFLOW}, each rejected; the real file clean.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
