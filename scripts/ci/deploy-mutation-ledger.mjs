/**
 * The re-runnable ledger behind #40's mutation claims.
 *
 * Every assertion the `deploy` job runs states, in its own header, the source or
 * configuration mutation it catches. A claim like that is a hypothesis until
 * somebody makes the mutation and watches the check go red — and the standing
 * rule in this repository is that a test whose mutation nobody can name is not
 * yet a test. This is how the naming is checked rather than believed.
 *
 * It is **not** a CI gate and is deliberately not wired into the workflow: it
 * cycles the whole stack once per case, which is minutes each, and its value is
 * as a receipt a reviewer can reproduce rather than as a per-commit check.
 *
 *   node scripts/ci/deploy-mutation-ledger.mjs            # every case
 *   node scripts/ci/deploy-mutation-ledger.mjs proxy-misroute hops-zero
 *   node scripts/ci/deploy-mutation-ledger.mjs --pipeline  # print the pipeline
 *
 * Environment: the same variables the deploy job sets — `ATRIUM_COMPOSE_PROJECT`,
 * `ATRIUM_COMPOSE_FILES`, `ATRIUM_STACK_DOMAIN`, `ATRIUM_STACK_CA` — plus a
 * `.env` compose can interpolate. The images must already be built.
 *
 * ## Round 2: it runs the real job, in the real order
 *
 * Round 1's gauntlet, and the finding that mattered most here: "the ledger's
 * named-check attribution is false. `hops-zero` and `split-secret` are both
 * stopped by `assert-stack-config` before the rate-limit and websocket scripts
 * the ledger credits, because the ledger bypasses the ordered job and invokes
 * those scripts directly. It proves each script *can* fail, not that CI catches
 * each mutation *by the named check*."
 *
 * That was exactly right, and it was the second appearance of the class (CI
 * round 4 had two mutations passing for another rule's reason), so the fix is a
 * property of this file rather than an edit to two cases:
 *
 *  1. **The pipeline is read out of `.github/workflows/ci.yml`.** `PIPELINE`
 *     below is derived from the `deploy` job's steps, in file order. There is no
 *     second copy of the order to drift, and a step added to the job that this
 *     file cannot classify is a hard error rather than a silently skipped stage.
 *  2. **Every case runs that pipeline from the top** and stops at the first
 *     stage that fails. What is recorded is the stage that *actually* fired.
 *  3. **A case whose declared `catches` is not the stage that fired is a ledger
 *     failure**, exactly like a mutation nothing catches. Where an earlier gate
 *     legitimately gets there first, the case says so and names it — see
 *     `hops-zero`, `split-secret` and `up-but-not-serving`, all three of which
 *     now credit the check that really stops them, with the check they were
 *     written for named in the note.
 *
 * The consequence worth stating: re-attributing those three left
 * `assert-rate-limit` and `assert-ws-upgrade` with no mutation that reaches them
 * at all, which is what "the attribution was false" *meant* in practice. Two new
 * cases — `trusted-cidr-swallows-caller` and `no-ws-route` — get past every
 * earlier gate and fail at those two.
 *
 * ## How the mutations are applied
 *
 * As a **third compose overlay**, wherever that is possible, rather than as an
 * edit to a tracked file. Two reasons. It keeps the ledger re-runnable from a
 * clean checkout with no `git stash` dance, and — more usefully — it means each
 * case mutates exactly one thing and puts it back, so a case that passes for the
 * wrong reason is much harder to write. Compose merges `volumes` by target path
 * and `networks` by key, so "the shipped Caddyfile, with one upstream changed"
 * and "this project's network, with its gateway mode changed" are both one-line
 * overlays. The three cases that cannot be expressed that way — an engine
 * version, an image identity, and the teardown's own flags — say so and are
 * driven directly.
 *
 * The two stages that describe *what was built* rather than *what is running* —
 * the build and the image record — always run against the shipped files with no
 * overlay. That is what makes `swapped-image` meaningful: the manifest says what
 * this tree builds, and the stack is running something else.
 *
 * ## Round 3: it runs the command the workflow runs, not one of its own
 *
 * Round 2's gauntlet found what "runs the real job" was still short of: this
 * file recovered each step's *script name* with a regular expression and then
 * invoked `node <that name>` itself. So
 *
 *     false && node scripts/ci/assert-page-serves.mjs; true
 *
 * skipped the assertion in CI, exited the step green — and the ledger extracted
 * `assert-page-serves.mjs`, ran it, watched it fail, and certified that the
 * assertion CI had skipped caught its mutation. Both halves of the verification
 * stack reported success about something false, which is strictly worse than
 * either half being missing.
 *
 * Two changes, and they are the same change from two ends:
 *
 *  1. **The workflow's deploy steps are canonical single commands**, enforced by
 *     `protected-steps-run-one-command` in `workflow-policy.mjs`. There is no
 *     conditional form left to recover a name out of.
 *  2. **This file parses each step with the same parser the policy uses and
 *     executes the resulting argv verbatim** — `execFileSync(argv[0],
 *     argv.slice(1))`, no shell, no reconstruction. A step whose argv it cannot
 *     execute (an expansion it would have to resolve, a shape the policy would
 *     refuse) is a hard error, not a stage quietly modelled.
 *
 * ## Round 4: the same command is not the same execution
 *
 * The round-3 gauntlet, on `setsid -f node scripts/ci/assert-page-serves.mjs`:
 * "CI (bash, parent returns) and the ledger (`execFileSync`, Node waits on the
 * child tree) again describe different executions." Exactly so, and it is worth
 * being precise about the mechanism, because the two halves fail in opposite
 * directions. GitHub runs the step as `bash -e <file>`: `setsid -f` forks, the
 * parent exits 0 in about two milliseconds, and the runner marks the step green
 * while the assertion is still starting. This file ran the same words through
 * `execFileSync` with piped stdio — which returns when the pipes reach EOF, and
 * the detached grandchild inherited them, so Node waited for the whole tree and
 * saw the assertion's real outcome. A ledger that reports CAUGHT for an
 * execution CI never performed is the round-2 defect with the halves swapped.
 *
 * So the ledger stopped having an execution model of its own. Each stage's
 * `run:` script is written to a file and executed the way the runner executes
 * it — `bash -e <file>`, with `-o pipefail` deliberately *not* added, because
 * GitHub's default shell for a step with no `shell:` key does not add it either
 * and the point is to be the same shell rather than a better one. The workflow
 * is checked for anything that would make that untrue (a `defaults.run.shell`,
 * a job or step `shell:`) and refuses to run if it finds one, rather than
 * trusting `no-shell-override` to have been enforced by a different program.
 *
 * The shape rule is still asked first, so nothing conditional or multi-command
 * reaches bash here; what bash adds is the *process semantics* — who waits for
 * whom — which is the half an argv cannot carry.
 *
 * The mutation overlay reaches those commands the way the real job's file list
 * reaches them: through `ATRIUM_COMPOSE_FILES`, which
 * `scripts/ci/compose-stack.mjs` and every assertion resolve from. That is why
 * the compose verbs had to stop carrying literal `-f` flags — with them, no
 * ledger could have run the workflow's own command against a mutated stack.
 *
 * ## What a "pass" means here
 *
 * The named stage **failed** against the mutated stack, no earlier stage did,
 * and the whole pipeline passes against the unmutated one — which the deploy job
 * proves on every run.
 *
 * ## The tree it reads
 *
 * A clean one, at a HEAD that does not move. Round 2 recorded a run that was
 * invalid because the branch was switched underneath it: the pipeline came from
 * one `ci.yml` and the scripts from a different working tree. That is checked
 * now rather than remembered, and there is no override — an override is how a
 * limitation becomes a receipt nobody can trust.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { notAVerdict } from './child-verdict.mjs';
import { firstOperand, parseScript, singleCommandProblems } from './shell-command.mjs';
import { deployEntrypoint } from './workflow-policy.mjs';

const project = process.env.ATRIUM_COMPOSE_PROJECT?.trim() || 'atrium-ledger';
const baseFiles = (
  process.env.ATRIUM_COMPOSE_FILES?.trim() || 'docker-compose.yml:docker-compose.mailpit.yml'
)
  .split(/[:,]/)
  .filter(Boolean);
const workDir = mkdtempSync(join(tmpdir(), 'atrium-ledger-'));
const manifestFile = join(workDir, 'built-images.json');

// ─── The pipeline, read out of the workflow ──────────────────────────────────

const WORKFLOW = process.env.CI_WORKFLOW ?? '.github/workflows/ci.yml';

/**
 * One `deploy` step, as something this file can run.
 *
 * `id` is what the ledger credits, and it is the vocabulary the `catches` field
 * of every case is written in: a script name for the assertions, and a phrase
 * for the compose verbs — the same phrases `scripts/ci/workflow-policy.mjs`
 * uses for the same steps, so a reader moving between the two files does not
 * have to translate.
 *
 * A step this cannot classify throws. That is the point: a new gate added to the
 * deploy job without a line here would otherwise be a stage the ledger silently
 * never runs, and every case would keep passing while the job it claims to
 * mirror had grown a check nobody mutated.
 *
 * `record-built-images` gets a kind of its own rather than falling into the
 * generic `script` bucket, and that distinction is load-bearing rather than
 * tidy: it decides whether the stage sees the mutation overlay. The first run
 * of this file had it in the generic bucket, so `swapped-image` recorded the
 * doppelganger as "what this run built" and the identity assertion compared the
 * mutated stack against a manifest of the mutated stack — and passed. A ledger
 * case that goes green because the check was handed the wrong baseline is the
 * exact failure this whole file exists to detect, and it took a full run to
 * find it. See `runStage`.
 */
const RECORDS_WHAT_WAS_BUILT = 'record-built-images';

/** The compose verbs `scripts/ci/compose-stack.mjs` takes, and what they are. */
const COMPOSE_VERBS = {
  build: { kind: 'build', id: 'the image build' },
  up: { kind: 'up', id: 'the stack boot' },
  'trust-ca': { kind: 'cp-ca', id: 'the certificate-authority copy' },
  down: { kind: 'down', id: 'the teardown' },
};

/**
 * One step's argv, classified — never its text.
 *
 * Round 2 matched `/node\s+scripts\/ci\/([a-z0-9-]+)\.mjs/` against the whole
 * `run:` string and executed whatever name came back, which is how
 * `false && node …assert-page-serves.mjs; true` produced a ledger line
 * certifying an assertion CI had skipped. The argv comes from the same parser
 * `workflow-policy.mjs` uses, and it is the thing that gets executed.
 *
 * Round 4: *which* commands are classifiable is no longer decided here. It is
 * `deployEntrypoint()`, exported by the policy engine, which is the same list
 * `compose-through-one-entrypoint` allows in this job. Two files agreeing about
 * what may run in the deploy job used to be two lists that happened to match;
 * now it is one list, and teaching the policy a new entrypoint without teaching
 * this file is a syntax error rather than a silently skipped stage.
 */
function classify(command, script) {
  const found = deployEntrypoint(command);
  if (found === null) return null;
  // `script`, not the argv: the step is executed by bash exactly as the runner
  // executes it, so what a stage carries is the text of its own `run:` block.
  // Round 3 executed the argv and had to reason about which launcher it had
  // unwrapped; round 4 does not reason about it at all.
  const run = { argv: command.raw, script };
  if (found.entrypoint.id === 'env-file') {
    return { kind: 'environment', id: 'the deployment environment', ...run };
  }
  const name = found.name;
  if (name === 'compose-stack') {
    const operand = firstOperand(command.argv);
    const verb = firstOperand(command.argv, command.argv.indexOf(operand) + 1);
    const definition = verb && Object.hasOwn(COMPOSE_VERBS, verb) ? COMPOSE_VERBS[verb] : null;
    return definition ? { ...definition, ...run } : null;
  }
  const kind = name.startsWith('assert-')
    ? 'assertion'
    : name === RECORDS_WHAT_WAS_BUILT
      ? 'record'
      : 'script';
  return { kind, id: name, ...run };
}

/**
 * The shell GitHub Actions runs a `run:` step with, and the proof that it is
 * still that one.
 *
 * A step with no `shell:` key runs as `bash -e <file>` on a Linux runner —
 * `-e` and nothing else, which is why `-o pipefail` is deliberately absent both
 * here and from the `execFileSync` below. Every way of changing that —
 * `defaults.run.shell` at workflow or job level, a `shell:` on the step — is
 * refused by `no-shell-override` in the policy engine, and is re-checked here
 * rather than assumed: this file's whole claim in round 4 is that it executes
 * what CI executes, and "a different program enforces that" is not a claim, it
 * is a dependency.
 */
const RUNNER_SHELL = ['bash', '-e'];

/**
 * Every key that would make CI's execution differ from this file's, checked
 * before a single stage runs.
 *
 * ── WHY THIS IS NO LONGER ONLY ABOUT THE SHELL (#40 round 5) ────────────────
 * Round 4 asked one of the three questions this file depends on. `shell:`
 * decides *what interprets* the script and was checked; `container:` decides
 * *what image it runs in* and was not, and `working-directory:` decides *where*
 * and was not either. A deploy job with `container: { image: … }` runs every
 * stage inside somebody's image on the runner while this file runs it with the
 * host's `bash` from the repository root — two receipts about two executions,
 * which is precisely the failure round 4 claims to have closed. `runs-on:` is
 * the same question one level out.
 *
 * The policy engine refuses all four (`no-shell-override` and
 * `no-runtime-override`). They are re-checked here for the reason the shell
 * always was: this file may only *execute* what it read, and a dependency on
 * another program having run is not a proof.
 */
function requireSameExecutionContext(workflow) {
  const overrides = [];
  const note = (where, what) => overrides.push(`${where} (${what})`);
  const runtime = (where, node) => {
    if (node?.container !== undefined) note(`${where}.container`, 'a different image');
    if (node?.['working-directory'] !== undefined) {
      note(`${where}.working-directory`, 'a different directory');
    }
    if (node?.['runs-on'] !== undefined && node['runs-on'] !== 'ubuntu-latest') {
      note(`${where}.runs-on`, 'a different machine');
    }
  };

  if (workflow?.defaults?.run?.shell !== undefined) note('defaults.run.shell', 'a different shell');
  runtime('defaults.run', workflow?.defaults?.run);
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job?.defaults?.run?.shell !== undefined) {
      note(`jobs.${jobId}.defaults.run.shell`, 'a different shell');
    }
    runtime(`jobs.${jobId}.defaults.run`, job?.defaults?.run);
    runtime(`jobs.${jobId}`, job);
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (step?.shell !== undefined)
        note(`jobs.${jobId}.steps.${index}.shell`, 'a different shell');
      runtime(`jobs.${jobId}.steps.${index}`, step);
    }
  }
  if (overrides.length > 0) {
    throw new Error(
      `${WORKFLOW} changes the execution context at ${overrides.join(', ')}. This ledger runs every stage as \`${RUNNER_SHELL.join(' ')} <script>\`, on this host, from the repository root, because that is what the runner does with a step that declares none of those keys. A receipt from a different shell, a different image or a different directory is a receipt about a different execution — which is exactly how \`setsid -f node …\` came to be green in CI and caught here at the same time.`,
    );
  }
}

function readPipeline() {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
  requireSameExecutionContext(workflow);
  const steps = workflow?.jobs?.deploy?.steps;
  if (!Array.isArray(steps)) throw new Error(`${WORKFLOW} has no \`deploy\` job with steps`);
  const pipeline = [];
  for (const step of steps) {
    // `uses:` steps are the runner's own setup — a checkout and a Node install.
    // They are not stages of the deployment and there is nothing here to mutate.
    if (typeof step?.run !== 'string') continue;
    const where = `the deploy step "${step.name ?? '(unnamed)'}"`;

    // The same question the policy engine asks, asked again here rather than
    // assumed: this file is only allowed to *execute* what it read, so a step
    // that is not one unconditional command is a step it cannot honestly run.
    // The policy would already have refused it; a ledger that trusted the policy
    // to have run is a ledger with a hole exactly the shape of the last one.
    const problems = singleCommandProblems(step.run);
    if (problems.length > 0) {
      throw new Error(
        `${WORKFLOW}: ${where} is not a single unconditional command — ${problems.join('; and ')}. This ledger executes each step's own argv, so it cannot run this one, and it will not guess: a stage the ledger models instead of running is how \`false && node …; true\` came to be certified as caught.\n${step.run}`,
      );
    }

    const [command] = parseScript(step.run).commands;
    const expandable = command.words.find((word) => word.expandable);
    if (expandable) {
      throw new Error(
        `${WORKFLOW}: ${where} contains the word ${JSON.stringify(expandable.value)}, which the shell would expand. The deploy job's steps are executed here under a bash whose environment is this ledger's, not the runner's, so a \`$VAR\` would resolve to a different value — or to nothing — and the stage would be a different command from the one CI runs.`,
      );
    }
    if (command.assignments.length > 0) {
      throw new Error(
        `${WORKFLOW}: ${where} sets ${command.assignments.map(({ name }) => `\`${name}\``).join(', ')} for the command. This ledger replays the written argv with an environment of its own, so a one-shot assignment is a difference between what CI runs and what this file runs — and, for the compose variables, it is the divergence the policy engine refuses outright.`,
      );
    }

    const stage = classify(command, step.run);
    if (stage === null) {
      throw new Error(
        `${WORKFLOW}: ${where} runs \`${command.raw.join(' ')}\`, which this ledger cannot classify, so every case below would skip it silently. It is not one of the entrypoints \`compose-through-one-entrypoint\` allows in this job either — the policy engine and this file read the same list — so teach both, and give it a mutation.`,
      );
    }
    pipeline.push({ ...stage, name: step.name ?? stage.id });
  }
  return pipeline;
}

const PIPELINE = readPipeline();

// ─── The cases ───────────────────────────────────────────────────────────────

/**
 * Each case: what is mutated, which stage of the real job must catch it, and why
 * that is the interesting failure rather than an incidental one.
 *
 * `catches` is asserted, not decoration. It names a stage id from the pipeline
 * above, and the run fails if a different stage fires.
 */
const CASES = [
  {
    id: 'old-engine',
    what: 'a Docker engine that reports 27.5.1',
    catches: 'assert-deploy-preflight',
    prepare: oldEngineShim,
    note: 'Routed here from #26 round 6, and the one prerequisite no file in this repository can supply. Pre-28 engines DNAT published ports ahead of the filter chain, so `127.0.0.1:8025` — mailpit, a store of live sign-in links — is reachable from any host that can route a packet here, and a hostname matcher cannot help because `Host` is written by the client. The mutation is a `docker` earlier on PATH that answers `version` with 27.5.1 and forwards everything else, because a runner cannot be downgraded. It changes what the check observes about the host, not what the check is.',
  },
  {
    id: 'routed-gateway',
    what: "the project's network switched to gateway mode `routed`",
    catches: 'assert-deploy-preflight',
    overlay: {
      networks: {
        default: { driver_opts: { 'com.docker.network.bridge.gateway_mode_ipv4': 'routed' } },
      },
    },
    note: 'The same exposure as the old engine, re-enabled by configuration on a new one: in `routed` mode container addresses are directly routable and published-port filtering does not apply, so Postgres on 5432 and MinIO on 9000 are open to anything that can route to the subnet — neither of which this stack publishes, which is exactly why nothing else would notice. Caught before the images are even built, which is what a preflight is for.',
  },
  {
    id: 'no-transport',
    what: 'ATRIUM_MAIL_TRANSPORT=console on both processes — the pre-#40 state',
    catches: 'the stack boot',
    overlay: {
      services: {
        app: { environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' } },
        server: { environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' } },
      },
    },
    note: 'With no relay, `resolveMailer` refuses the console transport in production and both processes fail their boot condition. Before #40 the web app answered 500 to every request instead; `instrumentation.ts` turns that into a refusal to start, so this is caught at `up --wait` rather than by a page assertion.',
  },
  {
    id: 'no-health-check',
    what: "the app's health check disabled",
    catches: 'the stack boot',
    overlay: { services: { app: { healthcheck: { disable: true } } } },
    note: 'This case was written expecting `assert-stack-health` to catch it, on the belief that `docker compose up --wait` settles for "running" when a service has no health check. It does not: compose v2.39.1 fails the whole `up` with `container … has no healthcheck configured`, so the mutation is caught a step earlier and the ledger\'s first run reported MISSED — correctly, because the check it *named* never got to run. The belief was wrong, the comment in assert-stack-health.mjs that stated it has been corrected, and this entry names the step that really catches it. Also worth keeping: the pre-#40 `app` had no health check at all, so it could not have been brought up with `--wait` either.',
  },
  {
    id: 'up-but-not-serving',
    what: "the missing transport again, with the app's health check disabled",
    catches: 'the stack boot',
    overlay: {
      services: {
        app: {
          environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' },
          healthcheck: { disable: true },
        },
        server: { environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' } },
      },
    },
    note: 'Round 1\'s gauntlet called this out and it was right: this case was credited to `assert-page-serves` and cannot reach it. It disables the health check *and* breaks the server, so the boot fails on two counts and the page assertion — when the old ledger invoked it directly, out of order — was running against an already-failed stack. Two variables, wrong starting state. It stays, credited to the boot, because what it does demonstrate is real: a health check is the only thing standing between compose and a container that reports "running" while serving nothing. The page assertion\'s own demonstration is `proxy-misroute`, which starts from a fully green boot.',
  },
  {
    id: 'swapped-image',
    what: 'the app running a functionally identical image that is not the one built',
    catches: 'assert-image-identity',
    prepare: buildImageDoppelganger,
    overlay: (context) => ({ services: { app: { image: context.doppelganger } } }),
    note: "Round 1's gauntlet: built, scanned and running were three things bound together by a tag. The mutant here is `FROM <the built app image>` plus one label — a different image ID with byte-identical behaviour — so every other assertion in the job passes: the pages serve, the configuration is production, the signup verifies. Nothing but an identity comparison can tell the two apart, which is the whole argument for having one. Note that the image record deliberately runs against the shipped files, so the manifest says what this tree builds while the stack runs something else.",
  },
  {
    id: 'unenrolled-service',
    what: 'a new long-lived service joining the stack with nobody deciding what "well" means for it',
    catches: 'assert-stack-health',
    overlay: {
      services: {
        stowaway: {
          image: 'alpine:3',
          command: ['sleep', '600'],
          // A health check that always passes, so `up --wait` is satisfied and
          // the only thing left to object is the enrolment rule.
          healthcheckTest: ['CMD', 'true'],
        },
      },
    },
    note: 'The mutation `assert-stack-health` catches that nothing else does. `--wait` is happy — the container is healthy — and every other assertion is about services it knows by name. Only the enrolment rule notices that something is running which no list accounts for.',
  },
  {
    id: 'development-node-env',
    what: 'NODE_ENV=development smuggled onto the realtime server by an overlay',
    catches: 'assert-stack-config',
    overlay: { services: { server: { environment: { NODE_ENV: 'development' } } } },
    note: 'The lever this assertion exists for: an overlay that quietly turns the deploy job into a check on a development stack while every other assertion keeps passing.',
  },
  {
    id: 'hops-zero',
    what: 'ATRIUM_TRUSTED_PROXY_HOPS=0 on the web app',
    catches: 'assert-stack-config',
    overlay: { services: { app: { environment: { ATRIUM_TRUSTED_PROXY_HOPS: '0' } } } },
    note: 'Written for `assert-rate-limit` — a Server Action has no peer address, so every caller falls into `unresolvedIpKey` and the limiter stops being per-address, which is precisely what #26 round 3 shipped. The ordered job never gets that far: `assert-stack-config` reads the hop count back out of the running container four steps earlier and refuses anything but a positive whole number. Round 1 credited the rate-limit script because the old ledger invoked it directly. The earlier gate is the honest answer and this entry now gives it; the case that genuinely exercises the limiter is `trusted-cidr-swallows-caller`.',
  },
  {
    id: 'split-secret',
    what: 'a different BETTER_AUTH_SECRET on the realtime server',
    catches: 'assert-stack-config',
    overlay: {
      services: {
        server: { environment: { BETTER_AUTH_SECRET: 'a-different-secret-0123456789abcdef' } },
      },
    },
    note: "Same correction as `hops-zero`. Both processes work perfectly alone and no session crosses between them — the two-components-that-never-meet class at the deployment layer — and `assert-ws-upgrade` would indeed go red on it. But `assert-stack-config` compares the two containers' secrets and fires first, which is the better outcome: it names the divergence instead of reporting a refused upgrade. The websocket assertion's own demonstration is `no-ws-route`.",
  },
  {
    id: 'swapped-migration-image',
    what: 'the migration container pointed at an image that is not the one built',
    catches: 'assert-migration-image',
    prepare: (entry) => buildImageDoppelganger(entry, 'migrate'),
    overlay: (context) => ({ services: { migrate: { image: context.doppelganger } } }),
    note: "Round 2's gauntlet, on ordering: `migrate` runs *during* `up`, because `server` and `app` both declare `service_completed_successfully` on it — so by the time `assert-image-identity` inspects a container, an unknown migration image has already written to a persistent volume and the job is rejecting a database it cannot un-migrate. The fix is a check that happens before the boot, and this is its mutation. Delete the `Assert the migration image…` step and re-run this case to see the difference: the same overlay then gets all the way to `assert-image-identity`, which is a true statement made too late.",
  },
  {
    id: 'proxy-misroute',
    what: 'deploy/Caddyfile answering `/` — and only `/` — from a port nothing listens on',
    catches: 'assert-page-serves',
    caddyfile: (text) => insertIntoSite(text, ['handle / {', '\treverse_proxy app:3001', '}']),
    note: 'The case this ticket exists for, and the one round 1 blocked on: until then no mutation reached the page assertion from a green boot. `app` listens on 3000 and its health check fetches its own `127.0.0.1:3000`, so it is healthy; `server` is untouched; `proxy` health-checks its own loopback admin listener, so it is healthy too. Every container is well, the configuration is production, the images are the built ones — and the proxy answers 502 on `/`. Round 2 broke the whole catch-all; this breaks the single route, which is both a sharper statement (`/sign-up` still works, so the mail assertion ahead of this one stays green) and a more realistic one, since a route-specific `handle` is how a real Caddyfile goes wrong.',
  },
  {
    id: 'static-page-fixture',
    what: 'deploy/Caddyfile answering `/` with a copy of the page instead of proxying it',
    catches: 'assert-page-serves',
    caddyfile: (text) =>
      insertIntoSite(text, ['handle / {', `\trespond \`${PAGE_FIXTURE}\` 200`, '}']),
    note: 'Round 2\'s gauntlet, blocking 3: "`/` can be a static proxy fixture rather than the app. `assert-page-serves` matches fixed HTML markers and a fixed sign-in link, so a first `handle /` returning a stale copy passes while `/sign-up` stays proxied and health, signup, ws and rate-limit all go green." This is that Caddyfile, and it is a *successful non-product response* — the 502 above was the only failure mode the ledger had. Everything else in the job is untouched and passes: the app\'s own health check fetches `127.0.0.1:3000` and never crosses the proxy, and every other assertion uses another route. What catches it is that the fixture cannot name the account looking at it — the page assertion fetches `/` as a per-run account and compares the rendered name against the one Postgres holds — and cannot answer two different requests differently.',
  },
  {
    id: 'session-conditional-page-fixture',
    what: 'the same fixture, shown only to callers without a session cookie, with the app’s headers forged',
    catches: 'assert-page-serves',
    caddyfile: (text) =>
      insertIntoSite(text, [
        '@fixture {',
        '\tpath /',
        '\tnot header_regexp Cookie "session"',
        '}',
        'handle @fixture {',
        // The two headers round 3 compared against `/sign-in`'s, forged
        // byte-for-byte — including the `Accept-Encoding` Caddy's own `encode`
        // appends, which took three measurements to get exactly right and is
        // the whole point: this is a *constant*, and getting a constant right is
        // an afternoon's work for anybody who wants to. With them wrong round
        // 3's assertion catches this; with them right it passes.
        '\theader X-Powered-By "Next.js"',
        '\theader Vary "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding"',
        `\trespond \`${PAGE_FIXTURE}\` 200`,
        '}',
      ]),
    note: "Round 3's own blind review found this and round 3 could not close it: a fixture conditioned on the *presence* of a session cookie leaves the authenticated branch as the real app, so the per-run account name renders, the two polarities differ, and every check round 3 had is satisfied. Round 3 answered it by comparing `x-powered-by` and `Vary` against `/sign-in`'s — and the round-3 gauntlet's first major was that those are constants a Caddyfile writes with one line each, which is what the two `header` directives here demonstrate. Measured on one live stack at one moment, this exact Caddyfile mounted: round 3's `assert-page-serves` printed `passed.`, and round 4's printed two failures. What catches it is a request the fixture cannot be conditioned on: `/` fetched a third time carrying the session cookie's names with values that are not a session, which every cookie-presence rule routes to the app, and a comparison of the `/_next/static/…` chunk names the two signed-out responses reference.",
  },
  {
    id: 'schema-short-of-the-migrations',
    what: 'a table dropped from the composed stack after a migration that exited 0',
    catches: 'assert-stack-schema',
    afterBoot: 'drop table corrections cascade',
    note: 'Round 2\'s gauntlet: "migration success means only exit code 0, with no composed-stack schema assertion and no ledger case." This produces exactly the state that hides behind a zero exit — the migration ran, the container reported success, and the deployed schema is not what the migrations describe. It is applied as SQL after the boot rather than as an overlay because no overlay can express it: `migrate` would have to run a different program, which is a Dockerfile edit. Nothing else in the job notices, because nothing else in the job reads the schema and none of the asserted paths touches `corrections`.',
  },
  {
    id: 'dead-relay',
    what: 'SMTP_URL pointed at a port nothing listens on',
    catches: 'assert-signup-verifies',
    overlay: {
      services: {
        app: { environment: { SMTP_URL: 'smtp://mailpit:1099' } },
        server: { environment: { SMTP_URL: 'smtp://mailpit:1099' } },
      },
    },
    note: 'The configuration is well-formed, so every boot condition passes and the stack is healthy. Nothing is delivered. This is the case a config-shape check cannot reach and only a real message can.',
  },
  {
    id: 'no-ws-route',
    what: 'the `handle /ws*` block removed from deploy/Caddyfile',
    catches: 'assert-ws-upgrade',
    caddyfile: (text) =>
      text.replace(/\thandle \/ws\* \{\n\t\treverse_proxy server:4000\n\t\}\n/, ''),
    note: "The websocket assertion's own mutation, replacing the credit `split-secret` used to take. The realtime server is untouched and healthy, every page serves, signup verifies — and the upgrade falls through to the catch-all and reaches the Next app, which does not speak RFC 6455. Nothing else in the job routes anything to `/ws`, so nothing else notices.",
  },
  {
    id: 'origin-baked-into-the-image',
    what: 'a `wss://` realtime origin compiled into the web image the stack runs',
    catches: 'assert-image-origins',
    prepare: bakeRealtimeOrigin,
    note: "Round 3's gauntlet: the origin scan was required by policy and never mutation-proven — the one stage exempted for a reason that was about how the original defect got authored rather than about what the check can see. It is not an overlay, because the scan reads the recorded image ID rather than a tag: the tag `compose build` produced is re-pointed at a derived image carrying one unreferenced `.js` file with a `wss://` URL in it, and the pipeline's own `record-built-images` then resolves it. Built, recorded, running and scanned all move together, which is why `assert-image-identity` — the only stage that could have fired first — stays green, along with the boot, the pages, the signup and the websocket upgrade. The file is inert on purpose: the original defect (`next.config.ts` carrying `NEXT_PUBLIC_WS_URL`) breaks the boot as well, and a mutation that breaks four things proves nothing about which check caught it.",
  },
  {
    id: 'trusted-cidr-swallows-caller',
    what: 'ATRIUM_TRUSTED_PROXY_CIDRS widened to the whole stack subnet',
    catches: 'assert-rate-limit',
    overlay: {
      services: {
        app: { environment: { ATRIUM_TRUSTED_PROXY_CIDRS: '172.28.0.0/16' } },
        server: { environment: { ATRIUM_TRUSTED_PROXY_CIDRS: '172.28.0.0/16' } },
      },
    },
    note: "The rate limiter's own mutation, and the topology error `docker-compose.yml`'s comment warns about in so many words: trusting a range rather than the proxy's address swallows every caller on it as \"one of ours\". `firstUntrustedHop` walks the chain from the right, finds every entry inside the trusted range, runs out, and returns null — so both callers land in `unresolvedIpKey`, one shared bucket, and the second is refused with the first. The hop count is still 1 and the secret is still shared, so `assert-stack-config` has nothing to object to: this is a per-address limiter degraded to a global one with every configuration assertion green.",
  },
  {
    id: 'teardown-keeps-volumes',
    what: '`docker compose down` without `-v`',
    catches: 'assert-stack-teardown',
    teardownFlags: ['down', '--remove-orphans'],
    note: "One character. Four named volumes survive, and on a real host the next `up` adopts last month's database. The only case that mutates a pipeline stage rather than the stack, because the flag *is* the thing under test.",
  },
];

// ─── Running one stage ───────────────────────────────────────────────────────

function compose(files, args, options = {}) {
  return execFileSync(
    'docker',
    ['compose', '-p', project, ...files.flatMap((file) => ['-f', file]), ...args],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    },
  );
}

/**
 * Runs a command and reports whether it succeeded, never throwing.
 *
 * `error.message` from `execFileSync` already ends with the child's stderr, so
 * appending stderr to it prints every `::error::` annotation twice and the
 * ledger's one-line verdict reads as two. It is only used when nothing was
 * captured at all — a binary that did not exist, a timeout.
 */
function attempt(run) {
  try {
    return { ok: true, output: run() };
  } catch (error) {
    const captured = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return {
      ok: false,
      output: captured.trim() === '' ? String(error.message) : captured,
      inconclusive: notAVerdict(error, STAGE_TIMEOUT_MS),
    };
  }
}

/** A YAML overlay for one case, written without a YAML library. */
function writeOverlay(id, overlay) {
  const path = join(workDir, `mutation-${id}.yml`);
  const lines = ['# generated by scripts/ci/deploy-mutation-ledger.mjs', 'name: atrium'];
  if (overlay.services) {
    lines.push('services:');
    for (const [service, body] of Object.entries(overlay.services)) {
      lines.push(`  ${service}:`);
      if (body.image) lines.push(`    image: ${JSON.stringify(body.image)}`);
      if (body.command) lines.push(`    command: ${JSON.stringify(body.command)}`);
      if (body.healthcheck?.disable) lines.push('    healthcheck:', '      disable: true');
      if (body.healthcheckTest) {
        lines.push(
          '    healthcheck:',
          `      test: ${JSON.stringify(body.healthcheckTest)}`,
          '      interval: 5s',
          '      retries: 3',
        );
      }
      if (body.volumes) {
        lines.push('    volumes:');
        for (const volume of body.volumes) lines.push(`      - ${JSON.stringify(volume)}`);
      }
      if (body.environment) {
        lines.push('    environment:');
        for (const [key, value] of Object.entries(body.environment)) {
          lines.push(`      ${key}: ${JSON.stringify(String(value))}`);
        }
      }
    }
  }
  if (overlay.networks) {
    lines.push('networks:');
    for (const [network, body] of Object.entries(overlay.networks)) {
      lines.push(`  ${network}:`);
      if (body.driver_opts) {
        lines.push('    driver_opts:');
        for (const [key, value] of Object.entries(body.driver_opts)) {
          lines.push(`      ${key}: ${JSON.stringify(String(value))}`);
        }
      }
    }
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/**
 * A `docker` earlier on PATH that lies about the engine version.
 *
 * The only way to run the preflight against an engine this machine does not
 * have. Everything except `docker version` is forwarded to the real binary, so
 * the mutation is one answer to one question rather than a fake docker.
 */
function oldEngineShim(entry) {
  const dir = join(workDir, `shim-${entry.id}`);
  const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'docker');
  writeFileSync(
    shim,
    `#!/bin/sh\n# generated by scripts/ci/deploy-mutation-ledger.mjs — case ${entry.id}\nif [ "$1" = "version" ]; then echo "27.5.1"; exit 0; fi\nexec ${real} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return { env: { PATH: `${dir}:${process.env.PATH}` } };
}

/**
 * A page that carries every structural marker `assert-page-serves` looks for and
 * is not the app.
 *
 * Three `data-region` sections, a sign-in link with its test id, and nothing
 * else — copied from what the real home page renders, which is exactly the point:
 * every one of those markers is a constant, and a constant can be copied. What
 * cannot be copied is the display name of an account created ninety seconds ago,
 * or a second answer to a second request.
 *
 * Backticks, because Caddy takes a backtick-quoted token and the markup has to
 * carry double quotes to be the markup.
 */
const PAGE_FIXTURE = [
  '<!doctype html><html lang="en"><body><main>',
  '<section data-region="conversation"><h2>Conversation</h2></section>',
  '<section data-region="current-state"><h2>Current state</h2></section>',
  '<section data-region="needs-you"><h2>Needs you</h2></section>',
  '<span><a data-testid="sign-in-link" href="/sign-in">sign in</a></span>',
  '</main></body></html>',
].join('');

/**
 * The shipped Caddyfile with a `handle` block added to the site, ahead of the
 * catch-all.
 *
 * Ahead of it deliberately: Caddy evaluates `handle` blocks in the order they
 * are written, so a route-specific one placed first wins — which is both how a
 * real Caddyfile misroutes a single path and the only way to mutate one route
 * without touching the others.
 */
function insertIntoSite(text, block) {
  const anchor = '\t# Everything else is the Next.js app';
  const at = text.indexOf(anchor);
  if (at === -1) {
    throw new Error(
      'deploy/Caddyfile no longer has the catch-all comment this mutation anchors on; a mutation that cannot find its anchor must say so rather than change nothing',
    );
  }
  return `${text.slice(0, at) + block.map((line) => `\t${line}\n`).join('')}\n${text.slice(at)}`;
}

/**
 * An image that behaves exactly like the built one and is not it.
 *
 * `FROM <the built app image>` plus a label: one extra empty layer, a new image
 * ID, and nothing a behavioural assertion could ever distinguish. That is the
 * argument for asserting identity at all, made into a fixture.
 *
 * The `FROM` names the **tag**, not the recorded ID, because BuildKit reads a
 * bare `sha256:…` in a `FROM` as a repository name on Docker Hub and goes and
 * asks for it (measured: `pull access denied … library/sha256:cdf8f…`). So the
 * tag is used, and the tag is checked against the recorded ID first — otherwise
 * this would be building a doppelganger of whatever happened to answer to the
 * name, which is the very confusion the case exists to demonstrate.
 */
function buildImageDoppelganger(entry, service = 'app') {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const built = manifest[service];
  if (!built?.id || !built?.image) {
    throw new Error(`no \`${service}\` image in the manifest to make a doppelganger of`);
  }
  const resolved = execFileSync(
    'docker',
    ['image', 'inspect', built.image, '--format', '{{.Id}}'],
    { encoding: 'utf8' },
  ).trim();
  if (resolved !== built.id) {
    throw new Error(
      `\`${built.image}\` resolves to ${resolved}, not the recorded ${built.id}; the doppelganger would be built from the wrong image`,
    );
  }
  const tag = `atrium-ledger-doppelganger:${entry.id}`;
  execFileSync('docker', ['build', '-t', tag, '-f', '-', workDir], {
    input: `FROM ${built.image}\nLABEL org.atrium.ledger="${entry.id}"\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    doppelganger: tag,
    cleanup: () => attempt(() => execFileSync('docker', ['rmi', '-f', tag])),
  };
}

/**
 * A realtime origin baked into the shipped web image (#40 round 4).
 *
 * ── WHY THIS CASE EXISTS ────────────────────────────────────────────────────
 * The round-3 gauntlet: "`assert-image-origins` is `EXEMPT` in the ledger —
 * required by policy, never mutation-proven." It was exempted on the grounds
 * that its mutation is "a `next.config.ts` revert and a rebuild", which is true
 * of the *original* defect and was the wrong question. What has to be
 * demonstrated is that the scan goes red when the literal is in the image, not
 * that one particular authoring mistake puts it there.
 *
 * ── HOW IT REACHES THE SCANNER, WHICH IS THE INTERESTING PART ───────────────
 * `assert-image-origins` deliberately scans the image ID `record-built-images`
 * wrote down, never a tag — that was round 1's fix, and it means an overlay
 * pointing `services.app.image` somewhere else does not move the scan at all.
 * So this case does not use an overlay. It re-points the *tag* `docker compose
 * build` produced, at an image derived from it that carries one extra file, and
 * then lets the pipeline's own `record-built-images` stage resolve that tag —
 * exactly as the real job does. Built, recorded, running and scanned all move
 * together, which is why `assert-image-identity` (two stages earlier, and the
 * one thing that could have fired first) stays green.
 *
 * The extra file is an unreferenced `.js` under `.next` holding a `wss://` URL.
 * Deliberately inert: the app must boot, serve, sign users up and answer a
 * websocket upgrade, so that the only stage with anything to say about it is the
 * scan. A `next.config.ts` revert would fail the boot as well, and a case that
 * breaks four things proves nothing about which check caught it.
 */
function bakeRealtimeOrigin(entry, service = 'app') {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const built = manifest[service];
  if (!built?.id || !built?.image) {
    throw new Error(`no \`${service}\` image in the manifest to bake an origin into`);
  }
  const original = execFileSync(
    'docker',
    ['image', 'inspect', built.image, '--format', '{{.Id}}'],
    { encoding: 'utf8' },
  ).trim();
  if (original !== built.id) {
    throw new Error(
      `\`${built.image}\` resolves to ${original}, not the recorded ${built.id}; this case would bake an origin into an image nobody built`,
    );
  }
  // Assembled rather than written, so that this source file does not itself
  // contain the literal the scan forbids — the file would then be a hit for
  // anybody who ever pointed the scan at the repository instead of the image.
  const probe = `export const realtime = ${JSON.stringify(`${'ws'}s://probe.example/ws`)};\n`;
  const probeFile = join(workDir, 'atrium-ledger-probe.js');
  writeFileSync(probeFile, probe);
  execFileSync('docker', ['build', '-t', built.image, '-f', '-', workDir], {
    input: `FROM ${built.image}\nCOPY atrium-ledger-probe.js /app/apps/web/.next/atrium-ledger-probe.js\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mutated = execFileSync('docker', ['image', 'inspect', built.image, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();
  if (mutated === original) {
    throw new Error(
      `building a layer onto \`${built.image}\` produced the same image ID ${original}; the tag was not re-pointed and this case would assert nothing`,
    );
  }
  return {
    // The tag is put back on the image this tree actually built. Without this
    // every later case would run against the mutant — the crash-safety lesson
    // from #22 r5, applied to a tag rather than to a file.
    cleanup: () => {
      attempt(() => execFileSync('docker', ['tag', original, built.image]));
      attempt(() => execFileSync('docker', ['rmi', '-f', mutated]));
    },
  };
}

/** The shipped Caddyfile with one thing changed, mounted over the shipped one. */
function writeCaddyfile(entry) {
  const original = readFileSync('deploy/Caddyfile', 'utf8');
  const mutated = entry.caddyfile(original);
  if (mutated === original) {
    throw new Error(
      `case ${entry.id} changed nothing in deploy/Caddyfile — the file moved under the edit, and a mutation that mutates nothing reports CAUGHT for the wrong reason`,
    );
  }
  const path = join(workDir, `Caddyfile-${entry.id}`);
  writeFileSync(path, mutated);
  return { services: { proxy: { volumes: [`${path}:/etc/caddy/Caddyfile:ro`] } } };
}

/**
 * Did the boot fail *because of the mutation*, or because of the machine?
 *
 * The first draft of this file read any non-zero `up` as the mutation being
 * caught, and the first real run of it duly reported CAUGHT on a case whose
 * stack had failed to start because another compose project on the same laptop
 * already held the subnet. That is the "passed for the wrong reason" failure
 * this whole ledger exists to detect, committed by the ledger itself. So the
 * failure has to be about a *container*: compose names one when a service fails
 * its own condition, and says something about networks, images or ports when the
 * environment is at fault.
 */
const CONTAINER_FAILURE = /container .* (is unhealthy|exited|has no healthcheck configured)/i;

/**
 * The workflow's own step, run the way the runner runs it.
 *
 * ── WHY A SHELL, AFTER ROUND 3 REMOVED ONE (#40 round 4) ────────────────────
 * Round 3 executed `execFileSync(argv[0], argv.slice(1))` precisely so that no
 * shell could be involved, and that was the right answer to round 2's defect
 * (a *name* recovered by regex and run in place of the step). It introduced a
 * different one. `execFileSync` with piped stdio returns when the pipes reach
 * EOF, so a step that detaches its command — `setsid -f node …` — was waited for
 * here and not waited for on the runner. This file reported CAUGHT for an
 * execution CI never performs.
 *
 * Two verifiers that disagree about what "ran" means is the whole ticket. So the
 * step's own `run:` text is written to a file and executed as `bash -e <file>`,
 * which is what a runner does with a step that has no `shell:` key — verified at
 * startup by `requireDefaultShell`. `bash` reaps nothing the runner would not
 * reap: `setsid -f node x` now returns here in milliseconds, the stage goes
 * green, and the mutation the assertion was supposed to catch is reported MISSED
 * — which is the true answer.
 *
 * Nothing conditional reaches this function: `singleCommandProblems` has already
 * refused every shape that could skip or background the command, and the policy
 * engine refuses the same shapes in the workflow. What bash contributes is only
 * the process semantics — who waits for whom — which is the half an argv cannot
 * carry.
 *
 * Everything a stage needs to know about *which* stack it is looking at arrives
 * through the environment, because that is how the real job tells it too:
 * `compose-stack.mjs` and every assertion resolve their file list from
 * `ATRIUM_COMPOSE_FILES` via `composeArgs`.
 */
let stepSerial = 0;

/** How long a stage may take before this file stops believing its own receipt. */
const STAGE_TIMEOUT_MS = 420_000;

function runValidatedCommand(stage, files, env) {
  stepSerial += 1;
  const scriptFile = join(workDir, `step-${stepSerial}.sh`);
  writeFileSync(scriptFile, stage.script);
  return attempt(() =>
    execFileSync(RUNNER_SHELL[0], [...RUNNER_SHELL.slice(1), scriptFile], {
      encoding: 'utf8',
      env: {
        ...env,
        ATRIUM_COMPOSE_PROJECT: project,
        ATRIUM_COMPOSE_FILES: files.join(':'),
        ATRIUM_IMAGE_MANIFEST: manifestFile,
      },
      timeout: STAGE_TIMEOUT_MS,
    }),
  );
}

function runStage(stage, entry, context) {
  const { files, env } = context;
  // The build and the record describe what this tree produces, so they run
  // against the shipped files: a mutation is a statement about what is *running*.
  const stageFiles = stage.kind === 'build' || stage.kind === 'record' ? baseFiles : files;

  switch (stage.kind) {
    case 'environment':
      // A heredoc into `.env`, which the ledger's own documentation requires the
      // caller to have supplied. There is no argv to run without a shell, and
      // nothing in it an overlay could reach that the overlays do not.
      return { skipped: true };
    case 'build':
      // The images are built once, before the ledger runs. Rebuilding them per
      // case would be tens of minutes and no case mutates a Dockerfile.
      return { skipped: true };
    case 'down':
      // The one place a case is allowed to run something other than the
      // workflow's command, and it is stated where it happens rather than in a
      // footnote: `teardown-keeps-volumes` mutates the teardown's *flags*, so
      // for that case the command under test IS the mutation and there is
      // nothing else it could mean. Every other case runs the real verb.
      if (entry.teardownFlags) {
        return attempt(() => compose(stageFiles, entry.teardownFlags, { env }));
      }
      return runValidatedCommand(stage, stageFiles, env);
    case 'cp-ca':
    case 'up':
    case 'record':
    case 'script':
    case 'assertion':
      return runValidatedCommand(stage, stageFiles, env);
    default:
      throw new Error(`unhandled stage kind ${stage.kind}`);
  }
}

// ─── Running one case ────────────────────────────────────────────────────────

function runCase(entry) {
  const cleanups = [];
  const context = { files: baseFiles, env: process.env };
  let prepared = {};
  try {
    if (entry.prepare) {
      prepared = entry.prepare(entry) ?? {};
      if (prepared.cleanup) cleanups.push(prepared.cleanup);
      if (prepared.env) context.env = { ...process.env, ...prepared.env };
    }
    const overlay =
      typeof entry.overlay === 'function'
        ? entry.overlay(prepared)
        : (entry.overlay ?? (entry.caddyfile ? writeCaddyfile(entry) : undefined));
    if (overlay) context.files = [...baseFiles, writeOverlay(entry.id, overlay)];
  } catch (error) {
    return {
      entry,
      verdict: 'inconclusive',
      fired: null,
      detail: `the case could not be set up: ${error.message}`,
    };
  }

  attempt(() => compose(context.files, ['down', '-v', '--remove-orphans'], { env: context.env }));

  let fired = null;
  let output = '';
  let setupFailure = null;
  for (const stage of PIPELINE) {
    const result = runStage(stage, entry, context);
    if (result.skipped) continue;
    if (!result.ok) {
      // A stage that did not exit on its own has not decided anything — see
      // `notAVerdict`. Reporting CAUGHT here would credit an assertion with a
      // verdict it never reached, which is the failure this whole file exists
      // to detect, committed by the file itself.
      if (result.inconclusive !== undefined) {
        setupFailure = `\`${stage.name}\` (${stage.id}) did not produce a verdict: ${result.inconclusive}. Its output was: ${lastLines(result.output, 2)}`;
        break;
      }
      fired = stage;
      output = result.output;
      break;
    }
    // A mutation that no overlay can express, applied at the one moment it is
    // expressible. `schema-short-of-the-migrations` is the only user: the state
    // it needs — a migration that reported success over a schema that is not the
    // one the migrations describe — exists only once the stack is up, and
    // producing it any other way means editing a Dockerfile.
    if (stage.kind === 'up' && entry.afterBoot) {
      const applied = attempt(() =>
        compose(
          context.files,
          [
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            'atrium',
            '-d',
            'atrium',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            entry.afterBoot,
          ],
          { env: context.env },
        ),
      );
      if (!applied.ok) {
        setupFailure = `the post-boot mutation \`${entry.afterBoot}\` did not apply: ${lastLines(applied.output, 2)}`;
        break;
      }
    }
  }

  attempt(() => compose(context.files, ['down', '-v', '--remove-orphans'], { env: context.env }));
  for (const cleanup of cleanups) cleanup();

  if (setupFailure !== null) {
    return { entry, verdict: 'inconclusive', fired: null, detail: setupFailure };
  }
  if (fired === null) {
    return {
      entry,
      verdict: 'missed',
      fired: null,
      detail: `the whole pipeline stayed green under the mutation; ${entry.catches} does not catch what it names`,
    };
  }
  // A boot that failed for a reason that is not a container's is the machine,
  // not the mutation, and reporting either verdict on it would be a guess.
  if (fired.kind === 'up' && !CONTAINER_FAILURE.test(output)) {
    return {
      entry,
      verdict: 'inconclusive',
      fired,
      detail: `the boot failed for a reason that is not the mutation: ${lastLines(output, 2)}`,
    };
  }
  if (fired.id !== entry.catches) {
    return {
      entry,
      verdict: 'misattributed',
      fired,
      detail: `${fired.id} fired first, not ${entry.catches}: ${lastLines(output, 3)}`,
    };
  }
  return { entry, verdict: 'caught', fired, detail: lastLines(output, 4) };
}

/**
 * The lines worth reading out of a failed run.
 *
 * `report()` in `stack-client.mjs` prints the stack's container logs when an
 * assertion fails, which is right in CI and drowns this ledger's one-line
 * summary in a hundred lines of Better Auth warnings. So when the output
 * contains GitHub error annotations — which is what an assertion's own verdict
 * looks like — those are the lines; only otherwise does it fall back to the
 * tail.
 */
function lastLines(text, count) {
  const annotations = String(text)
    .split('\n')
    .filter((line) => line.startsWith('::error::'));
  if (annotations.length > 0) {
    return annotations.slice(0, count).join(' | ').replaceAll('::error::', '').slice(0, 700);
  }
  // A script that *threw* rather than reporting — `assert-signup-verifies`
  // waiting for mail that never arrives is the one that does — writes a stack
  // trace, whose last lines are node's own frames. The thrown message is the
  // line worth reading.
  const thrown = String(text)
    .split('\n')
    .filter((line) => /^[A-Za-z]*Error: /.test(line.trim()));
  if (thrown.length > 0) return thrown.slice(0, count).join(' | ').slice(0, 700);
  return String(text)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('::group'))
    .slice(-count)
    .join(' | ')
    .slice(0, 700);
}

// ─── The run ─────────────────────────────────────────────────────────────────

/**
 * Every stage of the real job that can fail must have a case naming it.
 *
 * The other half of "the ledger runs the real pipeline": running it proves the
 * attribution, and this proves the *coverage*. A gate added to the deploy job
 * with no mutation behind it is a gate nobody has watched go red, and this file
 * is where that becomes visible instead of being noticed two rounds later.
 *
 * `EXEMPT` is the exception list, and every entry states why the stage cannot
 * have a mutation of its own — not why nobody got round to it.
 *
 * ── ROUND 3: AN EXEMPTION IS A CLAIM, AND CLAIMS GET STATED ─────────────────
 * Round 2's gauntlet: "ledger coverage exempts six stages rather than exercising
 * them, so 'a stage no case names refuses to run' is not an invariant — a new
 * stage can be exempted in the same edit." Both halves are true, and they need
 * different answers.
 *
 * The exemptions themselves survive scrutiny, and each entry below now says
 * exactly which mutation is impossible rather than gesturing at "no overlay can
 * express it". Two of them were previously the vaguest and are the most worth
 * being precise about: `record-built-images` runs against the *shipped* files by
 * construction — that is what makes `swapped-image` mean anything at all — so no
 * overlay can reach it by design rather than by omission; and `the teardown` has
 * no failure of its own to demonstrate, but its argv is not unexercised, because
 * `teardown-keeps-volumes` mutates exactly that argv and the next stage catches
 * the result.
 *
 * "A new stage can be exempted in the same edit" is the real point and cannot be
 * closed from inside — but it can stop being quiet. `EXEMPT_COUNT` is asserted
 * against the table and quoted in the README, so exempting a stage is an edit to
 * a number a reviewer sees, next to a reason they can read.
 *
 * ── ROUND 4: ONE OF THE SIX WAS AN EXCUSE AFTER ALL ─────────────────────────
 * The round-3 gauntlet: "`assert-image-origins` is EXEMPT — required by policy,
 * never mutation-proven." Its entry read "its mutation is a `next.config.ts`
 * revert and a rebuild", which is a true statement about how the *original*
 * defect was authored and the wrong question entirely: what needs demonstrating
 * is that the scan goes red when the literal is in the image, not that one
 * particular mistake puts it there. `origin-baked-into-the-image` does that
 * without a rebuild, and the table is five. Worth keeping as a lesson about
 * exemption prose: an entry that describes the *cause* rather than the
 * *observation* is an entry nobody has re-derived.
 */
const EXEMPT = {
  'the deployment environment':
    'a heredoc writing the .env this ledger requires the caller to have supplied. There is no argv to run without a shell, and every value in it is interpolated by docker-compose.yml with no default — so the mutation "this file is wrong" is already caught by compose refusing to start, one stage later and by name.',
  'the image build':
    'the ledger runs against images built once beforehand, because rebuilding per case is tens of minutes. A mutation here is a Dockerfile edit, which is the one thing no overlay can express.',
  'record-built-images':
    'it runs against the *shipped* files, always, and that is not an omission — it is what makes `swapped-image` mean anything: the manifest says what this tree builds while the stack runs something else. An overlay that could reach this stage would be an overlay that could forge the baseline, which the round-2 run demonstrated by accident.',
  'the certificate-authority copy':
    'copies one file out of the proxy and refuses an empty result. It has no configuration an overlay could reach; its one real failure mode is running before the proxy exists, which is a `required-step-prerequisites` pair in the workflow policy with a mutation of its own.',
  'the teardown':
    "`docker compose down` fails for reasons that are the machine's, not a configuration's. Its argv is exercised rather than assumed: `teardown-keeps-volumes` mutates this stage's own flags and `assert-stack-teardown` catches the result, so what is missing is a failure *of* this stage, not a test *through* it.",
};

/**
 * How many stages of the deploy job have no mutation of their own.
 *
 * Asserted against `EXEMPT` rather than derived from it, so that exempting a new
 * stage is an edit to a number a reviewer can see, in a file the README quotes.
 */
export const EXEMPT_COUNT = 5;

function checkCoverage() {
  const named = new Set(CASES.map((entry) => entry.catches));
  const problems = [];
  if (Object.keys(EXEMPT).length !== EXEMPT_COUNT) {
    problems.push(
      `EXEMPT holds ${Object.keys(EXEMPT).length} stages and EXEMPT_COUNT says ${EXEMPT_COUNT}. Exempting a stage is allowed and has to be visible: change the number, and expect to justify it where the README quotes it.`,
    );
  }
  for (const stage of PIPELINE) {
    if (named.has(stage.id) || stage.id in EXEMPT) continue;
    problems.push(
      `the deploy job runs \`${stage.name}\` (${stage.id}) and no case in this ledger names it. Add a mutation it catches, or add it to EXEMPT with the reason no overlay can express one.`,
    );
  }
  for (const stage of Object.keys(EXEMPT)) {
    if (!PIPELINE.some((entry) => entry.id === stage)) {
      problems.push(
        `EXEMPT names \`${stage}\`, which is not a stage of the deploy job any more. A stale exemption is an exemption nobody re-read.`,
      );
    }
    if (named.has(stage)) {
      problems.push(
        `\`${stage}\` is both exempted and named by a case. One of the two is out of date, and the exemption is the one that reads as an excuse.`,
      );
    }
  }
  const ids = new Set(PIPELINE.map((stage) => stage.id));
  for (const entry of CASES) {
    if (!ids.has(entry.catches)) {
      problems.push(
        `case \`${entry.id}\` claims to be caught by \`${entry.catches}\`, which is not a stage of the deploy job. Nothing can ever satisfy it.`,
      );
    }
  }
  return problems;
}

/**
 * The tree this run is a receipt for: clean, and not moving.
 *
 * Round 2 recorded a run it then had to throw away: I switched branches while it
 * was running, so it read a mutated `deploy/Caddyfile` off disk mid-run. The
 * pipeline comes from `ci.yml` read once at startup and the stages come from
 * whatever is in the working tree at the moment each one executes, so a tree
 * that changes underneath this file produces a receipt about a combination that
 * never existed — workflow A with scripts B.
 *
 * There is deliberately no `--allow-dirty`. A receipt with an override is a
 * receipt whose reader has to ask whether the override was used, and the whole
 * value of this file is that its output can be taken at face value. `git stash`
 * is right there.
 */
function treeState() {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) };
}

function requireStableTree(before) {
  const now = treeState();
  if (now.dirty !== '') {
    console.error(
      `::error::deploy-mutation-ledger: the working tree is not clean, so what this run reports would be about files nobody can name:\n${now.dirty}`,
    );
    process.exit(2);
  }
  if (before && now.head !== before.head) {
    console.error(
      `::error::deploy-mutation-ledger: HEAD moved from ${before.head} to ${now.head} while this run was in progress. The pipeline was read from one revision and the scripts from another, which is a receipt for a tree that never existed.`,
    );
    process.exit(2);
  }
  return now;
}

const argv = process.argv.slice(2);
if (argv.includes('--pipeline')) {
  console.info(`The \`deploy\` job of ${WORKFLOW}, as this ledger runs it:\n`);
  for (const [index, stage] of PIPELINE.entries()) {
    console.info(`  ${String(index + 1).padStart(2)}. ${stage.id.padEnd(26)} ${stage.name}`);
  }
  const problems = checkCoverage();
  for (const problem of problems) console.error(`::error::deploy-mutation-ledger: ${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

const coverage = checkCoverage();
if (coverage.length > 0) {
  for (const problem of coverage) console.error(`::error::deploy-mutation-ledger: ${problem}`);
  process.exit(1);
}

/**
 * What this tree built, written down once, before any case runs.
 *
 * The pipeline records it too — that is a stage of the real job — but a case's
 * `prepare` hook runs *before* the pipeline and `swapped-image` needs the
 * manifest to build its doppelganger from. Leaving that to whichever earlier
 * case happened to write the file makes a case's result depend on the ones
 * before it, which is the shape of every "green because of the order" defect
 * this file is for. So it is written here, from the shipped files, and every
 * case starts from the same answer.
 */
const recorder = PIPELINE.find((stage) => stage.kind === 'record');
if (recorder) {
  // The workflow's own command again, not a reconstruction of it — the same
  // rule the stages follow. (It ran as `node <a name from a regex>` until this
  // round, and that name is exactly what round 2's gauntlet was about.)
  const recorded = runValidatedCommand(recorder, baseFiles, process.env);
  if (!recorded.ok) {
    console.error(
      `::error::deploy-mutation-ledger: could not record what this tree built — the images have to exist before the ledger runs. ${lastLines(recorded.output, 3)}`,
    );
    process.exit(2);
  }
}

const selected = argv.length > 0 ? CASES.filter((entry) => argv.includes(entry.id)) : CASES;
if (selected.length === 0) {
  console.error(`no such case. Known: ${CASES.map((entry) => entry.id).join(', ')}`);
  process.exit(2);
}

const tree = requireStableTree();
console.info(`Working tree clean at ${tree.head}.`);

const results = [];
for (const entry of selected) {
  console.info(`\n=== ${entry.id}: ${entry.what}`);
  console.info(`    expecting ${entry.catches} to fire, and nothing before it`);
  const result = runCase(entry);
  requireStableTree(tree);
  results.push(result);
  console.info(`    ${result.verdict.toUpperCase()} — ${result.detail}`);
}

rmSync(workDir, { recursive: true, force: true });

console.info('\n--- ledger ---');
for (const { entry, verdict, fired, detail } of results) {
  const label =
    verdict === 'caught'
      ? 'CAUGHT '
      : verdict === 'missed'
        ? 'MISSED '
        : verdict === 'misattributed'
          ? 'MISCRED'
          : verdict === 'inconclusive'
            ? 'NOCALL '
            : 'UNKNOWN';
  console.info(`${label} ${entry.id.padEnd(28)} ${fired?.id ?? '(nothing fired)'}`);
  if (verdict !== 'caught') console.info(`         ${detail}`);
}
const bad = results.filter((result) => result.verdict !== 'caught');
if (bad.length > 0) {
  console.error(
    `\n${bad.length} case(s) did not land where they claim: ${bad.map((result) => `${result.entry.id} (${result.verdict})`).join(', ')}. A check that does not catch what it names is not yet a check, and a ledger that credits the wrong check is worse than none.`,
  );
  process.exit(1);
}
console.info(
  `\nAll ${results.length} mutations caught by the stage of the real ${WORKFLOW} pipeline that names them, with no earlier stage firing. Every stage ran that step's own \`run:\` script under \`${RUNNER_SHELL.join(' ')}\` — the shell the runner uses for a step with no \`shell:\` key — at ${tree.head} on a clean tree.`,
);
