/**
 * The sign-in limiter's IP dimension is per address, through the shipped proxy.
 *
 * ## What #26 could never establish, and why
 *
 * Round 3 of #26 published `app` directly with `ATRIUM_TRUSTED_PROXY_HOPS=0`,
 * and both critics found the consequence: a Next.js Server Action has no caller
 * address at all in that topology, so the limiter's IP dimension counted nobody.
 * Round 4 put Caddy in front, set `hops=1`, and demonstrated a per-address
 * limit — but the demonstration ran against an **uncommitted development
 * override**, because the committed stack could not serve a page. So the claim
 * "the shipped deployment gets the per-address version" has never been true of
 * anything anyone ran. This is that claim, measured against the shipped file.
 *
 * ## Why the callers are containers
 *
 * Because a caller is an address, and from the host every caller has the same
 * one. Traffic to a published port arrives at Caddy from the docker bridge, so
 * `X-Forwarded-For` ends `…, 172.28.0.1` for every request no matter who sent
 * it — and a per-address limiter is then indistinguishable from a global one.
 * (A client-supplied `X-Forwarded-For` does not help and must not: Caddy
 * *appends*, `firstUntrustedHop` reads from the right, and the forged prefix is
 * ignored. That is the property the hop count exists for.)
 *
 * So each caller is a throwaway container with a fixed address on the compose
 * network, talking to `proxy` directly with the deployment's hostname in SNI and
 * `Host`. Caddy sees two genuinely different peers and appends two different
 * addresses, which is the arrangement a real deployment has.
 *
 * ## The assertion
 *
 * `apps/web/app/(auth)/actions.ts` caps sign-in at 60 attempts per 5 minutes per
 * address, with a separate per-account cap of 10 that every attempt below dodges
 * by using a fresh email. So:
 *
 *  - caller A, over the cap: refused, and refused *at* the cap rather than
 *    somewhere else — a limiter that fires on the third attempt is as broken as
 *    one that never fires;
 *  - caller B, one attempt, from a different address: allowed.
 *
 * B being allowed after A is refused is the whole property. If the dimension
 * were inert, neither would be refused; if it were global, both would be.
 *
 * ## Mutations it catches
 *
 * - `ATRIUM_TRUSTED_PROXY_HOPS` dropped or set to 0 on `app`: every caller falls
 *   into `unresolvedIpKey`, one shared bucket, and B is refused with A.
 * - the `proxy` service removed, or `reverse_proxy` replaced with something that
 *   does not append: same outcome, reached from the other side.
 * - the IP dimension deleted from `allow()` (round 3's `ip === null ? true`
 *   shape): A is never refused.
 */

import { execFileSync } from 'node:child_process';
import { inspect, psAll } from './compose.mjs';
import { check, report } from './stack-client.mjs';

const domain = process.env.ATRIUM_STACK_DOMAIN?.trim() || 'atrium.localhost';
const caPath = process.env.ATRIUM_STACK_CA?.trim();
const repoRoot = process.cwd();
/** `createThrottle({ limit: 60, … })` on the IP dimension, in actions.ts. */
const capacity = Number(process.env.ATRIUM_SIGNIN_IP_LIMIT ?? 60);

const proxy = psAll().find((container) => container.Service === 'proxy');
if (!check(proxy !== undefined, 'no `proxy` container to aim at')) report('assert-rate-limit');

const networks = inspect(proxy.ID).NetworkSettings?.Networks ?? {};
const [networkName, networkInfo] = Object.entries(networks)[0] ?? [];
if (!check(networkName !== undefined, 'the proxy container is on no network')) {
  report('assert-rate-limit');
}
const proxyAddress = networkInfo.IPAddress;

/** Runs one caller in its own container, at its own address. */
function probe(label, address, attempts) {
  const args = [
    'run',
    '--rm',
    '--network',
    networkName,
    '--ip',
    address,
    '-v',
    `${repoRoot}/scripts:/scripts:ro`,
    ...(caPath ? ['-v', `${caPath}:/ca/root.crt:ro`] : []),
    '-e',
    `ATRIUM_STACK_DOMAIN=${domain}`,
    '-e',
    `ATRIUM_STACK_ADDRESS=${proxyAddress}`,
    '-e',
    'ATRIUM_STACK_HTTPS_PORT=443',
    ...(caPath ? ['-e', 'ATRIUM_STACK_CA=/ca/root.crt'] : []),
    '-e',
    `ATRIUM_PROBE_ATTEMPTS=${attempts}`,
    '-e',
    `ATRIUM_PROBE_LABEL=${label}`,
    'node:22-alpine',
    'node',
    '/scripts/ci/probe-caller.mjs',
  ];
  const out = execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // The image prints nothing else, but a stray line would make JSON.parse throw
  // with a message about the wrong thing.
  const json = out.slice(out.indexOf('{'));
  return JSON.parse(json);
}

// One over the cap: the last attempt must be the refused one.
const spraying = probe('spray', '172.28.0.101', capacity + 1);
check(!spraying.error, `the spraying caller could not run: ${spraying.error}`);
check(
  spraying.limited === true,
  `${spraying.attempts} sign-in attempts from one address were all allowed; the IP dimension is inert (last landed on ${spraying.lastPath})`,
);
check(
  spraying.limitedAt === capacity + 1,
  `the limiter refused attempt ${spraying.limitedAt} from one address; the configured cap is ${capacity}, so it should have refused attempt ${capacity + 1}`,
);

// A different address, one attempt, immediately afterwards.
const bystander = probe('bystander', '172.28.0.102', 1);
check(!bystander.error, `the bystanding caller could not run: ${bystander.error}`);
check(
  bystander.limited === false,
  `a caller at a different address was refused straight away (landed on ${bystander.lastPath}); the limiter is counting everybody into one bucket, not per address`,
);

console.info(
  `Caller 172.28.0.101 refused at attempt ${spraying.limitedAt} (cap ${capacity}); caller 172.28.0.102 allowed.`,
);
report('assert-rate-limit');
