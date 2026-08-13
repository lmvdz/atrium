import { randomUUID } from 'node:crypto';
import { advanceSeenSeq, provisionAgentConfig } from '@atrium/auth';
import { attentionItems, messages, plans, sessions } from '@atrium/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadControlPlane } from '../../apps/web/lib/control-plane-data.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/* ---------------------------------------------------------------------------
 * THE CONTROL PLANE'S SURFACES BELONG TO A VIEWER — #121 fix round, finding 5.
 *
 * Both surfaces were room facts wearing a second-person label:
 *
 *   * every pending `attention_items` row in the room was handed to every viewer
 *     and marked owed to them, so a person owed nothing read "4 DECISIONS OWED";
 *   * "unseen activity" was the last twelve lifecycle events, with
 *     `memberships.seen_seq` — the per-person read cursor this product already
 *     maintains and already advances — consulted by nothing.
 *
 * The mutation these exist to catch is the one that shipped: return a constant
 * from the derivation, or drop the `room_seq > seen_seq` predicate, and the same
 * room reads identically to two different people. So every case here loads the
 * SAME room twice, as two different viewers, and asserts the readings differ.
 * A per-viewer projection proved with one viewer is not proved.
 * ------------------------------------------------------------------------- */

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

/**
 * Append a lifecycle event through the SAME door the ledger uses.
 *
 * Not `db.insert(coreEvents)`: `core_events_append_through_procedure` refuses a
 * direct INSERT, and `room_seq` is minted inside the function and cannot be
 * supplied — which is exactly the column the unseen surface now reads, so a
 * fixture that hand-wrote it would be testing a cursor against a number the
 * product does not produce.
 */
let clock = 0;
async function lifecycleEvent(roomId: string, actorId: string): Promise<void> {
  clock += 1;
  const at = new Date(Date.UTC(2026, 7, 13, 0, 0, clock)).toISOString();
  const id = randomUUID();
  /* The payload is the whole event envelope, `at` included — `core_events`
     carries a CHECK that the stored payload agrees with the row's own columns,
     so a fixture that sent only a type would be refused (and rightly). */
  const payload = { id, type: 'session_opened', at, roomId };
  await handle.db.execute(sql`
    SELECT "room_seq" FROM atrium_append_core_event(
      ${roomId}::uuid,
      ${id}::text,
      'session_opened'::event_type,
      'agent'::actor_kind,
      ${actorId}::text,
      ${JSON.stringify(payload)}::jsonb,
      ${at}::timestamptz,
      ${null}::text
    )
  `);
}

/**
 * A real message to hang an attention item off.
 *
 * `attention_items_message_same_room_fk` is a COMPOSITE foreign key — the item's
 * subject must be a message IN THIS ROOM — so a random uuid is refused. "Needs
 * you must never point at something from a room you cannot see" is the rule, and
 * it means a fixture cannot invent a subject.
 */
async function messageIn(roomId: string, authorId: string): Promise<string> {
  const [row] = await handle.db
    .insert(messages)
    .values({ roomId, authorId, body: 'a decision awaits somebody' })
    .returning({ id: messages.id });
  return (row as { id: string }).id;
}

/** An agent with a config sidecar, which is what gives a plan a channel to live in. */
async function agentWithChannel(userId: string, ownerId: string, roomId: string): Promise<void> {
  await provisionAgentConfig({
    db: handle.db,
    userId,
    ownerUserId: ownerId,
    channelRoomId: roomId,
    host: 'fly-ord',
    harness: 'claude-code',
    model: 'opus',
    budgetLimitMicros: 20_000_000,
  });
}

describe('DECISIONS OWED is owed to somebody in particular', () => {
  /**
   * FLIP THE VIEWER. The projection used to mark every item owed to whoever
   * asked.
   *
   * RED ON REVERT: set `owedToViewer: true` unconditionally in
   * `loadControlPlane`'s decision mapping — both readings then come back
   * identical and every assertion below about `bob` fails.
   */
  it("ada's item is owed to ada and not to bob, in the same room", async () => {
    const room = await seedRoom(handle, ['ada', 'bob']);
    const ada = room.people.ada as string;
    const bob = room.people.bob as string;

    await handle.db.insert(attentionItems).values({
      roomId: room.roomId,
      userId: ada,
      subjectKind: 'message',
      subjectId: await messageIn(room.roomId, ada),
      class: 'needs_decision',
      reason: { kind: 'mention', request: 'a decision awaits' },
      status: 'pending',
    });

    const asAda = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const asBob = await loadControlPlane(handle.db, room.roomId, 'fleet', bob);

    expect(asAda.decisions).toHaveLength(1);
    expect(asAda.decisions[0]?.owedToViewer).toBe(true);

    // Bob sees the same room. The item is not his, and the projection says so.
    expect(asBob.decisions).toHaveLength(1);
    expect(asBob.decisions[0]?.owedToViewer).toBe(false);

    expect(asAda.viewerId).toBe(ada);
    expect(asBob.viewerId).toBe(bob);
  });

  it('a resolved item is owed to nobody — status still filters before the viewer does', async () => {
    const room = await seedRoom(handle, ['ada']);
    const ada = room.people.ada as string;
    await handle.db.insert(attentionItems).values({
      roomId: room.roomId,
      userId: ada,
      subjectKind: 'message',
      subjectId: await messageIn(room.roomId, ada),
      class: 'needs_decision',
      reason: { kind: 'mention', request: 'a decision awaits' },
      status: 'resolved',
      resolvedAt: new Date(),
    });
    const asAda = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    expect(asAda.decisions).toEqual([]);
  });
});

describe('UNSEEN ACTIVITY is what THIS reader has not seen', () => {
  /**
   * RED ON REVERT: delete the `gt(coreEvents.roomSeq, seenSeq)` predicate. Ada
   * then sees all three events she has already read, and the two viewers'
   * readings collapse into one.
   */
  it("advancing one viewer's cursor empties their unseen surface and not the other's", async () => {
    const room = await seedRoom(handle, ['ada', 'bob', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const bob = room.people.bob as string;
    const hexi = room.people.hexi as string;

    await lifecycleEvent(room.roomId, hexi);
    await lifecycleEvent(room.roomId, hexi);
    await lifecycleEvent(room.roomId, hexi);

    // Nobody has read anything yet: both see all three.
    expect((await loadControlPlane(handle.db, room.roomId, 'fleet', ada)).unseen).toHaveLength(3);
    expect((await loadControlPlane(handle.db, room.roomId, 'fleet', bob)).unseen).toHaveLength(3);

    // Ada reads to the head, through the same function `room.ack` uses.
    await advanceSeenSeq(handle.db, room.roomId, ada, 3);

    expect((await loadControlPlane(handle.db, room.roomId, 'fleet', ada)).unseen).toEqual([]);
    // Bob's cursor did not move, so his surface did not either.
    expect((await loadControlPlane(handle.db, room.roomId, 'fleet', bob)).unseen).toHaveLength(3);
  });

  it('a partial cursor shows only what came after it', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await lifecycleEvent(room.roomId, hexi);
    await lifecycleEvent(room.roomId, hexi);
    await lifecycleEvent(room.roomId, hexi);

    await advanceSeenSeq(handle.db, room.roomId, ada, 2);
    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    expect(view.unseen).toHaveLength(1);
  });
});

describe('a session row carries the certifier KIND, not only the name', () => {
  /**
   * The glyph derivation runs @atrium/core's one predicate over this field. It
   * has to arrive, or `state.ts` fails closed to `~` for every certified session
   * and nobody notices the projection dropped it.
   */
  it('an uncertified settled session projects a null kind; the room still loads', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await agentWithChannel(hexi, ada, room.roomId);
    const planId = randomUUID();
    await handle.db.insert(plans).values({
      id: planId,
      roomId: room.roomId,
      agentUserId: hexi,
      title: 'a plan',
      status: 'open',
    });
    const [row] = await handle.db
      .insert(sessions)
      .values({
        roomId: room.roomId,
        planId,
        harness: 'claude-code',
        model: 'opus',
        status: 'settled',
      })
      .returning({ id: sessions.id });

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const session = view.agents[0]?.plans[0]?.sessions[0];
    expect(session?.id).toBe((row as { id: string }).id);
    expect(session?.certifiedByName).toBeNull();
    expect(session?.certifiedByKind).toBeNull();
  });

  it('a human-certified session projects kind `human`, which is what mints the tick', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await agentWithChannel(hexi, ada, room.roomId);
    const planId = randomUUID();
    await handle.db.insert(plans).values({
      id: planId,
      roomId: room.roomId,
      agentUserId: hexi,
      title: 'a plan',
      status: 'open',
    });
    const [row] = await handle.db
      .insert(sessions)
      .values({
        roomId: room.roomId,
        planId,
        harness: 'claude-code',
        model: 'opus',
        status: 'settled',
      })
      .returning({ id: sessions.id });
    await handle.db
      .update(sessions)
      .set({ certifiedBy: ada, certifiedAt: new Date(), certifiedHeldMs: 2400 })
      .where(eq(sessions.id, (row as { id: string }).id));

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const session = view.agents[0]?.plans[0]?.sessions[0];
    expect(session?.certifiedByName).toBe('ada');
    expect(session?.certifiedByKind).toBe('human');
  });
});
