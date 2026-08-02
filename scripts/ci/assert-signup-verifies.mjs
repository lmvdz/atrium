/**
 * Signing up sends a verification mail through the configured transport, and
 * the link in it signs the new account in.
 *
 * ## What is real here, and why each part had to be
 *
 * - **The transport is real.** `docker-compose.mailpit.yml` sets
 *   `ATRIUM_MAIL_TRANSPORT=smtp` and `SMTP_URL=smtp://mailpit:1025`, so
 *   `createSmtpMailer` opens a real SMTP session to a real server and the
 *   message below is read back out of that server's API. Nothing is stubbed,
 *   and nothing reads the process's stdout — which is what the pre-#40 outbox
 *   seam does. That seam is right for the e2e suite on a laptop and useless as
 *   evidence about a deployment, because it proves the console transport works.
 * - **The signup is the product's signup.** `packages/auth/src/mounted.ts`
 *   deliberately does not publish `POST /sign-up/email`, so there is no API to
 *   call: this fetches `/sign-up`, reads the Server Action id out of the
 *   rendered form, and posts the form back. Everything in the path is
 *   exercised — the throttle, `signUpAction`, Better Auth, the mailer.
 * - **The link is followed from the mail.** Not reconstructed, not read from a
 *   log: the URL is extracted from the message body mailpit received.
 * - **The session is proved by using it.** Verifying redirects to `/app`;
 *   `/app` is behind `requireSession`, and `requireSession` refuses a session
 *   whose address is unverified. So a 200 there carrying the account's own
 *   display name is the whole claim: the mail arrived, the link worked, and the
 *   account it belongs to is signed in.
 *
 * ## Mutations it catches
 *
 * - the SMTP transport removed or misconfigured (`ATRIUM_MAIL_TRANSPORT=console`
 *   in the compose files): the app refuses to boot, so `/sign-up` never
 *   answers. If the gate in `mailer.ts` were *weakened* instead — the thing #40
 *   was forbidden to do — the app would boot and this assertion would fail at
 *   the mailpit poll, because a console transport sends no SMTP.
 * - `sendOnSignUp: false`, or `sendVerificationEmail` no longer calling the
 *   mailer: no message arrives.
 * - `APP_URL` pointing anywhere other than the deployment's origin: the link in
 *   the mail is built from it, and this asserts the link's origin matches.
 * - `requireEmailVerification: false`, or `useSecureCookies` going false: the
 *   pre-verification `/app` fetch would succeed, or the session cookie would
 *   lose its `__Secure-` prefix. Both are asserted below.
 */

import {
  check,
  establishSession,
  mailpit,
  report,
  requireDeployment,
  stackTarget,
} from './stack-client.mjs';

const target = stackTarget();
await requireDeployment('assert-signup-verifies', target);
const session = await establishSession(target, mailpit(), 'signup');

check(session.form.status === 200, `GET /sign-up returned ${session.form.status}`);
check(
  Object.keys(session.fields).some((name) => name.startsWith('$ACTION_ID_')),
  'the sign-up form carries no Server Action id, so there is nothing to submit to',
);

const trail = (response) => response.trail.map((hop) => `${hop.status} ${hop.path}`).join(' → ');

check(
  session.submitted.path.startsWith('/check-email'),
  `signing up landed on ${session.submitted.path}, not /check-email (trail: ${trail(session.submitted)})`,
);
check(session.submitted.status === 200, `/check-email returned ${session.submitted.status}`);

// Unverified, no session and no app. Both are read from the state as it was
// *before* the link was followed — `cookiesBeforeVerifying` is a snapshot, not
// the live jar, because the live jar necessarily holds a session by the time
// this file runs. Asserting against the live jar is what the first draft did,
// and it went red against a stack that was behaving correctly.
check(
  !session.cookiesBeforeVerifying.some((name) => name.includes('session')),
  `signing up minted a session before the address was verified — \`requireEmailVerification\` is off (cookies held: ${session.cookiesBeforeVerifying.join(', ') || 'none'})`,
);
check(
  session.beforeVerifying.path.startsWith('/sign-in') ||
    session.beforeVerifying.path.startsWith('/check-email'),
  `an unverified account reached ${session.beforeVerifying.path}; it must be sent back to sign in or to check its mail`,
);

check(
  /confirm/i.test(String(session.message.Subject ?? '')),
  `the message subject is "${session.message.Subject}", which is not the verification mail`,
);
check(
  String(session.message.From?.Address ?? '').length > 0,
  'the message has no From address, so a real relay would have rejected it',
);
check(session.link !== undefined, 'the verification mail contains no link');

if (session.url) {
  check(
    session.url.origin === target.origin,
    `the link in the mail points at ${session.url.origin}, not at this deployment's ${target.origin} — APP_URL is wrong`,
  );
  check(session.url.protocol === 'https:', `the link is ${session.url.protocol}, not https:`);
}

if (session.verified) {
  check(
    session.verified.status === 200 && session.verified.path.startsWith('/app'),
    `following the verification link landed on ${session.verified.path} with ${session.verified.status}, not /app with 200 (trail: ${trail(session.verified)})`,
  );
  check(
    session.verified.body.includes(session.displayName),
    'the signed-in page does not name the account that just verified',
  );
}

check(
  session.jar.has((name) => name.includes('session')),
  `verifying set no session cookie (jar holds: ${session.jar.names.join(', ') || 'nothing'})`,
);
check(
  session.jar.has((name) => name.startsWith('__Secure-')),
  `the session cookie is not \`__Secure-\` prefixed (jar holds: ${session.jar.names.join(', ')}), so this deployment is not minting cookies for an https origin`,
);

report('assert-signup-verifies');
