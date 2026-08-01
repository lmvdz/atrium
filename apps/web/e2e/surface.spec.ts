import { expect, test } from '@playwright/test';
import { baseURL } from './support/config.mjs';
import {
  createWorkspace,
  invite,
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
 * and POST `role: "owner"` straight at `/api/auth/organization/invite`. The
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

    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'SurfaceOwner' });
    const slug = await createWorkspace(owner, 'Surface');

    // A real, fully-fledged workspace admin — the strongest caller short of the
    // owner, and exactly the one the reviewers escalated from.
    const invitationUrl = await invite(owner, { slug, email: adminEmail, role: 'admin' });

    const adminContext = await browser.newContext();
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
    expect(escalation.status()).toBeGreaterThanOrEqual(400);
    expect(escalation.status()).toBeLessThan(500);

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
    ]) {
      const post = await page.request.post(path, { headers: asOwnPage, data: {} });
      expect(post.status(), `POST ${path}`).toBe(404);
      const get = await page.request.get(path, { headers: asOwnPage });
      expect(get.status(), `GET ${path}`).toBe(404);
    }
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
