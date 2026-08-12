import { provisionAgentPrincipal } from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  messages,
  rooms,
  users,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { databaseUrl } from './support/config.mjs';
import { openRail, signUpAndVerify, uniqueEmail } from './support/flows';

/**
 * A room with a provisioned agent member renders the agent distinctly in every
 * surface that names a participant — and flipping the member's kind moves every
 * one of those surfaces.
 *
 * This is the acceptance test for the kinded `ParticipantSummary`. Ticket #96
 * proved the identity end to end server-side (`provisionAgentPrincipal` /
 * `mintAgentSession`, `integration/server/agent-principal.test.ts`); this proves
 * the render half — that `users.principal_kind` reaches the roster, the presence
 * marker, the room-head monogram and the participant count, and that the only
 * thing deciding an agent from a person is that column.
 *
 * The identity is created through the blessed helper (`provisionAgentPrincipal`),
 * so the agent member is exactly the row the product mints, not a hand-built
 * approximation. Membership is seeded directly — an identity and a room
 * membership are separate decisions (the helper refuses to conflate them), and
 * the read paths (`loadWorkspace`, `loadRoom`, `roomMemberIds`) all join
 * `workspace_members` and `memberships`, so a seeded pair is what the page reads.
 *
 * The mutation is the point (flip-the-input). An identity's `principal_kind` is
 * immutable — #96's trigger refuses `agent → human` because the kind is what
 * every `core_events` row the identity appended was checked against, so changing
 * it would re-attribute written history. The member's kind is therefore flipped
 * the only honest way: the agent leaves the room's second slot and a human
 * identity takes it. Same room, same viewer, the participant behind the slot
 * swapped from agent to human — and every surface that carried the agent register
 * must move. If a renderer kept a hardcoded person assumption, the first half
 * already fails; if a renderer ignored the kind and painted a constant, the flip
 * does not move and the second half fails.
 */

let handle: ReturnType<typeof createDatabase>;
let db: Database;

test.beforeAll(() => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
});

test.afterAll(async () => {
  await handle.close();
});

interface Seeded {
  workspaceSlug: string;
  roomSlug: string;
  workspaceId: string;
  roomId: string;
  viewerId: string;
  agentId: string;
}

/**
 * One workspace, one room, two members: the signed-in human viewing the page and
 * a provisioned agent. Returns the ids so the test can flip the agent's kind and
 * the teardown can delete exactly what it made.
 */
async function seed(viewerEmail: string): Promise<Seeded> {
  const tag = viewerEmail.split('@')[0] ?? 'agent-participant';
  const [viewer] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, viewerEmail))
    .limit(1);
  if (!viewer) throw new Error(`the signed-up viewer ${viewerEmail} was not found`);

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `agent-participant ${tag}`, slug: `agent-participant-${tag}` })
    .returning({ id: workspaces.id, slug: workspaces.slug });
  if (!workspace) throw new Error('workspace insert returned nothing');

  const [room] = await db
    .insert(rooms)
    .values({ workspaceId: workspace.id, slug: 'kinded', name: 'kinded', createdBy: viewer.id })
    .returning({ id: rooms.id, slug: rooms.slug });
  if (!room) throw new Error('room insert returned nothing');

  // The agent identity, minted the way the product mints it.
  const agent = await provisionAgentPrincipal({
    db,
    email: `agent-${tag}@agents.atrium.invalid`,
    displayName: 'atrium',
  });

  // Both members: the viewer so the room loads for its session, the agent so it
  // is in the room's derived roster. Same two rows for each; the only difference
  // between them anywhere downstream is `users.principal_kind`.
  await db.insert(workspaceMembers).values([
    { organizationId: workspace.id, userId: viewer.id, role: 'admin' },
    { organizationId: workspace.id, userId: agent.userId, role: 'member' },
  ]);
  await db.insert(memberships).values([
    { roomId: room.id, userId: viewer.id, role: 'admin' },
    { roomId: room.id, userId: agent.userId, role: 'member' },
  ]);

  return {
    workspaceSlug: workspace.slug,
    roomSlug: room.slug,
    workspaceId: workspace.id,
    roomId: room.id,
    viewerId: viewer.id,
    agentId: agent.userId,
  };
}

/**
 * The flip: retire the agent from the room's second slot and seat a human there.
 * Returns the new human's id so the teardown deletes it too. The display name is
 * kept ('atrium') so the only thing that changed between the two renders is the
 * kind of the identity filling the slot.
 */
async function swapAgentForHuman(at: Seeded): Promise<string> {
  await db
    .delete(memberships)
    .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.agentId)));
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.organizationId, at.workspaceId),
        eq(workspaceMembers.userId, at.agentId),
      ),
    );
  const [human] = await db
    .insert(users)
    .values({
      email: `human-${at.roomId}@atrium.test`,
      displayName: 'atrium',
      emailVerified: true,
    })
    .returning({ id: users.id });
  if (!human) throw new Error('swap human insert returned nothing');
  await db
    .insert(workspaceMembers)
    .values({ organizationId: at.workspaceId, userId: human.id, role: 'member' });
  await db.insert(memberships).values({ roomId: at.roomId, userId: human.id, role: 'member' });
  return human.id;
}

/**
 * One message from the agent and one from the viewer, in that order. The agent's
 * `author_id` is its own `users` row — the attribution #101 writes instead of the
 * old NULL — so the feed reads a real author and its kind. Returns the two message
 * ids so the test can flip the agent message's author and prove the register
 * follows the identity, not the row. The message cascades with the workspace.
 */
async function seedTwoMessages(at: Seeded): Promise<{ agentMsgId: string; humanMsgId: string }> {
  const [agentMsg] = await db
    .insert(messages)
    .values({
      roomId: at.roomId,
      authorId: at.agentId,
      body: 'I read the last twelve messages and nothing was settled.',
    })
    .returning({ id: messages.id });
  const [humanMsg] = await db
    .insert(messages)
    .values({
      roomId: at.roomId,
      authorId: at.viewerId,
      body: 'Agreed — let us pick this up on Monday.',
    })
    .returning({ id: messages.id });
  if (!agentMsg || !humanMsg) throw new Error('message seed returned nothing');
  return { agentMsgId: agentMsg.id, humanMsgId: humanMsg.id };
}

async function teardown(at: Seeded, swappedHumanId: string | null): Promise<void> {
  // The workspace cascade takes the room, every membership and every
  // workspace_members row; the identities are deleted by hand.
  await db.delete(workspaces).where(eq(workspaces.id, at.workspaceId));
  if (swappedHumanId) await db.delete(users).where(eq(users.id, swappedHumanId));
  await db.delete(users).where(eq(users.id, at.agentId));
  await db.delete(users).where(eq(users.id, at.viewerId));
}

test.describe('a provisioned agent member renders as an agent, and its kind is the only reason', () => {
  test('the roster, the presence marker, the monogram and the count all read the kind, and the flip moves every one', async ({
    page,
  }) => {
    const email = uniqueEmail('agent-participant');
    await signUpAndVerify(page, { email, name: 'Kinded viewer' });
    const at = await seed(email);
    let swappedHumanId: string | null = null;

    try {
      const rail = page.locator('nav[aria-label="Rooms and participants"]');
      const agentRow = rail.locator('.atr-scroll [data-participant-kind="agent"]');
      const humanRows = rail.locator('.atr-scroll [data-participant-kind="human"]');
      const roomHead = page.locator('header');

      // ---- the agent is present, and it is an agent everywhere -------------
      await page.goto(`/replay/${at.workspaceSlug}/${at.roomSlug}`);
      await openRail(page);
      await expect(page.locator('[data-rail="open"]')).toBeVisible();

      // the section header no longer claims the roster is only humans
      await expect(rail.getByText('PARTICIPANTS', { exact: true })).toBeVisible();
      await expect(rail.getByText('HUMANS', { exact: true })).toHaveCount(0);

      // the roster: exactly one agent row, naming the agent and its register
      await expect(agentRow).toHaveCount(1);
      await expect(agentRow).toContainText('atrium');
      await expect(agentRow).toContainText('agent');
      // and one human — the viewer — carrying the opposite kind
      await expect(humanRows).toHaveCount(1);

      // the presence marker on the agent row is the squared, kind-marked one
      await expect(agentRow.locator('[data-presence]')).toHaveCount(1);

      // the count reads by kind: one of each, named separately
      await expect(page.getByText('1 room · 1 person · 1 agent', { exact: true })).toBeVisible();

      // the room-head monogram carries the kind too — and it is DERIVED from the
      // single participant source (there is no separate `room.members` register),
      // so the flip below moving it is the proof that source is the only one.
      await expect(roomHead.locator('[data-participant-kind="agent"]')).toHaveCount(1);

      // the viewer's OWN monogram is kind-aware now (round-2 finding 2): the
      // strip's "you" tile reads `viewer.kind` rather than always painting a
      // person. The signed-in viewer is a human, so it reads `human` — before
      // this fix the tile carried no kind at all. `participant-kind.test.tsx`
      // proves the tile moves to agent/unknown when the viewer's kind does; a
      // real agent VIEWER needs an agent session, which is #96's surface, not
      // this render test's.
      await expect(
        page.locator('aside[aria-label="Workspace"] [data-participant-kind]'),
      ).toHaveAttribute('data-participant-kind', 'human');

      // ---- flip the input: the agent leaves, a person takes its slot ------
      swappedHumanId = await swapAgentForHuman(at);
      await page.reload();
      await openRail(page);
      await expect(page.locator('[data-rail="open"]')).toBeVisible();

      // every surface that carried the agent register has moved
      await expect(agentRow).toHaveCount(0);
      await expect(humanRows).toHaveCount(2);
      await expect(roomHead.locator('[data-participant-kind="agent"]')).toHaveCount(0);
      await expect(page.getByText('1 room · 2 people', { exact: true })).toBeVisible();
      await expect(rail.getByText(/·\s*agent/)).toHaveCount(0);
    } finally {
      await teardown(at, swappedHumanId);
    }
  });

  test('an agent’s message renders attributed, in the agent voice register, and the register moves when the author’s kind does', async ({
    page,
  }) => {
    /**
     * The acceptance test for #101, the render half. #96 proved server-side that
     * an agent posting via its session lands `author_id = <agent>` with a
     * non-human ledger kind (`integration/server/agent-principal.test.ts`); this
     * proves the read model turns that into a row a reader can tell from a
     * person's — never the old NULL that rendered "author unavailable", never a
     * person's typed words.
     *
     * Flip-the-input, on the exact same row: re-point the agent message's author
     * at a human identity and reload. The words, the room and the message id do
     * not move; the register does — because it reads `authorKind` and nothing
     * else. If a renderer keyed the register off anything but the author's kind,
     * this half fails.
     */
    const email = uniqueEmail('agent-voice');
    await signUpAndVerify(page, { email, name: 'Voice viewer' });
    const at = await seed(email);
    const { agentMsgId, humanMsgId } = await seedTwoMessages(at);

    try {
      await page.goto(`/replay/${at.workspaceSlug}/${at.roomSlug}`);

      const agentRow = page.locator(`[data-row="message"][data-message-id="${agentMsgId}"]`);
      const humanRow = page.locator(`[data-row="message"][data-message-id="${humanMsgId}"]`);

      // ---- the agent's message is attributed, kinded, in the machine register --
      await expect(agentRow).toHaveCount(1);
      // attributed to the agent — NOT "author unavailable" (the old NULL)
      await expect(agentRow).toContainText('atrium');
      await expect(agentRow).not.toContainText('author unavailable');
      // the row itself says a machine authored it
      await expect(agentRow).toHaveAttribute('data-author-kind', 'agent');
      // the kind is stated in a word
      await expect(agentRow.locator('[data-author-kind-word="agent"]')).toHaveCount(1);
      // the words are painted in the machine voice register
      await expect(agentRow.locator('[data-author-voice="agent"]')).toHaveCount(1);
      // the actor cell names the identity by the roster's own attribute
      await expect(agentRow.locator('[data-participant-kind="agent"]')).toHaveCount(1);

      // ---- the human's message carries NONE of it: the two are never identical -
      await expect(humanRow).toHaveCount(1);
      await expect(humanRow).not.toHaveAttribute('data-author-kind', 'agent');
      await expect(humanRow.locator('[data-author-voice]')).toHaveCount(0);
      await expect(humanRow.locator('[data-author-kind-word]')).toHaveCount(0);

      // ---- flip the input: the same message, authored by a person now ---------
      await db.update(messages).set({ authorId: at.viewerId }).where(eq(messages.id, agentMsgId));
      await page.reload();

      const flipped = page.locator(`[data-row="message"][data-message-id="${agentMsgId}"]`);
      await expect(flipped).toHaveCount(1);
      // the register moved off the row: no machine markers remain
      await expect(flipped).not.toHaveAttribute('data-author-kind', 'agent');
      await expect(flipped.locator('[data-author-voice]')).toHaveCount(0);
      await expect(flipped.locator('[data-author-kind-word]')).toHaveCount(0);
      // and there is no agent voice anywhere in the feed now
      await expect(page.locator('[data-author-kind="agent"]')).toHaveCount(0);
    } finally {
      await teardown(at, null);
    }
  });
});
