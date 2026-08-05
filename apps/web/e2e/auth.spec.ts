import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { serverPort } from './support/config.mjs';
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

async function commandEvent(
  page: import('@playwright/test').Page,
  roomId: string,
  command: Record<string, unknown>,
  eventType: string,
): Promise<Record<string, unknown>> {
  return page.evaluate(
    ({ command, eventType, roomId, url }) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = new WebSocket(url);
        const commandId = `e2e-${Date.now()}-${Math.random()}`;
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`timed out waiting for ${eventType}`));
        }, 10_000);
        const done = (event: Record<string, unknown>) => {
          clearTimeout(timer);
          socket.close();
          resolve(event);
        };
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'subscribe', roomId }));
        });
        socket.addEventListener('message', (raw: MessageEvent<string>) => {
          const frame = JSON.parse(raw.data) as Record<string, unknown>;
          if (frame.type === 'subscribed') {
            socket.send(JSON.stringify({ type: 'command', commandId, command }));
            return;
          }
          if (frame.type === 'nack' && frame.commandId === commandId) {
            clearTimeout(timer);
            socket.close();
            reject(new Error(String(frame.message)));
            return;
          }
          if (frame.type !== 'event') return;
          const entry = frame.entry as { event?: Record<string, unknown> } | undefined;
          if (entry?.event?.type === eventType) done(entry.event);
        });
        socket.addEventListener('error', () => reject(new Error('command socket failed')));
      }),
    { command, eventType, roomId, url: `ws://localhost:${serverPort}/ws` },
  );
}

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
   * Mutation: send attachment bytes through Atrium, omit their metadata from
   * the room event, or render a download that does not recover the same bytes.
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

    const sourceRow = invitee.locator('[data-message-id]').filter({ hasText: words });
    await sourceRow.getByRole('button', { name: 'reply' }).focus();
    await sourceRow.getByRole('button', { name: 'reply' }).press('Enter');
    await expect(invitee.getByText('REPLYING TO')).toBeVisible();
    const replyWords = `A persisted reply to the exact source ${Date.now()}.`;
    await invitee.getByRole('textbox', { name: 'Message #general' }).fill(replyWords);
    await invitee.getByRole('button', { name: 'Send' }).click();
    const replyRow = founder.locator('[data-message-id]').filter({ hasText: replyWords });
    await expect(replyRow).toContainText(words);

    const roomId = await founder.locator('main[data-room-id]').getAttribute('data-room-id');
    const sourceMessageId = await founder
      .locator('[data-row-body]')
      .filter({ hasText: words })
      .getAttribute('data-row-body');
    if (!roomId || !sourceMessageId) throw new Error('the live room did not expose its records');
    const objectiveProposal = await commandEvent(
      founder,
      roomId,
      {
        name: 'record_proposal',
        roomId,
        proposal: {
          type: 'objective',
          payload: { title: 'Choose the release plan', status: 'open' },
          confidence: 1,
          provenance: [sourceMessageId],
          quote: words,
          interpretationId: null,
        },
      },
      'proposal_recorded',
    );
    const objectiveProposalId = (objectiveProposal.proposal as { id?: string } | undefined)?.id;
    if (!objectiveProposalId) throw new Error('the objective proposal did not carry its id');
    const acceptedObjective = await commandEvent(
      founder,
      roomId,
      {
        name: 'accept_proposal',
        roomId,
        proposalId: objectiveProposalId,
        objectiveId: null,
      },
      'object_accepted',
    );
    const objectiveId = (acceptedObjective.object as { id?: string } | undefined)?.id;
    if (!objectiveId) throw new Error('the accepted objective did not carry its id');
    const questionText = `Which release date is approved ${Date.now()}?`;
    const proposalEvent = await commandEvent(
      founder,
      roomId,
      {
        name: 'record_proposal',
        roomId,
        proposal: {
          type: 'open_question',
          payload: { question: questionText, status: 'open' },
          confidence: 1,
          provenance: [sourceMessageId],
          quote: words,
          interpretationId: null,
        },
      },
      'proposal_recorded',
    );
    const proposalId = (proposalEvent.proposal as { id?: string } | undefined)?.id;
    if (!proposalId) throw new Error('the proposal event did not carry its id');
    const acceptedQuestion = await commandEvent(
      founder,
      roomId,
      { name: 'accept_proposal', roomId, proposalId, objectiveId },
      'object_accepted',
    );
    const questionId = (acceptedQuestion.object as { id?: string } | undefined)?.id;
    if (!questionId) throw new Error('the accepted question did not carry its id');

    await Promise.all([founder.reload(), invitee.reload()]);
    for (const page of [founder, invitee]) {
      await page
        .locator('[data-region="current-state"] [data-object-id]')
        .filter({ hasText: questionText })
        .click();
      await page
        .getByRole('region', { name: 'Receipt' })
        .getByRole('button', { name: 'Answer', exact: true })
        .click();
    }
    const founderAnswer = `Ship on Friday ${Date.now()}.`;
    const inviteeAnswer = `Ship after the Friday review ${Date.now()}.`;
    const answerName = `Answer ${questionText} in your own words`;
    const founderBound = founder.getByRole('textbox', { name: answerName });
    const inviteeBound = invitee.getByRole('textbox', { name: answerName });
    await founderBound.fill(founderAnswer);
    await inviteeBound.fill(inviteeAnswer);
    await Promise.all([
      founder.getByRole('button', { name: 'Send' }).click(),
      invitee.getByRole('button', { name: 'Send' }).click(),
    ]);

    // CATCHES: clearing the losing participant's exact words merely because a
    // different participant's answer changed the shared question to answered.
    await expect
      .poll(async () => (await founderBound.count()) + (await inviteeBound.count()))
      .toBe(1);
    const founderLost = (await founderBound.count()) === 1;
    const loser = founderLost ? founder : invitee;
    const loserBound = founderLost ? founderBound : inviteeBound;
    const loserWords = founderLost ? founderAnswer : inviteeAnswer;
    const winner = founderLost ? invitee : founder;
    const winnerWords = founderLost ? inviteeAnswer : founderAnswer;
    await expect(loserBound).toHaveValue(loserWords);
    await expect(loserBound).toBeEnabled();
    await expect(loser.locator('[data-binding="bound"]')).toBeVisible();
    const winnerReceipt = winner.getByRole('region', { name: 'Receipt' });
    await expect(winnerReceipt).toContainText(winnerWords);
    await expect(winnerReceipt).toContainText('answered');
    const answerQuote = winnerReceipt.locator('[data-quoted]').filter({ hasText: winnerWords });
    await expect(answerQuote).toHaveCount(1);
    const quotedId = /^msg:([^@]+)/.exec((await answerQuote.getAttribute('data-quoted')) ?? '');
    const answerMessageId = quotedId?.[1];
    if (!answerMessageId)
      throw new Error('the accepted answer receipt has no canonical message id');
    await expect(winner.locator(`[data-message-id="${answerMessageId}"]`)).toContainText(
      winnerWords,
    );
    await expect(founder.getByRole('region', { name: 'Conversation' })).toContainText(winnerWords);
    await expect(invitee.getByRole('region', { name: 'Conversation' })).toContainText(winnerWords);

    // Leave the long-running attachment half of this scenario in free-compose
    // mode whichever participant lost the race.
    await loserBound.fill('');
    await loser.getByRole('button', { name: 'Cancel answering' }).click();

    const bytes = Buffer.from('persisted object bytes\n', 'utf8');
    let uploadTarget = '';
    let releaseUpload: (() => void) | undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await founder.route(/:59000\//, async (route) => {
      if (route.request().method() === 'PUT') await uploadGate;
      await route.continue();
    });
    const failedUploads: string[] = [];
    founder.on('request', (request) => {
      if (request.method() === 'PUT') uploadTarget = request.url();
      if (request.url().includes(':4100') || request.url().includes(':59000')) {
        failedUploads.push(`request ${request.method()} ${request.url()}`);
      }
    });
    founder.on('response', (response) => {
      if (response.url().includes(':4100') || response.url().includes(':59000')) {
        failedUploads.push(`response ${response.status()} ${response.url()}`);
      }
    });
    founder.on('requestfailed', (request) => {
      if (request.url().includes('attachment') || request.method() === 'PUT') {
        failedUploads.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`);
      }
    });
    await founder.getByLabel('Choose an attachment').setInputFiles({
      name: 'evidence.txt',
      mimeType: 'text/plain',
      buffer: bytes,
    });
    // CATCHES: Send remaining live during a PUT, which sent this draft without
    // the file and attached the eventual result to the following message.
    await expect(founder.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(founder.getByRole('textbox', { name: 'Message #general' })).toBeDisabled();
    releaseUpload?.();
    await expect(
      founder.locator('[data-attachment-note="true"]'),
      `attachment failures: ${failedUploads.join(' | ')}`,
    ).toContainText('evidence.txt attached');
    await founder.unroute(/:59000\//);
    expect(new URL(uploadTarget).port).toBe('59000');
    await founder.getByRole('textbox', { name: 'Message #general' }).fill('Attached evidence.');
    await founder.getByRole('button', { name: 'Send' }).click();

    const attachment = invitee.getByRole('button', { name: /evidence\.txt/ });
    await expect(attachment).toBeVisible();
    const downloadPromise = invitee.waitForEvent('download');
    await attachment.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('evidence.txt');
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error('the browser did not persist the downloaded attachment');
    expect(await readFile(downloadedPath)).toEqual(bytes);

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
    /**
     * Mutation: redirect to the right URL while rendering no room. The live
     * three-surface route names the room with its real heading, not the retired
     * scaffold's `room-name` test hook, so judge what the participant sees.
     */
    await expect(page.getByRole('heading', { name: 'general', exact: true })).toBeVisible();
  });
});
