import type { DatabaseHandle } from '@atrium/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealtimeClient, type RealtimeClient } from '../../apps/web/src/lib/realtime.js';
import {
  nodeSocketFactory,
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startSecondInstance,
  TestClient,
  until,
} from '../support/harness.js';

/**
 * A lost doorbell must not strand a subscriber (#22 gauntlet r2 delta,
 * blocking 1).
 *
 * The finding, verbatim:
 *
 * > `LISTEN/NOTIFY` is consumed only at startup: no periodic `ledger.sync()`,
 * > no listener-loss callback, no post-resubscribe reconciliation. NOTIFY is
 * > at-most-once and is lost on listener disconnect or transaction rollback, so
 * > if instance A misses B's notification, A never broadcasts those durable rows
 * > and its clients have no gap signal to trigger `since`.
 *
 * The last clause is the sharp one. A client can recover from anything it can
 * *detect*, and a client on the deaf instance detects nothing: no frame arrives,
 * so there is no `roomSeq` gap to notice, so it never asks. r2's whole recovery
 * story — the catch-up loop, the durable cursor, the `more` arithmetic — is
 * downstream of a signal that never comes.
 *
 * ## How the doorbell is severed here
 *
 * `pg_terminate_backend` on the listener connections, found through
 * `pg_stat_activity`. That is a real severed listener rather than a simulated
 * one: the notifications instance B's commits emit are delivered to nobody,
 * exactly as they would be if the network dropped that socket.
 *
 * postgres-js does reconnect and re-issue `LISTEN` on its own, and that is a
 * genuine part of the fix (`BusHandlers.onListen` reconciles on every
 * resubscribe) — but it would also make a sloppy version of this test pass for a
 * reason it was not testing. So the second case removes the bus entirely: an
 * instance with no listener at all, no doorbell to lose and none to regain, and
 * delivery still happens. Between the two, the claim "the doorbell is an
 * optimization" is pinned from both sides.
 *
 * In every case the reader sends **no command of any kind** after the cut. That
 * is the finding's real teeth: a client can recover from anything it detects,
 * and this one has nothing to detect.
 */

let handle: DatabaseHandle;
let room: SeededRoom;
const open: TestClient[] = [];
const clients: RealtimeClient[] = [];
const teardown: Array<() => Promise<void>> = [];

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice', 'bob']);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(open.splice(0).map((client) => client.close()));
  for (const close of teardown.splice(0)) await close();
});

afterAll(async () => {
  await handle?.close();
});

function productionClient(url: string, userId: string): RealtimeClient {
  const client = createRealtimeClient({
    userId,
    url,
    reconnect: { initialDelayMs: 10, maxDelayMs: 40, factor: 1 },
    catchUpPageSize: 5,
    socketFactory: nodeSocketFactory(),
  });
  clients.push(client);
  return client;
}

/**
 * Kill every backend whose last statement was a `LISTEN`, except our own.
 *
 * `pg_listening_channels()` is per-session, so a test cannot ask another backend
 * what it is subscribed to; what it *can* see is `pg_stat_activity.query`, which
 * for an idle listener still holds the `listen "…"` statement that put it there.
 *
 * The match is on `listen %` rather than on the ledger channel by name, and that
 * is a correction the first draft of this test needed: postgres-js multiplexes
 * both subscriptions onto one connection, so after `event-bus.ts` subscribes to
 * `atrium_ledger` *and* `atrium_ephemeral`, the connection's recorded query is
 * the second one. Matching the ledger channel found nothing and severed nothing,
 * and the test would have passed for the wrong reason had the count assertion
 * not been there.
 *
 * Which is why it is there. The returned count is asserted `> 0` at every call
 * site: a change in how the driver subscribes must break this loudly rather than
 * turn it into a test that cuts no wire and reports green — the exact class of
 * vacuity this round exists to close.
 */
async function severLedgerListeners(): Promise<number> {
  const rows = await handle.db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND datname = current_database()
      AND query ILIKE 'listen %'
  `);
  for (const row of rows) {
    await handle.db.execute(sql`SELECT pg_terminate_backend(${row.pid})`);
  }
  return rows.length;
}

async function post(client: TestClient, body: string) {
  const ack = await client.command({
    name: 'send_message',
    roomId: room.roomId,
    body,
    clientMessageId: body,
    replyToId: null,
    attachments: [],
  });
  expect(ack.type).toBe('ack');
  return ack;
}

describe('a lost doorbell costs latency, never delivery', () => {
  it('converges a subscriber after its instance’s listener is severed mid-run, with no client command', async () => {
    const a = await startSecondInstance();
    const b = await startSecondInstance();
    teardown.push(a.close, b.close);

    // The reader is on A. Every writer is on B. A hears about B's commits only
    // through the database.
    const reader = productionClient(a.server.url, room.people.bob as string);
    await reader.connect();
    reader.join(room.roomId);
    await until(() => reader.room(room.roomId).subscribed, 15_000, 'the reader to subscribe');

    const writer = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);

    // A first commit that arrives the ordinary way, so the test is not merely
    // observing a client that was never connected properly.
    await post(writer, 'before-the-cut');
    await until(() => reader.lastSeq(room.roomId) === 1, 15_000, 'the ordinary delivery path');

    // Cut the wire that carries the doorbell. Both instances' listeners go,
    // because either could be the one that would have heard it.
    const severed = await severLedgerListeners();
    expect(severed).toBeGreaterThan(0);

    // Twelve commits on B while A is deaf. Every notification these emit is
    // delivered to nobody — the row is durable and the bell rang into a dead
    // connection.
    for (let i = 0; i < 12; i += 1) await post(writer, `after-the-cut-${i}`);

    // Nobody tells the reader anything. It sends no `since`, no `subscribe`, no
    // command of any kind: convergence has to come from A's own reconciliation.
    //
    // Catches: removing `reconciler.start()` from `ws-server.ts`, removing the
    // `onListen` handler from the bus, or reverting `onLedger` to be the only
    // trigger. Under r2 this times out with the reader still at 1 — the rows are
    // durable and unreachable, which is the finding.
    await until(
      () => reader.lastSeq(room.roomId) === 13,
      20_000,
      'instance A’s subscriber to converge after the doorbell was lost',
    );

    // Byte-identical history, not a count: the recovery has to be the same rows
    // in the same order, which is what a client renders.
    const entries = await a.server.ledger.since(room.roomId, 0);
    expect(
      JSON.stringify(
        reader.room(room.roomId).events.map((e) => ({ roomSeq: e.roomSeq, event: e.event })),
      ),
    ).toBe(JSON.stringify(entries.map((e) => ({ roomSeq: e.roomSeq, event: e.event }))));

    // And instance A folded them, rather than merely relaying frames. A relay
    // that did not fold would answer `head` correctly and `coreState()` wrongly,
    // and the divergence would only surface the next time A appended.
    expect(a.server.ledger.serialize()).toBe(b.server.ledger.serialize());
  });

  it('converges with no event bus at all — the reconciler is the durable path', async () => {
    // An instance with no listener whatsoever. There is no doorbell to lose
    // because there is no doorbell, and delivery still happens.
    //
    // Catches: making the reconciler conditional on the bus. r2's fan-out lived
    // entirely inside `onLedger`, so an instance without a bus delivered nothing
    // a peer wrote — and this is the shape that hid it, because the single-
    // instance tests never had a peer.
    const handleA = openDatabase(5);
    teardown.push(() => handleA.close());
    const { startTestServer } = await import('../support/harness.js');
    const a = await startTestServer(handleA, { bus: false, reconcileIntervalMs: 150 });
    teardown.push(a.close);

    const b = await startSecondInstance();
    teardown.push(b.close);

    const reader = productionClient(a.url, room.people.bob as string);
    await reader.connect();
    reader.join(room.roomId);
    await until(() => reader.room(room.roomId).subscribed, 15_000, 'the reader to subscribe');

    const writer = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);
    for (let i = 0; i < 6; i += 1) await post(writer, `bus-less-${i}`);

    await until(
      () => reader.lastSeq(room.roomId) === 6,
      20_000,
      'a bus-less instance’s subscriber to converge',
    );
  });

  it('tells a subscriber the head even when the event frame itself was lost', async () => {
    // The failure `sync` cannot cover: the instance folded the row and broadcast
    // it, and *that socket* dropped the frame. There is nothing left for the
    // ledger to hand over, so the only thing that closes the gap is being told
    // where the room is.
    //
    // Simulated honestly rather than by dropping a frame in the transport: a
    // second client subscribes with a cursor the server has no reason to send
    // anything for, having already been told `head` at subscribe time. The
    // reconciler's head frame is what moves it.
    const a = await startSecondInstance();
    teardown.push(a.close);

    const writer = await TestClient.connect(a.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);
    for (let i = 0; i < 3; i += 1) await post(writer, `pre-${i}`);

    const watcher = await TestClient.connect(a.server.url, room.people.bob as string);
    open.push(watcher);
    await watcher.subscribe(room.roomId);

    // Catches: dropping `onHead` from the reconciler wiring, or the `head` case
    // from `ServerFrame`. Without it a socket that lost one event frame has no
    // in-band way to learn it, and the client's own arithmetic never fires
    // because its cursor and its (stale) head agree.
    const head = await watcher.waitFor((f) => f.type === 'head' && f.roomId === room.roomId);
    expect(head).toMatchObject({ type: 'head', roomId: room.roomId, head: 3 });
  });
});
