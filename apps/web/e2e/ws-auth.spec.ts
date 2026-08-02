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
  requireBrowser();

  test('refuses the upgrade for a visitor with no session', async ({ browser }) => {
    const anonymous = await newCallerContext(browser);
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

    const ownerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'WsOwner' });
    const slug = await createWorkspace(owner, 'Ws Roles');
    const invitationUrl = await invite(owner, {
      slug,
      email: memberEmail,
      role: 'member',
    });

    const memberContext = await newCallerContext(browser);
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

  /**
   * Revocation, all the way through, on a socket that was already open.
   *
   * Round 1 had no removal path and no reconciliation behind one: workspace
   * membership was Better Auth's table, room membership was ours, and nothing
   * connected them in the *removing* direction. A removed person kept every room
   * and every live connection. This test removes somebody mid-connection and
   * asserts the very next command over that same socket is refused.
   */
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

    // The socket is open and the member genuinely has authority over the room.
    expect(await openLiveSocket(member)).toBe(true);
    const before = await sendOnLiveSocket(member, { command: 'room.join', roomId });
    expect(before.reply).toMatchObject({ type: 'joined' });

    // The owner removes them, in the app, while that socket is still open.
    await owner.goto(`/app/${slug}`);
    await owner.getByTestId(`member-remove-${memberEmail}`).click();
    await expect(owner.getByTestId('member-removed')).toBeVisible();
    await expect(owner.getByTestId('member-list')).not.toContainText(memberEmail);

    /**
     * Same socket, next command — and **the assertion has to name which of two
     * mechanisms answered**, because the two are racing.
     *
     * Round 11 found this by running the suite on a slower machine: the sweep
     * (`WS_SWEEP_INTERVAL_MS: 1000` in `e2e/support/config.mjs`) evicts a
     * removed member's socket on its own, and if the UI round-trip above takes
     * longer than one interval the socket is already closed when this line
     * runs. `sendOnLiveSocket` then answers `{ closed: true, reply: null }` and
     * the old single assertion failed with "received value must be a non-null
     * object" — reproducibly, on `fix/auth-r10` as well, so it is an
     * environment-sensitive test defect rather than a regression.
     *
     * Writing it as "either is fine" would be the wrong repair: that is a test
     * that cannot say what it measured. So both outcomes are asserted, each
     * with its own verdict, and neither admits the failure the test exists to
     * catch — a socket that stayed open and answered `joined`, or one that
     * closed for some unrelated reason. The sweep half has its own test below;
     * this one is about authority being re-read per command *when there is a
     * command to read it for*.
     */
    const after = await sendOnLiveSocket(member, { command: 'room.join', roomId });
    if (after.closed) {
      // The sweep won the race: the socket must be closed *as a revocation*
      // (1008), which is the same close code the eviction test pins.
      expect((await liveSocketStatus(member)).closeCode).toBe(1008);
    } else {
      expect(after.reply).toMatchObject({ type: 'command_error', reason: 'not_a_member' });
    }

    // And the workspace itself is gone from their account.
    await member.goto('/app');
    await expect(member.getByTestId('no-workspaces')).toBeVisible();

    await ownerContext.close();
    await memberContext.close();
  });

  /**
   * The other half of revocation: what a removed member still *receives*.
   *
   * Round 2 asserted that a removed member's next command was refused, and
   * round 2's gauntlet named what that misses — a socket that only listens
   * sends no commands, so nothing ever refuses it. It stayed on the room's
   * in-memory roster and went on receiving presence and every broadcast the
   * room made, by a person who had been thrown out of it. "Cannot send" is not
   * revocation; "cannot see" is.
   *
   * So this test never sends a command after the removal. It watches.
   */
  test('a removed member stops receiving the room’s broadcasts', async ({ browser }) => {
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

    // The member joins the room and then goes quiet — a listener, which is the
    // whole point.
    expect(await openLiveSocket(member)).toBe(true);
    expect((await sendOnLiveSocket(member, { command: 'room.join', roomId })).reply).toMatchObject({
      type: 'joined',
    });

    // Somebody else in the room, so the room has something to broadcast.
    await owner.goto(`/app/${slug}/general`);
    await joinedRoomId(owner);
    expect(await openLiveSocket(owner)).toBe(true);
    expect((await sendOnLiveSocket(owner, { command: 'room.join', roomId })).reply).toMatchObject({
      type: 'joined',
    });

    // The member is being told about the room right now: the owner's join
    // reached them.
    await expect
      .poll(async () => (await liveSocketStatus(member)).broadcasts, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The removal, in the app, over that same still-open socket.
    await owner.goto(`/app/${slug}`);
    await owner.getByTestId(`member-remove-${memberEmail}`).click();
    await expect(owner.getByTestId('member-removed')).toBeVisible();

    // Evicted from the roster and closed with 1008 — without the member's page
    // having sent a single frame since the removal.
    await expect
      .poll(async () => (await liveSocketStatus(member)).closeCode, { timeout: 20_000 })
      .toBe(1008);

    const afterEviction = await liveSocketStatus(member);
    expect(afterEviction.open).toBe(false);

    // The room keeps talking. None of it reaches them any more, and the
    // assertion is about what they receive rather than what they may send.
    await owner.goto(`/app/${slug}/general`);
    await joinedRoomId(owner);
    expect(await openLiveSocket(owner)).toBe(true);
    await sendOnLiveSocket(owner, { command: 'room.join', roomId });
    await sendOnLiveSocket(owner, { command: 'room.leave', roomId });

    expect((await liveSocketStatus(member)).broadcasts).toBe(afterEviction.broadcasts);

    await ownerContext.close();
    await memberContext.close();
  });

  /**
   * Demotion is a revocation too. An admin who becomes a plain member has to
   * stop being able to do admin things in the workspace's rooms — which only
   * happens if the role change is carried down into room membership.
   */
  test('a demoted member’s open socket loses the admin commands', async ({ browser }) => {
    const ownerEmail = uniqueEmail('demote-owner');
    const adminEmail = uniqueEmail('demote-admin');

    const ownerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    await signUpAndVerify(owner, { email: ownerEmail, name: 'DemoteOwner' });
    const slug = await createWorkspace(owner, 'Demotion');
    const invitationUrl = await invite(owner, { slug, email: adminEmail, role: 'admin' });

    const adminContext = await newCallerContext(browser);
    const admin = await adminContext.newPage();
    await signUpAndVerify(admin, { email: adminEmail, name: 'DemoteAdmin' });
    await admin.goto(invitationUrl);
    await admin.getByTestId('accept-invitation').click();
    await admin.waitForURL('**/app');

    await admin.goto(`/app/${slug}/general`);
    const roomId = await joinedRoomId(admin);
    expect(await openLiveSocket(admin)).toBe(true);

    // `room.archive` is an admin command; unimplemented, so an authorized caller
    // gets the same opaque denial as an unknown one. What matters is the
    // *difference* between the two runs below.
    const asAdmin = await sendOnLiveSocket(admin, { command: 'room.archive', roomId });
    expect(asAdmin.reply).toMatchObject({ reason: 'unknown_command' });

    await owner.goto(`/app/${slug}`);
    await owner.getByTestId(`member-role-${adminEmail}`).click();
    await expect(owner.getByTestId('member-role-changed')).toBeVisible();

    const asMember = await sendOnLiveSocket(admin, { command: 'room.archive', roomId });
    expect(asMember.reply).toMatchObject({ reason: 'insufficient_role' });

    await ownerContext.close();
    await adminContext.close();
  });

  test('serves health without a session, and nothing else', async ({ request }) => {
    const health = await request.get(`http://127.0.0.1:${serverPort}/health`);
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const elsewhere = await request.get(`http://127.0.0.1:${serverPort}/rooms`);
    expect(elsewhere.status()).toBe(404);
  });
});
