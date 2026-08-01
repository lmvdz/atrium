import { expect, test } from '@playwright/test';
import { serverPort } from './support/config.mjs';
import {
  browserAvailable,
  createWorkspace,
  invite,
  sendCommand,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

/**
 * The WebSocket trust boundary, from a real browser.
 *
 * Two questions, both of which have to be answered by the server and not by the
 * page: may this socket exist at all, and may this person run this command. The
 * probes below open the socket from inside the page so the browser attaches
 * whatever cookies it really has — no header is hand-crafted, because a
 * hand-crafted header proves nothing about the app.
 */

/** The room the page actually joined, read off the DOM rather than guessed. */
async function joinedRoomId(page: import('@playwright/test').Page): Promise<string> {
  await expect(page.getByTestId('presence')).toHaveAttribute('data-status', 'live');
  const roomId = await page.getByTestId('presence').getAttribute('data-room-id');
  expect(roomId, 'the room page must expose the room id it joined').toBeTruthy();
  return roomId ?? '';
}

test.describe('websocket authorization', () => {
  test.skip(
    !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  test('refuses the upgrade for a visitor with no session', async ({ browser }) => {
    const anonymous = await browser.newContext();
    const page = await anonymous.newPage();
    await page.goto('/');

    const result = await sendCommand(page, {
      command: 'room.join',
      roomId: '00000000-0000-4000-8000-000000000000',
    });

    // No session, no socket: the handshake never completes, so there is nothing
    // to send a command over.
    expect(result.opened).toBe(false);
    expect(result.reply).toBeNull();

    await anonymous.close();
  });

  test('refuses a room the signed-in caller is not a member of', async ({ page }) => {
    const email = uniqueEmail('outsider');
    await signUpAndVerify(page, { email, name: 'Outsider' });
    await createWorkspace(page, 'Outsider Space');

    const result = await sendCommand(page, {
      command: 'room.join',
      // A well-formed id for a room this person has nothing to do with.
      roomId: '00000000-0000-4000-8000-000000000000',
    });

    expect(result.opened).toBe(true);
    expect(result.reply).toMatchObject({ type: 'command_error', reason: 'not_a_member' });
  });

  test('refuses an admin-only command from a plain member', async ({ browser }) => {
    const ownerEmail = uniqueEmail('ws-owner');
    const memberEmail = uniqueEmail('ws-member');

    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'WsOwner' });
    const slug = await createWorkspace(owner, 'Ws Roles');
    const invitationUrl = await invite(owner, {
      slug,
      email: memberEmail,
      role: 'member',
    });

    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    await signUpAndVerify(member, { email: memberEmail, name: 'WsMember' });
    await member.goto(invitationUrl);
    await member.getByTestId('accept-invitation').click();
    await member.waitForURL('**/app');

    await member.goto(`/app/${slug}/general`);
    const roomId = await joinedRoomId(member);

    const denied = await sendCommand(member, { command: 'room.archive', roomId });
    expect(denied.opened).toBe(true);
    expect(denied.reply).toMatchObject({
      type: 'command_error',
      reason: 'insufficient_role',
    });

    // The same member may still do member things in that room.
    const allowed = await sendCommand(member, { command: 'room.join', roomId });
    expect(allowed.reply).toMatchObject({ type: 'joined' });

    await ownerContext.close();
    await memberContext.close();
  });

  test('refuses a workspace command sent over the room transport', async ({ page }) => {
    const email = uniqueEmail('scope');
    await signUpAndVerify(page, { email, name: 'Scope' });
    const slug = await createWorkspace(page, 'Scope Space');
    await page.goto(`/app/${slug}/general`);
    const roomId = await joinedRoomId(page);

    // This person really is the workspace owner. The command is still refused,
    // because owning a *room* is not owning the workspace.
    const result = await sendCommand(page, { command: 'workspace.delete', roomId });
    expect(result.reply).toMatchObject({ type: 'command_error', reason: 'wrong_scope' });
  });

  test('serves health without a session, and nothing else', async ({ request }) => {
    const health = await request.get(`http://127.0.0.1:${serverPort}/health`);
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const elsewhere = await request.get(`http://127.0.0.1:${serverPort}/rooms`);
    expect(elsewhere.status()).toBe(404);
  });
});
