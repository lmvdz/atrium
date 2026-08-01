/**
 * The stack serves a real page, over TLS, through the shipped proxy.
 *
 * ## The assertion this replaces
 *
 * There wasn't one. Three rounds of gauntlet receipts described the compose
 * deployment as working while `app` answered 500 to every request, because
 * everything that had ever been checked about it was a part: the images built,
 * the containers reported healthy, `caddy validate` accepted the Caddyfile,
 * `docker compose config` refused an unset domain. None of those is the product
 * responding.
 *
 * So this one is deliberately not a health endpoint. It fetches `/` — which
 * renders the root layout, which renders `AccountBar`, which constructs the
 * whole Better Auth instance (the mail-transport gate, the secure-origin rule,
 * the proxy strategy) and then reads the session out of Postgres — and it
 * asserts on *content that only that page produces*. A 200 with an empty body,
 * an error page, or Next's default 500 shell all fail here.
 *
 * ## The mutations it catches
 *
 * - `ATRIUM_MAIL_TRANSPORT=console` in the deploy job (or the SMTP variables
 *   removed): `resolveMailer` throws, `auth()` throws, every page 500s. This is
 *   the exact pre-#40 state, and it is what the red run on the scratch branch
 *   demonstrates.
 * - the `env:` block put back in `apps/web/next.config.ts`: `ATRIUM_WS_URL` gets
 *   baked at build time, the runtime `wss://` value never arrives,
 *   `assertSecureTransport` refuses it, every page 500s.
 * - `deploy/Caddyfile`'s `handle` block pointed at nothing, or the app's port
 *   changed: the proxy answers 502 rather than the app's HTML.
 * - HSTS deleted from the Caddyfile, or the `:80` redirect removed — both are
 *   the "a comment is not a control" class this repo has been round with once.
 *
 * What it cannot catch is a page whose markers were changed to match a broken
 * render. The markers are structural (`data-region`, the sign-in link's
 * test id) rather than prose, so that would be a deliberate edit to
 * `apps/web/app/page.tsx` in the same commit, not a drift.
 */

import { check, follow, once, report, stackTarget } from './stack-client.mjs';

const target = stackTarget();

/** Regions come from `data-region` attributes the three-region shell renders. */
function regionsIn(html) {
  return new Set([...html.matchAll(/data-region="([a-z-]+)"/g)].map((match) => match[1]));
}

const home = await follow(target, '/');
check(home.status === 200, `GET / returned ${home.status}, not 200 (trail: ${trail(home)})`);
check(
  !/Application error|__NEXT_ERROR|Internal Server Error/i.test(home.body),
  'GET / returned an error shell rather than the page',
);

const regions = regionsIn(home.body);
for (const region of ['conversation', 'current-state', 'needs-you']) {
  check(
    regions.has(region),
    `GET / is missing the \`${region}\` region — this is not the app's page`,
  );
}
check(
  home.body.includes('data-testid="sign-in-link"'),
  'GET / rendered no sign-in link, so `AccountBar` — and therefore `auth()` — did not render',
);

// A second real page, and one whose whole job is a form. A root that renders
// while every other route 500s would be a stranger failure than the one this
// file exists for, but it is a failure the home page alone cannot see.
const signIn = await follow(target, '/sign-in');
check(signIn.status === 200, `GET /sign-in returned ${signIn.status}, not 200`);
check(
  signIn.body.includes('$ACTION_ID_'),
  'GET /sign-in rendered no Server Action id, so its form cannot be submitted without JavaScript',
);

// TLS is the deployment's boot condition, so the response has to carry the
// header that keeps a browser on it.
check(
  /max-age=\d+/.test(String(home.headers['strict-transport-security'] ?? '')),
  `no Strict-Transport-Security on the response (got ${home.headers['strict-transport-security']})`,
);

// And the cleartext listener redirects rather than serving. `once`, not
// `follow`: what is being asserted is the redirect itself.
const cleartext = await once(target, '/', { cleartext: true });
check(
  cleartext.status >= 300 && cleartext.status < 400,
  `GET http:// returned ${cleartext.status}; the :80 listener must redirect, not serve`,
);
check(
  String(cleartext.headers.location ?? '').startsWith(`https://${target.domain}`),
  `the :80 redirect points at ${cleartext.headers.location}, not at https://${target.domain}`,
);

function trail(response) {
  return response.trail.map((hop) => `${hop.status} ${hop.path}`).join(' → ');
}

report('assert-page-serves');
