import type { DatabaseHandle } from '@atrium/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerFrame } from '../../apps/server/src/protocol.js';
import { createRealtimeClient, type RealtimeClient } from '../../apps/web/src/lib/realtime.js';
import {
  nodeSocketFactory,
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startSecondInstance,
  startTestServer,
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

function productionClient(
  url: string,
  userId: string,
  options: { dropFrame?: (frame: ServerFrame) => boolean } = {},
): RealtimeClient {
  const client = createRealtimeClient({
    userId,
    url,
    reconnect: { initialDelayMs: 10, maxDelayMs: 40, factor: 1 },
    catchUpPageSize: 5,
    socketFactory: nodeSocketFactory({ userId, dropFrame: options.dropFrame }),
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

  it('reconciles on the listener’s resubscribe, not only on the next tick', async () => {
    /**
     * `onListen` is a latency fix rather than a correctness one — the timer
     * gets there eventually — so every other test in this file stays green
     * without it, and it needs a pin that isolates it.
     *
     * Two variables are removed to get that isolation, and both are deliberate:
     *
     *  - **The timer is set to a minute.** Nothing it does can explain
     *    convergence inside five seconds.
     *  - **Both instances share an instance id.** The origin filter then makes A
     *    deaf to B's doorbell *by construction* — the same state a permanently
     *    lost notification leaves it in, reached deterministically instead of
     *    by racing a driver reconnect. An earlier draft severed the listener and
     *    then wrote, and postgres-js resubscribed fast enough to hear the later
     *    commits' doorbells; the mutant escaped, because the test was measuring
     *    the doorbell it thought it had removed.
     *
     * What is left is exactly one path: the resubscribe fires `onListen`, which
     * reconciles. Catches: dropping `onListen` from the `bus.start` call in
     * `ws-server.ts`, or from `BusHandlers` in `event-bus.ts`.
     */
    const shared = 'deaf-to-its-own-echo';
    const a = await startSecondInstance({ instanceId: shared, reconcileIntervalMs: 60_000 });
    const b = await startSecondInstance({ instanceId: shared });
    teardown.push(a.close, b.close);

    const reader = productionClient(a.server.url, room.people.bob as string);
    await reader.connect();
    reader.join(room.roomId);
    await until(() => reader.room(room.roomId).subscribed, 15_000, 'the reader to subscribe');

    const writer = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);
    for (let i = 0; i < 4; i += 1) await post(writer, `resubscribe-${i}`);

    // A is deaf by origin, and its timer will not fire for a minute. It stays
    // where it was — which is the r2 world, and is asserted rather than assumed
    // so that the convergence below has something to be a change from.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reader.lastSeq(room.roomId)).toBe(0);

    expect(await severLedgerListeners()).toBeGreaterThan(0);

    await until(
      () => reader.lastSeq(room.roomId) === 4,
      5_000,
      'convergence from the listener resubscribe, well inside the 60s timer',
    );
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
    // A client that joins after the fact, having been told `head` at subscribe
    // time and having nothing sent to it since. The reconciler's head frame is
    // what moves it. This is the *easy* half — the hard one is the next test,
    // which the r3 delta found this one was standing in for and could not cover.
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

  /**
   * A frame lost **after a successful fan-out**, in a room that then goes quiet
   * (#22 gauntlet r3 delta, blocking 1).
   *
   * The finding, and it is about the test as much as about the code:
   *
   * > `reconciler.ts:109–116` sets `announcedHeads` from a successful
   * > `onEntries` and `:127–129` then skips `onHead` when `announcedHeads >=
   * > head`. That treats "we called broadcast" as "the client received it" […]
   * > **The pin is theatre** (`reconcile.test.ts:280–308` waits for a head after
   * > subscribe and never drops an event frame); r4's test must drop an event
   * > frame after a successful fan-out and assert convergence.
   *
   * Every clause of that is right, including the last. The test above waits for a
   * head frame that r3 was always going to send, because nothing had been fanned
   * out to that room on that instance — so it passed under the very code whose
   * defect it was supposed to describe.
   *
   * ## The shape, and why each piece is necessary
   *
   * **The writer is on B and the reader is on A**, so the rows reach A through
   * `ledger.sync()` and leave it through `onEntries`. That is the only path that
   * sets r3's `announcedHeads` from an attempt; an instance appending its own
   * rows never took it, which is how the bug survived a suite full of
   * single-instance tests.
   *
   * **Every `event` frame is dropped at the reader's socket.** Not the catch-up
   * frames: the recovery has to be able to happen, or the test measures nothing.
   * The server genuinely broadcasts — `hub.broadcast` runs, `ws.send` succeeds —
   * and the client genuinely does not receive, which is exactly a frame lost on
   * the wire and exactly the case `sync` cannot help with, because A has already
   * folded those rows.
   *
   * **The room goes quiet.** Dropping frames in a *busy* room proves nothing: the
   * next live event arrives across a gap and `applyEntry` asks for it. The
   * permanent loss needs the burst to end, which is why the writes finish before
   * the assertion and nothing writes again.
   *
   * **The reader sends no command.** As everywhere else in this file: a client
   * recovers from what it can detect, and this one can detect nothing.
   *
   * **All six rows are folded by one pass, and the pass is triggered by hand.**
   * This is the difference between a test that fails under r3 and one that
   * happens to. r3 set `announcedHeads` from the fold and then compared it with a
   * *fresh* head read — so a pass that folded rows 1–2 while the writer was
   * already at 4 announced 2, saw 4, and sent a head frame after all. Mid-burst,
   * r3 recovers. The defect is only the defect once the burst has ended, so the
   * two instances share an id (deaf to each other's doorbell, by the origin
   * filter), the timer is set past the life of the test, every write lands, and
   * then exactly one reconciliation runs against a room that is already quiet.
   *
   * Under r3 that pass folds six, fans out six, sets `announcedHeads` to 6, finds
   * the head at 6, and says nothing — for ever, because every later pass finds
   * the same thing. The reader sits at 0 with six durable, folded, broadcast,
   * unreachable rows. Under r4 the same pass reports the head, the reader has
   * acknowledged nothing, and it is told.
   */
  it('converges after an event frame is lost following a fan-out, in a room that goes quiet', async () => {
    const shared = 'deaf-to-its-own-echo';
    const a = await startSecondInstance({ instanceId: shared, reconcileIntervalMs: 600_000 });
    const b = await startSecondInstance({ instanceId: shared });
    teardown.push(a.close, b.close);

    const droppedEvents: number[] = [];
    const reader = productionClient(a.server.url, room.people.bob as string, {
      dropFrame: (frame) => {
        if (frame.type !== 'event') return false;
        droppedEvents.push(frame.entry.roomSeq);
        return true;
      },
    });
    await reader.connect();
    reader.join(room.roomId);
    await until(() => reader.room(room.roomId).subscribed, 15_000, 'the reader to subscribe');

    const writer = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);
    for (let i = 0; i < 6; i += 1) await post(writer, `lost-${i}`);

    // Asserted, not assumed: A has heard nothing yet, so the single pass below
    // really is the whole of the fan-out and the room really is quiet by then.
    expect(a.server.ledger.lastSeq()).toBe(0);
    expect(reader.lastSeq(room.roomId)).toBe(0);

    // One pass. It folds all six and broadcasts all six — and the reader's socket
    // eats every frame.
    await a.server.realtime.reconcile();
    expect(a.server.ledger.lastSeq()).toBeGreaterThanOrEqual(6);
    expect(droppedEvents).toEqual([1, 2, 3, 4, 5, 6]);

    await until(
      () => reader.lastSeq(room.roomId) === 6,
      20_000,
      'the reader to converge on the head frame alone, with every event frame lost',
    );

    // Byte-identical history, not a count. The recovery has to be the same rows
    // in the same order — what a UI renders — and it arrived entirely through
    // catch-up, because no `event` frame ever reached this client.
    const entries = await a.server.ledger.since(room.roomId, 0);
    expect(
      JSON.stringify(
        reader.room(room.roomId).events.map((e) => ({ roomSeq: e.roomSeq, event: e.event })),
      ),
    ).toBe(JSON.stringify(entries.map((e) => ({ roomSeq: e.roomSeq, event: e.event }))));
    // Nothing arrived live: every one of the six was lost and every one was
    // recovered. Catches a version of this test where the drop stopped working.
    expect(droppedEvents).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * The head frame is retired by acknowledgement, and by nothing else.
   *
   * The correction's second half. Repeating the head every pass is what makes the
   * recovery above possible; stopping when — and only when — the client says it
   * holds the position is what keeps that from being a permanent per-room
   * heartbeat. Both halves are asserted here, in that order, because either alone
   * is satisfiable by a wrong implementation: "always send" passes the first,
   * "never send" passes the second.
   *
   * A raw `TestClient` is the right instrument precisely because it does *not*
   * behave like the production client — it acknowledges only when this test tells
   * it to, so the two régimes are separated by one frame rather than by a race.
   *
   * Catches: retiring the head on anything the server did (a broadcast, a
   * previous head frame, a catch-up it answered), and ignoring `ack_head`.
   */
  it('repeats the head until the socket acknowledges it, then stops', async () => {
    const a = await startSecondInstance({ reconcileIntervalMs: 100 });
    teardown.push(a.close);

    const writer = await TestClient.connect(a.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);

    const watcher = await TestClient.connect(a.server.url, room.people.bob as string);
    open.push(watcher);
    await watcher.subscribe(room.roomId);
    for (let i = 0; i < 3; i += 1) await post(writer, `ack-${i}`);

    const heads = () => watcher.frames.filter((f) => f.type === 'head').length;

    // Unacknowledged: told again, and again. This is the safe direction — an old
    // client, or one whose acknowledgement was itself lost, degrades to the
    // unconditional heartbeat rather than to silence.
    await until(() => heads() >= 3, 15_000, 'the head to be repeated to an unanswering socket');

    watcher.send({ type: 'ack_head', roomId: room.roomId, roomSeq: 3 });
    // One in-flight pass may already have been decided, so the count is allowed
    // to move once more before it must settle.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const settled = heads();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(heads()).toBe(settled);

    // And it starts again the moment the room moves past what was acknowledged —
    // otherwise "stops" would mean "stops forever", which is r3 with an extra
    // step.
    await post(writer, 'ack-3');
    await until(() => heads() > settled, 15_000, 'the head to resume once the room moved');
  });
});
