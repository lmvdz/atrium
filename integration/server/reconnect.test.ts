import type { DatabaseHandle } from '@atrium/db';
import { coreEvents } from '@atrium/db/schema';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { isFoldedEntry } from '../../apps/server/src/ledger.js';
import { createRealtimeClient, type RealtimeClient } from '../../apps/web/src/lib/realtime.js';
import {
  nodeSocketFactory,
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
/** Small enough that a 40-event recovery takes eight pages. See below. */
const CATCH_UP_PAGE = 5;
const KILL_AFTER = 12;

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];
/** Production clients, closed with the same care as the raw sockets. */
const clients: RealtimeClient[] = [];

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
  for (const client of clients.splice(0)) client.close();
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/** The ledger's own view of a room, as canonical JSON — the reference history. */
async function ledgerHistory(roomId: string): Promise<string> {
  const entries = (await server.ledger.since(roomId, 0)).filter(isFoldedEntry);
  return JSON.stringify(entries.map((entry) => ({ roomSeq: entry.roomSeq, event: entry.event })));
}

describe('kill mid-burst, reconnect through the production client', () => {
  /**
   * #22's acceptance test, and the r1 gauntlet's major 6.
   *
   * Round 1 asserted the right *claim* against the wrong subject. It drove the
   * harness: subscribe, kill, reconnect, one `since`, and then the test itself
   * stitched `[...beforeKill, ...catchup.entries]` back together and compared
   * that to the ledger. Which is right by construction — the test wrote the
   * recovery. The client's own interleaving of live delivery and catch-up, the
   * thing that actually runs in a browser, was never exercised, and neither was
   * the race, because the burst had finished before the reconnect began.
   *
   * So: `createRealtimeClient` from `apps/web/src/lib/realtime.ts`, over a real
   * socket, killed while *three writers are appending concurrently*, left to
   * reconnect on its own backoff and close its own gap. The assertion is on the
   * client's `events` array — what a UI would render — against the ledger, as
   * canonical JSON.
   */
  it('recovers a byte-identical history through a socket killed during concurrent appends', async () => {
    const writers = await Promise.all([
      connect(room.people.alice as string),
      connect(room.people.carol as string),
    ]);
    for (const writer of writers) await writer.subscribe(room.roomId);

    const sockets: WebSocket[] = [];
    const errors: string[] = [];
    const bob = createRealtimeClient({
      userId: room.people.bob as string,
      url: server.url,
      // Tight, so the test is not mostly waiting. The behaviour under test is
      // the catch-up loop, not the backoff curve.
      reconnect: { initialDelayMs: 10, maxDelayMs: 40, factor: 1 },
      // Five, against a forty-event burst: eight pages, so the recovery this
      // test is about crosses page boundaries instead of arriving in one frame.
      // r2 ran this fixture against the server's 1000-entry default, which meant
      // the acceptance test never once exercised the catch-up loop it exists to
      // prove (#22 gauntlet r2 delta, major 2).
      catchUpPageSize: CATCH_UP_PAGE,
      socketFactory: nodeSocketFactory({
        userId: room.people.bob as string,
        onSocket: (socket) => sockets.push(socket),
      }),
      onError: (message) => errors.push(message),
    });
    clients.push(bob);
    await bob.connect();
    bob.join(room.roomId);
    await until(() => bob.room(room.roomId).subscribed, 15_000, 'the client to subscribe');

    // Two writers, interleaved, not awaited: the socket has to die while
    // appends are genuinely in flight, which is the condition r1's test could
    // not produce and therefore never tested under.
    const burst = Promise.all(
      writers.flatMap((writer, w) =>
        Array.from({ length: BURST / 2 }, (_, i) =>
          writer.command({
            name: 'send_message',
            roomId: room.roomId,
            body: `w${w}-${i}`,
            clientMessageId: `w${w}-${i}`,
            replyToId: null,
            attachments: [],
          }),
        ),
      ),
    );

    // Cut the wire mid-stream: a hard terminate, no close frame, no goodbye.
    await until(
      () => bob.lastSeq(room.roomId) >= KILL_AFTER,
      15_000,
      'the client to receive the pre-kill slice',
    );
    const killedAt = bob.lastSeq(room.roomId);
    expect(killedAt).toBeGreaterThanOrEqual(KILL_AFTER);
    sockets.at(-1)?.terminate();

    const acks = await burst;
    expect(acks.every((ack) => ack.type === 'ack')).toBe(true);

    // Nobody tells it to catch up. It reconnects on its own and loops until its
    // cursor reaches the head it was told about.
    const head = await server.ledger.head(room.roomId);
    expect(head).toBe(BURST);
    await until(
      () => bob.lastSeq(room.roomId) === head,
      20_000,
      `the client to reach head ${head} on its own`,
    );

    const recovered = bob.room(room.roomId).events;
    expect(
      JSON.stringify(recovered.map((entry) => ({ roomSeq: entry.roomSeq, event: entry.event }))),
    ).toBe(await ledgerHistory(room.roomId));

    // Gap-free and duplicate-free across the seam, which is the half a
    // count-based assertion would miss: the recovery must start exactly one
    // past where the socket died, and repeat nothing.
    expect(recovered.map((entry) => entry.roomSeq)).toEqual(
      Array.from({ length: BURST }, (_, i) => i + 1),
    );
    expect(errors).toEqual([]);
    // It really did lose the wire and come back — otherwise this test is a
    // long-winded way of asserting that live delivery works.
    expect(sockets.length).toBeGreaterThan(1);
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
    const entries = (await server.ledger.since(room.roomId, 0)).filter(isFoldedEntry);
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
