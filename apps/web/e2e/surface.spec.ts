import { expect, test } from '@playwright/test';
import { baseURL } from './support/config.mjs';
import {
  createWorkspace,
  invite,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

/**
 * The attacker here is a *legitimate* admin escalating their own authority, not
 * a stranger, so they control every header their own client sends. Spelling the
 * `Origin` out is what keeps these probes honest: without it Better Auth's own
 * origin check refuses the request and the test would pass for a reason that
 * has nothing to do with the thing under test.
 */
const asOwnPage = { origin: baseURL };

/**
 * The HTTP surface, attacked rather than described.
 *
 * Round 1 of this ticket's review — codex and grok independently — landed on the
 * same hole: the app's policy lived in Server Actions, but the catch-all route
 * also published Better Auth's whole API, so a workspace admin could skip the UI
 * and POST `role: "owner"` straight at `/api/auth/organization/invite-member`
 * (round 1's receipt named `/organization/invite`, which does not exist; the
 * corrected path is the one probed below). The
 * checks below are that attack, run from a real signed-in browser context, plus
 * the surrounding claim that the endpoints Atrium does not use are not there at
 * all.
 *
 * Two independent locks are being tested here and only one of them lives in this
 * file's blast radius:
 *
 *  - the mounted-path allowlist (`packages/auth/src/mounted.ts`), which is what
 *    makes these requests 404, and
 *  - the library-layer escalation guard (`packages/auth/src/org.ts`), which
 *    refuses the same invitation even for a caller who *does* reach the API —
 *    a Server Action, a future admin CLI, a route mounted later. That one is
 *    exercised directly in `packages/auth/test/org.test.ts`, because reaching it
 *    over HTTP is precisely what this file proves you cannot do.
 */

test.describe('the mounted auth surface', () => {
  requireBrowser();

  test('refuses a raw invitation that asks for a role above the caller’s', async ({ browser }) => {
    const ownerEmail = uniqueEmail('surface-owner');
    const adminEmail = uniqueEmail('surface-admin');

    const ownerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'SurfaceOwner' });
    const slug = await createWorkspace(owner, 'Surface');

    // A real, fully-fledged workspace admin — the strongest caller short of the
    // owner, and exactly the one the reviewers escalated from.
    const invitationUrl = await invite(owner, { slug, email: adminEmail, role: 'admin' });

    const adminContext = await newCallerContext(browser);
    const admin = await adminContext.newPage();
    await signUpAndVerify(admin, { email: adminEmail, name: 'SurfaceAdmin' });
    await admin.goto(invitationUrl);
    await admin.getByTestId('accept-invitation').click();
    await admin.waitForURL('**/app');
    await admin.goto(`/app/${slug}`);
    await expect(admin.getByTestId('workspace-role')).toHaveText('admin');

    // The workspace id, read from the page the admin is legitimately looking at.
    const workspaceId = await admin.getByTestId('workspace').getAttribute('data-workspace-id');
    expect(workspaceId).toBeTruthy();

    // The attack: the admin's own cookies, straight at the library's endpoint.
    const escalation = await admin.request.post('/api/auth/organization/invite-member', {
      headers: asOwnPage,
      data: {
        email: uniqueEmail('promoted'),
        role: 'owner',
        organizationId: workspaceId,
      },
    });
    // Exactly 404, not "some 4xx". A 403 would mean the endpoint is mounted and
    // something inside it said no, which is a different — and weaker — claim
    // than the one this file is making: that the endpoint is not published at
    // all. Round 2 asserted the range and would have passed either way.
    expect(escalation.status()).toBe(404);

    // And not because the *role* was odd — the endpoint is not there at all.
    // An admin inviting a plain member is something they are entirely allowed
    // to do in the app, and it still 404s here, which is what makes this an
    // allowlist rather than a patch over one known escalation.
    const ordinary = await admin.request.post('/api/auth/organization/invite-member', {
      headers: asOwnPage,
      data: { email: uniqueEmail('ordinary'), role: 'member', organizationId: workspaceId },
    });
    expect(ordinary.status()).toBe(404);

    // Nobody was invited by either call.
    await admin.reload();
    await expect(admin.getByTestId('no-pending-invitations')).toBeVisible();

    await ownerContext.close();
    await adminContext.close();
  });

  test('publishes only the paths a browser genuinely arrives at', async ({ page }) => {
    await signUpAndVerify(page, { email: uniqueEmail('surface'), name: 'Surface' });

    // Not mounted: everything Atrium drives in-process, where `authorize()` and
    // the sign-in throttle live. A raw caller here would have skipped both.
    for (const path of [
      '/api/auth/organization/invite-member',
      '/api/auth/organization/create',
      '/api/auth/organization/update-member-role',
      '/api/auth/organization/remove-member',
      '/api/auth/organization/accept-invitation',
      '/api/auth/organization/list-members',
      '/api/auth/sign-in/email',
      '/api/auth/sign-up/email',
      '/api/auth/send-verification-email',
      '/api/auth/change-password',
      '/api/auth/list-sessions',
      '/api/auth/get-session',
      // Better Auth fires no member hooks for this one, so a self-removal
      // through it would leave room membership behind (see the note at the top
      // of `org.ts`). It is unreachable because it is not on the allowlist, and
      // this assertion is what stops a future widening exposing it silently.
      '/api/auth/organization/leave',
    ]) {
      const post = await page.request.post(path, { headers: asOwnPage, data: {} });
      expect(post.status(), `POST ${path}`).toBe(404);
      const get = await page.request.get(path, { headers: asOwnPage });
      expect(get.status(), `GET ${path}`).toBe(404);
    }
  });

  /**
   * The same refusals, spelled the ways an attacker spells them.
   *
   * Round 2's guard normalised paths — decoded segments, collapsed `//`,
   * resolved `..` — while Better Auth's router matches the raw pathname. Both
   * critics found the divergence; nothing was exposed, but only because the
   * *library* happened to be stricter than the guard. `mounted.test.ts` asserts
   * every fixture below is refused **at the guard itself**, which is the claim
   * that matters. This one asserts what the whole stack does with them over real
   * HTTP, and it is deliberately split by *who* refuses, because "some 4xx"
   * would hide which layer did the work — and one of these layers is Next, whose
   * behaviour is not ours to promise.
   */
  test('cannot be walked around by spelling the path differently', async ({ page }) => {
    await signUpAndVerify(page, { email: uniqueEmail('smuggle'), name: 'Smuggle' });

    // Refused by our guard: the request reaches the route handler with the path
    // exactly as written, and `isMountedAuthPath` says no.
    for (const path of [
      // %2f — an encoded slash, which some routers resolve and others do not.
      '/api/auth/verify-email%2f..%2forganization%2finvite-member',
      '/api/auth/organization%2finvite-member',
      // %2e%2e — an encoded `..`.
      '/api/auth/%2e%2e/api/auth/organization/invite-member',
      '/api/auth/verify-email/%2e%2e/organization/invite-member',
      // Doubled, so one decode pass would produce a fresh path.
      '/api/auth/%252e%252e/organization/invite-member',
      // Literal dot segments, which rou3 treats as ordinary segments.
      '/api/auth/./organization/invite-member',
      '/api/auth/callback/../organization/invite-member',
      // Case: rou3 matches segments byte-for-byte.
      '/api/auth/Verify-Email',
      '/api/auth/ORGANIZATION/invite-member',
    ]) {
      const response = await page.request.get(path, { headers: asOwnPage, maxRedirects: 0 });
      expect(response.status(), `GET ${path}`).toBe(404);
    }

    // Refused by Next, before any route module runs: it rejects a request line
    // carrying a `..` segment outright. Asserted as 400 rather than folded into
    // the 404s above, because pretending our guard did this would be a claim
    // about somebody else's code.
    const dotdot = await page.request.get('/api/auth/organization/../verify-email', {
      headers: asOwnPage,
      maxRedirects: 0,
    });
    expect(dotdot.status()).toBe(400);

    /**
     * Canonicalised by Next with a 308 *before* routing: doubled slashes and
     * trailing slashes never reach the guard at all, so the guard never has to
     * have an opinion about them (it refuses them anyway — see
     * `mounted.test.ts` — which is what keeps the two in step if Next ever
     * stops doing this).
     *
     * `maxRedirects: 0` is what makes that visible. Following the redirect
     * lands on the canonical path, which is a *different* request and is
     * covered by the allowed-paths test below.
     */
    for (const path of [
      '/api/auth//verify-email',
      '/api/auth/verify-email/',
      '/api/auth/callback/github/',
    ]) {
      const response = await page.request.get(path, { headers: asOwnPage, maxRedirects: 0 });
      expect(response.status(), `GET ${path}`).toBe(308);
    }
  });

  test('publishes the verification link on GET only', async ({ page }) => {
    // Better Auth registers `/verify-email` for GET alone, so a POST is a 404
    // at the router — and therefore has to be a 404 at the guard.
    const posted = await page.request.post('/api/auth/verify-email?token=x', {
      headers: asOwnPage,
      data: {},
    });
    expect(posted.status()).toBe(404);

    // And the GET is genuinely mounted: 400 is Better Auth answering about a
    // token it does not like, which only happens if the request got there.
    const got = await page.request.get('/api/auth/verify-email', {
      headers: asOwnPage,
      maxRedirects: 0,
    });
    expect(got.status()).not.toBe(404);
  });

  test('still serves the verification link, which is the point of mounting anything', async ({
    page,
  }) => {
    // A junk token: the endpoint must answer *something other than 404*, or the
    // allowlist has locked out the one flow that needs it. Signup already proved
    // the happy path in auth.spec.ts.
    const response = await page.request.get('/api/auth/verify-email?token=not-a-real-token', {
      maxRedirects: 0,
    });
    expect(response.status()).not.toBe(404);
  });
});
