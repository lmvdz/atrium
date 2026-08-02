/**
 * Break the thing; require the red — and require the red to be about the break.
 *
 * ── THE DEFECT (#40 round 8, D3) ────────────────────────────────────────────
 * Nothing in this repository required an assertion script to contain an
 * assertion. A blind critic replaced the whole of `assert-page-serves.mjs` —
 * the deploy job's largest assertion, the one the `/_next/static` lesson
 * produced — with two lines:
 *
 *     import { report } from './stack-client.mjs';
 *     report('assert-page-serves');
 *
 * and measured it: `assert-page-serves: passed.`, **exit 0 with no stack
 * running at all**. Every rule this repository has was satisfied. No rule about
 * the text of a file can close that: `main()` rewritten to `() => 0` satisfies
 * every syntactic rule here and always will. The only thing that can tell an
 * assertion from a shape that looks like one is running it in a world where it
 * *must* fail and requiring it to.
 *
 * ── AND THEN THE CONTROL PASSED FOR THE WRONG REASON (#40 round 9, D1) ──────
 * Round 8 built that and gave three of its controls `expect: /assert-page-serves/`
 * — the script's own name. A blind critic measured what that is worth:
 *
 *   - `ATRIUM_STACK_CA` points at `caddy-root.crt`, written by `compose-stack.mjs
 *     trust-ca` at **step 10** of the deploy job. The control runs at **step 4**.
 *     So `stackTarget()` threw `ENOENT` at module scope and the stack frame said
 *     `assert-page-serves.mjs:110:16` — which matched, and was scored "red as
 *     required".
 *   - With the CA present it would not have matched at all: `connect
 *     ECONNREFUSED` names `TCPConnectWrap.afterConnect` and nothing else.
 *
 * **The control proved the assertion went red because a file was missing, never
 * because the deployment was missing**, which is the case `controlProblems`'
 * own third branch exists to reject. The exploit is twenty lines: re-import
 * every binding the original imported, call `stackTarget()`, call `report(…)`.
 * `positive-control deploy` prints `red as required`, and the same file prints
 * `passed.` against a live stack it has never looked at.
 *
 * **An expectation that matches an artifact's identity is satisfied by any
 * failure that mentions it.** That sentence is now a rule rather than a lesson:
 * `expectationProblems` runs every control's `expect` against a corpus of reds
 * that are *not* the planted one — a stack trace naming the script, an ENOENT
 * naming it, a syntax error in it, `node: command not found`, a bare
 * `ECONNREFUSED` — and refuses any pattern one of them satisfies. `stack-client.mjs`
 * makes the cold world produce a *recorded failure with a sentence in it*
 * instead of a crash, so there is something behavioural left to match.
 *
 * ── AND THE CORPUS WENT STALE ON THE FIX ITSELF (#40 round 10, D1) ──────────
 * That corpus was a **denylist**, written down by hand, and round 9's own fix
 * changed the shape of the red out from under it. The thrown `ENOENT` became a
 * *recorded assertion* — the right change — and the recorded spelling was in no
 * corpus entry, so `expectationProblems` returned 0 while three controls'
 * `expect` consisted of exactly that message, admitted as an alternative:
 *
 *     expect: /assert-page-serves: (?:nothing is serving this deployment
 *              |ATRIUM_STACK_CA points at)/
 *
 * `ATRIUM_STACK_CA` is set at job level and written six steps after this step
 * runs, so the second arm fired every time and the first was dead code. Measured
 * by a blind critic: a live server on 18443 versus nothing on 18444 produced
 * **byte-identical output**, both exit 1.
 *
 * Two answers, and the second is the one that matters.
 *
 *  1. **The corpus is derived, not written.** `preconditionReds` enumerates the
 *     *worlds* the precondition distinguishes and runs the shipped
 *     `absentDeployment` over them, so a branch added tomorrow enters the corpus
 *     without anybody remembering it; and the summary line `verdict` prints for
 *     any recorded failure whatever is generated from `verdict`'s own renderer.
 *  2. **The control measures the distinction instead of matching a string.**
 *     `distinguishProblems` runs the entry point against a closed port and
 *     against a peer that accepts the connection, and requires the two outputs
 *     to differ. **A control that produces identical output with and without a
 *     deployment is not a control, whatever it matches**, and that is a property
 *     no regular expression can carry.
 *
 * ── AND THE CONTROLLER WAS THE ONE ENTRY POINT NOTHING CONTROLLED (D2) ──────
 * `main` printed `${CONTROLS[group].length} entry point(s) each failed` — the
 * table's size, not the number run. One line at the top of `runGroup`:
 *
 *     if (process.env.CI !== undefined) return [];
 *
 * and `positive-control.mjs deploy` exits 0 announcing that ten entry points
 * each failed, having spawned no child process at all, with `gate-selftest`,
 * `ci-guard` and `lint` clean. So this file reports what it *ran*, cross-checks
 * that against what it was asked to run, and is itself a controlled entry
 * point: the `positive-control` row in the `verify` group runs this file, in a
 * copy of the tree where the script the `selfcheck` group names has been gutted
 * to `report(…)`, and requires it to say so.
 *
 * ── THE PAIR ────────────────────────────────────────────────────────────────
 * Each control below is half of a pair, and the job runs both halves:
 *
 *   negative control  the real step, later in the same job, against the real
 *                     world — it must pass
 *   positive control  this step, against a world that is deliberately broken —
 *                     it must fail, and say something only that break produces
 *
 * One half alone proves nothing. A script that always passes satisfies the
 * first; a script that always fails satisfies the second; only a script whose
 * answer is a function of the world satisfies both. **`exit 0` here is the
 * failure this file exists to report.**
 *
 * ── THE SCOPE, AS A SENTENCE, AND THE ATTACK ON IT ──────────────────────────
 * *This runs the entry points named in `CONTROLS`, as CI runs them, against a
 * world whose brokenness it has verified, and requires a non-zero exit whose
 * output matches a pattern no unrelated red could satisfy.*
 *
 *  - **"the entry points named in CONTROLS"** — the required set is not this
 *    table. `controlCoverageProblems` in checker-graph.mjs reads *every*
 *    `scripts/ci/<name>.mjs` **every job** of the workflow runs and requires
 *    each to be controlled here or exempted with the reason a broken world for
 *    it would be a false red. Round 8 derived that set from the `deploy` job's
 *    steps alone, and matched it with `assert-[a-z0-9-]+\.mjs` — so
 *    `assert-vitest-report`, `assert-floor-ratchet`, `assert-tables`,
 *    `assert-workspace-enrollment` and `assert-playwright-report` were all
 *    unproven, which is precisely where round 9's D3 bypass was weaponised.
 *  - **"a world whose brokenness it has verified"** — a control whose world is
 *    not the world it says fails, rather than passing. `requires` is that
 *    check: the deploy controls refuse to call a red evidence unless nothing is
 *    actually listening on the deployment's port.
 *  - **"a pattern no unrelated red could satisfy"** — `expectationProblems`,
 *    above, enforced before a single child is spawned.
 *  - **and this file is itself an entry point**, so `guard-scan.mjs` applies to
 *    it, `packages/ci-guard` asserts on `controlProblems` and
 *    `expectationProblems` from outside `scripts/`, and the `positive-control`
 *    row controls it behaviourally.
 *
 * ── WHERE IT STILL STOPS ────────────────────────────────────────────────────
 * The cold world catches an assertion that checks *nothing*. It cannot, on its
 * own, catch one that checks *less than it claims*: a script cut down to its
 * `requireDeployment` precondition goes red here exactly like the real one.
 * That gap is closed from the other side, in three pieces, and round 10 is about
 * why the first of them was not enough:
 *
 *   - `assertionFloorProblems` counts `check(…)` **call sites**. Four scripts
 *     record every problem through one site over a computed list, so their floor
 *     was 1 and an empty list satisfied it — measured against the live migrated
 *     stack as `assert-stack-schema: passed.` with zero schema compared.
 *   - so `verdict` holds each run to a `minRun` floor over the assertions it
 *     actually *evaluated*, a number `checkSchema` and its siblings produce from
 *     inside their own traversal, and to a `minRequests` floor over the
 *     questions it actually put to the deployment.
 *   - and `assertionConditionProblems` requires a recorded assertion to read a
 *     value, because twenty-three `check(true, …)` calls satisfy any count.
 *
 * All three are ratcheted against `origin/main` and fingerprinted in the README.
 * The strongest control of all is still the one this file does not run:
 * perturbing a *live* deployment (deleting the HSTS block from the Caddyfile and
 * restarting the proxy) and requiring the assertion to notice. `distinguishes`
 * below is the cheapest possible step towards it — a peer that accepts a
 * connection is not a deployment — and it is not that. Said plainly so nobody
 * reads the list below as complete.
 */

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notAVerdict } from './child-verdict.mjs';
import { isMainModule } from './main-module.mjs';
import { repoRoot } from './repo-root.mjs';
import { absentDeployment, failureSummary, stackTarget } from './stack-client.mjs';

/** Long enough for a cold assertion to give up, short enough to be a gate. */
const TIMEOUT_MS = 180_000;

/** The round-5 guard, planted into a copy of the tree. */
const BROKEN_GUARD =
  "import { isMainModule } from './main-module.mjs';\nif (isMainModule(import.meta.url) && process.env.CI === undefined) {\n  process.exit(main());\n}\n";

/**
 * Copying the tree: what a broken world is made of, for the `verify` controls.
 *
 * The child runs the *repository's* script with its working directory set into
 * the copy, rather than running a copied script — a copy under `/tmp` cannot
 * resolve `typescript` or `yaml`, and vendoring `node_modules` into a temporary
 * directory to make it could would be a second installation of the thing under
 * test. `repo-root.mjs` walks up from the working directory, so the shipped
 * entry point reads the broken copy and nothing else changes about how it runs.
 */
const COPIED = ['scripts', 'packages', 'apps', '.github', 'README.md', 'pnpm-workspace.yaml'];
const NOT_COPIED = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
]);

/**
 * The gutting the whole file exists for, written into a copied script.
 *
 * ── ONE TURN STRONGER THAN LAST ROUND'S (#40 round 10) ──────────────────────
 * This was `import { report } … report('${name}');` — two lines, and it exited 0
 * against no stack at all. It does not any more: `verdict` holds each run to a
 * `minRun` floor now, so the two-line version goes *red* and this row would have
 * been grading the machinery on the wrong branch, never reaching the `exited 0`
 * one it exists for. So the plant is the version that survives the new floor —
 * a script that reports having made forty comparisons and makes none — which is
 * both the honest way to keep this control's world true and the next shape of
 * the same attack. What it cannot survive is `compared` being a number the
 * comparison itself produces, which is why `checkSchema` and its siblings count
 * from inside their own traversal.
 */
const gut = (name) =>
  `import { compared, report } from './stack-client.mjs';\ncompared(40, 'nothing at all');\nreport('${name}');\n`;

/**
 * Every entry point this repository runs, and the world in which it must fail.
 *
 * `id` names the control; `entry` names the `scripts/ci/<entry>.mjs` it proves,
 * which is what `controlCoverageProblems` matches against the workflow — the two
 * are separate so one script can have more than one broken world.
 *
 * `expect` is what the output has to say, and it is held to
 * `expectationProblems`: a pattern any *unrelated* red would also satisfy is
 * refused before anything runs.
 */
export const CONTROLS = {
  verify: [
    {
      id: 'gate-selftest',
      entry: 'gate-selftest',
      argv: ['scripts/ci/gate-selftest.mjs'],
      world: 'a copy of the tree with the round-5 broken guard planted in assert-tables.mjs',
      break: (root) =>
        writeFileSync(join(root, 'scripts', 'ci', 'assert-tables.mjs'), BROKEN_GUARD),
      expect: /condition is not exactly/,
      because:
        'this is the file the round-5, round-7 and round-8 defects all silenced, and every one of them left it exiting 0 with nothing on stdout. Its cases are the largest single body of assertions in CI and the cheapest thing in the repository to turn off',
    },
    {
      id: 'workflow-policy-selftest',
      entry: 'workflow-policy-selftest',
      argv: ['scripts/ci/workflow-policy-selftest.mjs'],
      world: 'a copy of the tree whose ci.yml lets the verify job fail without failing',
      break: (root) => breakWorkflow(root),
      expect: /continue-on-error/,
      because:
        "the other half of the pair that checks each other: disarming one leaves the other scanning it, which is worth exactly nothing if both can be disarmed by the same insertion — and on r7 they could, one line above each one's guard",
    },
    {
      id: 'workflow-policy',
      entry: 'workflow-policy',
      argv: ['scripts/ci/workflow-policy.mjs', '.github/workflows'],
      world: 'the same copy, read by the policy engine itself rather than by its self-test',
      break: (root) => breakWorkflow(root),
      expect: /continue-on-error/,
      because:
        'the engine and its self-test are separate entry points and a green self-test says nothing about the engine the workflow actually invokes',
    },
    {
      /**
       * The controller, controlled (#40 round 9, D2).
       *
       * This runs *this file* against a copy of the tree in which the script
       * the `selfcheck` group names has been gutted to `report(…)` — the exact
       * measured D3 exploit — and requires the child to report that it exited 0
       * in a world where it could not have. It is the only row here whose
       * subject is the machinery rather than an assertion, and it is the one
       * whose absence let `if (process.env.CI !== undefined) return [];` at the
       * top of `runGroup` produce "10 entry point(s) each failed" with no child
       * process spawned.
       */
      id: 'positive-control',
      entry: 'positive-control',
      argv: ['scripts/ci/positive-control.mjs', 'selfcheck'],
      world:
        'a copy of the tree in which assert-stack-health.mjs has been gutted to `report(…)`, so the control it is given must come back green and this file must say so',
      break: (root) =>
        writeFileSync(
          join(root, 'scripts', 'ci', 'assert-stack-health.mjs'),
          gut('assert-stack-health'),
        ),
      expect: /assert-stack-health exited 0 when no stack has been brought up/,
      because:
        "every other row here is worth what this machinery is worth, and nothing ran it. A `runGroup` that returns an empty list, a `main` that prints the size of the table instead of the number of children it spawned, and a filter that quietly selects nothing are all invisible to a gate that only reads this file's exit status",
    },
    {
      id: 'assert-vitest-report',
      entry: 'assert-vitest-report',
      argv: ['scripts/ci/assert-vitest-report.mjs'],
      world: 'a copy of the tree in which the test runner has not written a report',
      break: () => undefined, // The copy has no reports in it; that is the world.
      expect: /vitest-report\.json was never written/,
      because:
        'it is the gate that says the suite actually ran, and it was one of the five the round-9 D3 bypass was weaponised on precisely because nothing here had ever required it to fail. Its own silence is indistinguishable from a green suite',
    },
    {
      id: 'assert-playwright-report',
      entry: 'assert-playwright-report',
      argv: ['scripts/ci/assert-playwright-report.mjs'],
      world: 'a copy of the tree in which Playwright has not written a report',
      break: () => undefined,
      expect: /playwright-report\.json was never written/,
      because:
        'the same claim about the browser suite, in a different job, with the same consequence: a missing report read as an empty one is a browser suite that never ran reported as one that passed',
    },
    {
      id: 'assert-workspace-enrollment',
      entry: 'assert-workspace-enrollment',
      argv: ['scripts/ci/assert-workspace-enrollment.mjs'],
      world: 'a copy of the tree whose CI manifest has forgotten one of its workspaces',
      break: (root) => forgetWorkspace(root),
      expect: /is a pnpm workspace but is absent from \.github\/ci-manifest\.json/,
      because:
        'it is what stops a package arriving with no tests and no floor, so a version of it that reports nothing is a version of the manifest that describes whatever it likes',
    },
    {
      id: 'assert-floor-ratchet',
      entry: 'assert-floor-ratchet',
      argv: ['scripts/ci/assert-floor-ratchet.mjs'],
      world: 'a copy of the tree with no `origin/main` to ratchet against',
      break: () => undefined, // A copy is not a git checkout; that is the world.
      expect: /there is no ref `origin\/main` in this checkout/,
      because:
        'the founding defect of this ticket is a ratchet that takes its no-baseline exit-0 path because the `git fetch` above it was dropped. "No baseline" being fatal is the whole fix, and nothing had ever required this script to take that path out loud',
    },
    {
      id: 'assert-chromium',
      entry: 'assert-chromium',
      argv: ['scripts/ci/assert-chromium.mjs'],
      world: 'a Playwright browser directory with no browsers in it',
      // Not "the runner has not run `playwright install` yet": that is true of a
      // GitHub runner and false of every laptop with a browser cache, and a
      // control whose world depends on whose machine it is is a control that
      // reports a defect when somebody runs the gate at home. An empty
      // `PLAYWRIGHT_BROWSERS_PATH` is the same absence, made a fact.
      env: () => ({
        WEB_PACKAGE_DIR: join(repoRoot(), 'apps', 'web'),
        PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), 'atrium-no-browsers-')),
      }),
      expect: /Chromium is not installed at/,
      because:
        'a browser suite with no browser does not pass, it does not run — and the step that installs the browser is one line above the step that checks for it, which is exactly the pairing round 4 learned to stop trusting',
    },
    {
      id: 'assert-tables',
      entry: 'assert-tables',
      argv: ['scripts/ci/assert-tables.mjs'],
      world: 'a `@atrium/db` that has not been built, so there is no schema to compare against',
      env: () => ({ DB_PACKAGE_DIR: mkdtempSync(join(tmpdir(), 'atrium-unbuilt-db-')) }),
      expect: /does not exist — build @atrium\/db before asserting its schema/,
      because:
        'it is the only thing that says the migrations produced the tables the code declares, and it is the file every silencing round of this ticket reached for first — round 5, round 7 and round 8 each left it exiting 0 with nothing on stdout',
    },
    {
      id: 'record-built-images',
      entry: 'record-built-images',
      argv: ['scripts/ci/record-built-images.mjs'],
      world:
        'no image manifest path declared, so nothing would bind a built image to a running one',
      env: () => ({ ATRIUM_IMAGE_MANIFEST: undefined }),
      expect: /without it nothing binds the built image to the running one/,
      because:
        'built = running = scanned is a chain, and this is its first link: a version of it that quietly defaulted to a path nobody reads would leave all three identity assertions comparing a manifest to itself. That mutant is in the registry; this is the entry point around it',
    },
    {
      id: 'wait-for-postgres',
      entry: 'wait-for-postgres',
      argv: ['scripts/ci/wait-for-postgres.mjs'],
      world: 'a database URL pointing at a port nothing is listening on',
      env: () => ({
        DATABASE_URL: 'postgres://atrium:atrium@127.0.0.1:1/atrium',
        POSTGRES_WAIT_MS: '2000',
        DB_PACKAGE_DIR: join(repoRoot(), 'packages', 'db'),
      }),
      expect: /Postgres service container never became ready within \d+ms/,
      because:
        'it is a deadline, not a retry-forever loop, and the difference matters only if the deadline is ever reached. A version of it that returns 0 on a database that never arrives turns every migration and schema assertion after it into an error about something else',
    },
  ],

  /**
   * The stack assertions, run before anything is brought up.
   *
   * Every one of them is a function of a running deployment, so with no
   * deployment every one of them must be red — and, since round 9, must be red
   * *through a recorded assertion* rather than through an unhandled
   * `ECONNREFUSED`. `requireDeployment` in stack-client.mjs is what turns the
   * cold world into a sentence; `requires` below is what confirms the cold
   * world is the world.
   */
  deploy: [
    {
      id: 'assert-stack-health',
      entry: 'assert-stack-health',
      argv: ['scripts/ci/assert-stack-health.mjs'],
      world: 'no stack has been brought up',
      expect: /assert-stack-health: the compose project has no containers at all/,
      because:
        'it is the first thing that would notice a deployment that is not there, and "healthy" was true of a 500ing app for three rounds',
    },
    {
      id: 'assert-stack-config',
      entry: 'assert-stack-config',
      argv: ['scripts/ci/assert-stack-config.mjs'],
      world: 'no stack has been brought up',
      // Not `/\d+ assertion\(s\) failed\./` (#40 round 10, D6): that is the line
      // `verdict` prints for *any* recorded failure, so it was satisfied by a
      // red about anything at all in this file. `preconditionReds` generates it
      // into the corpus now, so this shape cannot come back.
      expect: /assert-stack-config: no `app` container to inspect/,
      because:
        'it reads the production configuration back out of the containers, so with no containers it must have nothing to read and say so',
    },
    {
      id: 'assert-image-identity',
      entry: 'assert-image-identity',
      argv: ['scripts/ci/assert-image-identity.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-image-identity: no readable image manifest/,
      because:
        'built = running = scanned is the whole claim, and it is bound by a manifest that does not exist yet at this point in the job',
    },
    {
      id: 'assert-migration-image',
      entry: 'assert-migration-image',
      argv: ['scripts/ci/assert-migration-image.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-migration-image: no readable image manifest/,
      because:
        'it is the last moment the answer about the migration image can still be no — `migrate` runs *inside* the boot, so by the time anything else looks, a wrong image has already written to a persistent volume. Found by the coverage rule in checker-graph.mjs, which reads the required set out of the workflow rather than out of this table',
    },
    {
      id: 'assert-image-origins',
      entry: 'assert-image-origins',
      argv: ['scripts/ci/assert-image-origins.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-image-origins: no readable image manifest/,
      because: 'same manifest, and this is the scan round 3 exempted from the ledger',
    },
    {
      id: 'assert-stack-schema',
      entry: 'assert-stack-schema',
      argv: ['scripts/ci/assert-stack-schema.mjs'],
      world: 'no stack has been brought up, so there is no database to read',
      // The script's own annotation prefix, deliberately (#40 round 10, D5).
      // This sentence used to reach the output as an *unhandled throw* out of
      // `queryDatabase` in compose.mjs — a crash, which this repository's own
      // rule says is not a verdict, and which is what made the D2 gutting work:
      // the control was satisfied before the file's own comparison ran at all.
      // `::error::assert-stack-schema: …` is written only by `verdict`.
      expect: /assert-stack-schema: the stack has no `postgres` container to query/,
      because:
        'it is the difference between `migrate` exiting 0 and the schema being there, and it cannot make that claim about a database that does not exist',
    },
    {
      /**
       * The row the round-9 D1 finding is about, and the round-10 one.
       *
       * Round 8's `expect` was `/assert-page-serves/` — the script's own name,
       * which every stack trace supplies for free. Round 9 replaced it with the
       * sentence `requireDeployment` records **and then wrote the certificate-
       * authority sentence into it as an accepted alternative**, which is the
       * branch that actually fired: `ATRIUM_STACK_CA` is set at job level and
       * written six steps after this control runs, so the CA arm matched every
       * time and the deployment arm was dead code. A blind critic measured the
       * consequence — a live server on 18443 against nothing on 18444 produced
       * **byte-identical output**, both exit 1.
       *
       * So the alternation is gone: this is the refused-connection sentence and
       * nothing else, `absentDeployment` reaches it before it looks at the CA,
       * and `distinguishes` below makes the two-world difference a thing this
       * step measures rather than a thing a reviewer has to.
       */
      id: 'assert-page-serves',
      entry: 'assert-page-serves',
      argv: ['scripts/ci/assert-page-serves.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-page-serves: nothing is serving this deployment/,
      distinguishes: true,
      because:
        'the measured D3 exploit replaced this entire file with `report(…)` and got `passed.` with no stack running. This control is the thing that says no',
    },
    {
      id: 'assert-signup-verifies',
      entry: 'assert-signup-verifies',
      argv: ['scripts/ci/assert-signup-verifies.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-signup-verifies: nothing is serving this deployment/,
      distinguishes: true,
      because: 'it drives a real form through a real SMTP relay, neither of which is up yet',
    },
    {
      id: 'assert-ws-upgrade',
      entry: 'assert-ws-upgrade',
      argv: ['scripts/ci/assert-ws-upgrade.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-ws-upgrade: nothing is serving this deployment/,
      distinguishes: true,
      because: 'an upgrade handshake against nothing cannot complete',
    },
    {
      id: 'assert-rate-limit',
      entry: 'assert-rate-limit',
      argv: ['scripts/ci/assert-rate-limit.mjs'],
      world: 'no stack has been brought up, so there is no proxy to aim callers at',
      // Same D6 correction as assert-stack-config: the failure count is not a
      // fact about this control's world.
      expect: /assert-rate-limit: no `proxy` container to aim at/,
      because: 'it runs callers inside the compose network, which does not exist yet',
    },
  ],

  /**
   * One control, so that the row controlling *this file* costs one grandchild.
   *
   * Not a group any workflow step names: the `positive-control` row in `verify`
   * runs it, in a tree where this script has been gutted. It is a real group run
   * by the real `runGroup`, so what it proves is the whole mechanism — the copy,
   * the spawn, the grading, the counting and the printing — and not a fixture
   * shaped like it.
   */
  selfcheck: [
    {
      id: 'assert-stack-health',
      entry: 'assert-stack-health',
      argv: ['scripts/ci/assert-stack-health.mjs'],
      world: 'no stack has been brought up',
      expect: /assert-stack-health: the compose project has no containers at all/,
      because:
        'it is the cheapest control in the table to run and the loudest to gut, which is what makes it the one the self-control plants a `report(…)` into',
    },
  ],
};

/** Groups whose world is "the deployment is not up", and must be verified so. */
const COLD_STACK_GROUPS = new Set(['deploy', 'selfcheck']);

/**
 * Reds that are *not* the planted break, written out so a pattern can be tested
 * against them.
 *
 * ── WHY THESE, AND WHY AS DATA (#40 round 9, D1) ────────────────────────────
 * Every one of these is a real way a child process here can come back non-zero
 * without the assertion having asserted anything: node not on PATH, a syntax
 * error, a file the script needed being absent, a socket refusing a connection.
 * Each is rendered with the script's own name in it, because that is the point
 * — a Node stack trace supplies the file's name for free, so a pattern that
 * only asks for the name is satisfied by all of them.
 *
 * `%s` is the entry point's bare name.
 */
export const WRONG_REDS = [
  {
    what: 'the summary line any recorded failure in the file produces',
    // Derived from `verdict` rather than written out: two controls on r9
    // expected `/assert-stack-config: \d+ assertion\(s\) failed\./`, which is
    // satisfied by *any* failure that file records, in any world. `1` because a
    // pattern that accepts one accepts the shape.
    text: `${failureSummary('%s', 1)}\n`,
  },
  {
    what: 'a Node stack trace from anywhere inside the script',
    text: 'file:///repo/scripts/ci/%s.mjs:110\nconst target = stackTarget();\n              ^\nTypeError: x is not a function\n    at file:///repo/scripts/ci/%s.mjs:110:16\n    at ModuleJob.run (node:internal/modules/esm/module_job:274:25)\n',
  },
  {
    what: 'a file the script needed being absent',
    text: "node:fs:441\n  return binding.open(...);\nError: ENOENT: no such file or directory, open '/repo/caddy-root.crt'\n    at readFileSync (node:fs:441:20)\n    at stackTarget (file:///repo/scripts/ci/stack-client.mjs:57:14)\n    at file:///repo/scripts/ci/%s.mjs:110:16\n",
  },
  {
    what: 'a syntax error in the script itself',
    text: "file:///repo/scripts/ci/%s.mjs:3\nconst = ;\n      ^\nSyntaxError: Unexpected token '='\n",
  },
  {
    what: 'no node on the runner',
    text: 'bash: line 1: node: command not found\nnode scripts/ci/%s.mjs\n',
  },
  {
    what: 'a bare connection refusal with no assertion behind it',
    text: 'Error: connect ECONNREFUSED 127.0.0.1:443\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)\n',
  },
  {
    what: 'a runner with no docker',
    text: 'Error: spawnSync docker ENOENT\n    at Object.spawnSync (node:child_process:876:20)\n    at docker (file:///repo/scripts/ci/compose.mjs:88:10)\n    at file:///repo/scripts/ci/%s.mjs:12:19\n',
  },
  {
    what: 'the step being killed',
    text: 'Terminated\nscripts/ci/%s.mjs\n',
  },
];

/**
 * A target with an unreadable certificate authority, obtained by asking for one.
 *
 * `stackTarget` is called with a path that cannot exist, so the sentence below
 * is the one the shipped code produces rather than a copy of it. That is the
 * whole point of `preconditionReds`: round 9 converted a thrown `ENOENT` into a
 * recorded assertion — the right change — and the new spelling was in no corpus
 * entry, so `expectationProblems` returned 0 while three controls' `expect`
 * consisted of exactly that message.
 */
const UNREADABLE_CA = stackTarget({
  ATRIUM_STACK_DOMAIN: 'atrium.localhost',
  ATRIUM_STACK_CA: join(tmpdir(), 'atrium-no-such-certificate-authority', 'caddy-root.crt'),
  ATRIUM_STACK_HTTPS_PORT: '443',
});

/** The same deployment, with the certificate authority the job eventually writes. */
const TRUSTED_CA = {
  ...UNREADABLE_CA,
  ca: Buffer.from('-----BEGIN CERTIFICATE-----'),
  caProblem: undefined,
};

/**
 * Worlds a cold-stack control's red might have come from that are *not* its own.
 *
 * The planted world for every `deploy` control is "nothing is listening on the
 * deployment's port", which `absentDeployment` answers with the refused-
 * connection sentence. Every other answer that function can give describes a
 * different world — the certificate authority not written yet, a peer that
 * accepted the connection and failed the exchange, an answer with no status —
 * and a red produced by one of those is a red this control did not cause.
 *
 * Enumerated as *inputs* rather than as messages, and run through the shipped
 * function, so a branch added to `absentDeployment` tomorrow enters this corpus
 * without anybody remembering to add it. That is the round-10 D1 lesson stated
 * as machinery: **a denylist of wrong reds goes stale the moment a fix changes
 * the shape of the red**, so the list enumerates the situations the code
 * distinguishes and lets the code do the spelling.
 *
 * What it is *not* is exhaustive over branches: a branch reachable only from an
 * input shape nobody listed here — a fourth field on `outcome`, say — still
 * would not enter. This is a smaller list to keep honest than a list of
 * sentences, and it is still a list. The half that does not depend on any list
 * is `distinguishProblems`, which measures the difference rather than enumerating
 * it, and the one entry below that fires when the planted sentence stops being
 * distinct is what makes a collapse of the two loud rather than silent.
 */
const OTHER_WORLDS = [
  {
    what: 'the certificate authority not being written yet, with something on the port',
    target: UNREADABLE_CA,
    outcome: { error: { code: 'ECONNRESET' } },
  },
  {
    what: 'a handshake that could not be verified because the job has not copied the CA out yet',
    target: UNREADABLE_CA,
    outcome: { error: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } },
  },
  {
    what: 'a page obtained with no certificate authority to verify it against',
    target: UNREADABLE_CA,
    outcome: { response: { status: 200 } },
  },
  {
    what: 'a peer that accepted the connection and then failed the exchange',
    target: TRUSTED_CA,
    outcome: { error: { code: 'ECONNRESET' } },
  },
  {
    what: 'an answer this file could not read a status out of',
    target: TRUSTED_CA,
    outcome: { response: {} },
  },
];

/** The sentence a cold-stack control is *allowed* to be graded on. */
const PLANTED_RED = String(absentDeployment(TRUSTED_CA, { error: { code: 'ECONNREFUSED' } }));

/**
 * The corpus entries `absentDeployment` itself generates, rendered as a child's
 * output would carry them.
 *
 * @param {object[]} [worlds]
 * @param {(target: object, outcome: object) => string|undefined} [absent]
 * @returns {{what: string, text: string}[]}
 */
export function preconditionReds(worlds = OTHER_WORLDS, absent = absentDeployment) {
  const reds = [];
  for (const world of worlds) {
    const sentence = absent(world.target, world.outcome);
    if (sentence === undefined) continue;
    if (sentence === PLANTED_RED) {
      // The one shape that makes this whole file wrong: if the precondition
      // stops telling the planted world from another one, every deploy control
      // is being graded on a sentence two worlds produce. Said as a corpus entry
      // that no pattern can avoid, so the gate goes red loudly rather than the
      // corpus quietly accepting everything.
      reds.push({
        what: `${world.what} — which now produces the *same* sentence as a refused connection, so no expectation can tell the two apart`,
        text: `::error::%s: ${sentence}\n`,
      });
      continue;
    }
    reds.push({ what: world.what, text: `::error::%s: ${sentence}\n${failureSummary('%s', 1)}\n` });
  }
  return reds;
}

/**
 * Every control whose expectation is about an identity rather than a behaviour.
 *
 * This is the round-9 D1 rule, made checkable. A control's `expect` is what
 * separates "it failed because of the break" from "it failed"; round 8 gave
 * three controls the script's own name, which every entry in `WRONG_REDS`
 * contains. So each pattern is run against each of those, and a pattern that
 * matches one of them is refused with the one it matched — because that is a
 * red this control would score as evidence.
 *
 * Deliberately *not* a rule about how the pattern is written. `/assert-page-serves/`
 * is refused for what it accepts, not for its shape, and a longer pattern that
 * happens to match a stack trace is refused just the same.
 *
 * @param {object} [controls] the table, injectable so the self-tests can hand in
 *   a known-bad row without editing the real one
 * @returns {string[]}
 */
export function expectationProblems(
  controls = CONTROLS,
  corpus = [...WRONG_REDS, ...preconditionReds()],
) {
  const problems = [];
  for (const [group, rows] of Object.entries(controls)) {
    for (const control of rows) {
      const { id, entry, expect } = control;
      if (!(expect instanceof RegExp)) {
        problems.push(
          `${group}/${id} has no \`expect\` regular expression, so any non-zero exit would satisfy it — including one from a syntax error in the file it is meant to be proving.`,
        );
        continue;
      }
      if (expect.test('')) {
        problems.push(
          `${group}/${id}'s \`expect\` (${expect}) matches the empty string, so a child that printed nothing at all would satisfy it.`,
        );
      }
      for (const wrong of corpus) {
        const rendered = wrong.text.replaceAll('%s', entry ?? id);
        if (!expect.test(rendered)) continue;
        problems.push(
          `${group}/${id}'s \`expect\` (${expect}) is satisfied by ${wrong.what} — a red this control did not plant and cannot have caused. An expectation that matches an artifact's *identity* is satisfied by any failure that mentions it, and a Node stack trace supplies the file's own name for free: round 8's three deploy controls each expected \`/${entry ?? id}/\` and were being scored "red as required" against an ENOENT for a certificate authority the job had not written yet. Match on behaviour instead — the specific sentence the assertion records, or an exit status plus a named check.`,
        );
      }
    }
  }
  return problems;
}

/** `continue-on-error` on the verify job, which is the bypass the policy names. */
function breakWorkflow(root) {
  const path = join(root, '.github', 'workflows', 'ci.yml');
  const source = readFileSync(path, 'utf8');
  const marker = '  verify:\n';
  if (!source.includes(marker)) {
    throw new Error(
      `${path} has no \`verify\` job to break, so this control would pass by not being able to plant anything.`,
    );
  }
  writeFileSync(path, source.replace(marker, `${marker}    continue-on-error: true\n`));
}

/** A workspace taken out of the copied manifest, which is what "not enrolled" is. */
function forgetWorkspace(root) {
  const path = join(root, '.github', 'ci-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const [first] = Object.keys(manifest.vitest?.workspaces ?? {});
  if (first === undefined) {
    throw new Error(
      `${path} enrolls no workspaces at all, so this control would pass by not being able to remove one.`,
    );
  }
  delete manifest.vitest.workspaces[first];
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Whether the world a group claims is broken really is (#40 round 9, D1).
 *
 * The third of the three remedies the round-9 review named: *a control that
 * first ensures the stated world before treating a red as evidence*. For the
 * stack groups the stated world is "nothing is listening on the deployment's
 * port". If something is — a stack left up from a previous run, another service
 * on 443, a developer's laptop — then every red below is a red about something
 * else and the control is proving nothing. That is a problem, not a pass.
 *
 * @param {string} group
 * @param {(address: string, port: number) => boolean} [listening] injectable
 * @returns {string[]}
 */
export function worldProblems(group, listening = isListening) {
  if (!COLD_STACK_GROUPS.has(group)) return [];
  const target = stackTarget();
  const problems = [];
  if (listening(target.address, target.httpsPort)) {
    problems.push(
      `something is already listening on ${target.address}:${target.httpsPort}, and every control in the \`${group}\` group claims a world in which nothing is. A red obtained against a stack that is up — a leftover from an earlier run, or an unrelated service on this port — is a red about something else, and scoring it as evidence is the round-9 D1 defect with a different cause. Tear the stack down, or point ATRIUM_STACK_HTTPS_PORT somewhere unoccupied, before treating these reds as proof.`,
    );
  }
  if (target.caPath !== undefined && existsSync(target.caPath)) {
    problems.push(
      `ATRIUM_STACK_CA already points at a readable ${target.caPath}, and these controls run *before* \`compose-stack.mjs trust-ca\` writes it. A certificate authority that already exists means either a stack has been up or the file is stale; either way the world here is not the one every \`because\` below describes.`,
    );
  }
  return problems;
}

/**
 * A decoy: something that accepts the connection and is not a deployment.
 *
 * Run as its own process, not as a server in this one, because `runControl`
 * blocks the event loop in `execFileSync` — a listener inside this process would
 * accept nothing while the child it exists for is running. It resets every
 * connection immediately, so the child gets an answer from the socket layer and
 * never hangs.
 */
const DECOY_SERVER =
  "require('net').createServer((socket) => socket.destroy()).listen(Number(process.argv[1]), '127.0.0.1');";

/** A port nothing was listening on a moment ago, asked of the kernel. */
function freePort() {
  return Number(
    execFileSync(
      process.execPath,
      [
        '-e',
        "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()});",
      ],
      { encoding: 'utf8', timeout: 15_000 },
    ).trim(),
  );
}

/**
 * Both worlds, and the requirement that the entry point can tell them apart.
 *
 * ── THE ACCEPTANCE TEST FOR THE ROUND-9 DEFECT (#40 round 10, D1) ───────────
 * A blind critic's finding, in one sentence: *a control that produces identical
 * output with and without a deployment is not a control, whatever it matches.*
 * Round 9's did. `absentDeployment` returned the certificate-authority problem
 * on its first line, before any request, and `ATRIUM_STACK_CA` names a file the
 * job writes six steps after this step runs — so the CA branch fired in the only
 * world this ever ran in, the deployment branch was dead code, and a live server
 * on one port versus nothing on another gave byte-identical output.
 *
 * The remedy is not a better regular expression. It is to *make the measurement*:
 * run the entry point against a closed port and against a peer that accepts the
 * connection, and require the two outputs to differ. That is a property of the
 * script's precondition and of nothing else, it needs no docker and no stack,
 * and it fails on `fix/deploy-serves-r9` as committed.
 *
 * What the decoy is not is a deployment. It cannot be: standing one up is what
 * the rest of the job does, six steps later. What it is is the cheapest possible
 * *different world*, and a script that answers a refused connection and an
 * accepted-then-reset one with the same bytes has a precondition that is not
 * reading the socket at all.
 *
 * @param {object} control the row from `CONTROLS`
 * @param {{status?: number, output?: string}} cold  the planted world's outcome
 * @param {{status?: number, output?: string}} decoy the other world's outcome
 * @returns {string[]}
 */
export function distinguishProblems(control, cold, decoy) {
  const { id, expect } = control;
  const coldOutput = String(cold.output ?? '');
  const decoyOutput = String(decoy.output ?? '');
  const problems = [];
  if (coldOutput === decoyOutput) {
    return [
      `${id} produced byte-identical output against a port nothing is listening on and against a peer that accepts the connection and resets it (${coldOutput.length} bytes, exit ${cold.status ?? 'none'} and ${decoy.status ?? 'none'}). Its answer is therefore not a function of what is on the deployment's port, and every red this control has ever scored was about something else — a certificate authority the job had not written yet, on r9. A control that cannot tell its two worlds apart is not a control.`,
    ];
  }
  if (decoy.status === 0) {
    problems.push(
      `${id} exited 0 against a peer that accepts a connection and resets it. That is not a deployment, and an assertion that reports \`passed\` against it is reporting on the fact that a socket answered.`,
    );
  }
  if (expect instanceof RegExp && expect.test(decoyOutput)) {
    problems.push(
      `${id}'s expectation (${expect}) is satisfied by its run against a decoy that is not a deployment at all. The sentence this control is graded on has to be the one the *planted* world produces; one that a peer accepting a connection also produces is a sentence about neither world.`,
    );
  }
  return problems;
}

/** A TCP connect that is allowed to fail, answered synchronously enough to gate on. */
function isListening(address, port, timeoutMs = 1500) {
  const probe = execFileSync(
    process.execPath,
    [
      '-e',
      `const s=require('net').connect(${port},${JSON.stringify(address)});s.setTimeout(${timeoutMs});const d=(o)=>{try{s.destroy()}catch{};process.stdout.write(o)};s.on('connect',()=>d('open'));s.on('error',()=>d('shut'));s.on('timeout',()=>d('shut'));`,
    ],
    { encoding: 'utf8', timeout: timeoutMs + 5000 },
  );
  return probe.trim() === 'open';
}

/**
 * One control's verdict, from what the child process did.
 *
 * Separated from running it so that `packages/ci-guard` and `gate-selftest.mjs`
 * can hand this every outcome — including the ones that are awkward to produce
 * on purpose — without spawning anything. The shapes, in the order they matter:
 *
 *   exit 0                    the failure this file exists for
 *   killed / never started    inconclusive, and inconclusive is not a pass
 *   red, wrong output         it failed, but not visibly for the planted reason
 *   red, expected output      the control is satisfied
 *
 * @param {object} control the row from `CONTROLS`
 * @param {object} outcome `{ status, output, error }` — `error` is the throw
 *   from `execFileSync`, when there was one
 * @returns {string[]}
 */
export function controlProblems(control, outcome) {
  const { id, world, expect, because } = control;
  const output = outcome.output ?? '';
  if (outcome.error !== undefined) {
    const why = notAVerdict(outcome.error, TIMEOUT_MS);
    if (why !== undefined) {
      return [
        `${id} did not reach a verdict when ${world}: ${why}. A control that could not observe an answer is not a control that got one, and this is not a pass.`,
      ];
    }
  }
  if (outcome.status === 0) {
    return [
      `${id} exited 0 when ${world}. ${because}. An assertion that reports \`passed\` about a world it cannot possibly have checked is not asserting anything — this is exactly the shape a script gutted to \`report('${id}')\` takes, and it is green under every other rule in this repository. Its output was: ${output.trim().slice(0, 400) || '(nothing at all)'}`,
    ];
  }
  if (!expect.test(output)) {
    return [
      `${id} exited ${outcome.status} when ${world}, which is red — but nothing in its output matched ${expect}, so it did not visibly fail for the reason this control planted. A red for an unrelated reason (a missing binary, a syntax error, a runner with no docker) would look exactly like this, and a control that accepts it is a control that would keep passing after the check was deleted. Its output was: ${output.trim().slice(0, 400) || '(nothing at all)'}`,
    ];
  }
  return [];
}

/**
 * Run one control's entry point and collect what happened.
 *
 * The *repository's* script, always — `control.argv` is resolved against the
 * child's working directory only for the arguments, and the script path is made
 * absolute against the real tree. A control that ran a copied script would be
 * checking the copy, and the copy is the one thing here nobody ships.
 */
function runControl(control, cwd, root, overrides = {}) {
  const argv = [resolve(root, control.argv[0]), ...control.argv.slice(1)];
  const env = { ...process.env, ...(control.env?.() ?? {}), ...overrides };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  try {
    const output = execFileSync(process.execPath, argv, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : undefined,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      error,
    };
  }
}

/**
 * The second world, run, and the grading of the pair.
 *
 * The decoy listens on a port of its own rather than on the deployment's, so
 * `worldProblems`' "nothing may be listening here" precondition stays true of
 * the port every other control in the group is about. Only the child is pointed
 * at it.
 */
function distinguish(control, cwd, root, cold) {
  let port;
  try {
    port = freePort();
  } catch (error) {
    return [
      `${control.id}: no port could be obtained to stand the decoy on (${error.message}), so the two worlds could not be compared. An inconclusive measurement is not a passing one.`,
    ];
  }
  const server = spawn(process.execPath, ['-e', DECOY_SERVER, String(port)], { stdio: 'ignore' });
  try {
    let up = false;
    for (let attempt = 0; attempt < 20 && !up; attempt += 1) up = isListening('127.0.0.1', port);
    if (!up) {
      return [
        `${control.id}: the decoy never started listening on 127.0.0.1:${port}, so the world this control has to be told apart from was never created. Inconclusive is not a pass.`,
      ];
    }
    const decoy = runControl(control, cwd, root, {
      ATRIUM_STACK_ADDRESS: '127.0.0.1',
      ATRIUM_STACK_HTTPS_PORT: String(port),
    });
    return distinguishProblems(control, cold, decoy);
  } finally {
    server.kill('SIGKILL');
  }
}

/** A copy of the tree, broken the way this group of controls needs it broken. */
function brokenTree(root, controls) {
  const workspace = mkdtempSync(join(tmpdir(), 'atrium-positive-control-'));
  for (const entry of COPIED) {
    cpSync(join(root, entry), join(workspace, entry), {
      recursive: true,
      filter: (source) => !NOT_COPIED.has(source.split(/[/\\]/).pop()),
    });
  }
  for (const control of controls) control.break?.(workspace);
  return workspace;
}

/**
 * Every control in one group, run.
 *
 * @param {'verify'|'deploy'|'selfcheck'} group
 * @param {string} root the repository
 * @returns {{problems: string[], ran: string[]}}
 */
export function runGroup(group, root) {
  const controls = CONTROLS[group];
  if (!Array.isArray(controls) || controls.length === 0) {
    return {
      ran: [],
      problems: [
        `there is no control group called \`${group}\`. The groups are ${Object.keys(CONTROLS).join(', ')}, and a step that names one that does not exist would run nothing and exit 0 — which is this file's own failure mode, one level up.`,
      ],
    };
  }
  const world = worldProblems(group);
  if (world.length > 0) return { ran: [], problems: world };
  return runControls(controls, root);
}

/**
 * The number of children a group was supposed to produce (#40 round 9, D2).
 *
 * Read by `main`, deliberately *outside* `runGroup`. The first version of this
 * cross-check lived inside `runGroup`, one line below the place the measured
 * bypass goes — `if (process.env.CI !== undefined) return [];` — so the bypass
 * short-circuited the check along with the work, and `CI=true positive-control
 * selfcheck` still exited 0 announcing that nothing had failed. A check inside
 * the thing it is checking is the sole-enforcer defect this repository has a
 * whole registry about, at the scale of one function.
 */
export function expectedControls(group) {
  const controls = CONTROLS[group];
  return Array.isArray(controls) ? controls.length : 0;
}

/**
 * A list of controls, run.
 *
 * Exported separately from `runGroup` so that `gate-selftest.mjs` can hand this
 * one synthetic control — a script gutted to `report(…)`, which is the measured
 * D3 exploit — and require the whole mechanism, not just its grading function,
 * to say so. A test of `controlProblems` alone would be a test of the arithmetic
 * over an outcome nobody produced.
 *
 * @param {object[]} controls
 * @param {string} root the repository
 * @returns {{problems: string[], ran: string[]}}
 */
export function runControls(controls, root) {
  const needsTree = controls.some((control) => control.break !== undefined);
  const workspace = needsTree ? brokenTree(root, controls) : undefined;
  const problems = [];
  const ran = [];
  try {
    for (const control of controls) {
      const cwd = control.break === undefined ? root : workspace;
      const outcome = runControl(control, cwd, root);
      ran.push(control.id);
      const found = controlProblems(control, outcome);
      if (control.distinguishes === true) {
        found.push(...distinguish(control, cwd, root, outcome));
      }
      problems.push(...found);
      console.info(
        `  ${found.length === 0 ? 'red as required' : 'DID NOT FAIL   '} ${control.id.padEnd(28)} exit=${outcome.status ?? 'none'} bytes=${(outcome.output ?? '').length}${control.distinguishes === true ? ' (+decoy)' : ''}`,
      );
    }
  } finally {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  }
  return { problems, ran };
}

function main(argv) {
  const group = argv[2];
  if (group === undefined) {
    console.error(
      `::error::positive-control: name a group — ${Object.keys(CONTROLS).join(' or ')}. A run with no argument would check nothing and exit 0.`,
    );
    return 2;
  }
  // Before a single child is spawned: a table of expectations that could be
  // satisfied by an unrelated red is a table that proves nothing, and finding
  // that out after ten green children is finding it out too late.
  const expectations = expectationProblems();
  if (expectations.length > 0) {
    for (const problem of expectations) console.error(`::error::positive-control: ${problem}`);
    console.error(`positive-control: ${expectations.length} expectation(s) match an identity.`);
    return 1;
  }
  const root = repoRoot();
  console.info(
    `Positive control (${group}): every entry point below is run against a world in which it must fail. An exit of 0 here is the failure.`,
  );
  const { problems, ran } = runGroup(group, root);
  // The names the loop produced, against the table `main` can see for itself.
  // Whatever silences the loop — an early return, a filter that selects nothing,
  // a `break` — the names are what it has to have produced.
  const expected = expectedControls(group);
  if (ran.length !== expected) {
    problems.push(
      `the \`${group}\` group has ${expected} control(s) and ${ran.length} ran (${ran.join(', ') || 'none at all'}). A control that did not run is not a control that passed, and a step that reports its table's size rather than its children's names is a step one \`return []\` disarms in silence — measured on r8 as "10 entry point(s) each failed" with no child process spawned at all.`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::positive-control: ${problem}`);
    console.error(`positive-control: ${problems.length} control(s) did not come back red.`);
    return 1;
  }
  console.info(
    `positive-control: ${ran.length} entry point(s) each failed, visibly, in a world where they had to (${ran.join(', ')}). The other half of every pair is the same script's real run later in this job.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
