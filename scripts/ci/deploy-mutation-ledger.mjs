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
 *   node scripts/ci/deploy-mutation-ledger.mjs no-transport hops-zero
 *
 * Environment: the same variables the deploy job sets —
 * `ATRIUM_COMPOSE_PROJECT`, `ATRIUM_COMPOSE_FILES`, `ATRIUM_STACK_DOMAIN`,
 * `ATRIUM_STACK_CA`, `ATRIUM_WEB_IMAGE` — plus a `.env` compose can interpolate.
 * The images must already be built.
 *
 * ## How the mutations are applied
 *
 * As a **third compose overlay**, wherever that is possible, rather than as an
 * edit to a tracked file. Two reasons. It keeps the ledger re-runnable from a
 * clean checkout with no `git stash` dance, and — more usefully — it means each
 * case mutates exactly one thing and puts it back, so a case that passes for the
 * wrong reason is much harder to write. The two cases that cannot be expressed
 * that way (a value compiled into the image, and the teardown's own flags) say
 * so and are driven directly.
 *
 * ## What a "pass" means here
 *
 * The named assertion **failed** against the mutated stack, and the same
 * assertion passes against the unmutated one — which the deploy job proves on
 * every run. A case that goes green under mutation is reported as a FAILED
 * LEDGER ENTRY, because the check it names does not catch what it claims to.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = process.env.ATRIUM_COMPOSE_PROJECT?.trim() || 'atrium-ledger';
const baseFiles = (
  process.env.ATRIUM_COMPOSE_FILES?.trim() || 'docker-compose.yml:docker-compose.mailpit.yml'
)
  .split(/[:,]/)
  .filter(Boolean);
const workDir = mkdtempSync(join(tmpdir(), 'atrium-ledger-'));

/**
 * Each case: what is mutated, which assertion must catch it, and why that is
 * the interesting failure rather than an incidental one.
 */
const CASES = [
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
    expect: 'boot',
    note: 'With no relay, `resolveMailer` refuses the console transport in production and both processes fail their boot condition. Before #40 the web app answered 500 to every request instead; `instrumentation.ts` turns that into a refusal to start, so this is caught at `up --wait` rather than by a page assertion. The 500 itself is the `serves-500` case below.',
  },
  {
    id: 'serves-500',
    what: "the same missing transport, with #40's boot guard and health check disabled",
    catches: 'assert-page-serves',
    overlay: {
      services: {
        app: {
          environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' },
          // `disable: true` is compose's own way of removing an inherited health
          // check, so the container reports "running" the way a pre-#40 one did.
          healthcheck: { disable: true },
        },
        server: { environment: { ATRIUM_MAIL_TRANSPORT: 'console', SMTP_URL: '' } },
      },
    },
    // `server` still refuses to boot, so the stack never fully settles; the
    // point of the case is what `app` does, which is answer 500 to a real page.
    expect: 'assertion',
    assertion: 'assert-page-serves.mjs',
    tolerateBootFailure: true,
    note: 'This is the state #26 round 4 actually found: a web app that starts, reports nothing wrong, and answers 500 to every page. It is what the page assertion exists for.',
  },
  {
    id: 'hops-zero',
    what: 'ATRIUM_TRUSTED_PROXY_HOPS=0 on the web app',
    catches: 'assert-rate-limit',
    overlay: { services: { app: { environment: { ATRIUM_TRUSTED_PROXY_HOPS: '0' } } } },
    expect: 'assertion',
    assertion: 'assert-rate-limit.mjs',
    note: 'A Server Action has no peer address, so every caller falls into `unresolvedIpKey` — one shared bucket. The limiter still refuses somebody; it stops being per-address, which is precisely what round 3 shipped and what nothing could see.',
  },
  {
    id: 'split-secret',
    what: 'a different BETTER_AUTH_SECRET on the realtime server',
    catches: 'assert-ws-upgrade',
    overlay: {
      services: {
        server: { environment: { BETTER_AUTH_SECRET: 'a-different-secret-0123456789abcdef' } },
      },
    },
    expect: 'assertion',
    assertion: 'assert-ws-upgrade.mjs',
    note: 'Both processes work perfectly alone. No session crosses between them, so every upgrade reads as unauthenticated — the two-components-that-never-meet class, at the deployment layer.',
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
    expect: 'assertion',
    assertion: 'assert-signup-verifies.mjs',
    note: 'The configuration is well-formed, so every boot condition passes and the stack is healthy. Nothing is delivered. This is the case a config-shape check cannot reach and only a real message can.',
  },
  {
    id: 'development-node-env',
    what: 'NODE_ENV=development smuggled onto the realtime server by an overlay',
    catches: 'assert-stack-config',
    overlay: { services: { server: { environment: { NODE_ENV: 'development' } } } },
    expect: 'assertion',
    assertion: 'assert-stack-config.mjs',
    note: 'The lever this assertion exists for: an overlay that quietly turns the deploy job into a check on a development stack while every other assertion keeps passing.',
  },
  {
    id: 'no-health-check',
    what: "the app's health check disabled",
    catches: 'assert-stack-health',
    overlay: { services: { app: { healthcheck: { disable: true } } } },
    expect: 'assertion',
    assertion: 'assert-stack-health.mjs',
    note: '`docker compose up --wait` settles for "running" on a service with no health check, and reports success. Round 4\'s `app` was running.',
  },
  {
    id: 'teardown-keeps-volumes',
    what: '`docker compose down` without `-v`',
    catches: 'assert-stack-teardown',
    expect: 'teardown',
    note: "One character. Four named volumes survive, and on a real host the next `up` adopts last month's database.",
  },
];

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

/** Runs a command and reports whether it succeeded, never throwing. */
function attempt(run) {
  try {
    return { ok: true, output: run() };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}` };
  }
}

/** A YAML overlay for one case, written without a YAML library. */
function writeOverlay(id, overlay) {
  const path = join(workDir, `mutation-${id}.yml`);
  const lines = [
    '# generated by scripts/ci/deploy-mutation-ledger.mjs',
    'name: atrium',
    'services:',
  ];
  for (const [service, body] of Object.entries(overlay.services)) {
    lines.push(`  ${service}:`);
    if (body.healthcheck?.disable) lines.push('    healthcheck:', '      disable: true');
    if (body.environment) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(body.environment)) {
        lines.push(`      ${key}: ${JSON.stringify(String(value))}`);
      }
    }
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function copyCertificateAuthority(files) {
  const target = process.env.ATRIUM_STACK_CA;
  if (!target) return { ok: true };
  rmSync(target, { force: true });
  const copied = attempt(() =>
    compose(files, ['cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', target]),
  );
  return { ok: copied.ok && existsSync(target), output: copied.output };
}

/**
 * Did the boot fail *because of the mutation*, or because of the machine?
 *
 * The first draft of this file read any non-zero `up` as the mutation being
 * caught, and the first real run of it duly reported CAUGHT on a case whose
 * stack had failed to start because another compose project on the same laptop
 * already held the subnet. That is the "passed for the wrong reason" failure
 * this whole ledger exists to detect, committed by the ledger itself. So the
 * failure has to be about a *container*: compose says `container X is unhealthy`
 * or `container X exited` when a service fails its own condition, and says
 * something about networks, images or ports when the environment is at fault.
 */
const CONTAINER_FAILURE = /container .* (is unhealthy|exited)/i;

function runCase(entry) {
  const files = entry.overlay ? [...baseFiles, writeOverlay(entry.id, entry.overlay)] : baseFiles;
  attempt(() => compose(files, ['down', '-v', '--remove-orphans']));

  const boot = attempt(() =>
    compose(files, ['up', '-d', '--wait', '--wait-timeout', '180'], { timeout: 300_000 }),
  );
  const bootFailedOnAContainer = !boot.ok && CONTAINER_FAILURE.test(boot.output);

  let caught;
  let detail;

  if (entry.expect === 'boot') {
    caught = bootFailedOnAContainer;
    detail = boot.ok
      ? 'the stack came up healthy, which it must not have'
      : bootFailedOnAContainer
        ? lastLines(boot.output, 3)
        : `INCONCLUSIVE — the boot failed for a reason that is not the mutation: ${lastLines(boot.output, 2)}`;
  } else if (entry.expect === 'teardown') {
    // The stack has to have genuinely come up, or "nothing survived the
    // teardown" is trivially true and this case proves nothing.
    if (!boot.ok) {
      attempt(() => compose(files, ['down', '-v', '--remove-orphans']));
      return {
        entry,
        caught: false,
        detail: `INCONCLUSIVE — nothing was running to survive a teardown: ${lastLines(boot.output, 2)}`,
      };
    }
    attempt(() => compose(files, ['down', '--remove-orphans']));
    const assertion = attempt(() =>
      execFileSync('node', ['scripts/ci/assert-stack-teardown.mjs'], {
        encoding: 'utf8',
        env: { ...process.env, ATRIUM_COMPOSE_PROJECT: project },
      }),
    );
    caught = !assertion.ok;
    detail = lastLines(assertion.output, 3);
  } else {
    // `tolerateBootFailure` cases expect *some* service to fail its condition;
    // they still need that failure to be a container's rather than the host's.
    const bootUsable = boot.ok || (entry.tolerateBootFailure && bootFailedOnAContainer);
    if (!bootUsable) {
      attempt(() => compose(files, ['down', '-v', '--remove-orphans']));
      return {
        entry,
        caught: false,
        detail: `INCONCLUSIVE — the stack never came up: ${lastLines(boot.output, 2)}`,
      };
    }
    const authority = copyCertificateAuthority(files);
    if (!authority.ok) {
      attempt(() => compose(files, ['down', '-v', '--remove-orphans']));
      return {
        entry,
        caught: false,
        detail:
          'INCONCLUSIVE — the certificate authority could not be copied, so the assertion would have failed on TLS rather than on the mutation',
      };
    }
    const assertion = attempt(() =>
      execFileSync('node', [`scripts/ci/${entry.assertion}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ATRIUM_COMPOSE_PROJECT: project,
          ATRIUM_COMPOSE_FILES: files.join(':'),
        },
        timeout: 300_000,
      }),
    );
    caught = !assertion.ok;
    detail = lastLines(assertion.output, 4);
  }

  attempt(() => compose(files, ['down', '-v', '--remove-orphans']));
  return { entry, caught, detail };
}

function lastLines(text, count) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('::group'))
    .slice(-count)
    .join(' | ')
    .slice(0, 700);
}

const wanted = process.argv.slice(2);
const selected = wanted.length > 0 ? CASES.filter((entry) => wanted.includes(entry.id)) : CASES;
if (selected.length === 0) {
  console.error(`no such case. Known: ${CASES.map((entry) => entry.id).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const entry of selected) {
  console.info(`\n=== ${entry.id}: ${entry.what}`);
  const result = runCase(entry);
  results.push(result);
  console.info(`    ${result.caught ? 'CAUGHT' : 'MISSED'} by ${entry.catches} — ${result.detail}`);
}

rmSync(workDir, { recursive: true, force: true });

console.info('\n--- ledger ---');
for (const { entry, caught, detail } of results) {
  console.info(`${caught ? 'CAUGHT ' : 'MISSED '} ${entry.id.padEnd(24)} ${entry.catches}`);
  if (!caught) console.info(`         ${detail}`);
}
const missed = results.filter((result) => !result.caught);
if (missed.length > 0) {
  console.error(
    `\n${missed.length} mutation(s) went unnoticed: ${missed.map((result) => result.entry.id).join(', ')}. A check that does not catch what it names is not yet a check.`,
  );
  process.exit(1);
}
console.info(`\nAll ${results.length} mutations caught by the check that names them.`);
