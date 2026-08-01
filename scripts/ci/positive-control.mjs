/**
 * Break the thing; require the red.
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
 * running at all**, `gate-selftest 0 (184) · wps 0 · workflow-policy 0 · vitest
 * 0 (766) · biome 0 · mainGuardProblems: 0`. Every rule this repository has was
 * satisfied. The guard scanner pins that the `report` a script ends on is the
 * shared one, which makes the *decision* honest; the registry pins that
 * `verdict` still turns a recorded failure into a failing status, which makes
 * the *arithmetic* honest. Neither says anything about whether anything was
 * checked before the reporting.
 *
 * No rule about the text of a file can. `main()` rewritten to `() => 0`
 * satisfies every syntactic rule here and always will — `guard-scan.mjs` says so
 * in its own scope statement. The only thing that can tell an assertion from a
 * shape that looks like one is running it in a world where it *must* fail and
 * requiring it to.
 *
 * ── THE PAIR ────────────────────────────────────────────────────────────────
 * So each control below is half of a pair, and the job runs both halves:
 *
 *   negative control  the real step, later in the same job, against the real
 *                     world — it must pass
 *   positive control  this step, against a world that is deliberately broken —
 *                     it must fail, and say something about why
 *
 * One half alone proves nothing. A script that always passes satisfies the
 * first; a script that always fails satisfies the second; only a script whose
 * answer is a function of the world satisfies both. **`exit 0` here is the
 * failure this file exists to report**, and it is the one no rule about syntax
 * can reach.
 *
 * ── THE SCOPE, AS A SENTENCE, AND THE ATTACK ON IT ──────────────────────────
 * *This runs the entry points named in `CONTROLS`, as CI runs them, against a
 * broken world, and requires a non-zero exit whose output matches a stated
 * pattern.* Attacking that sentence, out loud, because the round this file was
 * written in is about scope statements:
 *
 *  - **"the entry points named in CONTROLS"** — a script not in the table is not
 *    controlled, and taking one *out* of the table is a one-line way past every
 *    word of this file. So the required set is not this table:
 *    `controlCoverageProblems` in checker-graph.mjs reads the deploy job's own
 *    steps and requires every `assert-*.mjs` it runs to be controlled here or
 *    exempted with the reason a broken world for it would be a false red. It
 *    found a real gap the moment it was written — `assert-migration-image` had
 *    no control at all — which is the argument for deriving a required set
 *    rather than declaring one, made by the rule against its own author.
 *  - **"a broken world"** — for the deploy controls that world is "no stack has
 *    been brought up yet", which is the cheapest one and not the strongest. It
 *    catches an assertion that checks nothing. It does not catch an assertion
 *    that checks *less than it claims* — deleting the HSTS header from the
 *    proxy and requiring `assert-page-serves` to notice is a stronger control,
 *    and it needs a running stack to perturb, which is a step that would have to
 *    come after the boot and put the deployment back afterwards. Stated, not
 *    done.
 *  - **"whose output matches a stated pattern"** — three of these scripts fail
 *    cold by *crashing* (an unhandled `ECONNREFUSED`) rather than by recording a
 *    failure through `check`. That is red, and red is what the control needs, but
 *    it is weaker than a recorded failure: a crash is not a verdict, which is the
 *    distinction `child-verdict.mjs` exists for. Their pattern therefore requires
 *    the output to name the script itself, so "it failed because node is not on
 *    PATH" is not mistaken for "it failed because the deployment was not there".
 *  - **and this file is itself an entry point**, so everything `guard-scan.mjs`
 *    enforces about the others applies to it, and `packages/ci-guard` asserts on
 *    `controlProblems` from outside `scripts/`.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notAVerdict } from './child-verdict.mjs';
import { isMainModule } from './main-module.mjs';
import { repoRoot } from './repo-root.mjs';

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
 * Every entry point this repository runs, and the world in which it must fail.
 *
 * `expect` is what the output has to say. It is per control rather than
 * "anything at all" so that a red for an unrelated reason — a missing binary, a
 * syntax error, a runner with no docker — is not read as the check working.
 */
export const CONTROLS = {
  verify: [
    {
      id: 'gate-selftest',
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
      argv: ['scripts/ci/workflow-policy-selftest.mjs'],
      world: 'a copy of the tree whose ci.yml lets the verify job fail without failing',
      break: (root) => breakWorkflow(root),
      expect: /continue-on-error/,
      because:
        "the other half of the pair that checks each other: disarming one leaves the other scanning it, which is worth exactly nothing if both can be disarmed by the same insertion — and on r7 they could, one line above each one's guard",
    },
    {
      id: 'workflow-policy',
      argv: ['scripts/ci/workflow-policy.mjs', '.github/workflows'],
      world: 'the same copy, read by the policy engine itself rather than by its self-test',
      break: (root) => breakWorkflow(root),
      expect: /continue-on-error/,
      because:
        'the engine and its self-test are separate entry points and a green self-test says nothing about the engine the workflow actually invokes',
    },
  ],

  /**
   * The stack assertions, run before anything is brought up.
   *
   * Every one of them is a function of a running deployment, so with no
   * deployment every one of them must be red. A script gutted to `report('…')`
   * is green here, which is the measured D3 exploit and the reason this group
   * exists; so is a script whose `main` was replaced by `() => 0`, and so is one
   * whose assertions were deleted and whose `console.info` was left behind.
   */
  deploy: [
    {
      id: 'assert-stack-health',
      argv: ['scripts/ci/assert-stack-health.mjs'],
      world: 'no stack has been brought up',
      expect: /assert-stack-health: the compose project has no containers at all/,
      because:
        'it is the first thing that would notice a deployment that is not there, and "healthy" was true of a 500ing app for three rounds',
    },
    {
      id: 'assert-stack-config',
      argv: ['scripts/ci/assert-stack-config.mjs'],
      world: 'no stack has been brought up',
      expect: /assert-stack-config: \d+ assertion\(s\) failed\./,
      because:
        'it reads the production configuration back out of the containers, so with no containers it must have nothing to read and say so',
    },
    {
      id: 'assert-image-identity',
      argv: ['scripts/ci/assert-image-identity.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-image-identity: no readable image manifest/,
      because:
        'built = running = scanned is the whole claim, and it is bound by a manifest that does not exist yet at this point in the job',
    },
    {
      id: 'assert-migration-image',
      argv: ['scripts/ci/assert-migration-image.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-migration-image: no readable image manifest/,
      because:
        'it is the last moment the answer about the migration image can still be no — `migrate` runs *inside* the boot, so by the time anything else looks, a wrong image has already written to a persistent volume. Found by the coverage rule in checker-graph.mjs, which reads the required set out of the workflow rather than out of this table',
    },
    {
      id: 'assert-image-origins',
      argv: ['scripts/ci/assert-image-origins.mjs'],
      world: 'nothing has been built and no image manifest has been written',
      expect: /assert-image-origins: no readable image manifest/,
      because: 'same manifest, and this is the scan round 3 exempted from the ledger',
    },
    {
      id: 'assert-stack-schema',
      argv: ['scripts/ci/assert-stack-schema.mjs'],
      world: 'no stack has been brought up, so there is no database to read',
      expect: /assert-stack-schema|no `postgres` container/,
      because:
        'it is the difference between `migrate` exiting 0 and the schema being there, and it cannot make that claim about a database that does not exist',
    },
    {
      id: 'assert-page-serves',
      argv: ['scripts/ci/assert-page-serves.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-page-serves/,
      because:
        'the measured D3 exploit replaced this entire file with `report(…)` and got `passed.` with no stack running. This control is the thing that says no',
    },
    {
      id: 'assert-signup-verifies',
      argv: ['scripts/ci/assert-signup-verifies.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-signup-verifies/,
      because: 'it drives a real form through a real SMTP relay, neither of which is up yet',
    },
    {
      id: 'assert-ws-upgrade',
      argv: ['scripts/ci/assert-ws-upgrade.mjs'],
      world: 'nothing is listening on the deployment’s port',
      expect: /assert-ws-upgrade/,
      because: 'an upgrade handshake against nothing cannot complete',
    },
    {
      id: 'assert-rate-limit',
      argv: ['scripts/ci/assert-rate-limit.mjs'],
      world: 'no stack has been brought up, so there is no proxy to aim callers at',
      expect: /assert-rate-limit: \d+ assertion\(s\) failed\./,
      because: 'it runs callers inside the compose network, which does not exist yet',
    },
  ],
};

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
function runControl(control, cwd, root) {
  const argv = [resolve(root, control.argv[0]), ...control.argv.slice(1)];
  try {
    const output = execFileSync(process.execPath, argv, {
      cwd,
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
 * @param {'verify'|'deploy'} group
 * @param {string} root the repository
 * @returns {string[]}
 */
export function runGroup(group, root) {
  const controls = CONTROLS[group];
  if (!Array.isArray(controls) || controls.length === 0) {
    return [
      `there is no control group called \`${group}\`. The groups are ${Object.keys(CONTROLS).join(', ')}, and a step that names one that does not exist would run nothing and exit 0 — which is this file's own failure mode, one level up.`,
    ];
  }
  return runControls(controls, root);
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
 * @returns {string[]}
 */
export function runControls(controls, root) {
  const needsTree = controls.some((control) => control.break !== undefined);
  const workspace = needsTree ? brokenTree(root, controls) : undefined;
  const problems = [];
  try {
    for (const control of controls) {
      const cwd = control.break === undefined ? root : workspace;
      const outcome = runControl(control, cwd, root);
      const found = controlProblems(control, outcome);
      problems.push(...found);
      console.info(
        `  ${found.length === 0 ? 'red as required' : 'DID NOT FAIL   '} ${control.id.padEnd(26)} exit=${outcome.status ?? 'none'} bytes=${(outcome.output ?? '').length}`,
      );
    }
  } finally {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  }
  return problems;
}

function main(argv) {
  const group = argv[2];
  if (group === undefined) {
    console.error(
      `::error::positive-control: name a group — ${Object.keys(CONTROLS).join(' or ')}. A run with no argument would check nothing and exit 0.`,
    );
    return 2;
  }
  const root = repoRoot();
  console.info(
    `Positive control (${group}): every entry point below is run against a world in which it must fail. An exit of 0 here is the failure.`,
  );
  const problems = runGroup(group, root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::positive-control: ${problem}`);
    console.error(`positive-control: ${problems.length} control(s) did not come back red.`);
    return 1;
  }
  console.info(
    `positive-control: ${CONTROLS[group].length} entry point(s) each failed, visibly, in a world where they had to. The other half of every pair is the same script's real run later in this job.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
