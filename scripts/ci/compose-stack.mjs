/**
 * The one place this repository says `docker compose` about the deployed stack.
 *
 * ## The defect this closes (#40, round-2 gauntlet, blocking 2)
 *
 * "Preflight may not inspect the configuration that is deployed. Preflight
 * resolves `ATRIUM_COMPOSE_FILES`; build/up/cp/down hard-code the two base
 * files. An extra 'safe' overlay lets preflight see `gateway_mode=nat` while the
 * real `up` uses a routed base network."
 *
 * That was exactly right, and it is the two-halves-that-never-meet class one
 * level up: the assertions read the file list out of the environment (through
 * `composeArgs` in compose.mjs) while the four compose verbs in the workflow
 * carried their own literal `-f` flags. Nothing compared the two. Any check in
 * this job that reads the *resolved configuration* — the preflight's gateway
 * modes, `record-built-images`'s image names — was therefore inspecting a
 * different stack from the one that came up, and every one of them would have
 * reported honestly about it.
 *
 * So the file list is resolved **once**, by `composeArgs`, and every invocation
 * goes through it: the assertions already did, and now the verbs do too. There
 * is no second list to disagree with the first, because there is no second list.
 * `workflow-policy.mjs`'s `compose-through-one-entrypoint` rule keeps it that
 * way: a bare `docker compose` in the `deploy` job is refused, so re-introducing
 * a literal file list is a red build rather than a silent divergence.
 *
 * ## Why the flags live here and not in the workflow
 *
 * `--wait` and `-v` are load-bearing (see each verb below), and moving them out
 * of the YAML means the policy engine can no longer read them off the step. That
 * is a real trade and it is paid for: `gate-selftest.mjs` asserts the argv this
 * file builds for every verb, which is a stronger check than matching words in a
 * `run:` string — it tests the code that runs rather than the text beside it.
 *
 * ## Why the mutation ledger can re-run these
 *
 * A ledger case is "the shipped stack plus one overlay". Because the file list
 * comes from `ATRIUM_COMPOSE_FILES`, the ledger applies its overlay by setting
 * that variable and then runs *the workflow's own command, verbatim* — the same
 * argv, parsed out of `ci.yml`. Before this file existed it had to recover a
 * script name by regular expression and invoke something of its own devising,
 * which is how it certified an assertion that CI had skipped.
 *
 *   node scripts/ci/compose-stack.mjs build
 *   node scripts/ci/compose-stack.mjs up
 *   node scripts/ci/compose-stack.mjs trust-ca
 *   node scripts/ci/compose-stack.mjs down
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { composeArgs } from './compose.mjs';

/**
 * The four verbs, and what each one's flags are for.
 *
 * Exported as data so `gate-selftest.mjs` can assert the argv rather than trust
 * the prose: the two flags that carry an argument — `--wait` and `-v` — are the
 * two whose absence is a silent failure, and each has a mutation naming it.
 */
export const VERBS = {
  build: {
    /**
     * From the shipped Dockerfiles, from a clean checkout. This is the step that
     * had silently been failing for everyone since `packages/ingest` landed
     * without its manifest being copied into either image.
     */
    args: () => ['build'],
    streams: true,
  },
  up: {
    /**
     * `--wait` is part of the claim, not decoration: `up -d` alone returns the
     * moment the containers are *created*, so every assertion after it would
     * race a stack that has not finished starting — and a race that loses reads
     * as a broken deployment rather than a slow one. `--wait` also fails the
     * command outright when a service never becomes healthy, which is what turns
     * the ledger's `no-transport` and `no-health-check` cases red here rather
     * than four steps later for a confusing reason.
     */
    args: () => ['up', '-d', '--wait', '--wait-timeout', '300'],
    streams: true,
  },
  'trust-ca': {
    /**
     * Caddy's internal root, copied out of the running proxy. Every assertion
     * verifies the certificate chain against it, so a stack whose TLS was broken
     * fails rather than being waved through — which is what
     * `rejectUnauthorized: false` would have done, and it appears nowhere in
     * this repository.
     */
    args: (env) => ['cp', `proxy:${CA_IN_PROXY}`, caPath(env)],
    streams: false,
    after: (env) => {
      const path = caPath(env);
      if (!existsSync(path) || statSync(path).size === 0) {
        throw new Error(
          `\`docker compose cp\` reported success but ${path} is missing or empty. Every assertion in this job verifies the deployment's certificate chain against that file; an empty one makes all of them fail on the certificate instead of on what they are about.`,
        );
      }
      console.info(`Trusting ${path} (${statSync(path).size} bytes) as this deployment's root CA.`);
    },
    before: (env) => rmSync(caPath(env), { force: true }),
  },
  down: {
    /**
     * `-v` is the whole point: `down` without it leaves every named volume, and
     * on a real host the next `up` adopts last month's database.
     * `assert-stack-teardown.mjs` exists to notice exactly that, and the ledger
     * case `teardown-keeps-volumes` is a mutation of this argv.
     */
    args: () => ['down', '-v', '--remove-orphans'],
    streams: true,
  },
};

/** Where Caddy keeps the root it mints for its internal CA. */
const CA_IN_PROXY = '/data/caddy/pki/authorities/local/root.crt';

function caPath(env) {
  const path = env.ATRIUM_STACK_CA?.trim();
  if (!path) {
    throw new Error(
      "set ATRIUM_STACK_CA to the file this run should copy the deployment root CA into; without it nothing in this job can verify the stack's certificate chain, and the only alternative is to stop verifying",
    );
  }
  return path;
}

/**
 * The full argv for one verb, as a pure function of the verb and the
 * environment. `gate-selftest.mjs` asserts these; nothing else derives them.
 */
export function composeStackArgv(verb, env = process.env) {
  const definition = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!definition) {
    throw new Error(
      `unknown compose verb "${verb}". Known: ${Object.keys(VERBS).join(', ')}. A verb this file does not know is a compose invocation nobody reviewed.`,
    );
  }
  return ['compose', ...composeArgs(env), ...definition.args(env)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [verb, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    console.error(
      `::error::compose-stack: extra arguments ${JSON.stringify(rest)}. This takes exactly one verb, so that what runs is decided here rather than at every call site.`,
    );
    process.exit(2);
  }
  let argv;
  try {
    argv = composeStackArgv(verb);
  } catch (error) {
    console.error(`::error::compose-stack: ${error.message}`);
    process.exit(2);
  }
  const definition = VERBS[verb];
  definition.before?.(process.env);
  console.info(`$ docker ${argv.join(' ')}`);
  try {
    execFileSync('docker', argv, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: definition.streams ? 'inherit' : ['ignore', 'inherit', 'inherit'],
    });
    definition.after?.(process.env);
  } catch (error) {
    console.error(`::error::compose-stack: \`docker ${argv.join(' ')}\` failed — ${error.message}`);
    process.exit(1);
  }
}
