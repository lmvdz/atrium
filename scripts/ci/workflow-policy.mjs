/**
 * Semantic policy for this repo's GitHub Actions workflows.
 *
 * Round 1 of this ticket enforced the same intent with `grep`. A grep over a
 * workflow is not a policy engine: it cannot see that a construct sits on a job
 * rather than a step, it reads a quoted key as different from a bare one, it is
 * blind to YAML aliases, and — the failure that actually mattered — it never
 * runs at all when the job carrying it is skipped by an `if:` the attacker
 * controls. So the rules below run over the *parsed document*, and the `gate`
 * job (rule gate-covers-all-jobs) makes skipping any of them red rather than
 * green.
 *
 * Every rule is a hard failure. There are no warnings: a warning is a fail-open
 * construct wearing a different hat.
 *
 * SCOPE. This engine — and the CI it guards — defends against **accident and
 * drift**: a step deleted in a hurry, a floor quietly lowered, an action tag
 * that moved under us, a job that stopped running and nobody noticed. It does
 * *not* defend against a malicious author with write access, because it cannot:
 * the policy, its self-test, the reporters and the floors all execute from the
 * revision under test, so an author who can edit this file can edit what it
 * checks. The rules below make that expensive and loud, not impossible.
 *
 * Being exact about the four things a green run here does not claim, because
 * "not against a malicious author" is true and too vague to act on:
 *
 *   1. **Not semantics.** The rules pin invocation *shape*. Replacing an assert
 *      script's body with `process.exit(0)` satisfies all of them. And shape is
 *      not reachability: `false && git fetch …` is a real command in command
 *      position, and nothing here evaluates the guard.
 *   2. **Not executable provenance.** Recognition is by command *word*.
 *      `no-command-shadowing` bans the obvious redefinitions; a list of
 *      spellings is not a proof that `git` is git.
 *   3. **Not self-reference-proof.** This file, its self-test, and the README
 *      readback that keeps the prose counts honest all come from the revision
 *      under test — the readback compares a number against prose the same
 *      commit wrote.
 *   4. **Not complete about mutation purity.** A mutation must fire its own
 *      rule and declare any other rule it trips. An *extra* violation of the
 *      same rule goes unnoticed, and an `also` entry's reason is prose.
 *
 * All four are owned by the governance trigger in the README — required-check
 * rulesets, pull requests, and code-owner review, before a second contributor
 * gets write access or this repository goes public. They are recorded here
 * rather than chased, because a check that runs from the revision it judges
 * cannot close any of them at any level of effort.
 *
 * KNOWN GAP, STATED RATHER THAN CHASED: composite-action bodies are not
 * expanded. A step written `uses: ./.github/actions/run-gates` has its real
 * commands in that action's `action.yml`, which this engine never reads, so a
 * required step moved wholesale into a local composite action would read as
 * missing (loud, and therefore safe) while a *prerequisite* moved there would
 * also read as missing (equally loud). Both directions fail closed, which is why
 * this is a note rather than a feature: the repo uses no composite actions
 * today, and the day it does, the presence rules will say so on that commit.
 * Expanding them means resolving and parsing a second file whose own `uses:`
 * chain can recurse — cost that buys nothing until the first one exists.
 *
 * Usage:
 *   node scripts/ci/workflow-policy.mjs .github/workflows/*.yml
 *   import { checkWorkflow } from './workflow-policy.mjs'
 */

import { readFileSync } from 'node:fs';
import { isAlias, isCollection, parseDocument, visit } from 'yaml';
import { isMainModule } from './main-module.mjs';
import {
  basename,
  completedCommands,
  firstOperand,
  LAUNCHER_NAMES,
  PACKAGE_MANAGER_NAMES,
  parseScript,
  runsItsScript,
  singleCommandProblems,
} from './shell-command.mjs';

/** A pinned action reference: `owner/repo@<40 hex>`, optionally `owner/repo/path@sha`. */
const PINNED_USES = /^[^@\s]+@([0-9a-f]{40})$/;
/** Local (`./.github/actions/x`) and docker refs are pinned by other means. */
const LOCAL_USES = /^\.\//;
const DOCKER_USES = /^docker:\/\//;
/** `uses:` lines must carry a `# vN.N.N` comment recording the intended major. */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?\s*$/;
const VERSION_COMMENT = /v\d+(\.\d+)*/;

/** Shell fragments that turn a failing command into a passing step. */
const FAIL_OPEN_SHELL = [
  { pattern: /\|\|\s*true\b/, label: '`|| true`' },
  { pattern: /\|\|\s*:\s*(?:$|\n|;)/, label: '`|| :`' },
  { pattern: /\|\|\s*exit\s+0\b/, label: '`|| exit 0`' },
  { pattern: /set\s+\+e\b/, label: '`set +e`' },
  { pattern: /set\s+\+o\s+pipefail\b/, label: '`set +o pipefail`' },
  { pattern: /continue-on-error/, label: '`continue-on-error`' },
];

/**
 * The keys that decide *where and in what* a step runs, and the one answer each
 * of them may have.
 *
 * ── THE DEFECT (#40 round 5) ────────────────────────────────────────────────
 * Round 4 derived "an action is a program too" and guarded `uses:` — in the
 * deploy job, once. A container is a runtime too, and nothing in `RULES`
 * inspected the key. A job carrying
 *
 *     container:
 *       image: ghcr.io/somebody/thing@sha256:<40 hex>
 *
 * passed this engine completely clean — the digest even satisfies
 * `pin-actions-to-sha`, which only ever reads `uses:` lines — and every `run:`
 * step of that job then executes inside an image the author chose. `node` is
 * that image's node and `bash` is its bash, so `NODE_FLAGS_ALLOWED`,
 * `INJECTING_VARIABLES`, `no-command-shadowing` and `DEPLOY_ENTRYPOINTS` are all
 * governing argv inside a runtime nobody checked. It breaks the round's fidelity
 * claim independently: `deploy-mutation-ledger.mjs` runs each stage with
 * `execFileSync('bash', ['-e', scriptFile])` **on this host**, while CI would
 * run it in the image — two verifiers describing different executions, which is
 * the exact failure round 4 says it closed.
 *
 * So the sweep, rather than the one site. Everything below changes the machine,
 * the image, or the directory a step executes in:
 *
 *   - `container:` — the whole job runs inside somebody's image.
 *   - `working-directory:` — at workflow `defaults.run`, at job `defaults.run`,
 *     or on a step. The ledger writes each stage's script to a temp file and
 *     runs it from the repository root; a step that ran somewhere else is a step
 *     it replays wrongly, and `../../scripts/ci/x.mjs` resolves differently.
 *   - `runs-on:` — a self-hosted or differently-imaged runner is a different
 *     `bash`, a different `node`, and a `$PATH` this repository has never seen.
 *     The object form (`{group:…, labels:…}`) is refused by the same comparison.
 *   - `uses: docker://…` — a container action, i.e. an image with an entrypoint.
 *     `pin-actions-to-sha` deliberately skips these, so nothing else looks.
 *
 * `services:` is deliberately *not* here, and that is a claim rather than an
 * oversight: a service container is a sidecar the steps talk to over TCP, not
 * something a step runs inside. `verify` and `e2e` both use one for Postgres.
 * If a future GitHub schema adds another key that answers "where does this
 * execute", it belongs in this table, and the fixture beside it is what proves
 * the answer is enforced rather than described.
 *
 * ── ONE THING THIS DOES NOT SEE, STATED RATHER THAN CHASED ─────────────────
 * A published action can itself be a Docker action — `runs: using: docker` in
 * its own `action.yml` — reached by an ordinary `owner/repo@<sha>` ref with no
 * `docker://` anywhere in this file. This engine never reads `action.yml` (the
 * same boundary as the composite-action gap at the top of this file), so it
 * cannot tell that step from a JavaScript one. It is closed where it matters
 * and open where it does not: `deploy` — the job whose execution
 * `deploy-mutation-ledger.mjs` claims to reproduce — allowlists its two actions
 * by name in `DEPLOY_ACTIONS`, so nothing there can be a Docker action without
 * an edit to that list. In `verify` and `e2e` a container action would run in
 * its own image and nothing here would say so; those jobs have no ledger making
 * a fidelity claim about them. Closing it means resolving and parsing a second
 * repository's file, which is cost that buys nothing until the first such
 * action exists.
 */
const RUNTIME_KEYS = {
  container: {
    /** No value at all is admissible: the key itself is the defect. */
    allowed: [],
    why: 'every `run:` step of that job then executes inside an image the author chose, where `node` is its node and `bash` is its bash — so every rule in this file about argv is governing a runtime nobody checked, and `deploy-mutation-ledger.mjs`, which re-executes those same scripts on the host with `bash -e`, is certifying a different execution from the one CI performs',
  },
  'working-directory': {
    allowed: [],
    why: 'the ledger replays each stage from the repository root, the paths in these steps are written relative to it, and a step that ran somewhere else is a step the receipt describes wrongly — put the directory in the command (`pnpm --fail-if-no-match --filter @atrium/db exec …`) where both readers can see it',
  },
  'runs-on': {
    allowed: ['ubuntu-latest'],
    why: 'a self-hosted or differently-imaged runner is a different `bash`, a different `node` and a `$PATH` this repository has never seen, which is the same substitution `no-command-shadowing` refuses one word at a time',
  },
};

/** Untrusted context that must never be interpolated into a shell script. */
const INJECTABLE_CONTEXT =
  /\$\{\{\s*github\.(event\b|head_ref\b|event_name\s*==\s*)|github\.event\.(pull_request|issue|comment|head_commit)/;

const REQUIRED_TRIGGERS = ['pull_request', 'merge_group'];
const GATE_JOB = 'gate';

/**
 * Every rule this engine can emit, declared rather than counted by hand.
 *
 * Round 2 of this ticket claimed "15 rules" in a receipt while the engine
 * carried 18, and four of them had never been mutated by the self-test. Both
 * mistakes were possible because the rule set lived only in the call sites. It
 * lives here now: `add()` refuses an undeclared rule id, and the self-test
 * asserts every entry below has at least one mutation proving it fires. The
 * count in any receipt is `RULES.length`, not a number someone remembered.
 */
export const RULES = [
  'yaml-parse',
  'no-yaml-alias',
  'no-yaml-anchor',
  'no-continue-on-error',
  'no-shell-override',
  'no-step-timeout',
  'no-fail-open-shell',
  'no-untrusted-interpolation',
  'required-triggers',
  'least-privilege',
  'pin-actions-to-sha',
  'job-timeout-required',
  'gate-covers-all-jobs',
  'gate-runs-always',
  'gate-inspects-needs',
  'no-job-condition',
  'no-step-condition',
  'no-stray-condition',
  'policy-steps-present',
  'required-job-steps',
  'required-step-prerequisites',
  'no-remote-reusable-workflow',
  'no-command-shadowing',
  'no-runtime-override',
  'protected-steps-run-one-command',
  'compose-through-one-entrypoint',
  'protected-commands-cover-the-verbs',
];

/** The deployment job, whose extra rules are about a stack rather than a repo. */
const DEPLOY_JOB = 'deploy';

/**
 * Command recognition: a parse, not a pattern.
 *
 * ── WHY THIS IS A PARSER (round 6) ──────────────────────────────────────────
 * Round 4 matched required steps and prerequisites by substring, so
 * `echo 'git fetch … refs/heads/main'` satisfied the pair that named the rule
 * while `origin/main` never arrived and the ratchet took its no-baseline exit-0
 * path — policy green *and* runtime green over a fetch that never happened.
 * Round 5 replaced that with a line-start regular expression carrying an
 * optional package-manager prefix:
 *
 *     (?:^|\n)[^\S\n]*(?:(?:pnpm|npm|npx|yarn|bunx?)[^\n]*?\bexec\s+)?
 *
 * and the round-5 gauntlet took nine words to defeat it. `[^\n]*?` between the
 * manager and `exec` is arbitrary text, so
 *
 *     pnpm --version && echo exec node scripts/ci/assert-floor-ratchet.mjs
 *
 * matched: the regex ate through `echo exec ` and matched the tail. Every
 * protected step and every prerequisite fell to that one-line rewrite. The same
 * expression was wrong in the other direction as well — it rejected
 * `(git fetch …)`, `true && git fetch …`, `VAR=x git fetch …`, `sudo …`,
 * `timeout 30 …`, `command git …`, `xargs … git …` and any backslash
 * continuation, while *accepting* `git fetch … &`, which does not establish that
 * the fetch finished before the step that needs it.
 *
 * A guard that is wrong in both directions is worse than the one it replaced, so
 * round 6 does not write a third regex. `shell-command.mjs` tokenizes the script
 * — quoting, escapes, comments, expansions, redirections, here-documents,
 * operators, subshells — and yields simple commands with the word in command
 * position first. A matcher is then a predicate over `argv`, and `echo exec node
 * x` is an `echo` with two arguments no matter how it is spaced. See that file
 * for the four boundaries this deliberately does not cross.
 *
 * That is still a claim about *invocation shape* and nothing more: see the SCOPE
 * note above and the one in ci.yml. It stops `echo node scripts/ci/assert-x.mjs`
 * and `pnpm … echo exec node …` from satisfying a rule; it cannot stop the
 * script's own contents being replaced with `process.exit(0)`, and nothing in a
 * workflow can.
 */

/** Every matcher built below, so the shadowing rule can derive what it protects. */
const MATCHERS = [];

class CommandMatcher {
  constructor(describes, names, match) {
    this.describes = describes;
    this.names = names;
    this.match = match;
  }

  /** True when some simple command in `script` runs this, and completes. */
  test(script) {
    return completedCommands(script).some((command) => this.match(command));
  }

  /** Violation messages print this, so a red build says what shape was wanted. */
  toString() {
    return this.describes;
  }
}

/**
 * @param {string} describes what a human should read in a violation message
 * @param {string[]} names the command words this recognition depends on
 * @param {(command: object) => boolean} match predicate over one simple command
 */
function command(describes, names, match) {
  const matcher = new CommandMatcher(describes, names, match);
  MATCHERS.push(matcher);
  return matcher;
}

/**
 * A script being *invoked* under `node`, not merely mentioned.
 *
 * @param directory the directory it lives in, as a regexp source
 * @param script    its filename, as a regexp source
 */
function invokesIn(directory, script) {
  const path = new RegExp(String.raw`^(?:\.\.\/)*${directory}\/${script}$`);
  const shown = `${directory}/${script}`.replace(/\\/g, '');
  return command(`\`node …/${shown}\``, ['node'], ({ argv }) => {
    if (argv[0] !== 'node') return false;
    // `node --check x.mjs` parses the file, exits 0, and runs none of it — and
    // it is one unconditional command with the script as its first operand, so
    // the shape rule cannot see it either. Found by a blind cross-lineage review
    // of the first version of that rule. A node invocation that is not going to
    // run the script reads as *missing*, which is loud.
    if (!runsItsScript(argv)) return false;
    const operand = firstOperand(argv);
    return operand !== undefined && path.test(operand);
  });
}

/** A script in `scripts/ci/` being *invoked*, not merely mentioned. */
function invokes(script) {
  return invokesIn(String.raw`scripts\/ci`, script);
}

/**
 * A package.json script run through the workspace's package manager.
 *
 * `via` rather than `raw[0]`, so `sudo pnpm build` and `timeout 60 pnpm lint`
 * are the same claim as `pnpm build` — the launcher is not what makes it one.
 */
function packageScript(name) {
  return command(`\`pnpm ${name}\``, [...PACKAGE_MANAGER_NAMES], ({ via, argv }) => {
    return via.some(({ name: word }) => PACKAGE_MANAGER_NAMES.includes(word)) && argv[0] === name;
  });
}

/** A binary and its subcommand, however the package manager reaches it. */
function binary(name, ...subcommand) {
  const shown = [name, ...subcommand].join(' ');
  return command(`\`${shown}\``, [name], ({ argv }) => {
    if (basename(argv[0]) !== name) return false;
    return subcommand.every((word, index) => argv[index + 1] === word);
  });
}

/**
 * A run-scoped variable being *exported to the rest of the job*.
 *
 * `echo "VITEST_RUN_START=$(date +%s%3N)"` prints a line; only the redirection
 * into `$GITHUB_ENV` makes the later gate able to read it. Round 4 matched
 * `/\bVITEST_RUN_START=/`, which a comment about the timestamp satisfies as
 * happily as the assignment does. Round 5 required the redirection but wrote the
 * target as `\$\{?GITHUB_ENV\b`, which `>> "$GITHUB_ENV.bak"` satisfies — a word
 * boundary sits between `V` and `.`, so a file nobody reads passed as the job
 * environment. The target is now compared as a whole word: exactly
 * `$GITHUB_ENV` or `${GITHUB_ENV}`, and the `$` must be live rather than
 * single-quoted, because `>> '$GITHUB_ENV'` writes a file with a funny name and
 * exports nothing at all.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, quoted verbatim
const JOB_ENV_FILE = new Set(['$GITHUB_ENV', '${GITHUB_ENV}']);

function exportsToJobEnv(name) {
  return command(
    `\`echo ${name}=… >> "$GITHUB_ENV"\``,
    ['echo', 'printf'],
    ({ argv, redirections }) => {
      if (argv[0] !== 'echo' && argv[0] !== 'printf') return false;
      if (!(firstOperand(argv) ?? '').startsWith(`${name}=`)) return false;
      return redirections.some(
        ({ op, target }) =>
          (op === '>>' || op === '>') && target.expandable && JOB_ENV_FILE.has(target.value),
      );
    },
  );
}

/**
 * ── PREREQUISITES (round 4) ─────────────────────────────────────────────────
 * Round 3 required each assert script to be present and stopped there, and the
 * round-3 gauntlet found the hole that leaves: `assert-floor-ratchet.mjs` is
 * only a ratchet because the step *before* it fetches `origin/main`. Delete the
 * fetch — one line, the sort of thing a rebase does without malice — and the
 * assertion still runs, finds no baseline, says so politely, and exits 0. The
 * gate is present, named, invoked, and comparing against nothing.
 *
 * So a required step may declare what it depends on, and the policy enforces
 * the pair: the prerequisite must be in the same job *and* run before it.
 * Presence alone is not the property that matters — a report reset that happens
 * after the run it is meant to precede is as useless as one that is missing.
 *
 * The rule is general on purpose. Every assert script below was re-examined for
 * a setup dependency and the ones that have one now declare it, so the next
 * script to acquire one has an obvious place to say so rather than a comment
 * nobody reads. The ratchet's pair is the only one that failed *open* on its
 * own — the rest already went red at runtime when their setup was missing (a
 * report gate with no run-start timestamp refuses to prove freshness;
 * `assert-tables.mjs` against an unmigrated database finds an empty table set;
 * `assert-chromium.mjs` without an install finds no browser). Declaring them
 * moves the failure from the middle of a CI run to the edit that caused it, and
 * the ordering half of the rule is new information for every one of them.
 *
 * How many there are is `PREREQUISITE_PAIRS.length`, derived below and printed
 * by the self-test — not a number in this comment. A first draft of it said
 * "five" and the table already held nine, which is round 2's rule-count mistake
 * reappearing in a fresh place within a day of being fixed elsewhere.
 *
 * `policy-steps-present` covers the meta-guards: the things that check the
 * workflow itself. `required-job-steps` covers the verification work.
 * `required-step-prerequisites` covers what has to have happened first.
 *
 * ── ROUND 5 ─────────────────────────────────────────────────────────────────
 * All of that was true and matched by substring, which meant the rule's own
 * motivating case still passed when the fetch was quoted into an `echo`. Every
 * test below now goes through COMMAND_POSITION, so a prerequisite has to be a
 * command and not a sentence about one. See that comment for the receipt.
 */

/**
 * The commands the pairs below are about, each matched at command position.
 *
 * Declared once and shared, because several of them are both a required step in
 * their own right and another step's prerequisite: `drizzle-kit migrate` has to
 * exist *and* has to come after the wait for Postgres *and* has to come before
 * the schema assertion. One matcher per command means the two rules can never
 * drift into disagreeing about what "the migrations ran" means.
 */
const RUNS_ACTIONLINT = command('`actionlint -color`', ['actionlint'], ({ argv }) => {
  return (
    basename(argv[0]) === 'actionlint' &&
    argv.slice(1).some((word) => word === '-color' || word === '--color')
  );
});
const RUNS_LINT = packageScript('lint');
const RUNS_TYPECHECK = packageScript('typecheck');
const RUNS_BUILD = packageScript('build');
const WAITS_FOR_POSTGRES = invokes('wait-for-postgres\\.mjs');
const RUNS_MIGRATIONS = binary('drizzle-kit', 'migrate');
const RUNS_VITEST = binary('vitest', 'run');
const INSTALLS_CHROMIUM = binary('playwright', 'install');
const MIGRATES_E2E_DATABASE = invokesIn(String.raw`e2e\/support`, String.raw`ensure-database\.mjs`);
const ASSERTS_CHROMIUM = invokes('assert-chromium\\.mjs');
const RUNS_PLAYWRIGHT = binary('playwright', 'test');

/**
 * The `deploy` job's four compose verbs (#40).
 *
 * ── WHY THESE ARE NOT `docker compose …` ANY MORE (round 3) ─────────────────
 * They were, and the round-2 gauntlet found what that cost: "preflight resolves
 * `ATRIUM_COMPOSE_FILES`; build/up/cp/down hard-code the two base files. An
 * extra 'safe' overlay lets preflight see `gateway_mode=nat` while the real `up`
 * uses a routed base network." Two expressions of one file list, and nothing
 * comparing them — so every check that reads the *resolved configuration* was
 * inspecting a stack that need not be the one that came up.
 *
 * `scripts/ci/compose-stack.mjs` is now the only thing in this repository that
 * says `docker compose` about the deployed stack, and it takes the file list
 * from `composeArgs` — the same function every assertion uses. The
 * `compose-through-one-entrypoint` rule refuses a bare `docker compose` in the
 * `deploy` job, so a literal file list cannot come back quietly.
 *
 * The flags that used to be visible here — `--wait` on the boot, `-v` on the
 * teardown — moved into that file with them. That is a real trade, paid for in
 * `gate-selftest.mjs`, which asserts the argv `compose-stack.mjs` builds for
 * every verb: a test of the code that runs, rather than a match against the text
 * beside it.
 */
function composeStack(verb) {
  const path = /^(?:\.\.\/)*scripts\/ci\/compose-stack\.mjs$/;
  return command(`\`node scripts/ci/compose-stack.mjs ${verb}\``, ['node'], ({ argv }) => {
    if (argv[0] !== 'node') return false;
    const script = firstOperand(argv);
    if (script === undefined || !path.test(script)) return false;
    return firstOperand(argv, argv.indexOf(script) + 1) === verb;
  });
}

const BUILDS_IMAGES = composeStack('build');
const PREFLIGHTS_HOST = invokes('assert-deploy-preflight\\.mjs');
const RECORDS_IMAGES = invokes('record-built-images\\.mjs');
const ASSERTS_MIGRATION_IMAGE = invokes('assert-migration-image\\.mjs');
const STARTS_STACK = composeStack('up');
const TRUSTS_CA = composeStack('trust-ca');
const TEARS_DOWN = composeStack('down');
const ASSERTS_SIGNUP = invokes('assert-signup-verifies\\.mjs');

/**
 * The report files being *deleted*, which is the other half of a report reset.
 *
 * Round 3 of #40 split "Reset the test reports" into a delete step and a record
 * step, because a protected step is one command now. A blind cross-lineage
 * review caught what that cost: the pair only ever named the `$GITHUB_ENV`
 * export, so after the split the delete could be dropped with the policy still
 * clean. Deleting it is not harmless — the freshness check is an mtime
 * comparison, and a report restored from a cache with a new mtime passes it.
 */
function deletesReports(...files) {
  return command(`\`rm -f ${files.join(' ')}\``, ['rm'], ({ argv }) => {
    if (basename(argv[0]) !== 'rm') return false;
    return files.every((file) => argv.slice(1).includes(file));
  });
}

const DELETES_VITEST_REPORTS = {
  what: 'the step that deletes the vitest reports',
  test: deletesReports('vitest-report.json', 'vitest-ci-report.json'),
  because:
    "freshness is proven by comparing a report's mtime against a recorded timestamp, and a report restored from a cache carries a new mtime; deleting them first is what makes the timestamp mean the run rather than the restore",
};
const DELETES_E2E_REPORT = {
  what: 'the step that deletes the e2e report',
  test: deletesReports('playwright-report.json'),
  because: 'same reason as the vitest delete: a leftover report is the quietest possible green',
};

const FETCHES_BASELINE = {
  what: 'the fetch of the baseline manifest from main',
  test: command('`git fetch … refs/heads/main`', ['git'], ({ argv }) => {
    if (basename(argv[0]) !== 'git') return false;
    // The subcommand by membership rather than by position: `git -c x=y fetch`
    // is a fetch, and reading the first operand would call it a `x=y`.
    if (!argv.slice(1).includes('fetch')) return false;
    return argv.slice(1).some((word) => word.includes('refs/heads/main'));
  }),
  because:
    'without it the shallow clone actions/checkout leaves has no `origin/main`, so the ratchet finds no baseline, reports that politely, and exits 0 — a floor lowered in the same pull request would sail through the very gate that exists to catch it',
};
const RESETS_VITEST_REPORT = {
  what: 'the step that deletes the vitest reports and records VITEST_RUN_START',
  test: exportsToJobEnv('VITEST_RUN_START'),
  because:
    "the gate proves a report is fresh by comparing its mtime against that timestamp; with no reset the previous run's report is still on disk, and with no timestamp freshness cannot be proven at all",
};
const RESETS_E2E_REPORT = {
  what: 'the step that deletes the e2e report and records E2E_RUN_START',
  test: exportsToJobEnv('E2E_RUN_START'),
  because: 'same reason as the vitest reset: a leftover report is the quietest possible green',
};

/**
 * Steps that must exist, by job — and, where one only means something because
 * of an earlier step, that pair.
 *
 * A job can satisfy every rule above and still prove nothing, by simply not
 * running the checks any more — delete the policy step and the policy stops
 * objecting to its own absence. That is circular, and knowingly so: it cannot
 * stop an author who means it (see SCOPE at the top of this file). What it does
 * stop is the accident — a step dropped during a rebase, a script renamed
 * without its call site, a job hollowed out to "make CI fast" — which is the
 * threat model this repo actually has today.
 */
const REQUIRED_STEPS = {
  verify: [
    // Matches actionlint being *run*, not merely downloaded — the install step
    // names it too, and a job that fetches a linter it never invokes is exactly
    // the shape this rule is looking for.
    { rule: 'policy-steps-present', what: 'actionlint', test: RUNS_ACTIONLINT },
    {
      rule: 'policy-steps-present',
      what: 'the workflow policy engine',
      test: invokes('workflow-policy\\.mjs'),
    },
    {
      rule: 'policy-steps-present',
      what: "the policy engine's own self-test",
      test: invokes('workflow-policy-selftest\\.mjs'),
    },
    {
      rule: 'policy-steps-present',
      what: "the test gates' self-test",
      test: invokes('gate-selftest\\.mjs'),
    },
    { rule: 'required-job-steps', what: 'the linter', test: RUNS_LINT },
    { rule: 'required-job-steps', what: 'the typechecker', test: RUNS_TYPECHECK },
    { rule: 'required-job-steps', what: 'the build', test: RUNS_BUILD },
    {
      rule: 'required-job-steps',
      what: 'the workspace-enrollment assertion',
      test: invokes('assert-workspace-enrollment\\.mjs'),
    },
    {
      rule: 'required-job-steps',
      what: 'the floor-ratchet assertion',
      test: invokes('assert-floor-ratchet\\.mjs'),
      requires: [FETCHES_BASELINE],
    },
    {
      rule: 'required-job-steps',
      what: 'the wait for Postgres',
      test: WAITS_FOR_POSTGRES,
    },
    {
      rule: 'required-job-steps',
      what: 'the migrations',
      test: RUNS_MIGRATIONS,
      requires: [
        {
          what: 'the wait for Postgres',
          test: WAITS_FOR_POSTGRES,
          because:
            'migrating against a container that has not finished starting is a race, and a race that loses looks like a broken migration rather than a slow database',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the schema set-equality assertion',
      test: invokes('assert-tables\\.mjs'),
      requires: [
        {
          what: 'the migrations',
          test: RUNS_MIGRATIONS,
          because:
            'set equality against a database nobody migrated compares the built schema with an empty database — which is a real failure, but a confusing one, and the ordering is the thing that makes the assertion mean "the migrations did work"',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the unit/integration suite',
      test: RUNS_VITEST,
      requires: [RESETS_VITEST_REPORT, DELETES_VITEST_REPORTS],
    },
    {
      rule: 'required-job-steps',
      what: 'the vitest report gate',
      test: invokes('assert-vitest-report\\.mjs'),
      requires: [
        {
          what: 'the unit/integration suite',
          test: RUNS_VITEST,
          because:
            'a report gate that runs before the runner reads whatever was on disk beforehand, which is the definition of the stale-report failure it exists to prevent',
        },
      ],
    },
  ],
  e2e: [
    {
      rule: 'required-job-steps',
      what: 'the browser-presence assertion',
      test: ASSERTS_CHROMIUM,
      requires: [
        {
          what: 'the Chromium install',
          test: INSTALLS_CHROMIUM,
          because:
            'asserting a browser is present before anything installs one is a check guaranteed to fail, and a check guaranteed to fail is a check somebody will delete',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the e2e database migration',
      test: MIGRATES_E2E_DATABASE,
    },
    {
      rule: 'required-job-steps',
      what: 'the Playwright suite',
      test: RUNS_PLAYWRIGHT,
      requires: [
        RESETS_E2E_REPORT,
        DELETES_E2E_REPORT,
        {
          what: 'the browser-presence assertion',
          test: ASSERTS_CHROMIUM,
          because:
            'the smoke spec skips itself when no browser is installed, which is right on a laptop and a lie in CI; the assertion has to come first or the suite has already reported green over zero executed tests',
        },
        {
          what: 'the e2e database migration',
          test: MIGRATES_E2E_DATABASE,
          because:
            '`pnpm test:e2e` runs it before Playwright on a laptop, and this job invokes `playwright test` directly so the policy can see the command rather than a package.json alias — which means the migration is a step of its own and can be dropped like any other. Playwright starts its `webServer` processes before `globalSetup` would run, so without it two servers query tables that do not exist and every spec fails at sign-up',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the e2e report gate',
      test: invokes('assert-playwright-report\\.mjs'),
      requires: [
        {
          what: 'the Playwright suite',
          test: RUNS_PLAYWRIGHT,
          because: 'same as the vitest gate: a report read before the run is last run’s report',
        },
      ],
    },
  ],
  /**
   * The deployment job (#40), where every gate is about a running stack.
   *
   * Ordering is nearly the whole content of these rules. Every assertion here
   * reads state that an earlier step created — the images, the containers, the
   * certificate authority, the absence of the containers — and every one of
   * them, run early, would be *right about the wrong moment*. Two of them would
   * fail loudly (there is no stack to inspect); the teardown assertion is the
   * dangerous shape, because run before the teardown it inspects a stack that
   * is still up, and run after a teardown that lost its `-v` it inspects
   * volumes nobody deleted.
   */
  deploy: [
    {
      rule: 'required-job-steps',
      what: 'the deployment preflight',
      test: PREFLIGHTS_HOST,
    },
    {
      rule: 'required-job-steps',
      what: 'the image build',
      test: BUILDS_IMAGES,
    },
    {
      rule: 'required-job-steps',
      what: 'the image record',
      test: RECORDS_IMAGES,
      requires: [
        {
          what: 'the image build',
          test: BUILDS_IMAGES,
          because:
            'it resolves each service image name to the ID that answers to it *now*; run before the build it records the previous run’s image, and every identity assertion afterwards then agrees with a stale answer',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the migration-image assertion',
      test: ASSERTS_MIGRATION_IMAGE,
      requires: [
        {
          what: 'the image record',
          test: RECORDS_IMAGES,
          because:
            'it compares the image the resolved configuration gives `migrate` against the ID that step wrote down; with no manifest there is nothing to compare against and the one container whose work cannot be undone runs unchecked',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the stack boot',
      test: STARTS_STACK,
      requires: [
        {
          what: 'the image build',
          test: BUILDS_IMAGES,
          because:
            'compose would otherwise start whatever image happens to be in the local cache from a previous run — which is how a build that has been failing since a workspace package landed goes unnoticed for three rounds',
        },
        {
          what: 'the deployment preflight',
          test: PREFLIGHTS_HOST,
          because:
            'it refuses a host whose engine publishes loopback-bound ports off-box, and the whole value of refusing is refusing *before* the stack is up: after `up` the mailpit UI this deployment documents as unreachable has already been listening on a host where it is not',
        },
        {
          what: 'the migration-image assertion',
          test: ASSERTS_MIGRATION_IMAGE,
          because:
            '`migrate` is a one-shot that `server` and `app` both wait on, so it runs *inside* this step — a wrong migration image has already altered a persistent volume by the time `assert-image-identity` looks at any container. This is the ordering the round-2 gauntlet named, and the only place the answer can still be no is before the boot',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the certificate-authority copy',
      test: TRUSTS_CA,
      requires: [
        {
          what: 'the stack boot',
          test: STARTS_STACK,
          because:
            "Caddy mints its internal root the first time it serves, so copying it out before the proxy is running copies nothing and every assertion afterwards falls back to the system trust store — where this deployment's certificate is not, so they would all fail for the wrong reason",
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the container-health assertion',
      test: invokes('assert-stack-health\\.mjs'),
      requires: [
        {
          what: 'the stack boot',
          test: STARTS_STACK,
          because:
            'inspecting the health of containers that were never started reports that the stack has no containers, which is true and is not the question',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the production-configuration assertion',
      test: invokes('assert-stack-config\\.mjs'),
      requires: [
        {
          what: 'the stack boot',
          test: STARTS_STACK,
          because:
            'this reads NODE_ENV and both public origins back out of the *running* containers, precisely so an overlay cannot quietly turn the job into a check on a development stack; there is nothing to read before they run',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the image-identity assertion',
      test: invokes('assert-image-identity\\.mjs'),
      requires: [
        {
          what: 'the image record',
          test: RECORDS_IMAGES,
          because:
            'it compares the running containers against the IDs that step wrote down; with no manifest there is nothing to compare to, and the binding between built, scanned and running is back to a shared tag',
        },
        {
          what: 'the stack boot',
          test: STARTS_STACK,
          because:
            'the running side of the comparison is `docker inspect` on containers; before the boot there are none, and "no container is running the wrong image" is true of an empty stack',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the compiled-origin assertion',
      test: invokes('assert-image-origins\\.mjs'),
      requires: [
        {
          what: 'the image build',
          test: BUILDS_IMAGES,
          because:
            'it scans the image that was just built; against a stale one it reports on a bundle nobody is about to deploy',
        },
        {
          what: 'the image record',
          test: RECORDS_IMAGES,
          because:
            'the scan reads the image *ID* that step captured rather than a tag anybody can re-point, so without it there is nothing naming which image to scan — which is precisely how it came to scan one nobody was running',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the composed-stack schema assertion',
      test: invokes('assert-stack-schema\\.mjs'),
      requires: [
        {
          what: 'the stack boot',
          test: STARTS_STACK,
          because:
            'the migration it is checking the result of runs during the boot, and before that there is no database to read a schema out of',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the signup-and-verification assertion',
      test: ASSERTS_SIGNUP,
      requires: [
        {
          what: 'the certificate-authority copy',
          test: TRUSTS_CA,
          because: 'same client, same verification, same failure without the root',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the real-page assertion',
      test: invokes('assert-page-serves\\.mjs'),
      requires: [
        {
          what: 'the certificate-authority copy',
          test: TRUSTS_CA,
          because:
            'the client verifies the chain against that root and never disables verification, so without it every request fails on the certificate instead of telling anybody whether the app serves',
        },
        {
          what: 'the signup-and-verification assertion',
          test: ASSERTS_SIGNUP,
          because:
            'the page assertion proves `/` is the app by rendering it *as a per-run account*, which means it drives the same signup-and-verify flow. Run first, it would go red on a broken mail path as well — two steps failing for one reason, and the ledger crediting whichever came first. The mail path belongs to the earlier step, so this one’s failures are about pages',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the websocket-upgrade assertion',
      test: invokes('assert-ws-upgrade\\.mjs'),
      requires: [
        {
          what: 'the certificate-authority copy',
          test: TRUSTS_CA,
          because: 'the upgrade is a TLS connection first; without the root it never gets that far',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the per-address rate-limit assertion',
      test: invokes('assert-rate-limit\\.mjs'),
      requires: [
        {
          what: 'the certificate-authority copy',
          test: TRUSTS_CA,
          because:
            'its two callers run in containers that mount that root and verify against it, so without the file both of them fail to connect and the limiter is never exercised',
        },
      ],
    },
    {
      rule: 'required-job-steps',
      what: 'the teardown assertion',
      test: invokes('assert-stack-teardown\\.mjs'),
      requires: [
        {
          what: 'the teardown',
          test: TEARS_DOWN,
          because:
            'run before the teardown it finds a running stack and calls it a leak; and it is the only thing that notices a teardown which lost its `-v` and left four named volumes behind, which on a real host is next month’s database being adopted with last month’s schema in it',
        },
      ],
    },
  ],
};

/** Stable identity for one (job, step, prerequisite) edge. */
export function pairId({ job, step, needs }) {
  return `${job}: ${step} ← ${needs}`;
}

/**
 * Every declared (step → prerequisite) edge, derived from REQUIRED_STEPS.
 *
 * Round 2's lesson, applied to the new rule before it can bite: the receipt for
 * that round said "15 rules" over an engine carrying 18, because the number was
 * something a human counted. Anything a receipt wants to quote about this table
 * comes from here.
 *
 * Round 5 makes the *identities* load-bearing too, not only the count: every
 * violation this rule emits carries the pair it is about, and the self-test
 * requires each pair below to be named by at least one mutation. Round 4's
 * self-test asserted only that some violation carried the rule id, which a
 * mutation that trips a different pair satisfies just as well as the one it
 * claims to model.
 */
export const PREREQUISITE_PAIRS = Object.entries(REQUIRED_STEPS).flatMap(([jobId, required]) =>
  required.flatMap((step) =>
    (step.requires ?? []).map((prerequisite) => ({
      job: jobId,
      step: step.what,
      needs: prerequisite.what,
    })),
  ),
);

/**
 * The command words every rule above depends on meaning what they say.
 *
 * Derived from the matchers themselves — plus the launchers and package managers
 * `shell-command.mjs` unwraps, since shadowing `timeout` or `pnpm` defeats
 * recognition just as thoroughly as shadowing `git`. A matcher added without a
 * thought for this list still protects its own command word.
 */
export const PROTECTED_COMMANDS = [
  ...new Set([
    ...MATCHERS.flatMap((matcher) => matcher.names),
    ...LAUNCHER_NAMES,
    ...PACKAGE_MANAGER_NAMES,
  ]),
].sort();

/**
 * The set above is *declared*, and a declaration can be emptied.
 *
 * ── THE DEFECT (#40 round 4, from a blind review of the shared engine) ──────
 * `PROTECTED_COMMANDS` is derived from each matcher's `names`, and `names` is a
 * field a matcher carries alongside the `match` predicate that does the work.
 * Zero every matcher's `names` — or replace this export with `[]` — and every
 * presence rule still fires, because `match` is untouched; `no-command-shadowing`
 * still refuses `PATH`, `hash -p` and `$GITHUB_PATH`, because those are matched
 * by name in the rule itself. What silently stops being caught is
 * `git() { :; }` and `alias git=…`: the words are gone from the set the rule
 * checks against, and the rule goes quiet while looking exactly as green.
 *
 * Deriving the *count* from the table (round 3) made exempting a stage visible.
 * Nothing did the same for the *set*, so this does. For every required step and
 * every prerequisite this policy declares, the real workflow is parsed and the
 * command words that step actually uses — the word in command position, and
 * every launcher and package manager unwrapped to reach it — must be in
 * `PROTECTED_COMMANDS`. Empty a matcher's `names` and its verb drops out of the
 * set while the step still satisfies the matcher, and this rule names it.
 *
 * It is deliberately computed from the workflow rather than from the matchers:
 * a check that asked the matchers what they depend on would be asking the thing
 * under test. The workflow is the independent witness — these are the words CI
 * really runs.
 *
 * @param {object} jobs the workflow's `jobs` mapping
 * @param {string[]} protectedCommands the set to check against; a parameter so
 *   the self-test can hand it a gutted one and watch this fire
 */
export function protectedCommandCoverage(jobs, protectedCommands = PROTECTED_COMMANDS) {
  const held = new Set(protectedCommands);
  const problems = [];
  for (const [jobId, required] of Object.entries(REQUIRED_STEPS)) {
    const job = jobs[jobId];
    if (!isPlainObject(job)) continue;
    const scripts = (Array.isArray(job.steps) ? job.steps : [])
      .filter((step) => isPlainObject(step) && typeof step.run === 'string')
      .map((step) => step.run);
    const matchers = [];
    for (const step of required) {
      matchers.push([step.what, step.test]);
      for (const prerequisite of step.requires ?? []) {
        matchers.push([prerequisite.what, prerequisite.test]);
      }
    }
    for (const [what, matcher] of matchers) {
      for (const script of scripts) {
        for (const command of completedCommands(script)) {
          if (!matcher.match(command)) continue;
          // The words a *shell* resolves, which is what shadowing is about. The
          // first word written, and every launcher and package manager stripped
          // to reach the real command — plus the unwrapped command word itself,
          // unless a package manager did the unwrapping, because `pnpm lint`
          // resolves `lint` in package.json and bash never sees it. That last
          // clause is not a convenience: without it this rule demanded that
          // `lint`, `typecheck` and `build` be protected against a shell
          // function that could not affect them, which is a false red and the
          // fastest way to get a rule deleted.
          const via = command.via ?? [];
          const words = [
            basename(command.raw[0] ?? ''),
            ...via.map(({ name }) => name),
            ...(via.some(({ kind }) => kind === 'manager')
              ? []
              : [basename(command.argv[0] ?? '')]),
          ].filter(Boolean);
          for (const word of words) {
            if (held.has(word)) continue;
            problems.push(
              `jobs.${jobId}: the step satisfying "${what}" runs \`${word}\` in command position, and \`${word}\` is not in PROTECTED_COMMANDS — so \`${word}() { :; }\` and \`alias ${word}=…\` are not refused by \`no-command-shadowing\`, and this rule is recognising a word anybody can redefine. PROTECTED_COMMANDS is derived from each matcher's \`names\`; a matcher whose \`names\` no longer lists the verbs its \`match\` depends on is a rule that still fires and no longer protects anything.`,
            );
          }
        }
      }
    }
  }
  return [...new Set(problems)];
}

/** Ways to make a command word mean something other than the command. */
const SHADOWING_BUILTINS = new Set(['alias', 'export', 'declare', 'typeset', 'readonly', 'local']);

/**
 * Environment variables that decide what code a protected command runs.
 *
 * ── THE SIXTEENTH BYPASS (#40 round 4, from this round's own blind review) ──
 * Round 4 inverted the node-flag denylist into `NODE_FLAGS_ALLOWED`, so
 * `node --require ./nobble.cjs scripts/ci/assert-x.mjs` reads as *missing*. A
 * blind cross-lineage review of that fix went one step sideways and put the flag
 * in the environment instead. Measured, exactly as written:
 *
 *     $ node /tmp/fake-assert.mjs                                   # exits 1
 *     $ NODE_OPTIONS="--require /tmp/nobble.cjs" node /tmp/fake-assert.mjs
 *     ::error::pretend assertion failed
 *     exit=0
 *
 * where `/tmp/nobble.cjs` is two lines: `process.exit = () => {}` and an `exit`
 * listener setting `process.exitCode = 0`. The annotation still prints. The step
 * goes green. Every gate in this repository is a `node` process, so one
 * `env: NODE_OPTIONS:` on the workflow, the job or the step disarms all of them
 * at once — and all three spellings were clean against the engine as committed
 * an hour earlier.
 *
 * ── THE COMPLETENESS CLAIM THIS TABLE USED TO MAKE, AND WHY IT IS GONE ──────
 * Round 4 justified keeping a *list* here, in a round whose whole lesson was
 * "don't list", with this sentence: "Environment variables that make a program
 * execute code it was not asked to is a documented property of three programs —
 * Node, bash, and the dynamic loader — and each of them publishes its own set.
 * The entries below are that union." It was not the union, and the blind review
 * of round 4 needed three lines to show it:
 *
 *     $ bash -e step.sh                                          # runs node, exits 7
 *     $ env "BASH_FUNC_node%%=() { return 0; }" bash -e step.sh   # exits 0
 *
 * bash imports exported *functions* from the environment, and a function beats
 * the binary in command position — `no-command-shadowing` bans `node() { :; }`
 * written in the script and could not see the same function arriving through
 * `env:`. Two more, both honoured and both clean against the round-4 engine:
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which turns off the certificate
 * verification the whole deploy job is conditioned on, and `OPENSSL_CONF`,
 * whose config file can load provider and engine `.so`s — code injection at
 * `LD_PRELOAD`'s level, which was already on the list.
 *
 * A completeness claim about a denylist is itself an overclaim, so the claim is
 * deleted rather than repaired. What replaced it is the polarity that closed
 * every other table in this round: `DECLARED_VARIABLES` below is an
 * **allowlist** of the variable names this workflow sets, and a name that is not
 * on it is refused *whether or not anybody has heard of what it does*.
 * `BASH_FUNC_node%%`, `NODE_TLS_REJECT_UNAUTHORIZED`, `OPENSSL_CONF` and the
 * next runtime's next idea are one clause, not four entries.
 *
 * This table survives underneath that, demoted to what it can honestly be: the
 * *reasons*, for the names somebody is most likely to reach for, so the refusal
 * says why rather than only that. It is explicitly not exhaustive and nothing
 * depends on it being so — every one of these names is refused by the allowlist
 * first, and this only decides which sentence the violation prints.
 *
 * Stated where it will be read: this is the same boundary `no-command-shadowing`
 * has always drawn. It makes the documented injection points loud. It does not
 * prove that the `node` on PATH is Node.
 */
const INJECTING_VARIABLES = {
  PATH: 'PATH decides which binary every command word in this policy resolves to, so prepending a directory redefines every gate at once.',
  NODE_OPTIONS:
    'Node applies NODE_OPTIONS to every `node` process as if the flags had been written on the command line, which is exactly the allowlist in `NODE_FLAGS_ALLOWED` reached through the environment: `NODE_OPTIONS="--require ./nobble.cjs"` loads code into the assertion before its first line and can make a failing gate exit 0 (measured).',
  NODE_PATH:
    "NODE_PATH prepends directories to the CommonJS module search path, so a gate's `require` can be answered by somebody else's file.",
  NODE_REPL_EXTERNAL_MODULE:
    'Node loads the named module in place of its REPL, and it is documented as ignored only when the process is hardened — an injection point by construction.',
  NODE_TLS_REJECT_UNAUTHORIZED:
    'Node reads it as the default for `rejectUnauthorized`, so `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off certificate verification for every TLS client in the process. Measured against a self-signed server: with the variable set and no explicit option, the request returns 200; unset, it fails DEPTH_ZERO_SELF_SIGNED_CERT. The deploy job asserts real TLS through the shipped proxy, so one `env:` line would have made "certificate verification is never disabled" false — see the explicit `rejectUnauthorized: true` in stack-client.mjs, which is what makes that sentence true rather than customary.',
  NODE_EXTRA_CA_CERTS:
    'Node adds the named file to the trusted roots for every TLS client in the process, so a certificate of somebody else’s minting verifies — the same guarantee as NODE_TLS_REJECT_UNAUTHORIZED, undone more quietly.',
  BASH_ENV:
    'bash sources the file named by BASH_ENV before running a non-interactive script, which is every `run:` block in this file.',
  ENV: 'the POSIX equivalent of BASH_ENV, sourced by `sh`.',
  SHELLOPTS:
    'bash applies SHELLOPTS at startup, so it can turn off the `-e` that makes a failing command fail the step.',
  OPENSSL_CONF:
    'OpenSSL reads its configuration from OPENSSL_CONF, and a configuration file can load providers and engines — `.so` files, in-process, chosen by whoever wrote the config. That is LD_PRELOAD-level injection through a file that does not look like code.',
  LD_PRELOAD:
    'the dynamic loader loads the named objects into every process started, ahead of libc — code injection one level below the interpreter.',
  LD_LIBRARY_PATH:
    'the dynamic loader searches it first, so a shared object of somebody else’s choosing answers for a real one.',
};

/**
 * `BASH_FUNC_node%%` is not a name, it is a family.
 *
 * bash exports a shell function as an environment variable called
 * `BASH_FUNC_<name>%%`, and imports every such variable at startup. The name in
 * the middle is the function being defined, so no fixed key can name them: the
 * prefix is the entry. Measured, exactly as written above — `env
 * "BASH_FUNC_node%%=() { return 0; }" bash -e step.sh` exits 0 where the same
 * script exits 7 without it.
 */
const EXPORTED_FUNCTION_PREFIX = 'BASH_FUNC_';

/** Why this variable is an injection point, or undefined if nobody has said. */
function injectionReason(name) {
  if (Object.hasOwn(INJECTING_VARIABLES, name)) return INJECTING_VARIABLES[name];
  if (name.startsWith(EXPORTED_FUNCTION_PREFIX)) {
    return `bash imports exported shell functions from the environment, and \`${name}\` is how one is spelled: it defines \`${name.slice(EXPORTED_FUNCTION_PREFIX.length).replace(/%%$/, '')}\` as a function for every \`run:\` block in the job, and a function beats the binary in command position. It is the \`node() { :; }\` this rule already refuses, arriving where the script cannot be read for it — measured: \`env "BASH_FUNC_node%%=() { return 0; }" bash -e step.sh\` exits 0 where \`bash -e step.sh\` exits 7.`;
  }
  return undefined;
}

/**
 * Every environment variable name this workflow is allowed to set, anywhere.
 *
 * ── WHY AN ALLOWLIST (#40 round 5) ──────────────────────────────────────────
 * See the block above `INJECTING_VARIABLES`: a denylist of injecting variables
 * cannot be complete, and round 4 claimed one was. This is the same inversion
 * the launcher table, the node-flag table, the deploy entrypoints and the
 * manager table have each had in turn, and it is cheap here because the set is
 * genuinely small — fourteen names, every one of them derived from what the
 * workflow actually does.
 *
 * The reason beside each is the same standard the launcher table asks for: a
 * variable is here because some program in this repository reads it, not
 * because it looked harmless. Nothing on this list names or locates code.
 *
 * The cost is stated rather than discovered: adding an environment variable to
 * this workflow is now an edit to this file. That is the intended price. Every
 * bypass in this ticket's sixteen rounds arrived as something nobody had
 * enumerated, and the only enumeration that survives that is the one that says
 * what is allowed.
 */
export const DECLARED_VARIABLES = {
  NODE_VERSION: 'the Node version the workflow installs and the jobs interpolate into a step name.',
  ACTIONLINT_VERSION: 'the actionlint release the lint job downloads.',
  ACTIONLINT_SHA256: 'the checksum that download is verified against.',
  DATABASE_URL: 'the connection string the `verify` job’s migrations and suite use.',
  POSTGRES_USER: 'the service container’s own credentials, read by Postgres at startup.',
  POSTGRES_PASSWORD: 'the same.',
  POSTGRES_DB: 'the same.',
  PLAYWRIGHT_JSON_OUTPUT_NAME: 'where Playwright writes the report the e2e gate reads.',
  NEEDS: 'the `toJSON(needs)` payload the gate job inspects.',
  ATRIUM_COMPOSE_PROJECT: 'the compose project name every stage of the deploy job shares.',
  ATRIUM_COMPOSE_FILES:
    'THE compose file list, declared once on the deploy job — see `compose-through-one-entrypoint`.',
  ATRIUM_STACK_DOMAIN: 'the hostname the deployment serves and the assertions ask for.',
  ATRIUM_STACK_CA: 'the path the certificate authority is copied to and verified against.',
  ATRIUM_IMAGE_MANIFEST: 'where this run records the image IDs it built.',
  VITEST_RUN_START:
    'the millisecond the unit suite started, written to `$GITHUB_ENV` so the report gate can refuse a stale report.',
  E2E_RUN_START: 'the same, for the Playwright suite.',
  GIT_TERMINAL_PROMPT:
    'git’s own "never ask for credentials" switch. Not set by the workflow today; it is here because an ACCEPTED_FORMS fixture writes it in front of the baseline fetch, and a fixture that the policy refuses is a fixture that proves nothing.',
};

/**
 * Why this variable name may not be set here, or undefined if it may.
 *
 * One sentence either way, never two: a name that is both undeclared and a
 * known injection point gets the sentence that says what it does, because "each
 * mutation fires exactly its own rule, once" is what makes the self-test's
 * purity check mean anything. Every caller below prints it after its own
 * description of *where* the name was set, so the two halves — what was done
 * and why it is refused — stay in the voice each site already had.
 */
function variableProblem(name) {
  const reason = injectionReason(name);
  if (reason !== undefined) return reason;
  if (Object.hasOwn(DECLARED_VARIABLES, name)) return undefined;
  return `\`${name}\` is not one of the environment variables this workflow declares (${Object.keys(
    DECLARED_VARIABLES,
  )
    .map((word) => `\`${word}\``)
    .join(
      ', ',
    )}). This is an allowlist because the denylist it replaces claimed to be "the union" of the variables that make a program run code it was not asked to, and was not: \`BASH_FUNC_node%%\` defines a shell function that beats the binary, \`NODE_TLS_REJECT_UNAUTHORIZED=0\` turns off the certificate verification this workflow's deploy job is conditioned on, and \`OPENSSL_CONF\` can load a provider \`.so\` — all three were clean against the previous version. To add a variable, put it here with the sentence saying which program in this repository reads it.`;
}

/**
 * Obvious redefinitions of a protected command word.
 *
 * ── WHAT THIS DOES AND DOES NOT PROVE ───────────────────────────────────────
 * Every rule in this file recognises a command by its *word*. `git fetch …` in
 * command position is a genuine invocation of whatever `git` resolves to, and a
 * shell function or a PATH entry can make that anything:
 *
 *     git() { :; }                        # the fetch runs, and does nothing
 *     export PATH="$PWD/fake:$PATH"       # so does this
 *
 * Both are banned here, along with `alias git=…`, `hash -p`, and writes to
 * `$GITHUB_PATH` (which prepends to PATH for every later step in the job).
 * That is a list of spellings, and a list of spellings is not a proof. Executable
 * *provenance* — that the `git` this step runs is the git the runner image
 * shipped — cannot be established by reading the workflow, because anything that
 * would check it also runs from the revision under test. It is owned by the
 * governance trigger in the README, and this rule exists to make the obvious
 * forms loud rather than to claim the class is closed.
 */
function checkCommandShadowing(script, where, add, path) {
  const { commands, functions } = parseScript(script);
  const protectedWord = (name) => PROTECTED_COMMANDS.includes(basename(name));

  for (const name of functions) {
    if (protectedWord(name)) {
      add(
        'no-command-shadowing',
        `${path}: the script at ${where} defines a shell function \`${name}()\`, which is one of the command words this policy recognises. Every presence rule here reads a command by its name, so redefining that name turns a gate that is present, named and invoked into a gate that does nothing.`,
      );
    }
  }

  for (const { raw, argv, assignments, redirections, via } of commands) {
    // `env PATH=/tmp/fake node …` survives `unwrap()` — the launcher's own
    // assignments are not the shell's, so the loop below never saw them. Round
    // 3's gauntlet filed it as polish, and it is the same rule: the protected
    // word stops meaning the runner's binary. On a *protected* step `env` is
    // refused outright by the launcher allowlist; this covers every other step.
    for (const assignment of via?.flatMap(({ name, assignments: words }) =>
      name === 'env' ? words : [],
    ) ?? []) {
      const name = assignment.split('=')[0];
      const problem = variableProblem(name);
      if (problem !== undefined) {
        add(
          'no-command-shadowing',
          `${path}: the script at ${where} runs \`env ${name}=…\`. That is an assignment the shell never sees — it is an argument to \`env\` — and ${problem}`,
        );
      }
    }
    for (const { name } of assignments) {
      const problem = variableProblem(name);
      if (problem !== undefined) {
        add(
          'no-command-shadowing',
          `${path}: the script at ${where} assigns \`${name}\` for one command. ${problem}`,
        );
      }
    }
    if (SHADOWING_BUILTINS.has(raw[0])) {
      for (const word of raw.slice(1)) {
        const name = word.split('=')[0];
        const problem = word.includes('=') ? variableProblem(name) : undefined;
        if (problem !== undefined) {
          add(
            'no-command-shadowing',
            `${path}: the script at ${where} runs \`${raw[0]} ${name}=…\`. ${problem}`,
          );
        }
        if (raw[0] === 'alias' && protectedWord(word.split('=')[0])) {
          add(
            'no-command-shadowing',
            `${path}: the script at ${where} aliases \`${word.split('=')[0]}\`, which is one of the command words this policy recognises.`,
          );
        }
      }
    }
    if (argv[0] === 'hash' && raw.includes('-p')) {
      add(
        'no-command-shadowing',
        `${path}: the script at ${where} runs \`hash -p\`, which points a command word at a path of its own choosing.`,
      );
    }
    // `echo "$PWD/fake" >> "$GITHUB_PATH"` prepends to PATH for every later step
    // in the job — the same shadowing, spelled as a file write.
    if (
      redirections.some(
        ({ target }) => target.expandable && /^\$\{?GITHUB_PATH\}?$/.test(target.value),
      )
    ) {
      add(
        'no-command-shadowing',
        `${path}: the script at ${where} writes to \`$GITHUB_PATH\`, which prepends a directory to PATH for every later step in the job. Invoke the binary by its full path instead.`,
      );
    }
    // `echo "NODE_OPTIONS=--require ./nobble.cjs" >> "$GITHUB_ENV"` is the same
    // thing for the variables above, and this workflow legitimately writes to
    // `$GITHUB_ENV` (the run-start timestamps), so the *payload* is what decides
    // rather than the destination. Every word of the command is inspected, which
    // covers `echo NAME=…`, `printf 'NAME=%s\n' …` and a heredoc's delimiter
    // line alike — anything naming one of these variables in an assignment
    // heading for the job's environment.
    if (
      redirections.some(
        ({ target }) => target.expandable && /^\$\{?GITHUB_ENV\}?$/.test(target.value),
      )
    ) {
      for (const word of raw) {
        const name = word.split('=')[0].trim();
        // A word is an assignment only if it is *shaped* like one. `--foo=bar`
        // contains an `=` and names no variable, and an allowlist that read it
        // as one would be a false red on the first ordinary flag.
        if (!/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)) continue;
        const problem = variableProblem(name);
        if (problem !== undefined) {
          add(
            'no-command-shadowing',
            `${path}: the script at ${where} writes \`${name}=…\` to \`$GITHUB_ENV\`, which sets it for every later step in the job. ${problem}`,
          );
        }
      }
    }
  }
}

/**
 * A protected step is one command, and it always runs.
 *
 * ── THE DEFECT (#40 round 2, shared with #28) ───────────────────────────────
 * Six rounds of hardening asked whether a protected script was *invoked*, and
 * the parser answered correctly. `false && node scripts/ci/assert-page-serves.mjs;
 * true` satisfies that question exactly: `node` is in command position, it is
 * not backgrounded, it completes. The assertion never runs, the step exits 0,
 * and — because the mutation ledger recovered the script name by regular
 * expression and ran it itself — the ledger went on certifying that the
 * assertion caught its mutation. Both halves of the verification stack agreed on
 * something false, which is the worst available outcome.
 *
 * Recognition cannot fix this, and a seventh matcher would not either:
 * `false && x` and `true && x` parse identically and nothing here evaluates a
 * shell. So the answer is to refuse the *shape* where it matters. A protected
 * step is a step whose whole purpose is to fail; if it can be written so that it
 * does not run, the guard is decoration. Canonical means: exactly one simple
 * command, no control operators, no reserved words, no subshell, not
 * backgrounded. Launchers, one-shot assignments, redirections and backslash
 * continuations all still pass, because none of them decides whether the command
 * runs.
 *
 * ── WHICH STEPS ─────────────────────────────────────────────────────────────
 *  - any step, in any job, that runs a command some rule in REQUIRED_STEPS
 *    depends on. Those are precisely the commands whose failure is the point.
 *  - *every* `run:` step of the `deploy` job, protected or not. That job is the
 *    pipeline `deploy-mutation-ledger.mjs` re-executes command for command; a
 *    step the ledger cannot run verbatim is a step it has to model, and a model
 *    is where the two descriptions drift apart.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────
 * Four forms that round 6 deliberately *accepted* — a subshell, a `&&` list, a
 * pipeline into `xargs`, and a shell function defined then called — are now
 * refused on a protected step. Round 6 was right that all four are honest
 * invocations and that a matcher which cannot see them is wrong; they are still
 * recognised. They are refused here for a different reason, and the two live
 * side by side in `workflow-policy-selftest.mjs`: recognition asks *is this a
 * command*, this asks *does it always run*.
 */
function checkProtectedStepShape(jobs, path, add) {
  for (const [jobId, required] of Object.entries(REQUIRED_STEPS)) {
    const job = jobs[jobId];
    if (!isPlainObject(job)) continue;
    const matchers = new Set();
    for (const step of required) {
      matchers.add(step.test);
      for (const prerequisite of step.requires ?? []) matchers.add(prerequisite.test);
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [index, step] of steps.entries()) {
      if (!isPlainObject(step) || typeof step.run !== 'string') continue;
      const protects = [...matchers].filter((matcher) => matcher.test(step.run));
      const everyStep = jobId === DEPLOY_JOB;
      if (protects.length === 0 && !everyStep) continue;
      const problems = singleCommandProblems(step.run);
      if (problems.length === 0) continue;
      const because =
        protects.length > 0
          ? `it runs ${protects.map(String).join(' and ')}, which this policy requires to be present`
          : 'every step of the `deploy` job is a stage the mutation ledger re-executes verbatim';
      add(
        'protected-steps-run-one-command',
        `${path}: jobs.${jobId}.steps.${index}.run is a protected step — ${because} — but ${problems.join('; and ')}. A protected step must be one unconditional command: \`false && node scripts/ci/assert-x.mjs; true\` satisfies every presence rule here, skips the assertion, and exits green. Split it into separate steps, or move the extra work into the script.`,
      );
    }
  }
}

/**
 * The deploy job resolves its compose file list exactly once.
 *
 * ── THE DEFECT (#40 round 2) ────────────────────────────────────────────────
 * "Preflight may not inspect the configuration that is deployed. Preflight
 * resolves `ATRIUM_COMPOSE_FILES`; build/up/cp/down hard-code the two base
 * files. An extra 'safe' overlay lets preflight see `gateway_mode=nat` while the
 * real `up` uses a routed base network."
 *
 * Two expressions of one list is two chances to disagree, and neither half could
 * see the other. So there is one: `scripts/ci/compose-stack.mjs`, which asks
 * `composeArgs` — the same function every assertion in the job uses. This rule
 * is what keeps it one: a bare `docker compose` in this job is refused outright,
 * because the moment a second `-f` list exists nothing in this file can prove it
 * matches the first.
 *
 * The environment variable itself must be declared on the job, and **only** on
 * the job. Without it `composeArgs` falls back to `docker-compose.yml` alone —
 * the mailpit overlay silently gone, which is a stack with no relay and a mail
 * assertion waiting for a message nobody could have sent. And re-declared on a
 * *step*, it is the original defect with a different spelling: a blind
 * cross-lineage review of the first version of this rule pointed out that
 *
 *     - run: node scripts/ci/assert-deploy-preflight.mjs
 *     - run: ATRIUM_COMPOSE_FILES=docker-compose.yml node scripts/ci/compose-stack.mjs up
 *
 * passed it, and that is exactly "the preflight sees one stack and the boot
 * brings up another". So the variable may be set in one place, and a step that
 * re-points it — by `env:` or by a one-shot assignment — is refused.
 *
 * Two more spellings from the same review: `docker-compose` (the v1 binary) is a
 * compose invocation this rule used to read as an unrelated command, and
 * `sh -c '…'` hides an entire script from an engine that parses `run:`. Neither
 * has any business in this job, so both are refused by name.
 *
 * ── ROUND 4: BY NAME WAS THE PROBLEM ────────────────────────────────────────
 * The round-3 gauntlet: "`compose-through-one-entrypoint` is a closed list of
 * binaries. Standalone `compose`, `podman compose`, and `node -e` with an inline
 * `execFileSync("docker", ["compose", …])` all pass — the same shape as `sh -c`
 * before it was banned by name." All three reproduced. It is the launcher
 * denylist again in a second file: an enumeration of ways to reach a container
 * runtime is unbounded, and the runtime does not have to be called `docker`.
 *
 * So this is an allowlist too, and a much shorter one, because the deploy job
 * genuinely only does two things. Every `run:` step of `deploy` must be either
 *
 *   - `node scripts/ci/<name>.mjs [args]`, the one file family that resolves its
 *     compose file list from `ATRIUM_COMPOSE_FILES` through `composeArgs()`, or
 *   - the `cat > .env` heredoc that writes the deployment environment.
 *
 * and anything else is refused *without this file having heard of it*. `compose
 * up`, `podman compose up`, `nerdctl compose`, `docker`, `sh -c`, `curl … |
 * sh`, `node -e "require('child_process').execFileSync('docker', …)"` and the
 * next container CLI are one clause, not five.
 *
 * `DEPLOY_ENTRYPOINTS` is exported and `deploy-mutation-ledger.mjs` classifies
 * its stages with it, so "what the policy permits in this job" and "what the
 * ledger knows how to run" are one list rather than two that agree today.
 */
const COMPOSE_VARIABLES = ['ATRIUM_COMPOSE_FILES', 'ATRIUM_COMPOSE_PROJECT'];

/** `scripts/ci/<name>.mjs`, however many `../` the step's directory needs. */
export const CI_SCRIPT_PATH = /^(?:\.\.\/)*scripts\/ci\/([a-z0-9-]+)\.mjs$/;

/**
 * The two command shapes the deploy job may run, as predicates over one parsed
 * command. Anything else is refused.
 *
 * `runsItsScript` is part of the first one deliberately: `node --check
 * scripts/ci/assert-page-serves.mjs` matches the path and executes nothing, and
 * an entrypoint allowlist that accepted it would re-open the round-3 bypass at
 * the level below the shell.
 */
/**
 * The actions the deploy job may `uses:`.
 *
 * Found by attacking the entrypoint allowlist rather than by a reviewer, and it
 * is the same hole one level out: the allowlist governs `run:` scripts, and a
 * `uses:` step is a program too. An action can call `core.exportVariable` — the
 * supported way to write `$GITHUB_ENV` — and set `NODE_OPTIONS` for every later
 * step in the job, which is the sixteenth bypass reached through a dependency
 * instead of through YAML. `pin-actions-to-sha` requires a commit SHA and says
 * nothing about whose commit.
 *
 * So this job may use two actions: a checkout and a Node install. Both are what
 * the runner needs before any of this repository's own code exists, and neither
 * is something a `scripts/ci/*.mjs` file could do instead. Anything else — a
 * cache, a docker login, a "setup" action for some tool — is refused, and the
 * refusal does not have to have heard of it.
 *
 * Compared without the `@<sha>`: the SHA is `pin-actions-to-sha`'s business and
 * a version bump must not be an edit to this list.
 */
export const DEPLOY_ACTIONS = ['actions/checkout', 'actions/setup-node'];

export const DEPLOY_ENTRYPOINTS = [
  {
    id: 'ci-script',
    describe: '`node scripts/ci/<name>.mjs [args]`',
    /** @returns {string|null} the script's bare name */
    match: ({ argv }) => {
      if (argv[0] !== 'node' || !runsItsScript(argv)) return null;
      const operand = firstOperand(argv);
      const found = operand === undefined ? null : CI_SCRIPT_PATH.exec(operand);
      return found ? found[1] : null;
    },
  },
  {
    id: 'env-file',
    describe: '`cat > .env <<…`, the deployment environment heredoc',
    match: ({ argv, redirections }) =>
      argv[0] === 'cat' &&
      redirections.some(({ op, target }) => (op === '>' || op === '>>') && target.value === '.env')
        ? '.env'
        : null,
  },
];

/**
 * Which deploy entrypoint this command is, or null.
 *
 * @param {object} command one entry of `parseScript(step.run).commands`
 * @returns {{entrypoint: object, name: string}|null}
 */
export function deployEntrypoint(command) {
  for (const entrypoint of DEPLOY_ENTRYPOINTS) {
    const name = entrypoint.match(command);
    if (name !== null) return { entrypoint, name };
  }
  return null;
}

function checkComposeEntrypoint(jobs, path, add) {
  const job = jobs[DEPLOY_JOB];
  if (!isPlainObject(job)) return;
  const files = isPlainObject(job.env) ? job.env.ATRIUM_COMPOSE_FILES : undefined;
  if (typeof files !== 'string' || files.trim() === '') {
    add(
      'compose-through-one-entrypoint',
      `${path}: job \`${DEPLOY_JOB}\` does not declare \`ATRIUM_COMPOSE_FILES\` in its \`env:\`. Every compose invocation in this job — the verbs and the assertions alike — resolves its file list from that variable, and unset it means \`docker-compose.yml\` alone: no mail catcher, and a mail assertion waiting for a message nothing could have sent.`,
    );
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!isPlainObject(step)) continue;
    for (const variable of COMPOSE_VARIABLES) {
      if (isPlainObject(step.env) && Object.hasOwn(step.env, variable)) {
        add(
          'compose-through-one-entrypoint',
          `${path}: jobs.${DEPLOY_JOB}.steps.${index}.env re-declares \`${variable}\`. It is declared once, on the job, precisely so that the preflight and the boot cannot be looking at different stacks; a step that re-points it is that divergence with the job-level declaration still in place to reassure the reader.`,
        );
      }
    }
    if (typeof step.uses === 'string') {
      const action = step.uses.split('@')[0];
      if (!DEPLOY_ACTIONS.includes(action)) {
        add(
          'compose-through-one-entrypoint',
          `${path}: jobs.${DEPLOY_JOB}.steps.${index} uses \`${action}\`, which is not one of the actions this job may run (${DEPLOY_ACTIONS.map((name) => `\`${name}\``).join(', ')}). An action is a program with the same reach as a \`run:\` step and one more capability: \`core.exportVariable\` writes \`$GITHUB_ENV\`, so an action can set \`NODE_OPTIONS\` for every later step and disarm every assertion in this job without a line of YAML that says so. If the work belongs to this deployment, it belongs in a \`scripts/ci/*.mjs\` file the ledger can run.`,
        );
      }
      continue;
    }
    if (typeof step.run !== 'string') continue;
    // A step the shape rule already refuses is refused; naming it twice would
    // make every `false && node …` mutation trip two rules, and "each mutation
    // fires exactly its own rule" is what makes the self-test's purity check
    // mean anything. `protected-steps-run-one-command` owns *is it one
    // unconditional command*; this owns *which command*.
    if (singleCommandProblems(step.run).length > 0) continue;
    for (const command of parseScript(step.run).commands) {
      for (const { name } of command.assignments) {
        if (COMPOSE_VARIABLES.includes(name)) {
          add(
            'compose-through-one-entrypoint',
            `${path}: jobs.${DEPLOY_JOB}.steps.${index}.run sets \`${name}\` for one command. Same divergence as a step \`env:\`, one line shorter: the assertions before and after it resolve a different stack from the one this command touches.`,
          );
        }
      }
      if (deployEntrypoint(command) !== null) continue;
      add(
        'compose-through-one-entrypoint',
        `${path}: jobs.${DEPLOY_JOB}.steps.${index}.run runs \`${command.raw.join(' ')}\`, which is not one of the entrypoints this job may use: ${DEPLOY_ENTRYPOINTS.map(({ describe }) => describe).join(', or ')}. This is an allowlist because the previous version was a list of binaries — \`docker\`, \`docker-compose\`, \`sh -c\` — and a blind review walked past it three ways in one line each: standalone \`compose\`, \`podman compose\`, and \`node -e\` with an inline \`execFileSync("docker", ["compose", …])\`. Anything that can reach a container runtime carries its own \`-f\` list, and a second file list is one the preflight, the image record and every assertion here cannot see. Put the work in a \`scripts/ci/*.mjs\` file, which resolves the list from ATRIUM_COMPOSE_FILES through \`composeArgs()\` like everything else in this job — and give it a mutation in \`deploy-mutation-ledger.mjs\`, which classifies stages with this same list.`,
      );
    }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collects violations, refusing any rule id not declared in RULES. A rule the
 * self-test has never heard of is a rule nobody has proved fires.
 */
function makeAdd(violations, path) {
  return (rule, message, detail = {}) => {
    if (!RULES.includes(rule)) {
      throw new Error(
        `workflow-policy: undeclared rule id "${rule}". Add it to RULES and give it a mutation in workflow-policy-selftest.mjs.`,
      );
    }
    violations.push({ rule, message, path, ...detail });
  };
}

/** Depth-first walk yielding [pathSegments, key, value] for every mapping key. */
function* walkKeys(node, path = []) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walkKeys(item, [...path, index]);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    yield [path, key, value];
    yield* walkKeys(value, [...path, key]);
  }
}

function pathString(path, key) {
  return [...path, key].join('.');
}

/** `always()`, `${{ always() }}`, `${{always()}}` all mean the same thing. */
function normalizeCondition(value) {
  return String(value)
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
}

/**
 * @param {string} source raw workflow YAML
 * @param {string} path file path, for messages
 * @returns {{rule: string, message: string}[]} every violation found
 */
export function checkWorkflow(source, path = '<workflow>') {
  const violations = [];
  const add = makeAdd(violations, path);

  const doc = parseDocument(source, { merge: false, strict: true });
  for (const error of doc.errors) {
    add('yaml-parse', `${path} is not valid YAML: ${error.message}`);
  }
  if (doc.errors.length > 0) return violations;

  // Anchors and aliases: GitHub does not support them, and a policy that reads
  // the expanded tree while a human reads the anchor is a policy nobody can
  // audit. Ban both outright.
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      add('no-yaml-alias', `${path}: YAML alias *${node.source} — aliases are not allowed.`);
    } else if (isCollection(node) && node.anchor) {
      add('no-yaml-anchor', `${path}: YAML anchor &${node.anchor} — anchors are not allowed.`);
    }
  });

  const workflow = doc.toJS({ maxAliasCount: -1 }) ?? {};
  // YAML 1.1 readers fold a bare `on` into boolean true. We parse as 1.2 (where
  // it stays a string), but accept both so the rule can never be dodged by a
  // schema quirk.
  const triggers = workflow.on ?? workflow.true ?? workflow[true];
  const jobs = isPlainObject(workflow.jobs) ? workflow.jobs : {};

  // ---- rules that apply to any key, at any depth -------------------------
  for (const [keyPath, key, value] of walkKeys(workflow)) {
    const where = pathString(keyPath, key);

    if (key === 'continue-on-error') {
      add(
        'no-continue-on-error',
        `${path}: \`continue-on-error\` at ${where}. A step allowed to fail is a gate that does not gate.`,
      );
    }

    if (key === 'shell') {
      add(
        'no-shell-override',
        // The runner's default for a step with no \`shell:\` key is \`bash -e
        // <file>\` — `-e` and nothing else. Round 4 wrote `bash -e -o pipefail`
        // here and in ci.yml, which is what `shell: bash` asks for; the ledger
        // (`RUNNER_SHELL = ['bash', '-e']`) had it right, so the two halves of
        // the verification stack disagreed in prose about the shell they claim
        // to share.
        `${path}: \`shell: ${value}\` at ${where}. The runner's default for a step with no \`shell:\` key — \`bash -e <file>\` — is the only shell allowed; an override can drop the \`-e\` that makes a failing command fail the step, and \`deploy-mutation-ledger.mjs\` re-executes these scripts under exactly that shell, so an override also makes its receipt about a different execution.`,
      );
    }

    if (key === 'if') {
      classifyCondition(keyPath, value, where, add, path);
    }

    // Where and in what a step runs — see RUNTIME_KEYS. Checked at every depth,
    // for the reason `shell` is: a key that means the same thing on a workflow,
    // a job and a step is a key that has to be refused in all three places, and
    // round 4's `uses:` guard was written for one job only.
    if (Object.hasOwn(RUNTIME_KEYS, key)) {
      const { allowed, why } = RUNTIME_KEYS[key];
      if (!allowed.includes(value)) {
        add(
          'no-runtime-override',
          `${path}: \`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\` at ${where}. ${allowed.length === 0 ? `\`${key}\` may not appear in this workflow at all` : `\`${key}\` may only be ${allowed.map((one) => `\`${one}\``).join(' or ')}`} — ${why}. Two verifiers that disagree about *where* a command ran is the same defect as two that disagree about whether it ran.`,
        );
      }
    }

    // A container action is an image with an entrypoint, and `pin-actions-to-sha`
    // deliberately skips `docker://` refs, so nothing else in this file looks at
    // one. Same clause, one line: a step may not bring its own runtime.
    if (key === 'uses' && DOCKER_USES.test(String(value))) {
      add(
        'no-runtime-override',
        `${path}: \`uses: ${value}\` at ${where} is a container action — an image with an entrypoint, run in place of a step. ${RUNTIME_KEYS.container.why}.`,
      );
    }

    if (key === 'timeout-minutes' && keyPath.at(-2) === 'steps') {
      add(
        'no-step-timeout',
        `${path}: step-level \`timeout-minutes\` at ${where}. A per-step timeout turns a hung test suite into a red step that a later edit can mask; the job-level timeout already fails the whole job closed.`,
      );
    }

    if (key === 'run' && typeof value === 'string') {
      for (const { pattern, label } of FAIL_OPEN_SHELL) {
        if (pattern.test(value)) {
          add('no-fail-open-shell', `${path}: ${label} in the script at ${where}.`);
        }
      }
      if (INJECTABLE_CONTEXT.test(value)) {
        add(
          'no-untrusted-interpolation',
          `${path}: attacker-controllable \`github.event\` context interpolated into the script at ${where}. Pass it through \`env:\` instead.`,
        );
      }
      checkCommandShadowing(value, where, add, path);
    }

    // `env: { PATH: … }` is a PATH assignment this rule claimed to ban and did
    // not, because it only ever read `run:` scripts. GitHub applies it to the
    // step, the job or the whole workflow depending on where it sits, so it is
    // the same bypass as `export PATH=…` with a longer reach and no shell.
    // Round 4 widened it from PATH to every variable in INJECTING_VARIABLES —
    // see that table for why `NODE_OPTIONS` belongs beside it.
    // Round 5 inverted it again, from "the injecting variables" to "the
    // variables this workflow declares" — see DECLARED_VARIABLES for why a
    // denylist here could not be finished. `BASH_FUNC_node%%: "() { return 0; }"`
    // is a legal YAML key and was clean against round 4.
    if (key === 'env' && isPlainObject(value)) {
      for (const name of Object.keys(value)) {
        const problem = variableProblem(String(name));
        if (problem !== undefined) {
          add(
            'no-command-shadowing',
            `${path}: \`env:\` at ${where} sets \`${name}\`. ${problem} Set it nowhere, or invoke the binary by its full path with the flags written in the step.`,
          );
        }
      }
    }
  }

  // ---- triggers ----------------------------------------------------------
  const triggerNames = isPlainObject(triggers)
    ? Object.keys(triggers)
    : Array.isArray(triggers)
      ? triggers.map(String)
      : triggers
        ? [String(triggers)]
        : [];
  for (const required of REQUIRED_TRIGGERS) {
    if (!triggerNames.includes(required)) {
      add(
        'required-triggers',
        `${path}: missing the \`${required}\` trigger. A merge queue that never gets a run treats the absence of a verdict as consent.`,
      );
    }
  }

  // ---- permissions -------------------------------------------------------
  if (!isPlainObject(workflow.permissions) || workflow.permissions.contents !== 'read') {
    add(
      'least-privilege',
      `${path}: workflow-level \`permissions:\` must declare \`contents: read\` so a job inherits nothing it did not ask for.`,
    );
  }

  // ---- actions are pinned to commit SHAs ---------------------------------
  for (const [index, line] of source.split('\n').entries()) {
    const match = USES_LINE.exec(line);
    if (!match) continue;
    const [, ref, comment] = match;
    const at = `${path}:${index + 1}`;
    if (LOCAL_USES.test(ref) || DOCKER_USES.test(ref)) continue;
    if (!PINNED_USES.test(ref)) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` is not pinned to a 40-character commit SHA. A tag is mutable; whoever can move it can run code here.`,
      );
      continue;
    }
    if (!comment || !VERSION_COMMENT.test(comment)) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` needs a trailing \`# vN.N.N\` comment recording which release the SHA is, so the pin stays auditable.`,
      );
    }
  }

  // ---- every job is bounded, and defined here -----------------------------
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    if (typeof job['timeout-minutes'] !== 'number') {
      add(
        'job-timeout-required',
        `${path}: job \`${jobId}\` has no \`timeout-minutes\`. A job that can hang forever is a check that never reports.`,
      );
    }
    // A reusable workflow moves the job body somewhere this engine cannot read
    // it. For a remote one that body is a different repository's file, on a ref
    // whose contents can change without a commit here — the policy would be
    // enforcing rules over a stub while the real steps ran elsewhere. Refused
    // outright, local ones included, so that adopting one is a deliberate edit
    // to this rule rather than a quiet hole. (Round-2 receipt: none are used
    // today; this converts the gap into a loud choice.)
    if (job.uses !== undefined) {
      add(
        'no-remote-reusable-workflow',
        `${path}: job \`${jobId}\` delegates to the reusable workflow \`${job.uses}\`. Reusable workflows are refused: their steps are not in this file, so nothing here can check them, and a remote one can change without a commit to this repository. Inline the job.`,
      );
    }
    if (job.secrets !== undefined) {
      add(
        'no-remote-reusable-workflow',
        `${path}: job \`${jobId}\` passes \`secrets:\` to a called workflow. Only reusable-workflow calls take that key, and those are refused.`,
      );
    }
  }

  // ---- the checks themselves must still be wired up -----------------------
  for (const [jobId, required] of Object.entries(REQUIRED_STEPS)) {
    const job = jobs[jobId];
    if (!isPlainObject(job)) {
      add(
        'required-job-steps',
        `${path}: no \`${jobId}\` job. The gates this repo relies on are declared per job in scripts/ci/workflow-policy.mjs; a workflow without \`${jobId}\` is missing ${required.length} of them.`,
      );
      continue;
    }
    const scripts = jobStepScripts(job);
    // Every index that matches, not the first one. Round 4 used `findIndex` on
    // both halves of a pair, which answers "is there a match somewhere" and then
    // silently assumes the first match is the one that matters. That is fine
    // while each pattern occurs once and wrong the moment one does not: a step
    // that appears twice has its second occurrence judged by the first one's
    // position. The satisfying prerequisite is now located per occurrence.
    const indicesOf = (test) => scripts.flatMap((step, index) => (test.test(step) ? [index] : []));

    for (const { rule, what, test, requires = [] } of required) {
      const stepIndices = indicesOf(test);
      if (stepIndices.length === 0) {
        add(
          rule,
          `${path}: job \`${jobId}\` never runs ${what} (nothing in its steps matches ${test}). A job can satisfy every other rule here and still prove nothing by quietly dropping the step that does the proving.`,
        );
        continue;
      }
      // The step is here. Everything it silently depends on had better be here
      // too, and earlier — a gate whose setup is gone does not fail, it drifts.
      for (const prerequisite of requires) {
        const pair = { job: jobId, step: what, needs: prerequisite.what };
        const prerequisiteIndices = indicesOf(prerequisite.test);
        if (prerequisiteIndices.length === 0) {
          add(
            'required-step-prerequisites',
            `${path}: job \`${jobId}\` runs ${what} but never runs ${prerequisite.what}, which it depends on (nothing matches ${prerequisite.test}). ${prerequisite.because}. A gate that still runs with its setup deleted is worse than a deleted gate: it reports.`,
            { pair },
          );
          continue;
        }
        // Each occurrence of the step needs *some* occurrence of its setup in
        // front of it. Report the first one that has none.
        const unsatisfied = stepIndices.find(
          (stepIndex) => !prerequisiteIndices.some((before) => before < stepIndex),
        );
        if (unsatisfied !== undefined) {
          add(
            'required-step-prerequisites',
            `${path}: job \`${jobId}\` runs ${what} at step ${unsatisfied} but the earliest ${prerequisite.what} is step ${prerequisiteIndices[0]}, i.e. afterwards. ${prerequisite.because}. Order the pair, or the earlier step is decoration.`,
            { pair },
          );
        }
      }
    }
  }

  // ---- the protected steps are canonical, and compose is resolved once ----
  checkProtectedStepShape(jobs, path, add);
  checkComposeEntrypoint(jobs, path, add);
  for (const problem of protectedCommandCoverage(jobs)) {
    add('protected-commands-cover-the-verbs', `${path}: ${problem}`);
  }

  // ---- the gate ----------------------------------------------------------
  const gate = jobs[GATE_JOB];
  if (!isPlainObject(gate)) {
    add(
      'gate-covers-all-jobs',
      `${path}: no \`${GATE_JOB}\` job. Every workflow needs exactly one job that fails unless all the others succeeded — it is the only check that may be marked required.`,
    );
  } else {
    const needs = Array.isArray(gate.needs) ? gate.needs : gate.needs ? [String(gate.needs)] : [];
    const others = Object.keys(jobs).filter((id) => id !== GATE_JOB);
    const uncovered = others.filter((id) => !needs.includes(id));
    if (uncovered.length > 0) {
      add(
        'gate-covers-all-jobs',
        `${path}: job(s) ${uncovered.map((id) => `\`${id}\``).join(', ')} are not in \`${GATE_JOB}.needs\`. A job the gate does not need is a job whose failure nothing reports.`,
      );
    }
    for (const need of needs) {
      if (!Object.hasOwn(jobs, need)) {
        add(
          'gate-covers-all-jobs',
          `${path}: \`${GATE_JOB}.needs\` names \`${need}\`, which is not a job in this file.`,
        );
      }
    }
    if (normalizeCondition(gate.if ?? '') !== 'always()') {
      add(
        'gate-runs-always',
        `${path}: \`${GATE_JOB}\` must declare \`if: always()\`. Without it the gate is skipped whenever a needed job is skipped or fails, and GitHub reports a skipped required check as success.`,
      );
    }
    checkGateInspectsNeeds(gate, path, add);
  }

  return violations;
}

/**
 * One script per step, in order.
 *
 * Round 3 flattened the whole job into a single string, which answers "is this
 * mentioned anywhere" and nothing else. Prerequisites are a question about
 * *order*, so the steps have to stay separate: a report reset that happens after
 * the run it is supposed to precede reads exactly like one that happens before
 * it, once the newlines are gone.
 */
function jobStepScripts(job) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps.map((step) => (isPlainObject(step) ? `${step.run ?? ''}\n${step.uses ?? ''}` : ''));
}

/**
 * The gate must actually read the results it needs — parsed, not grepped.
 *
 * Round 2 checked this with `JSON.stringify(gate).includes('toJSON(needs)')`,
 * which a comment containing that string satisfies just as well as a working
 * gate. So: find the step that binds `${{ toJSON(needs) }}` into an environment
 * variable, then read the script that step runs and require it to read that
 * variable, iterate it, look at each job's `result`, compare against the
 * literal `success`, exit non-zero when one is not, and refuse an empty `needs`
 * rather than passing by vacuous truth. gate-selftest.mjs then extracts that
 * same script and *runs* it against synthetic `needs` payloads, which is the
 * only check that can tell working code from convincing code.
 */
function checkGateInspectsNeeds(gate, path, add) {
  const steps = Array.isArray(gate.steps) ? gate.steps : [];
  let bound;
  for (const step of steps) {
    if (!isPlainObject(step) || typeof step.run !== 'string') continue;
    const env = isPlainObject(step.env) ? step.env : {};
    const entry = Object.entries(env).find(([, value]) =>
      /toJSON\s*\(\s*needs\s*\)/.test(String(value)),
    );
    if (entry) {
      bound = { name: entry[0], run: step.run };
      break;
    }
  }

  if (bound === undefined) {
    add(
      'gate-inspects-needs',
      `${path}: no step in \`${GATE_JOB}\` binds \`\${{ toJSON(needs) }}\` into an \`env:\` variable and then reads it. The gate must inspect every needed job's \`result\` and fail unless each one is literally \`success\`.`,
    );
    return;
  }

  const { name, run } = bound;
  const readsVariable = new RegExp(
    `process\\.env\\.${name}\\b|process\\.env\\[\\s*["']${name}["']\\s*\\]|\\$\\{?${name}\\b`,
  );
  const checks = [
    { ok: readsVariable.test(run), why: `never reads the \`${name}\` variable it binds` },
    {
      ok: /Object\.(entries|values|keys)\s*\(|\bfor\s*\(|\.map\s*\(|\.filter\s*\(/.test(run),
      why: 'never iterates the needed jobs, so it can only be looking at one of them (or none)',
    },
    { ok: /\bresult\b/.test(run), why: "never looks at any job's `result`" },
    {
      ok: /["']success["']/.test(run),
      why: 'never compares a result against the literal `success`, so `skipped` and `cancelled` would read as fine',
    },
    {
      ok: /process\.exit\s*\(\s*[1-9]|\bexit\s+[1-9]/.test(run),
      why: 'never exits non-zero, so whatever it finds it reports green',
    },
    {
      ok: /length\s*(?:===?|<)\s*[01]\b/.test(run),
      why: 'does not fail on an empty `needs`, so a gate quietly emptied of its dependencies would pass by vacuous truth',
    },
  ];
  for (const { ok, why } of checks) {
    if (!ok) {
      add(
        'gate-inspects-needs',
        `${path}: the \`${GATE_JOB}\` step that binds \`toJSON(needs)\` ${why}.`,
      );
    }
  }
}

/** `if:` is allowed in exactly two places; everything else is a verdict in disguise. */
function classifyCondition(keyPath, value, where, add, path) {
  const condition = normalizeCondition(value);
  const [root, jobId, maybeSteps] = keyPath;

  const isJobLevel = root === 'jobs' && keyPath.length === 2;
  const isStepLevel = root === 'jobs' && maybeSteps === 'steps' && keyPath.length === 4;

  if (isJobLevel) {
    if (jobId === GATE_JOB) return; // checked separately: must be always()
    add(
      'no-job-condition',
      `${path}: \`if: ${value}\` on job \`${jobId}\`. GitHub reports a skipped required check as *success*, so a condition on a gating job is a bypass — this is the exact hole \`if: \${{ false }}\` opens.`,
    );
    return;
  }

  if (isStepLevel) {
    // `failure()` is provisionally allowed here; checkConditionalStepsAreUploads
    // then proves the step it sits on is an artifact upload and nothing else.
    if (condition === 'failure()') return;
    add(
      'no-step-condition',
      `${path}: \`if: ${value}\` at ${where}. The only step condition allowed is \`if: failure()\` on an artifact upload — a condition on anything else lets a gate decline to run and still report green.`,
    );
    return;
  }

  add(
    'no-stray-condition',
    `${path}: \`if: ${value}\` at ${where}, which is not a place a condition belongs.`,
  );
}

/** Steps carrying `if: failure()` must be artifact uploads and nothing else. */
export function checkConditionalStepsAreUploads(workflow, path, add) {
  const jobs = isPlainObject(workflow.jobs) ? workflow.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job) || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!isPlainObject(step) || step.if === undefined) continue;
      const uses = String(step.uses ?? '');
      if (!uses.startsWith('actions/upload-artifact@')) {
        add(
          'no-step-condition',
          `${path}: jobs.${jobId}.steps.${index} carries \`if:\` but is not an \`actions/upload-artifact\` step. Conditions may gate artifacts, never verdicts.`,
        );
      }
    }
  }
}

/** Runs both passes over one file. */
export function checkWorkflowFile(source, path) {
  const violations = checkWorkflow(source, path);
  const doc = parseDocument(source, { merge: false, strict: true });
  if (doc.errors.length === 0) {
    checkConditionalStepsAreUploads(
      doc.toJS({ maxAliasCount: -1 }) ?? {},
      path,
      makeAdd(violations, path),
    );
  }
  return violations;
}

function main(argv) {
  const files = argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/ci/workflow-policy.mjs <workflow.yml> [...]');
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const violations = checkWorkflowFile(readFileSync(file, 'utf8'), file);
    for (const violation of violations) {
      console.error(`::error file=${file}::[${violation.rule}] ${violation.message}`);
    }
    failed += violations.length;
    if (violations.length === 0) console.info(`Workflow policy: ${file} clean.`);
  }
  if (failed > 0) console.error(`Workflow policy: ${failed} violation(s).`);
  return failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
