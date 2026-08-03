import { expect, test } from '@playwright/test';
import {
  createWorkspace,
  invite,
  newCallerContext,
  password,
  requireBrowser,
  signIn,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';
import { countMail, waitForMail } from './support/mail';

/**
 * The acceptance test for issue #26, end to end and for real: a browser signs
 * up, opens the emailed link, makes a workspace, invites somebody, and a second
 * browser — its own context, its own cookies — accepts and ends up in the same
 * room, where both of them can see each other.
 *
 * Everything here goes through the real Next server, the real Postgres and the
 * real WebSocket server. Nothing is stubbed; the only test-shaped affordance is
 * the dev mailer writing its links to a file instead of an inbox.
 */

test.describe('auth and workspaces', () => {
  requireBrowser();

  /**
   * Mutation: keep the authenticated route on the retired presence-only frame,
   * or wire the three-surface frame to a socket that never reaches an
   * authorized `subscribed` state. The composer stays absent/disabled and a
   * message written in one authenticated context never reaches the other.
   * Mutation: derive presence from workspace membership rather than live
   * per-user frames. Both people appear "here" before their sockets report it.
   */
  test('signup, verification, workspace, invitation, shared live room and presence', async ({
    browser,
  }) => {
    const founderEmail = uniqueEmail('ada');
    const inviteeEmail = uniqueEmail('grace');

    const founderContext = await newCallerContext(browser);
    const founder = await founderContext.newPage();

    // ── signup → verify ──────────────────────────────────────────────────
    await signUpAndVerify(founder, { email: founderEmail, name: 'Ada' });

    // ── create workspace ─────────────────────────────────────────────────
    await expect(founder.getByTestId('no-workspaces')).toBeVisible();
    const slug = await createWorkspace(founder, 'Ada Team');

    // Creating a workspace creates the room its owner lands in.
    await expect(founder.getByTestId('room-list')).toContainText('#general');
    await expect(founder.getByTestId('workspace-role')).toHaveText('owner');

    // ── invite ───────────────────────────────────────────────────────────
    const invitationUrl = await invite(founder, {
      slug,
      email: inviteeEmail,
      role: 'member',
    });
    await expect(founder.getByTestId('invitation-list')).toContainText(inviteeEmail);

    // ── second browser context accepts ───────────────────────────────────
    const inviteeContext = await newCallerContext(browser);
    const invitee = await inviteeContext.newPage();
    await signUpAndVerify(invitee, { email: inviteeEmail, name: 'Grace' });

    await invitee.goto(invitationUrl);
    await expect(invitee.getByTestId('invitation-state')).toHaveAttribute('data-state', 'pending');
    await invitee.getByTestId('accept-invitation').click();
    await invitee.waitForURL('**/app');

    // ── both land in the same room ───────────────────────────────────────
    await expect(invitee.getByTestId('workspace-list')).toContainText('Ada Team');
    await invitee.goto(`/app/${slug}`);
    await expect(invitee.getByTestId('workspace-role')).toHaveText('member');
    await expect(invitee.getByTestId('member-list')).toContainText('Ada');
    await expect(invitee.getByTestId('member-list')).toContainText('Grace');
    await expect(invitee.getByTestId('room-list')).toContainText('#general');

    // A member is not an admin: the invite form is not theirs to see.
    await expect(invitee.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);

    // ── live three-surface room: each sees the other ─────────────────────
    await founder.goto(`/app/${slug}/general`);
    await invitee.goto(`/app/${slug}/general`);

    for (const page of [founder, invitee]) {
      await expect(page.locator('[data-frame="live"]')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message #general' })).toBeEnabled();
      const people = page.getByRole('navigation', { name: 'Rooms and people' });
      await expect(people).toContainText('Ada');
      await expect(people).toContainText('Grace');
      await expect(people.locator('[data-presence="here"]')).toHaveCount(2);
    }

    const words = `The authenticated live frame carries this message ${Date.now()}.`;
    await founder.getByRole('textbox', { name: 'Message #general' }).fill(words);
    await founder.getByRole('button', { name: 'Send' }).click();
    await expect(invitee.getByRole('region', { name: 'Conversation' })).toContainText(words);

    await founderContext.close();
    await inviteeContext.close();
  });

  test('an invitation link works exactly once', async ({ browser }) => {
    const founderEmail = uniqueEmail('owner');
    const inviteeEmail = uniqueEmail('invitee');

    const founderContext = await newCallerContext(browser);
    const founder = await founderContext.newPage();
    await signUpAndVerify(founder, { email: founderEmail, name: 'Owner' });
    const slug = await createWorkspace(founder, 'Single Use');
    const invitationUrl = await invite(founder, {
      slug,
      email: inviteeEmail,
      role: 'member',
    });

    const inviteeContext = await newCallerContext(browser);
    const invitee = await inviteeContext.newPage();
    await signUpAndVerify(invitee, { email: inviteeEmail, name: 'Invitee' });

    await invitee.goto(invitationUrl);
    await invitee.getByTestId('accept-invitation').click();
    await invitee.waitForURL('**/app');
    await expect(invitee.getByTestId('workspace-list')).toContainText('Single Use');

    // The same link, the same person, a second time.
    await invitee.goto(invitationUrl);
    await expect(invitee.getByTestId('invitation-state')).toHaveAttribute('data-state', 'used');
    await expect(invitee.getByTestId('invitation-state')).toContainText('already been accepted');

    // And the same link in a third browser, signed in as somebody else. They
    // learn nothing: not the workspace, not who it was sent to, not whether the
    // id was even real. An invitation id arrives by email and travels — a
    // forward, a shared screen, a bug report — so anybody holding one who is not
    // the recipient gets one sentence with no nouns in it.
    const strangerEmail = uniqueEmail('stranger');
    const strangerContext = await newCallerContext(browser);
    const stranger = await strangerContext.newPage();
    await signUpAndVerify(stranger, { email: strangerEmail, name: 'Stranger' });
    await stranger.goto(invitationUrl);
    const state = stranger.getByTestId('invitation-state');
    await expect(state).toHaveAttribute('data-state', 'unavailable');
    await expect(state).not.toContainText('Single Use');
    await expect(state).not.toContainText(inviteeEmail);
    await expect(stranger.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
    const forSomebodyElse = await state.textContent();

    // A made-up id is answered identically — same state, same words — so
    // guessing ids does not even tell you which ones exist.
    await stranger.goto('/invite/00000000-0000-4000-8000-000000000000');
    const madeUp = stranger.getByTestId('invitation-state');
    await expect(madeUp).toHaveAttribute('data-state', 'unavailable');
    expect(await madeUp.textContent()).toBe(forSomebodyElse);

    await stranger.goto('/app');
    await expect(stranger.getByTestId('no-workspaces')).toBeVisible();

    await founderContext.close();
    await inviteeContext.close();
    await strangerContext.close();
  });

  test('an unverified account cannot sign in', async ({ page }) => {
    const email = uniqueEmail('unverified');

    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Unverified');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('check-email-lede')).toContainText(email);
    await waitForMail(email, 'email-verification');

    const before = countMail(email, 'email-verification');

    // Signing in without opening the link is refused, and says why.
    await signIn(page, email);
    await page.waitForURL(/\/check-email/);
    await expect(page.getByTestId('check-email-lede')).toContainText(email);

    // Refusal is not a dead end: the attempt itself sends a fresh link, because
    // someone who lost the first email tries to sign in before hunting for a
    // resend button.
    await expect.poll(() => countMail(email, 'email-verification')).toBeGreaterThan(before);
  });

  test('a signed-out visitor is sent to sign in, and back where they were going', async ({
    page,
  }) => {
    await page.goto('/app');
    await page.waitForURL(/\/sign-in/);

    const email = uniqueEmail('returning');
    await signUpAndVerify(page, { email, name: 'Returning' });
    const slug = await createWorkspace(page, 'Deep Link');

    await page.getByTestId('sign-out').click();
    await page.waitForURL(/\/sign-in/);

    // A deep link while signed out must come back to the deep link.
    await page.goto(`/app/${slug}/general`);
    await page.waitForURL(/\/sign-in\?next=/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`**/app/${slug}/general`);
    await expect(page.getByTestId('room-name')).toHaveText('#general');
  });
});
