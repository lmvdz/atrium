import { expect, test } from '@playwright/test';
import { serverPort } from './support/config.mjs';
import {
  createWorkspace,
  invite,
  liveSocketStatus,
  newCallerContext,
  openLiveSocket,
  requireBrowser,
  sendCommand,
  sendOnLiveSocket,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

/**
 * The production WebSocket trust boundary, from real browser cookies through
 * the current ordered-room protocol. Positive multiplayer behavior belongs in
 * auth.spec.ts; these cases retain the denials and mid-connection revocation.
 */

async function joinedRoomId(page: import('@playwright/test').Page): Promise<string> {
  const live = page.locator('main[data-room-id]');
  await expect(live.locator('[data-frame="live"]')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Message #general' })).toBeEnabled();
  const roomId = await live.getAttribute('data-room-id');
  expect(roomId, 'the authenticated live route must name its authorized room').toBeTruthy();
  return roomId ?? '';
}

test.describe('websocket authorization', () => {
  requireBrowser();

  test('refuses the upgrade for a visitor with no session', async ({ browser }) => {
    const anonymous = await newCallerContext(browser);
    const page = await anonymous.newPage();
    await page.goto('/');
    const result = await sendCommand(page, {
      type: 'subscribe',
      roomId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result).toEqual({ opened: false, reply: null });
    await anonymous.close();
  });

  test('refuses a room the signed-in caller is not a member of', async ({ page }) => {
    await signUpAndVerify(page, { email: uniqueEmail('outsider'), name: 'Outsider' });
    await createWorkspace(page, 'Outsider Space');
    const result = await sendCommand(page, {
      type: 'subscribe',
      roomId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result.opened).toBe(true);
    expect(result.reply).toMatchObject({ type: 'error' });
  });

  test('a removed member’s open socket loses its authority on the next command', async ({
    browser,
  }) => {
    const ownerEmail = uniqueEmail('revoke-owner');
    const memberEmail = uniqueEmail('revoke-member');
    const ownerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'RevokeOwner' });
    const slug = await createWorkspace(owner, 'Revocation');
    const invitationUrl = await invite(owner, { slug, email: memberEmail, role: 'member' });

    const memberContext = await newCallerContext(browser);
    const member = await memberContext.newPage();
    await signUpAndVerify(member, { email: memberEmail, name: 'RevokeMember' });
    await member.goto(invitationUrl);
    await member.getByTestId('accept-invitation').click();
    await member.waitForURL('**/app');
    await member.goto(`/app/${slug}/general`);
    const roomId = await joinedRoomId(member);

    expect(await openLiveSocket(member)).toBe(true);
    expect(
      (
        await sendOnLiveSocket(member, {
          type: 'subscribe',
          roomId,
        })
      ).reply,
    ).toMatchObject({ type: 'subscribed', roomId });

    await owner.goto(`/app/${slug}`);
    await owner.getByTestId(`member-remove-${memberEmail}`).click();
    await expect(owner.getByTestId('member-removed')).toBeVisible();

    // CATCHES: trusting subscribe-time membership for later commands. The
    // revalidation timer may have sent `unsubscribed` first; the socket itself
    // deliberately remains useful for any other rooms.
    const commandId = `revoked-${Date.now()}`;
    let result = await sendOnLiveSocket(member, {
      type: 'command',
      commandId,
      command: { name: 'set_presence', roomId, state: 'online' },
    });
    if (result.reply?.type === 'unsubscribed') {
      result = await sendOnLiveSocket(member, {
        type: 'command',
        commandId,
        command: { name: 'set_presence', roomId, state: 'online' },
      });
    }
    expect(result.closed).toBe(false);
    expect(result.reply).toMatchObject({ type: 'nack', commandId, code: 'not_a_member' });

    await member.goto('/app');
    await expect(member.getByTestId('no-workspaces')).toBeVisible();
    await ownerContext.close();
    await memberContext.close();
  });

  test('a removed passive listener is unsubscribed and receives no later room event', async ({
    browser,
  }) => {
    const ownerEmail = uniqueEmail('evict-owner');
    const memberEmail = uniqueEmail('evict-member');
    const ownerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'EvictOwner' });
    const slug = await createWorkspace(owner, 'Eviction');
    const invitationUrl = await invite(owner, { slug, email: memberEmail, role: 'member' });

    const memberContext = await newCallerContext(browser);
    const member = await memberContext.newPage();
    await signUpAndVerify(member, { email: memberEmail, name: 'EvictMember' });
    await member.goto(invitationUrl);
    await member.getByTestId('accept-invitation').click();
    await member.waitForURL('**/app');
    await member.goto(`/app/${slug}/general`);
    const roomId = await joinedRoomId(member);
    expect(await openLiveSocket(member)).toBe(true);
    expect((await sendOnLiveSocket(member, { type: 'subscribe', roomId })).reply).toMatchObject({
      type: 'subscribed',
      roomId,
    });

    await owner.goto(`/app/${slug}/general`);
    await joinedRoomId(owner);
    await owner.goto(`/app/${slug}`);
    await owner.getByTestId(`member-remove-${memberEmail}`).click();
    await expect(owner.getByTestId('member-removed')).toBeVisible();

    await expect
      .poll(
        async () =>
          (await liveSocketStatus(member)).frames.some(
            (frame) => frame.type === 'unsubscribed' && frame.roomId === roomId,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    const afterRevocation = await liveSocketStatus(member);
    expect(afterRevocation.open).toBe(true);
    const eventCount = afterRevocation.frames.filter((frame) => frame.type === 'event').length;

    await owner.goto(`/app/${slug}/general`);
    const words = `Only the remaining member receives this ${Date.now()}`;
    await owner.getByRole('combobox', { name: 'Message #general' }).fill(words);
    await owner.getByRole('button', { name: 'Send' }).click();
    await expect(owner.getByRole('region', { name: 'Conversation' })).toContainText(words);
    await member.waitForTimeout(500);
    expect(
      (await liveSocketStatus(member)).frames.filter((frame) => frame.type === 'event'),
    ).toHaveLength(eventCount);

    await ownerContext.close();
    await memberContext.close();
  });

  test('serves health without a session, and does not invent a rooms endpoint', async ({
    request,
  }) => {
    const health = await request.get(`http://127.0.0.1:${serverPort}/health`);
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect((await request.get(`http://127.0.0.1:${serverPort}/rooms`)).status()).toBe(404);
  });
});
