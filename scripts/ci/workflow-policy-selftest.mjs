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
 * ── WHAT A MUTATION HAS TO PROVE (round 5) ──────────────────────────────────
 * Round 4 asserted only that *some* violation carried the target rule id, which
 * three different things satisfy: the violation you meant, a violation about a
 * completely different step of the same rule, and a violation that fires because
 * the mutation broke something else entirely. The round-4 gauntlet found the
 * third kind — two prerequisite mutations that deleted a *required* step, so
 * they went red under `required-job-steps` and would have gone red with
 * `required-step-prerequisites` deleted from the engine. A mutation that passes
 * without its rule is not a test of that rule.
 *
 * So every mutation now declares one of:
 *   - `message`: a regular expression the violation's text must match, which
 *     pins *which instance* fired, not merely which rule;
 *   - `pair`:    for `required-step-prerequisites`, the exact (job, step, needs)
 *     edge, compared against the structured pair the engine attaches to the
 *     violation — identity, not prose.
 * and every mutation is checked for *purity*: the set of rules it trips must be
 * the target rule plus whatever it explicitly declares in `also`, with a written
 * reason. A mutation that fires four rules proves one of them at most.
 *
 * Coverage is derived twice over: once from RULES (every rule has a mutation)
 * and once from PREREQUISITE_PAIRS (every declared pair is named by a mutation).
 *
 *   node scripts/ci/workflow-policy-selftest.mjs [workflow.yml]
 */

// The `${{ ... }}` sequences below are GitHub Actions expression syntax inside
// plain strings, not JavaScript template placeholders. Biome cannot tell the two
// apart, and these mutations have to reproduce the workflow text byte for byte.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, quoted verbatim

import { readFileSync } from 'node:fs';
import { checkWorkflowFile, PREREQUISITE_PAIRS, pairId, RULES } from './workflow-policy.mjs';

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

/**
 * Guts a step's script while leaving every character of it visible: each command
 * becomes an `echo` of itself.
 *
 * This is the mutation nobody wrote, and the round-4 gauntlet's blocking
 * finding. A step whose entire body is
 *
 *     echo 'git fetch --no-tags --depth=1 origin +refs/heads/main:…'
 *
 * satisfies any rule that asks "does this text appear in the job" while doing
 * nothing at all — and for the ratchet's baseline fetch specifically, doing
 * nothing at all is *green*, because the ratchet's no-baseline path exits 0. So
 * the policy passed and the run passed over a fetch that never happened.
 * Deleting a step is the accident this ticket started with; quoting a step is
 * the same accident with a comment on top, and it is the one a substring matcher
 * cannot see. Every prerequisite gets one of these below.
 */
function decoyStep(source, name) {
  const rows = source.split('\n');
  const { start, end } = stepRange(rows, name);
  const runAt = rows.findIndex(
    (row, index) => index >= start && index < end && /^\s*run:/.test(row),
  );
  if (runAt === -1) throw new Error(`mutation step has no run: script: ${name}`);
  const indent = rows[runAt].slice(0, rows[runAt].search(/\S/));
  const inline = rows[runAt].replace(/^\s*run:\s*/, '');
  const script = [];
  // `run: cmd`, `run: 'cmd'` and `run: |` / `run: >-` followed by a block.
  if (inline !== '' && !/^[|>]/.test(inline)) script.push(inline.replace(/^(['"])(.*)\1$/, '$2'));
  for (let index = runAt + 1; index < end; index += 1) script.push(rows[index].trim());

  const quoted = script
    .filter((line) => line !== '')
    .map((line) => `${indent}  echo '${line.split("'").join(`'\\''`)}'`);
  rows.splice(runAt, end - runAt, `${indent}run: |`, ...quoted);
  return rows.join('\n');
}

/** The real baseline fetch, and the ways of writing it this file rewrites it into. */
const FETCH_RUN =
  '        run: git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main\n';
const FETCH = 'git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main';

/** A `run: |` block at the fetch step's indentation. */
function runBlock(lines) {
  return `        run: |\n${lines.map((line) => `          ${line}`).join('\n')}\n`;
}

/** Replaces the baseline fetch step's script, leaving the step itself intact. */
function rewriteFetch(source, lines) {
  return replaceOnce(source, FETCH_RUN, runBlock(lines));
}

/** The two other real lines these fixtures rewrite. */
const LINT_RUN = '        run: pnpm lint\n';
const ENV_LINE = '          echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n';

/** An accepted form: one exact line of the real workflow, and what it becomes. */
const rewritesFetch = (...lines) => [FETCH_RUN, runBlock(lines)];

/**
 * Legitimate ways to write a protected command that the policy must NOT reject.
 *
 * ── THE OTHER HALF OF THE ROUND-5 FINDING ───────────────────────────────────
 * Round 5's matcher recognised a command only at the start of a line, so the
 * fetch forms below all read as "the fetch is missing" — verified directly
 * against the round-5 engine, which reports `required-step-prerequisites` on
 * every one of them. None is exotic and none is an evasion: they are a subshell,
 * a conditional list, a one-shot environment variable, three ordinary launchers,
 * `xargs`, a per-invocation `git -c`, and a line long enough to wrap.
 *
 * A guard that is wrong in both directions is worse than the regex it replaced,
 * because a false red is fixed by deleting the rule. So these are fixtures with
 * the opposite polarity to everything else in this file: the mutated workflow
 * must come back *completely clean*, not merely free of one rule.
 */
const ACCEPTED_FORMS = {
  'the fetch inside a subshell': rewritesFetch(`(${FETCH})`),
  'the fetch after a `&&` list': rewritesFetch(`true && ${FETCH}`),
  'the fetch behind a one-shot environment variable': rewritesFetch(
    `GIT_TERMINAL_PROMPT=0 ${FETCH}`,
  ),
  'the fetch behind sudo': rewritesFetch(`sudo ${FETCH}`),
  'the fetch behind a timeout': rewritesFetch(`timeout 30 ${FETCH}`),
  'the fetch behind `command`, which bypasses functions and aliases': rewritesFetch(
    `command ${FETCH}`,
  ),
  'the fetch driven by xargs': rewritesFetch(`echo main | xargs -I{} ${FETCH}`),
  'the fetch with a per-invocation git config': rewritesFetch(
    `git -c protocol.version=2 fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main`,
  ),
  'the fetch wrapped over a backslash continuation': rewritesFetch(
    'git fetch --no-tags \\',
    '  --depth=1 origin +refs/heads/main:refs/remotes/origin/main',
  ),
  'the fetch as the body of a shell function that is then called': rewritesFetch(
    'fetch_baseline() {',
    `  ${FETCH}`,
    '}',
    'fetch_baseline',
  ),
  // The tightened $GITHUB_ENV matcher, from the accepting side. Its rejecting
  // side is two mutations below: `$GITHUB_ENV.bak` and `'$GITHUB_ENV'`.
  'the run-start timestamp with braces round the variable': [
    ENV_LINE,
    '          echo "VITEST_RUN_START=$(date +%s%3N)" >> "${GITHUB_ENV}"\n',
  ],
  'the run-start timestamp written with printf': [
    ENV_LINE,
    `          printf 'VITEST_RUN_START=%s\\n' "$(date +%s%3N)" >> "$GITHUB_ENV"\n`,
  ],
  'the run-start timestamp with the variable unquoted': [
    ENV_LINE,
    '          echo "VITEST_RUN_START=$(date +%s%3N)" >> $GITHUB_ENV\n',
  ],
  // A package.json script is still one behind a launcher: `sudo` is not what
  // makes `pnpm lint` a lint, so the rule asks what was unwrapped, not argv[0].
  'the linter behind a launcher': [LINT_RUN, '        run: timeout 300 pnpm lint\n'],
};

/**
 * Ways of writing something that *contains* the fetch without running it.
 *
 * Every one of these must break the ratchet's pair and nothing else. The first
 * is the round-5 gauntlet's blocking finding applied to a prerequisite: the
 * round-5 matcher allowed arbitrary text between a package manager and a later
 * `exec`, so `echo exec` in the middle satisfied it. Verified against the
 * round-5 engine: clean, on every one of these except the `echo` decoy it
 * already caught.
 */
const REJECTED_FORMS = {
  'the fetch behind a fake `exec`, the round-5 bypass': [`pnpm --version && echo exec ${FETCH}`],
  'the fetch backgrounded, so nothing waits for it': [`${FETCH} &`],
  'the fetch backgrounded inside a subshell': [`(${FETCH}) &`],
  'the fetch quoted into an echo': [`echo '${FETCH}'`],
  'the fetch in a here-document, which is data and not script': [
    "cat <<'EOF' > /dev/null",
    FETCH,
    'EOF',
  ],
  'the fetch commented out': ['true', `# ${FETCH}`],
  'a word between the package manager and its exec': [`pnpm install exec ${FETCH}`],
  'the fetch looked up rather than run': [`command -v ${FETCH}`],
};

/**
 * The nine declared (step → prerequisite) edges, by hand here and cross-checked
 * against `PREREQUISITE_PAIRS` in `main()`. Naming them makes a prerequisite
 * mutation assert *which* pair it broke rather than that some pair broke.
 */
const PAIRS = {
  ratchetNeedsFetch: {
    job: 'verify',
    step: 'the floor-ratchet assertion',
    needs: 'the fetch of the baseline manifest from main',
  },
  migrationsNeedPostgres: {
    job: 'verify',
    step: 'the migrations',
    needs: 'the wait for Postgres',
  },
  schemaNeedsMigrations: {
    job: 'verify',
    step: 'the schema set-equality assertion',
    needs: 'the migrations',
  },
  suiteNeedsReset: {
    job: 'verify',
    step: 'the unit/integration suite',
    needs: 'the step that deletes the vitest reports and records VITEST_RUN_START',
  },
  vitestGateNeedsSuite: {
    job: 'verify',
    step: 'the vitest report gate',
    needs: 'the unit/integration suite',
  },
  chromiumNeedsInstall: {
    job: 'e2e',
    step: 'the browser-presence assertion',
    needs: 'the Chromium install',
  },
  e2eSuiteNeedsReset: {
    job: 'e2e',
    step: 'the Playwright suite',
    needs: 'the step that deletes the e2e report and records E2E_RUN_START',
  },
  e2eSuiteNeedsChromium: {
    job: 'e2e',
    step: 'the Playwright suite',
    needs: 'the browser-presence assertion',
  },
  e2eGateNeedsSuite: {
    job: 'e2e',
    step: 'the e2e report gate',
    needs: 'the Playwright suite',
  },
};

/** Where a violation says it is: `jobs.<job>.steps.<n>.<key>`. */
function stepPath(job, key) {
  return new RegExp(String.raw`jobs\.${job}\.steps\.\d+\.${key}\b`);
}

const MUTATIONS = [
  {
    name: 'a step allowed to fail',
    rule: 'no-continue-on-error',
    mutate: (s) => insertAfter(s, '      - name: Lint', ['        continue-on-error: true']),
    message: stepPath('verify', 'continue-on-error'),
  },
  {
    name: 'the round-1 bypass: if: ${{ false }} on the verify job',
    rule: 'no-job-condition',
    mutate: (s) => replaceOnce(s, '  verify:\n', '  verify:\n    if: ${{ false }}\n'),
    message: /`if: \$\{\{ false \}\}` on job `verify`/,
  },
  {
    name: 'a job condition dressed up as an event check',
    rule: 'no-job-condition',
    mutate: (s) =>
      replaceOnce(s, '  e2e:\n', "  e2e:\n    if: github.event_name != 'pull_request'\n"),
    message: /on job `e2e`/,
  },
  {
    name: 'a quoted key, which grep reads as a different key',
    rule: 'no-continue-on-error',
    mutate: (s) => insertAfter(s, '      - name: Typecheck', ['        "continue-on-error": true']),
    message: stepPath('verify', 'continue-on-error'),
  },
  {
    name: 'a shell override that can drop -e',
    rule: 'no-shell-override',
    mutate: (s) => insertAfter(s, '      - name: Build', ['        shell: bash {0}']),
    message: /`shell: bash \{0\}`/,
  },
  {
    name: 'a step-level timeout that can mask a hung suite',
    rule: 'no-step-timeout',
    mutate: (s) =>
      insertAfter(s, '      - name: Unit + integration tests', ['        timeout-minutes: 1']),
    message: stepPath('verify', 'timeout-minutes'),
  },
  {
    name: 'a condition on a step that is not an artifact upload',
    rule: 'no-step-condition',
    mutate: (s) => insertAfter(s, '      - name: Build', ['        if: success()']),
    message: /`if: success\(\)` at jobs\.verify\.steps\.\d+\.if/,
  },
  {
    name: 'an always() condition smuggled onto a gate step',
    rule: 'no-step-condition',
    mutate: (s) =>
      insertAfter(s, '      - name: Assert the suite actually ran', ['        if: always()']),
    message: /`if: always\(\)` at jobs\.verify\.steps\.\d+\.if/,
  },
  {
    name: 'a swallowed exit code',
    rule: 'no-fail-open-shell',
    mutate: (s) => replaceOnce(s, '        run: pnpm lint\n', '        run: pnpm lint || true\n'),
    message: /`\|\| true` in the script at jobs\.verify\.steps\.\d+\.run/,
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
    message: /`uses: actions\/checkout@v7` is not pinned to a 40-character commit SHA/,
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
    message: /`uses: actions\/cache@[0-9a-f]{40}` needs a trailing `# vN\.N\.N` comment/,
  },
  {
    name: 'a new job the gate does not cover',
    rule: 'gate-covers-all-jobs',
    mutate: (s) =>
      `${s}\n  publish:\n    name: publish\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - name: Ship it\n        run: echo shipping\n`,
    message: /job\(s\) `publish` are not in `gate\.needs`/,
  },
  {
    name: 'the gate losing always()',
    rule: 'gate-runs-always',
    mutate: (s) =>
      replaceOnce(s, '    needs: [verify, e2e]\n    if: always()\n', '    needs: [verify, e2e]\n'),
    message: /`gate` must declare `if: always\(\)`/,
  },
  {
    name: 'the gate quietly dropping a job from needs',
    rule: 'gate-covers-all-jobs',
    mutate: (s) => replaceOnce(s, '    needs: [verify, e2e]', '    needs: [verify]'),
    message: /job\(s\) `e2e` are not in `gate\.needs`/,
  },
  {
    name: 'the gate no longer reading the results it needs',
    rule: 'gate-inspects-needs',
    mutate: (s) => replaceOnce(s, 'NEEDS: ${{ toJSON(needs) }}', 'NEEDS: nothing-to-see-here'),
    message: /no step in `gate` binds `\$\{\{ toJSON\(needs\) \}\}`/,
  },
  {
    name: 'the merge_group trigger removed, so a merge queue never reports',
    rule: 'required-triggers',
    mutate: (s) => replaceOnce(s, '  merge_group:\n', ''),
    message: /missing the `merge_group` trigger/,
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
    message: /job `verify` has no `timeout-minutes`/,
  },
  {
    name: 'untrusted PR text interpolated into a shell script',
    rule: 'no-untrusted-interpolation',
    // On its own line rather than `echo … && pnpm build`, so the build is still
    // in command position and this mutation tests one rule. See COMMAND_POSITION
    // in workflow-policy.mjs: a command is recognised at the start of a line and
    // nowhere else, which is what makes `echo 'git fetch …'` inert to the engine.
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: pnpm build\n',
        '        run: |\n          echo "${{ github.event.pull_request.title }}"\n          pnpm build\n',
      ),
    message: /attacker-controllable `github\.event` context interpolated/,
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
    message: /YAML alias \*perms/,
    // An alias cannot exist without the anchor it points at; writing one
    // necessarily writes the other. The anchor rule has its own mutation below.
    also: ['no-yaml-anchor'],
  },

  // ---- the four rules round 2 never mutated -------------------------------
  {
    name: 'a workflow that is not valid YAML at all',
    rule: 'yaml-parse',
    mutate: (s) => replaceOnce(s, 'name: CI\n', 'name: [CI\n'),
    message: /is not valid YAML/,
  },
  {
    name: 'a YAML anchor, whose expansion a human reading the file never sees',
    rule: 'no-yaml-anchor',
    mutate: (s) =>
      replaceOnce(s, 'permissions:\n  contents: read', 'permissions: &perms\n  contents: read'),
    message: /YAML anchor &perms/,
  },
  {
    name: 'the workflow handing every job write access it never asked for',
    rule: 'least-privilege',
    mutate: (s) =>
      replaceOnce(s, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
    message: /workflow-level `permissions:` must declare `contents: read`/,
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
    message: /`if: always\(\)` at if, which is not a place a condition belongs/,
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
    message: /never runs the workflow policy engine/,
  },
  {
    name: "the policy's own self-test deleted, so a policy that stopped firing looks fine",
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(s, '        run: node scripts/ci/workflow-policy-selftest.mjs\n', ''),
    message: /never runs the policy engine's own self-test/,
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
    message: /never runs actionlint/,
  },
  {
    name: 'actionlint downloaded and never run — the shape this rule is looking for',
    rule: 'policy-steps-present',
    mutate: (s) => decoyStep(s, 'Lint workflows with actionlint'),
    message: /never runs actionlint/,
  },
  {
    name: 'the gate self-test deleted, so a gate that stopped catching things looks fine',
    rule: 'policy-steps-present',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/gate-selftest.mjs\n', ''),
    message: /never runs the test gates' self-test/,
  },
  {
    name: 'the test suite removed from verify, leaving a job that lints and calls it a day',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '          pnpm vitest run\n', '          echo no tests today\n'),
    message: /never runs the unit\/integration suite/,
    // Deleting the run also orphans the gate that reads its report: the report
    // gate is still there, and now nothing produced the report it asserts on.
    also: ['required-step-prerequisites'],
  },
  {
    name: 'the vitest report gate removed while the suite still runs',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/assert-vitest-report.mjs\n', ''),
    message: /never runs the vitest report gate/,
  },
  {
    name: 'the floor ratchet removed, so lowering a floor becomes free again',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/assert-floor-ratchet.mjs\n', ''),
    message: /never runs the floor-ratchet assertion/,
  },
  {
    name: 'the e2e job hollowed out — the browser gate gone, the job still green',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(s, '        run: node scripts/ci/assert-playwright-report.mjs\n', ''),
    message: /never runs the e2e report gate/,
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
    message: /job `verify` delegates to the reusable workflow/,
    // A reusable-workflow call *is* a `uses:` line, and `…/verify.yml@main` is a
    // mutable ref by construction. There is no way to write this mutation
    // without also being unpinned; the two rules are looking at the same line.
    also: ['pin-actions-to-sha'],
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
    message: /job `gate` passes `secrets:` to a called workflow/,
  },
  {
    name: 'the gate no longer comparing results against the literal "success"',
    rule: 'gate-inspects-needs',
    mutate: (s) => replaceOnce(s, 'value.result !== "success"', 'value.result !== "anything"'),
    message: /never compares a result against the literal `success`/,
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
    message: /does not fail on an empty `needs`/,
  },
  {
    name: 'the gate keeping every incriminating word but losing its exit — round 2 passed this',
    rule: 'gate-inspects-needs',
    mutate: (s) => {
      if (!s.includes('process.exit(1);'))
        throw new Error('mutation target not found: process.exit(1);');
      return s.split('process.exit(1);').join('console.info("would have failed");');
    },
    message: /never exits non-zero/,
  },

  // ---- the rules round 4 adds ---------------------------------------------
  // Every one of these leaves the assert script in place, named, and running.
  // That is the point: round 3's presence rules all pass on each of them.
  {
    name: "the ratchet's baseline fetch deleted, sending it down its green no-baseline path",
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Fetch the baseline manifest from main'),
    pair: PAIRS.ratchetNeedsFetch,
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
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'the vitest report reset deleted, so freshness can no longer be proven',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Reset the test reports'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the report reset moved to after the run it is supposed to precede',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Reset the test reports', 'Unit + integration tests'),
    pair: PAIRS.suiteNeedsReset,
  },
  // Round 4 modelled these two as deletions. Both deleted a step that is *also*
  // required in its own right, so both went red under `required-job-steps` and
  // would have gone red with the prerequisite rule removed from the engine
  // entirely — theatre, in the exact sense this file exists to prevent. A
  // reorder is the pure form: the step is still present and still invoked, and
  // only the ordering half of the pair is broken.
  {
    name: 'the wait for Postgres reordered after the migration it protects, turning it into a race',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Wait for Postgres', 'Apply migrations'),
    pair: PAIRS.migrationsNeedPostgres,
  },
  {
    name: 'the migrations reordered after the schema assertion that checks them',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(s, 'Apply migrations', 'Assert the database matches the schema exactly'),
    pair: PAIRS.schemaNeedsMigrations,
  },
  // The two pairs round 4 declared and never mutated in isolation: a report gate
  // that runs before the run it reports on. Modelled as a reorder for the same
  // reason — the gate is still present, still named, still invoked.
  {
    name: 'the vitest report gate reordered before the suite, so it reads the previous run',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Assert the suite actually ran', 'Reset the test reports'),
    pair: PAIRS.vitestGateNeedsSuite,
  },
  {
    name: 'the e2e report gate reordered before the suite it reports on',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Assert the e2e suite actually ran', 'Reset the e2e report'),
    pair: PAIRS.e2eGateNeedsSuite,
  },
  {
    name: 'the e2e report reset deleted, so a leftover report can stand in for a run',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Reset the e2e report'),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    name: 'the e2e report reset moved to after the suite it is supposed to precede',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Reset the e2e report', 'Run e2e suite'),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    name: 'the browser-presence assertion moved to after the suite it guards',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Assert Chromium is present', 'Run e2e suite'),
    pair: PAIRS.e2eSuiteNeedsChromium,
  },
  {
    name: 'the Chromium install dropped, leaving the assertion guaranteed to fail',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Install Chromium'),
    pair: PAIRS.chromiumNeedsInstall,
  },
  {
    name: 'the Chromium install reordered after the assertion that checks it worked',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Install Chromium', 'Assert Chromium is present'),
    pair: PAIRS.chromiumNeedsInstall,
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
    message: /never runs the schema set-equality assertion/,
  },

  // ---- the mutation round 4 did not write ---------------------------------
  // Gutted-but-matching setup: the step is present, named, and every character
  // of its script is still in the file — inside an `echo`. Round 4's
  // prerequisite tests were substring matches, so all six of these passed the
  // policy while doing nothing, and the ratchet one passed the *run* too,
  // because a fetch that never happens sends the ratchet down its no-baseline
  // exit-0 path. Policy green and runtime green over a deleted gate is the
  // fail-open the rule was written to close.
  {
    name: 'the baseline fetch quoted into an echo: present, matching, and doing nothing',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Fetch the baseline manifest from main'),
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'the vitest report reset quoted into an echo, so VITEST_RUN_START is never exported',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Reset the test reports'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the e2e report reset quoted into an echo, so E2E_RUN_START is never exported',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Reset the e2e report'),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    name: 'the Chromium install quoted into an echo, so no browser is ever downloaded',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Install Chromium'),
    pair: PAIRS.chromiumNeedsInstall,
  },
  {
    name: 'the wait for Postgres quoted into an echo, so the migration races an empty socket',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Wait for Postgres'),
    pair: PAIRS.migrationsNeedPostgres,
    // The wait is a required step in its own right as well as a prerequisite, so
    // an inert one is caught twice. Both are the same edit; neither is theatre.
    also: ['required-job-steps'],
  },
  {
    name: 'the migration quoted into an echo, so the schema assertion checks an empty database',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Apply migrations'),
    pair: PAIRS.schemaNeedsMigrations,
    also: ['required-job-steps'],
  },
  {
    name: 'the browser-presence assertion quoted into an echo before the suite it guards',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Assert Chromium is present'),
    pair: PAIRS.e2eSuiteNeedsChromium,
    also: ['required-job-steps'],
  },

  // ---- the round-5 gauntlet's four, round 6 ------------------------------
  // The first one is this round's acceptance case, and it is deliberately the
  // *required step* rather than a prerequisite: round 5's matcher allowed
  // arbitrary text between a package manager and a later `exec`, so nine words
  // turned every protected step in this file into a mention of itself. Verified
  // against the round-5 engine directly: clean.
  {
    name: 'the ratchet rewritten as a fake `exec` — the round-5 blocking bypass',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: node scripts/ci/assert-floor-ratchet.mjs\n',
        '        run: pnpm --version && echo exec node scripts/ci/assert-floor-ratchet.mjs\n',
      ),
    message: /never runs the floor-ratchet assertion/,
  },
  {
    name: 'a shell function shadowing `git`, so the fetch runs and does nothing',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, ['git() { :; }', FETCH]),
    message: /defines a shell function `git\(\)`/,
  },
  {
    name: 'a directory prepended to PATH, which decides what every command word means',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, ['export PATH="$PWD/.fake-bin:$PATH"', FETCH]),
    message: /runs `export PATH=…`/,
  },
  {
    name: 'the same shadowing spelled as a write to $GITHUB_PATH, which outlives the step',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, ['echo "$PWD/.fake-bin" >> "$GITHUB_PATH"', FETCH]),
    message: /writes to `\$GITHUB_PATH`/,
  },
  {
    name: 'the run-start timestamp appended to a lookalike file instead of the job environment',
    rule: 'required-step-prerequisites',
    mutate: (s) => replaceOnce(s, '>> "$GITHUB_ENV"', '>> "$GITHUB_ENV.bak"'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the same, single-quoted, so it writes a file literally called $GITHUB_ENV',
    rule: 'required-step-prerequisites',
    mutate: (s) => replaceOnce(s, '>> "$GITHUB_ENV"', ">> '$GITHUB_ENV'"),
    pair: PAIRS.suiteNeedsReset,
  },

  // Every entry in REJECTED_FORMS, as a mutation of the baseline fetch step.
  // The step stays present and named; only the shape of what it runs changes.
  ...Object.entries(REJECTED_FORMS).map(([name, lines]) => ({
    name: `a fetch step that only contains a fetch: ${name}`,
    rule: 'required-step-prerequisites',
    mutate: (s) => rewriteFetch(s, lines),
    pair: PAIRS.ratchetNeedsFetch,
  })),
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

  // The same discipline for the prerequisite table: a declared pair that no
  // mutation ever breaks is a pair nobody has proved the engine enforces. Round
  // 4 declared nine and mutated seven of them.
  const declared = new Set(PREREQUISITE_PAIRS.map(pairId));
  const targeted = new Set(MUTATIONS.filter((m) => m.pair).map((m) => pairId(m.pair)));
  for (const id of declared) {
    if (!targeted.has(id)) {
      failures.push(
        `the prerequisite pair "${id}" is declared in workflow-policy.mjs but no mutation here breaks it. Add one, or stop declaring the pair.`,
      );
    }
  }
  for (const id of targeted) {
    if (!declared.has(id)) {
      failures.push(
        `a mutation claims to break the pair "${id}", which workflow-policy.mjs does not declare. Nothing can ever satisfy it.`,
      );
    }
  }

  for (const mutation of MUTATIONS) {
    const { name, rule, mutate, message, pair, also = [] } = mutation;
    if ((message === undefined) === (pair === undefined)) {
      failures.push(
        `mutation "${name}" must declare exactly one of \`message\` (a regexp the violation text must match) or \`pair\` (the step→prerequisite edge it breaks). Asserting only on the rule id is what round 4 did, and it let two mutations pass for the wrong reason.`,
      );
      continue;
    }
    let violations;
    try {
      violations = checkWorkflowFile(mutate(pristine), `${WORKFLOW}#${rule}`);
    } catch (error) {
      failures.push(`mutation "${name}" could not be applied: ${error.message}`);
      continue;
    }
    const said = violations.map((v) => `[${v.rule}] ${v.message}`).join(' | ') || '(nothing)';

    // 1. The right rule fired, about the right thing.
    const matched = violations.filter((violation) => {
      if (violation.rule !== rule) return false;
      if (pair !== undefined) return violation.pair && pairId(violation.pair) === pairId(pair);
      return message.test(violation.message);
    });
    if (matched.length === 0) {
      const wanted =
        pair === undefined ? `matching ${message}` : `about the pair "${pairId(pair)}"`;
      failures.push(
        `mutation "${name}" produced no ${rule} violation ${wanted}; policy said: ${said}`,
      );
    } else if (pair !== undefined && !matched.some((v) => v.message.includes(pair.needs))) {
      // The structured pair and the human-readable message must agree, or the
      // log a person reads and the identity a test asserts on can drift apart.
      failures.push(
        `mutation "${name}" fired for the right pair but its message never names ${pair.needs}: ${said}`,
      );
    }

    // 2. And nothing else fired, unless the mutation says why it should. Two of
    //    round 4's prerequisite mutations also tripped `required-job-steps`, so
    //    they would have gone red with the prerequisite rule deleted outright.
    const allowed = new Set([rule, ...also]);
    const collateral = [...new Set(violations.map((v) => v.rule))].filter((r) => !allowed.has(r));
    if (collateral.length > 0) {
      failures.push(
        `mutation "${name}" targets ${rule} but also tripped ${collateral.join(', ')}, so it would go red with ${rule} removed from the engine. Make the mutation surgical, or declare the collateral in \`also\` with a reason.`,
      );
    }
  }

  // 3. And the other polarity. A recognition rule is a claim about two sets, and
  //    round 5 got the second one wrong: every form below is a legitimate way to
  //    write the baseline fetch, and its line-start matcher called all of them
  //    missing. These must leave the workflow *entirely* clean — not "clean of
  //    the rule we were thinking about", because a false red anywhere in this
  //    file is a reason to delete a rule.
  for (const [name, [target, replacement]] of Object.entries(ACCEPTED_FORMS)) {
    let violations;
    try {
      violations = checkWorkflowFile(
        replaceOnce(pristine, target, replacement),
        `${WORKFLOW}#accepted`,
      );
    } catch (error) {
      failures.push(`accepted form "${name}" could not be applied: ${error.message}`);
      continue;
    }
    if (violations.length > 0) {
      failures.push(
        `the legitimate form "${name}" was rejected: ${violations.map((v) => `[${v.rule}] ${v.message}`).join(' | ')}. A guard that is wrong in this direction is worse than the one it replaced — a false red is fixed by deleting the rule.`,
      );
    }
  }

  failures.push(...checkReadmeClaims());

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::Workflow policy self-test: ${failure}`);
    return 1;
  }
  console.info(
    `Workflow policy self-test passed: ${MUTATIONS.length} mutations of ${WORKFLOW}, each rejected by the rule it targets and by nothing else undeclared; all ${RULES.length} declared rules exercised, and all ${PREREQUISITE_PAIRS.length} declared step→prerequisite pairs broken by name; ${Object.keys(ACCEPTED_FORMS).length} legitimate rewrites of real steps accepted; the real file clean.`,
  );
  return 0;
}

/**
 * The README's numbers must be this file's numbers.
 *
 * Twice in this ticket a receipt has quoted a count a human worked out: round 2
 * said "15 rules" over an engine carrying 18, and round 4's first draft said
 * "five pairs" over a table holding nine. Both were fixed by deriving the number
 * at the point it is printed — which does nothing for the copy of it sitting in
 * prose. So the prose is checked too: these are the only numbers in README.md
 * that describe this engine, and they are read back and compared.
 */
function checkReadmeClaims() {
  let readme;
  try {
    readme = readFileSync('README.md', 'utf8');
  } catch {
    return []; // Run from somewhere else; the CI job runs from the repo root.
  }
  // Whitespace-tolerant: the README is hard-wrapped, so any of these phrases can
  // acquire a newline in the middle without changing what it claims.
  const phrase = (words) => new RegExp(words.split(' ').join(String.raw`\s+`));
  const claims = [
    { what: 'house rules', pattern: phrase('enforces (\\d+) house rules'), actual: RULES.length },
    {
      what: 'declared rules with a mutation',
      pattern: phrase('every one of the (\\d+) declared rules has a mutation'),
      actual: RULES.length,
    },
    {
      what: 'workflow mutations',
      pattern: phrase('feeds the policy (\\d+) mutated copies'),
      actual: MUTATIONS.length,
    },
    {
      what: 'step→prerequisite pairs',
      pattern: phrase('(\\d+) pairs across \\d+ steps'),
      actual: PREREQUISITE_PAIRS.length,
    },
    {
      what: 'legitimate rewrites that must stay clean',
      pattern: phrase('(\\d+) legitimate rewrites'),
      actual: Object.keys(ACCEPTED_FORMS).length,
    },
  ];
  const failures = [];
  for (const { what, pattern, actual } of claims) {
    const found = pattern.exec(readme);
    if (found === null) {
      failures.push(
        `README.md no longer states the number of ${what} in a form this check can read (${pattern}). Restore the sentence or update the pattern — an unchecked number in prose is how this ticket got two counts wrong.`,
      );
      continue;
    }
    if (Number(found[1]) !== actual) {
      failures.push(
        `README.md says ${found[1]} ${what}; the code says ${actual}. The prose is wrong, or the code is.`,
      );
    }
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
