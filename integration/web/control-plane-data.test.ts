import { randomUUID } from 'node:crypto';
import { advanceSeenSeq, provisionAgentConfig } from '@atrium/auth';
import { attentionItems, messages, plans, sessions } from '@atrium/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadControlPlane } from '../../apps/web/lib/control-plane-data.js';
import {
  createRealtimeClient,
  type ServerFrame,
  type SocketLike,
} from '../../apps/web/src/lib/realtime.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * The minimum WebSocket the realtime client drives, for the cross-layer finding-3
 * recovery test below. Server→client frames arrive via `deliver`.
 */
class FakeWs implements SocketLike {
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

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
   * FLIP THE VIEWER. The projection used to hand EVERY viewer the room's whole
   * pending queue and only mark ownership at render (round-7 finding 6) — so the
   * server shipped one person's decisions to another, filtered late. The query
   * filters `user_id = viewerId` now, so two viewers get two DIFFERENT payloads
   * from the server: ada gets her item, bob gets nothing of hers.
   *
   * RED ON REVERT: drop the `eq(attentionItems.userId, viewerId)` predicate from
   * `loadControlPlane`'s decisions query — bob's payload then carries ada's item
   * again (masked to `owedToViewer: false`), and the length assertion below fails.
   */
  it("ada's item is in ada's payload and ABSENT from bob's, in the same room", async () => {
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

    // Bob sees the same room. The item is NOT in his payload at all — the server
    // never hands it to him, rather than handing it over and masking it.
    expect(asBob.decisions).toHaveLength(0);

    expect(asAda.viewerId).toBe(ada);
    expect(asBob.viewerId).toBe(bob);
  });

  /**
   * TWO PEOPLE, TWO QUEUES, ONE ROOM. Each viewer's payload is exactly their own
   * items — proof the filter is per-viewer AT THE SERVER, not a render mask.
   */
  it("each viewer's payload is their own items and only theirs", async () => {
    const room = await seedRoom(handle, ['ada', 'bob']);
    const ada = room.people.ada as string;
    const bob = room.people.bob as string;
    await handle.db.insert(attentionItems).values([
      {
        roomId: room.roomId,
        userId: ada,
        subjectKind: 'message',
        subjectId: await messageIn(room.roomId, ada),
        class: 'needs_decision',
        reason: { kind: 'mention', request: 'ada decides' },
        status: 'pending',
      },
      {
        roomId: room.roomId,
        userId: bob,
        subjectKind: 'message',
        subjectId: await messageIn(room.roomId, bob),
        class: 'blocking_question',
        reason: { kind: 'mention', request: 'bob answers' },
        status: 'pending',
      },
    ]);

    const asAda = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const asBob = await loadControlPlane(handle.db, room.roomId, 'fleet', bob);
    expect(asAda.decisions.map((d) => d.userId)).toEqual([ada]);
    expect(asBob.decisions.map((d) => d.userId)).toEqual([bob]);
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
    expect(view.unseenTotal).toBe(1);
  });

  /**
   * THE COUNT DOES NOT LIE PAST TWELVE (round-7 finding 5). The list caps at twelve;
   * a thirteenth unseen event must not read as "12". The projection returns the TRUE
   * total beside the capped list, so the surface can say `12+`.
   *
   * RED ON REVERT: render `data.unseen.length` as the total again (drop `unseenTotal`
   * / the count query). `unseen` is 12, and a 13th event is silently swallowed.
   */
  it('with thirteen unseen events the list caps at twelve but the total is thirteen', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    for (let i = 0; i < 13; i += 1) await lifecycleEvent(room.roomId, hexi);

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    // The displayed list is capped…
    expect(view.unseen).toHaveLength(12);
    // …but the reported total is the truth, so the surface reads "12+", not "12".
    expect(view.unseenTotal).toBe(13);
    expect(view.unseenTotal).toBeGreaterThan(view.unseen.length);
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

  it('carries the live progress snapshot so a reconnecting client recovers the preview (#159 fix, finding 3)', async () => {
    // The late-join / loss-recovery read: `sessions.progress` is selected via
    // `getTableColumns` but was dropped by the mapper before this fix, so a client
    // that reconnected mid-run could not recover the running session's `~` preview.
    // Revert the mapper's `progress` line and this reads `undefined`.
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
        status: 'open',
        progress: {
          progressSeq: 3,
          phase: 'writing',
          spendMicros: 4200,
          contextPct: 0.5,
          updatedAt: '2026-08-15T00:00:00.000Z',
        },
      })
      .returning({ id: sessions.id });

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const session = view.agents[0]?.plans[0]?.sessions[0];
    expect(session?.id).toBe((row as { id: string }).id);
    // The whole preview is recovered — phase, seq, and heartbeat — as `~` data.
    expect(session?.progress?.phase).toBe('writing');
    expect(session?.progress?.progressSeq).toBe(3);
    expect(session?.progress?.spendMicros).toBe(4200);
    expect(session?.progress?.contextPct).toBe(0.5);
  });

  it('a reconnecting client recovers the durable snapshot and FLOORS the live channel by its seq (#159 round-3, finding 3)', async () => {
    // END TO END across the seam. The server persists a durable `sessions.progress`
    // snapshot; `loadControlPlane` is the authenticated recovery read a reconnecting
    // client performs; and the realtime client floors its lossy live channel by the
    // recovered `progressSeq`, so a frame OLDER than the snapshot — a straggler or a
    // late duplicate on the bus, the frames a disconnect otherwise loses silently — is
    // dropped rather than shown as if it were current. `room.progress` starting empty
    // is exactly what let an un-floored late joiner accept a stale frame (round-2
    // finding 3); this proves the floor closes it.
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
        status: 'open',
        progress: {
          progressSeq: 7,
          phase: 'writing',
          spendMicros: 4200,
          contextPct: 0.5,
          updatedAt: '2026-08-15T00:00:00.000Z',
        },
      })
      .returning({ id: sessions.id });
    const sessionId = (row as { id: string }).id;

    // The authenticated recovery read.
    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const recovered = view.agents[0]?.plans[0]?.sessions[0]?.progress;
    expect(recovered?.progressSeq).toBe(7);

    // A reconnecting realtime client floors by the recovered snapshot.
    const sockets: FakeWs[] = [];
    const client = createRealtimeClient({
      userId: ada,
      url: 'ws://recover/ws',
      reconnect: false,
      socketFactory: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });
    await client.connect();
    sockets.at(-1)?.open();
    client.join(room.roomId);
    sockets.at(-1)?.deliver({ type: 'subscribed', roomId: room.roomId, head: 0, seenSeq: 0 });
    client.recoverProgress(room.roomId, [{ sessionId, progressSeq: recovered?.progressSeq ?? 0 }]);

    // A straggler at seq 5 — older than the recovered snapshot — is dropped.
    sockets.at(-1)?.deliver({
      type: 'session_heartbeat',
      roomId: room.roomId,
      sessionId,
      progressSeq: 5,
      spendMicros: 1,
      contextPct: 0.1,
      at: '2026-08-15T00:00:01.000Z',
    });
    expect(client.room(room.roomId).progress?.[sessionId]).toBeUndefined();

    // A frame past the snapshot is applied.
    sockets.at(-1)?.deliver({
      type: 'session_heartbeat',
      roomId: room.roomId,
      sessionId,
      progressSeq: 9,
      spendMicros: 2,
      contextPct: 0.2,
      at: '2026-08-15T00:00:02.000Z',
    });
    expect(client.room(room.roomId).progress?.[sessionId]?.progressSeq).toBe(9);

    client.close();
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
        /* An artifact to sign — a certification is bound to one now (0034), so a
           null-artifact row can no longer be certified. */
        artifact: { branch: 'feat/x', commit: 'abc123' },
      })
      .returning({ id: sessions.id });
    /* A COMPLETE RECEIPT. This used to write only `{ certifiedBy, certifiedAt,
       certifiedHeldMs }` and expect a valid certification — a `certified_by` with
       no arm behind it, exactly the shape CS-2 mints a false `✓` from. The
       receipt-complete backstop (drizzle/0035) now RAISES on that row, so the
       fixture writes the whole hold: armed, then stamped. Arm first (it is frozen
       once certified, 0033), then the signature over it. */
    await handle.db
      .update(sessions)
      .set({ certifyArmedBy: ada, certifyArmedAt: new Date(Date.now() - 3_000) })
      .where(eq(sessions.id, (row as { id: string }).id));
    await handle.db
      .update(sessions)
      .set({ certifiedBy: ada, certifiedAt: new Date(), certifiedHeldMs: 2400 })
      .where(eq(sessions.id, (row as { id: string }).id));

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const session = view.agents[0]?.plans[0]?.sessions[0];
    expect(session?.certifiedByName).toBe('ada');
    expect(session?.certifiedByKind).toBe('human');
    /* The arm timestamp travels with the receipt now — the render fails closed
       without it (CS-2), so the projection has to carry it. */
    expect(session?.certifyArmedAt).not.toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * THE REFUSED-DRAW COUNT ON THE COST SURFACE — #146.
 *
 * The cost meter reads GRANTED draws (`authorized_draws`) against the slice, so a
 * refused draw — which grants nothing — never moves it. The #140 gauntlet found a
 * spent slice turning work away was therefore invisible on cost, showing only as
 * an unseen line. `loadControlPlane` now carries `refusedDraws` per plan: the
 * `draw_refused` ledger rows refused UNDER THE PLAN'S CURRENT SLICE, so the
 * surface can render the refusal while the meter stays honest, and a human RAISING
 * the slice clears the count. This is the ENFORCED refusal (what Atrium turned
 * down), never adapter-reported spend.
 * ------------------------------------------------------------------------- */
describe('the cost surface carries the enforced refused-draw count (#146)', () => {
  /**
   * A `draw_refused` ledger row, appended through the one door, refused under
   * `slice`. `actorId` is the AGENT whose draw was refused — the ledger requires
   * the actor be a real identity in the room (the planId is not one).
   */
  async function drawRefused(
    roomId: string,
    planId: string,
    actorId: string,
    slice: number,
  ): Promise<void> {
    clock += 1;
    const at = new Date(Date.UTC(2026, 7, 14, 0, 0, clock)).toISOString();
    const id = randomUUID();
    const payload = {
      id,
      type: 'draw_refused',
      at,
      roomId,
      planId,
      reason: 'budget',
      slice,
      authorizedDraws: slice,
      harness: 'omp',
      model: 'haiku',
    };
    await handle.db.execute(sql`
      SELECT "room_seq" FROM atrium_append_core_event(
        ${roomId}::uuid,
        ${id}::text,
        'draw_refused'::event_type,
        'agent'::actor_kind,
        ${actorId}::text,
        ${JSON.stringify(payload)}::jsonb,
        ${at}::timestamptz,
        ${null}::text
      )
    `);
  }

  async function planWithSlice(
    roomId: string,
    agentUserId: string,
    slice: number | null,
    authorizedDraws: number,
  ): Promise<string> {
    const planId = randomUUID();
    await handle.db.insert(plans).values({
      id: planId,
      roomId,
      agentUserId,
      title: 'a plan',
      status: 'open',
      rlimitSlice: slice,
      authorizedDraws,
    });
    return planId;
  }

  it('counts the refusals under the CURRENT slice, and the meter (used) does not move', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await agentWithChannel(hexi, ada, room.roomId);

    // A plan funded to a slice of 3, all 3 draws granted; the 4th and 5th refused.
    const planId = await planWithSlice(room.roomId, hexi, 3, 3);
    await drawRefused(room.roomId, planId, hexi, 3);
    await drawRefused(room.roomId, planId, hexi, 3);

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const plan = view.agents[0]?.plans[0];
    expect(plan?.authorizedDraws).toBe(3); // GRANTS only — the refusals did not move it
    expect(plan?.rlimitSlice).toBe(3);
    expect(plan?.refusedDraws).toBe(2); // the two refused draws render
  });

  /**
   * RAISING THE SLICE CLEARS THE STALE COUNT. Two draws were refused under slice 3;
   * a human raises the slice to 5. Those refusals were against the old ceiling, so
   * they no longer describe the plan as it stands — `refusedDraws` reads 0.
   *
   * RED ON REVERT: count `draw_refused` rows regardless of the slice they carry,
   * and the raised plan keeps reporting 2 stale refusals forever.
   */
  it('a raise drops refusals taken under the old slice — the count is not stale', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await agentWithChannel(hexi, ada, room.roomId);

    const planId = await planWithSlice(room.roomId, hexi, 3, 3);
    await drawRefused(room.roomId, planId, hexi, 3);
    await drawRefused(room.roomId, planId, hexi, 3);
    // The human raises the ceiling to 5 — the old refusals were under 3.
    await handle.db.update(plans).set({ rlimitSlice: 5 }).where(eq(plans.id, planId));

    const view = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    const plan = view.agents[0]?.plans[0];
    expect(plan?.rlimitSlice).toBe(5);
    expect(plan?.refusedDraws).toBe(0); // stale refusals under slice 3 no longer count
  });

  it('an UNFUNDED plan counts its slice-0 refusals; funding then clears them', async () => {
    const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await agentWithChannel(hexi, ada, room.roomId);

    // Unfunded (null slice): the loop's first spawn is refused under slice 0.
    const planId = await planWithSlice(room.roomId, hexi, null, 0);
    await drawRefused(room.roomId, planId, hexi, 0);

    const unfunded = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    expect(unfunded.agents[0]?.plans[0]?.refusedDraws).toBe(1);

    // FLIP THE INPUT: fund it to 3. The slice-0 refusal is no longer the current story.
    await handle.db.update(plans).set({ rlimitSlice: 3 }).where(eq(plans.id, planId));
    const funded = await loadControlPlane(handle.db, room.roomId, 'fleet', ada);
    expect(funded.agents[0]?.plans[0]?.refusedDraws).toBe(0);
  });
});
