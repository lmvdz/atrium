/**
 * The stack CI just asserted against is the *production* stack.
 *
 * ## The hole this closes
 *
 * The deploy job runs `docker-compose.yml` plus `docker-compose.mailpit.yml`.
 * An overlay is a lever: it can add a mail catcher, which is what it is for, and
 * it can just as easily set `NODE_ENV=development`, or swap `APP_URL` for an
 * `http://` one, or set `ATRIUM_TRUSTED_PROXY_HOPS=0` — and every other
 * assertion in this job would keep passing while proving something about a
 * configuration nobody ships. That is precisely the shape of the defect #40
 * exists to close, one layer up: a green check over a thing that is not the
 * thing.
 *
 * So the values are read back out of the **running containers** rather than out
 * of the YAML. `docker inspect` reports the environment the process was actually
 * given, after every file, every `.env`, and every interpolation. A drift
 * anywhere in that chain shows up here.
 *
 * ## What is asserted, and why each one
 *
 * - `NODE_ENV=production` on `app` and `server` — the switch that turns on every
 *   fail-closed rule in this repository. Without it the mail gate, the secure
 *   -origin rule and the required proxy hop count all stand down, and the rest of
 *   this job would be measuring the development build.
 * - `APP_URL` is `https://` and identical on both processes — the origin session
 *   cookies are minted for, and the origin the WebSocket upgrade checks against.
 *   Two processes disagreeing about it is a deployment where every upgrade reads
 *   as unauthenticated, and each process looks fine alone.
 * - `ATRIUM_WS_URL` is `wss://` and on the app's own origin.
 * - `ATRIUM_TRUSTED_PROXY_HOPS` is a positive number on both — `0` is honest for
 *   a directly published port and false for this topology, and it is what makes
 *   the limiter's IP dimension a global bucket instead of a per-address one.
 * - `ATRIUM_MAIL_TRANSPORT=smtp` — that the boot gate was satisfied by a real
 *   transport rather than by the gate having been weakened.
 * - neither process has `ATRIUM_MAIL_OUTBOX` set: the outbox is a plaintext file
 *   of one-click sign-in links, and its own guard already refuses to write in
 *   production, but a production stack should not be asking.
 */

import { containerEnv, psAll } from './compose.mjs';
import { check, report } from './stack-client.mjs';

const containers = new Map(psAll().map((container) => [container.Service, container]));
const environments = new Map();

for (const service of ['app', 'server']) {
  const container = containers.get(service);
  if (!check(container !== undefined, `no \`${service}\` container to inspect`)) continue;
  const env = containerEnv(container.ID);
  environments.set(service, env);

  check(
    env.NODE_ENV === 'production',
    `\`${service}\` runs with NODE_ENV=${env.NODE_ENV ?? '(unset)'}; every fail-closed rule in this repository is conditioned on \`production\``,
  );
  check(
    (env.APP_URL ?? '').startsWith('https://'),
    `\`${service}\` has APP_URL=${env.APP_URL ?? '(unset)'}, which is not https://`,
  );
  const hops = Number(env.ATRIUM_TRUSTED_PROXY_HOPS);
  check(
    Number.isInteger(hops) && hops >= 1,
    `\`${service}\` has ATRIUM_TRUSTED_PROXY_HOPS=${env.ATRIUM_TRUSTED_PROXY_HOPS ?? '(unset)'}; this stack puts a proxy in front, so anything but a positive whole number is a limiter counting the wrong caller`,
  );
  check(
    env.ATRIUM_MAIL_TRANSPORT === 'smtp',
    `\`${service}\` has ATRIUM_MAIL_TRANSPORT=${env.ATRIUM_MAIL_TRANSPORT ?? '(unset)'}; the mail assertions only mean something against a real transport`,
  );
  check(
    !env.ATRIUM_MAIL_OUTBOX,
    `\`${service}\` sets ATRIUM_MAIL_OUTBOX, which is a plaintext file of single-use sign-in links`,
  );
}

const app = environments.get('app');
const server = environments.get('server');
if (app && server) {
  check(
    app.APP_URL === server.APP_URL,
    `\`app\` and \`server\` disagree about APP_URL (${app.APP_URL} vs ${server.APP_URL}); every socket upgrade would read as unauthenticated`,
  );
  check(
    app.BETTER_AUTH_SECRET === server.BETTER_AUTH_SECRET && Boolean(app.BETTER_AUTH_SECRET),
    '`app` and `server` do not share one BETTER_AUTH_SECRET; each process works and no session crosses between them',
  );
}

if (app) {
  check(
    (app.ATRIUM_WS_URL ?? '').startsWith('wss://'),
    `\`app\` has ATRIUM_WS_URL=${app.ATRIUM_WS_URL ?? '(unset)'}, which is not wss://`,
  );
  check(
    app.NEXT_PUBLIC_WS_URL === undefined,
    '`app` still carries NEXT_PUBLIC_WS_URL — that prefix means the value is substituted at build time, which is how this deployment shipped a browser told to open a socket to localhost',
  );
  try {
    check(
      new URL(app.ATRIUM_WS_URL ?? '').host === new URL(app.APP_URL ?? '').host,
      `\`app\` points the browser at ${app.ATRIUM_WS_URL} while serving ${app.APP_URL}; the socket has to be on the app's own origin for the session cookie to ride along`,
    );
  } catch {
    check(false, 'the app`s APP_URL or ATRIUM_WS_URL is not a URL');
  }
}

report('assert-stack-config');
