import type { DatabaseHandle } from '@atrium/db';
import { coreEvents } from '@atrium/db/schema';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startTestServer,
  TestClient,
  type TestServer,
  until,
} from '../support/harness.js';

/**
 * #22's acceptance test, as written on the ticket:
 *
 *   "two connected clients; client A posts through a burst while client B's
 *    socket is killed mid-stream; B reconnects with since(seq) and reaches
 *    byte-identical event history; per-room seq has no gaps/duplicates under
 *    concurrent posts (checked by constraint + test); a presence flood writes
 *    zero rows to events."
 *
 * The bar is Slack/Discord reconnect behaviour: lossless gap recovery. "Byte
 * identical" is meant literally here — the two histories are compared as
 * canonical JSON, not as a count or a set of ids, because a recovery that gets
 * the right events in the wrong order is still a client showing a different
 * conversation from everyone else.
 */

const BURST = 40;
const KILL_AFTER = 12;

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];

async function connect(userId: string): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId);
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice', 'bob', 'carol']);
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/** The ledger's own view of a room, as canonical JSON — the reference history. */
async function ledgerHistory(roomId: string): Promise<string> {
  const entries = await server.ledger.since(roomId, 0);
  return JSON.stringify(entries.map((entry) => ({ roomSeq: entry.roomSeq, event: entry.event })));
}

describe('kill mid-burst, reconnect with since()', () => {
  it('recovers a byte-identical history through a dropped socket', async () => {
    const alice = await connect(room.people.alice as string);
    let bob = await connect(room.people.bob as string);
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);

    // Post the first slice, wait for B to actually have it, then cut the wire.
    for (let i = 0; i < KILL_AFTER; i += 1) {
      const ack = await alice.command({
        name: 'send_message',
        roomId: room.roomId,
        body: `burst ${i}`,
        clientMessageId: `a-${i}`,
        replyToId: null,
        attachments: [],
      });
      expect(ack.type).toBe('ack');
    }
    await until(
      () => bob.events(room.roomId).length === KILL_AFTER,
      15_000,
      'B to receive the pre-kill slice',
    );

    const beforeKill = bob.events(room.roomId);
    const lastSeenBySeq = beforeKill.at(-1)?.roomSeq ?? 0;
    expect(lastSeenBySeq).toBe(KILL_AFTER);

    // A hard terminate, not a close: no close frame, no goodbye, exactly what a
    // lost network gives you.
    bob.kill();

    for (let i = KILL_AFTER; i < BURST; i += 1) {
      const ack = await alice.command({
        name: 'send_message',
        roomId: room.roomId,
        body: `burst ${i}`,
        clientMessageId: `a-${i}`,
        replyToId: null,
        attachments: [],
      });
      expect(ack.type).toBe('ack');
    }

    // B comes back on a fresh socket and asks for the gap.
    bob = await connect(room.people.bob as string);
    const subscribed = await bob.subscribe(room.roomId);
    expect(subscribed.head).toBe(BURST);

    const catchup = await bob.since(room.roomId, lastSeenBySeq);
    expect(catchup.more).toBe(false);
    expect(catchup.to).toBe(BURST);
    expect(catchup.entries).toHaveLength(BURST - KILL_AFTER);

    const recovered = [...beforeKill, ...catchup.entries];
    expect(
      JSON.stringify(recovered.map((entry) => ({ roomSeq: entry.roomSeq, event: entry.event }))),
    ).toBe(await ledgerHistory(room.roomId));

    // And the same history A itself saw live, with nothing duplicated across
    // the seam: the gap starts exactly one past where B stopped.
    expect(recovered.map((entry) => entry.roomSeq)).toEqual(
      Array.from({ length: BURST }, (_, i) => i + 1),
    );
    expect(alice.events(room.roomId).map((entry) => entry.roomSeq)).toEqual(
      recovered.map((entry) => entry.roomSeq),
    );
  });

  it('returns nothing when a client is already caught up', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'one',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
    });
    const catchup = await alice.since(room.roomId, 1);
    expect(catchup.entries).toEqual([]);
    expect(catchup.to).toBe(1);
    expect(catchup.head).toBe(1);
  });

  it('refuses catch-up for a room the caller is not a member of', async () => {
    const outsiders = await seedRoom(handle, ['mallory'], { slug: 'other-room' });
    const mallory = await connect(outsiders.people.mallory as string);
    mallory.send({ type: 'since', roomId: room.roomId, roomSeq: 0 });
    const frame = await mallory.waitFor((f) => f.type === 'error');
    expect(frame).toMatchObject({ type: 'error' });
    expect((frame as { message: string }).message).toMatch(/no membership/);
  });
});

describe('per-room seq under concurrent posts', () => {
  it('is gap-free and duplicate-free across three concurrent writers', async () => {
    const clients = await Promise.all([
      connect(room.people.alice as string),
      connect(room.people.bob as string),
      connect(room.people.carol as string),
    ]);
    for (const client of clients) await client.subscribe(room.roomId);

    const PER_CLIENT = 15;
    const acks = await Promise.all(
      clients.flatMap((client, c) =>
        Array.from({ length: PER_CLIENT }, (_, i) =>
          client.command({
            name: 'send_message',
            roomId: room.roomId,
            body: `c${c}-${i}`,
            clientMessageId: `c${c}-${i}`,
            replyToId: null,
            attachments: [],
          }),
        ),
      ),
    );
    expect(acks.every((ack) => ack.type === 'ack')).toBe(true);

    const total = clients.length * PER_CLIENT;
    // `-1` for anything that was not an append: a null or a nack must show up
    // as a hole in the sequence below, never be quietly filtered out.
    const assigned = acks
      .map((ack) => (ack.type === 'ack' ? (ack.roomSeq ?? -1) : -1))
      .sort((a, b) => a - b);
    expect(assigned).toEqual(Array.from({ length: total }, (_, i) => i + 1));

    // And the ledger agrees, which is the half a constraint can enforce.
    const entries = await server.ledger.since(room.roomId, 0);
    expect(entries.map((entry) => entry.roomSeq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(new Set(entries.map((entry) => entry.event.id)).size).toBe(total);

    // The global order is a strict total order too, and it agrees with the
    // canonical `(at, id)` one — which is what makes `reduce(ledger)` and the
    // live fold the same fold.
    const seqs = entries.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const ats = entries.map((entry) => entry.event.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it('keeps two rooms’ sequences independent while sharing one global order', async () => {
    const other = await seedRoom(handle, ['alice'], { slug: 'second-room' });
    // The same person, a member of both.
    const alice = await connect(room.people.alice as string);
    const aliceElsewhere = await connect(other.people.alice as string);
    await alice.subscribe(room.roomId);
    await aliceElsewhere.subscribe(other.roomId);

    await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'here',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
    });
    await aliceElsewhere.command({
      name: 'send_message',
      roomId: other.roomId,
      body: 'there',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
    });
    await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'here again',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
    });

    const here = await server.ledger.since(room.roomId, 0);
    const there = await server.ledger.since(other.roomId, 0);
    expect(here.map((e) => e.roomSeq)).toEqual([1, 2]);
    expect(there.map((e) => e.roomSeq)).toEqual([1]);
    expect(here.map((e) => e.seq)).toEqual([1, 3]);
    expect(there.map((e) => e.seq)).toEqual([2]);

    // A room's catch-up never leaks another room's events.
    expect(here.every((entry) => entry.roomId === room.roomId)).toBe(true);
  });
});

describe('presence is ephemeral (#14)', () => {
  it('writes zero rows for a presence and typing flood', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);

    const [{ count: before } = { count: 0 }] = await handle.db
      .select({ count: count() })
      .from(coreEvents);

    const states = ['online', 'away', 'offline'] as const;
    for (let i = 0; i < 60; i += 1) {
      const ack = await alice.command({
        name: 'set_presence',
        roomId: room.roomId,
        state: states[i % states.length] as (typeof states)[number],
      });
      expect(ack.type).toBe('ack');
    }
    for (let i = 0; i < 20; i += 1) {
      await alice.command({ name: 'set_typing', roomId: room.roomId, typing: i % 2 === 0 });
    }

    // Bob saw the churn...
    await until(
      () => bob.frames.filter((f) => f.type === 'presence').length === 60,
      15_000,
      'presence fan-out',
    );
    expect(bob.frames.filter((f) => f.type === 'typing').length).toBe(20);

    // ...and the ledger did not.
    const [{ count: after } = { count: 0 }] = await handle.db
      .select({ count: count() })
      .from(coreEvents);
    expect(Number(after)).toBe(Number(before));
    expect(Number(after)).toBe(0);

    const [{ count: inRoom } = { count: 0 }] = await handle.db
      .select({ count: count() })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId));
    expect(Number(inRoom)).toBe(0);
  });

  it('does not echo a typing indicator back to its sender', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);

    await alice.command({ name: 'set_typing', roomId: room.roomId, typing: true });
    await until(() => bob.frames.some((f) => f.type === 'typing'), 15_000, 'typing fan-out');
    expect(alice.frames.some((f) => f.type === 'typing')).toBe(false);
  });
});
