/**
 * The stack serves a real page — one this run's app rendered from this run's
 * database — over TLS, through the shipped proxy.
 *
 * ## The assertion this replaces, and the one before that
 *
 * There wasn't one at all until #40: three rounds of gauntlet receipts described
 * the compose deployment as working while `app` answered 500 to every request,
 * because everything ever checked about it was a *part* — the images built, the
 * containers reported healthy, `caddy validate` accepted the Caddyfile,
 * `docker compose config` refused an unset domain. None of those is the product
 * responding.
 *
 * Round 2 fixed that and left a narrower version of the same hole, which the
 * round-2 gauntlet named: "`/` can be a static proxy fixture rather than the
 * app. `assert-page-serves` matches fixed HTML markers and a fixed sign-in link,
 * so a first `handle /` returning a stale copy passes while `/sign-up` stays
 * proxied and health, signup, ws and rate-limit all go green."
 *
 * That is true and it is the exact shape of the defect this file exists for, one
 * level in: every marker it looked for — `data-region="conversation"`,
 * `data-testid="sign-in-link"`, `$ACTION_ID_` — is a *constant*. A constant can
 * be copied. Four lines in `deploy/Caddyfile` (`handle / { respond "<the page>" }`)
 * put a fixture in front of the one route the whole ticket is about, and
 * everything downstream keeps working because everything downstream uses other
 * routes. The app's own health check would not see it either: it fetches
 * `http://127.0.0.1:3000/` inside the container, which never crosses the proxy.
 *
 * ## So the page has to say something only this run can know
 *
 * A per-run account is created through the real sign-up form and verified
 * through the real mail, and then `/` is fetched **as that account**. The root
 * layout renders `AccountBar`, `AccountBar` reads the session out of Postgres,
 * and the page comes back carrying that account's display name — a string
 * generated microseconds earlier in this process and written to this stack's
 * database by this stack's app. Then, to close the loop from the other end, the
 * name is read back **straight out of the `postgres` container** with the
 * container's own credentials, and the page's value must equal the database's.
 *
 * Three properties make that a proof rather than a longer version of the same
 * check:
 *
 *  1. **It is per-run.** No fixture, no cache and no copy of yesterday's HTML
 *     contains it, because it did not exist yesterday.
 *  2. **It round-trips through the database.** The value on the page is compared
 *     against the value in Postgres, obtained without going through the app. A
 *     page that renders a name of its own invention fails.
 *  3. **The same URL answers differently to a different request.** `/` is
 *     fetched twice, once signed out and once signed in, and the signed-out
 *     response must *not* carry the name. One static body cannot satisfy both.
 *
 * `/app` is asserted the same way: it is behind `requireSession`, it renders the
 * account's address and its (empty) workspace list, and it is a second route
 * whose content is a function of this run's database rather than of the build.
 *
 * ## Why this step runs after the signup assertion
 *
 * It uses the same real flow, so a broken mail path would fail here too — and
 * then two steps would be red for one reason and the ledger would credit
 * whichever came first. `assert-signup-verifies.mjs` owns the mail path and runs
 * before this, so `dead-relay` still lands there and this file's own failures
 * are about pages. The workflow policy pins that order as a prerequisite.
 *
 * ## The mutations it catches
 *
 * - `handle /` in `deploy/Caddyfile` answering with a copy of the page (ledger
 *   case `static-page-fixture`). Signup verifies, mail arrives, every container
 *   is healthy, and `/` is not the app. This is the case round 2 could not see.
 * - `handle /` pointed at a port nothing listens on (ledger case
 *   `proxy-misroute`): `/` is 502 while every other route is fine, so it is the
 *   page assertion or nothing.
 * - `ATRIUM_MAIL_TRANSPORT=console`, or the `env:` block put back in
 *   `apps/web/next.config.ts`: the app refuses to boot, and this never runs —
 *   the boot catches both, which is where the ledger credits them.
 * - HSTS deleted from the Caddyfile, or the `:80` redirect removed — both are
 *   the "a comment is not a control" class this repo has been round with once.
 *
 * What it still cannot catch is a *source* change that renames the markers to
 * match a broken render. That would be a deliberate edit to `apps/web` in the
 * same commit; the per-run assertions above do not depend on any constant, so
 * the blast radius of such an edit is now the structural checks only.
 */

import { queryDatabase, sqlLiteral } from './compose.mjs';
import {
  check,
  establishSession,
  follow,
  mailpit,
  once,
  report,
  stackTarget,
} from './stack-client.mjs';

const target = stackTarget();

/** Regions come from `data-region` attributes the three-region shell renders. */
function regionsIn(html) {
  return new Set([...html.matchAll(/data-region="([a-z-]+)"/g)].map((match) => match[1]));
}

/** The text of the element carrying `data-testid="…"`, or undefined. */
function testId(html, id) {
  const found = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html);
  return found?.[1];
}

function trail(response) {
  return response.trail.map((hop) => `${hop.status} ${hop.path}`).join(' → ');
}

// ── 1. The page is there at all, and it is the app's shell ───────────────────

const anonymous = await follow(target, '/');
check(
  anonymous.status === 200,
  `GET / returned ${anonymous.status}, not 200 (trail: ${trail(anonymous)})`,
);
check(
  !/Application error|__NEXT_ERROR|Internal Server Error/i.test(anonymous.body),
  'GET / returned an error shell rather than the page',
);

const regions = regionsIn(anonymous.body);
for (const region of ['conversation', 'current-state', 'needs-you']) {
  check(
    regions.has(region),
    `GET / is missing the \`${region}\` region — this is not the app's page`,
  );
}
check(
  anonymous.body.includes('data-testid="sign-in-link"'),
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

// ── 2. `/` says something only this run's app, and this run's database, know ──

const session = await establishSession(target, mailpit(), 'page');
check(
  session.verified?.status === 200,
  `could not establish a session to render an authenticated page with: verification landed on ${session.verified?.path} with ${session.verified?.status} (trail: ${session.verified ? trail(session.verified) : 'no link followed'}). The mail path is asserted a step earlier, so this is a page-rendering failure rather than a mail one.`,
);

/**
 * What Postgres holds for the address that just signed up.
 *
 * Read out of the `postgres` container with the container's own credentials —
 * not through the app, and not from this process's environment. The point of the
 * comparison is that the two values came from different places.
 */
const stored = queryDatabase(
  `select display_name from users where lower(email) = lower(${sqlLiteral(session.email)})`,
);
check(
  stored === session.displayName,
  `the database holds ${JSON.stringify(stored)} as the display name for ${session.email}; this run created ${JSON.stringify(session.displayName)}. The signup did not land where the page is about to be read from.`,
);

const signedIn = await follow(target, '/', { jar: session.jar });
check(
  signedIn.status === 200,
  `GET / as a signed-in account returned ${signedIn.status}, not 200 (trail: ${trail(signedIn)})`,
);
const rendered = testId(signedIn.body, 'account-name');
check(
  rendered === stored,
  `GET / rendered ${JSON.stringify(rendered ?? null)} as the account name; this run's database holds ${JSON.stringify(stored)}. A page that cannot name the account looking at it is not being rendered by the app — a proxy answering \`/\` from a fixture passes every structural check above and fails exactly here.`,
);

// The other polarity, and the half a single stale body cannot survive: the same
// URL, without the cookie, must not carry the name.
check(
  !anonymous.body.includes(session.displayName),
  `GET / carried ${JSON.stringify(session.displayName)} while signed out. One body is being served to every caller, so \`/\` is not rendering per request.`,
);
check(
  anonymous.body.includes('data-testid="sign-in-link"') &&
    !signedIn.body.includes('data-testid="sign-in-link"'),
  '`/` renders the same account bar signed in and signed out, so the response does not depend on the request',
);

// ── 3. A second route, behind the session, reading the same database ─────────

const app = await follow(target, '/app', { jar: session.jar });
check(
  app.status === 200 && app.path.startsWith('/app'),
  `GET /app as a verified account landed on ${app.path} with ${app.status}, not /app with 200 (trail: ${trail(app)})`,
);
check(
  app.body.includes(session.email),
  `GET /app does not name ${session.email}, the account it was fetched as`,
);
check(
  app.body.includes('data-testid="no-workspaces"'),
  'GET /app rendered no workspace list at all — the page did not reach `listWorkspacesFor`, so it is not reading this stack’s database',
);

// ── 4. The transport the whole deployment is conditioned on ─────────────────

check(
  /max-age=\d+/.test(String(anonymous.headers['strict-transport-security'] ?? '')),
  `no Strict-Transport-Security on the response (got ${anonymous.headers['strict-transport-security']})`,
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

report('assert-page-serves');
