import type { DatabaseHandle } from '@atrium/db';
import { coreEvents, memberships } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_ADVISORY_LOCK_KEY } from '../../apps/server/src/ledger.js';
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
  type TestServer,
  until,
} from '../support/harness.js';

/**
 * Durable catch-up — the r1 gauntlet's blocking finding, in three parts.
 *
 * Codex and grok converged on one defect from different directions, and the
 * generalization was codex's: **delivery is process-local while the recovery
 * claim is durable.** Two consequences follow, and each gets its own section
 * here.
 *
 *  1. Within one instance, `more` was computed from page fullness, so a partial
 *     page delivered during concurrent writes said "you are caught up" while
 *     the head had already moved. `more` is now `to < head`, read in one
 *     snapshot, and the invariant is asserted on every frame a client receives
 *     under a live writer.
 *  2. Across instances there was no delivery at all. A client on instance A was
 *     never told that instance B had committed anything — no live frame, no gap
 *     to notice, no reason to ask — so it sat at its cursor indefinitely. That
 *     one needs no race to reproduce, and the test for it fails against r1 by
 *     timing out with the client still at zero.
 *
 * A third section covers the authorization TOCTOU (r1, major 4), which is a
 * different finding but the same shape of mistake: a check made outside the
 * transaction that writes is a check about a moment that has passed.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];
const clients: RealtimeClient[] = [];
const teardown: Array<() => Promise<void>> = [];

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
  for (const close of teardown.splice(0)) await close();
});

afterAll(async () => {
  await handle?.close();
});

function post(client: TestClient, body: string) {
  return client.command({
    name: 'send_message',
    roomId: room.roomId,
    body,
    clientMessageId: body,
    replyToId: null,
    attachments: [],
  });
}

/**
 * How many entries a catch-up page holds in this suite.
 *
 * Deliberately tiny, and the r2 delta gauntlet's major 2 is why:
 *
 * > the integration suite does not pin real multi-page catch-up (12- and
 * > 40-event tests against a 1000-event default page, so the old `more` defect
 * > is pinned only by a fake-socket unit test).
 *
 * That was exactly right. Every fixture in this repo fits in one page at the
 * default, so the loop this ticket's blocking finding was *about* never ran a
 * second turn against a real database — the only thing exercising it was
 * `apps/web/test/realtime.test.ts` handing frames to a fake socket. Five means a
 * twelve-event room takes three pages and a forty-event one takes eight, and the
 * `more`/`to < head` arithmetic is evaluated against real rows every time.
 */
const PAGE = 5;

/** A production client wired to a given server url, with a bounded page. */
function productionClient(
  url: string,
  userId: string,
  options: { onFrame?: (frame: { type?: string }) => void } = {},
): RealtimeClient {
  const client = createRealtimeClient({
    userId,
    url,
    reconnect: { initialDelayMs: 10, maxDelayMs: 40, factor: 1 },
    catchUpPageSize: PAGE,
    socketFactory: nodeSocketFactory({
      onSocket: (socket) => {
        if (!options.onFrame) return;
        socket.on('message', (raw) => {
          options.onFrame?.(JSON.parse(raw.toString()) as { type?: string });
        });
      },
    }),
  });
  clients.push(client);
  return client;
}

describe('`more` is `to < head`, not "was the page full?"', () => {
  it('never reports a client caught up while the head is ahead of it', async () => {
    const writer = await connect(room.people.alice as string);
    const reader = await connect(room.people.bob as string);
    await writer.subscribe(room.roomId);
    await reader.subscribe(room.roomId);

    // A writer that does not stop, and a reader that keeps asking. The pages
    // this produces are exactly the ones r1 got wrong: short, because the limit
    // is generous, while the head keeps moving.
    let writing = true;
    const written = (async () => {
      for (let i = 0; writing; i += 1) {
        const ack = await post(writer, `m${i}`);
        expect(ack.type).toBe('ack');
      }
    })();

    for (let round = 0; round < 60; round += 1) {
      // A cursor that moves, so each reply is matched to its own request; and
      // one that stays behind the writer, so the pages are the short-but-not-
      // caught-up ones r1 mislabelled.
      const cursor = Math.floor(round / 4);
      const page = await reader.since(room.roomId, cursor);
      // The invariant, on every frame. It is exact rather than nearly always
      // right because both numbers come from one snapshot — which is the other
      // half of the fix: two consecutive reads describe two different moments,
      // and a claim relating them is a claim about a state that never existed.
      expect(page.more).toBe(page.to < page.head);
      expect(page.to).toBeGreaterThanOrEqual(cursor);
    }

    writing = false;
    await written;
  });

  it('says there is more when a page is truncated, and stops when it is not', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    for (let i = 0; i < 5; i += 1) await post(alice, `m${i}`);

    const truncated = await alice.since(room.roomId, 0, 2);
    expect(truncated).toMatchObject({ to: 2, head: 5, more: true });

    const complete = await alice.since(room.roomId, 3);
    expect(complete).toMatchObject({ to: 5, head: 5, more: false });
  });

  /**
   * Multi-page catch-up, against a real database, actually crossing pages
   * (#22 gauntlet r2 delta, major 2).
   *
   * The previous version of this test posted twelve events and let the client
   * ask with the server's 1000-entry default: one page, one frame, loop never
   * turned. It asserted the right end state for the wrong reason. With `PAGE`
   * bound to five, twelve events is three pages, and the assertions below are
   * about the *pages* as well as the result — because "it got there" is exactly
   * what r1's defective client also did whenever the burst happened to fit.
   */
  it('drives the production client’s loop to the head across several real pages', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    for (let i = 0; i < 12; i += 1) await post(alice, `m${i}`);

    const catchups: Array<{ to?: number; head?: number; more?: boolean; entries?: unknown[] }> = [];
    const bob = productionClient(server.url, room.people.bob as string, {
      onFrame: (frame) => {
        if (frame.type === 'catchup') catchups.push(frame as (typeof catchups)[number]);
      },
    });
    await bob.connect();
    bob.join(room.roomId);
    await until(() => bob.lastSeq(room.roomId) === 12, 15_000, 'the client to reach the head');
    expect(bob.room(room.roomId).events.map((e) => e.roomSeq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );

    // Three pages: 5 + 5 + 2. Catches: dropping `limit` from the client's
    // `since` frame, or restoring the 1000-entry default here — either collapses
    // this to a single page and the loop under test stops running at all.
    expect(catchups.length).toBeGreaterThanOrEqual(3);
    expect(catchups.slice(0, 2).map((page) => page.entries?.length)).toEqual([PAGE, PAGE]);

    // And every page's `more` was `to < head` — the r1 blocking finding, now
    // evaluated against a real truncated page rather than a fake socket's frame.
    // Catches: reverting `more` to page fullness, which reports `true` on the
    // final short page and `false` on a full one that happens to end at the head.
    for (const page of catchups) {
      expect(page.more).toBe((page.to ?? 0) < (page.head ?? 0));
    }
    expect(catchups.filter((page) => page.more === true).length).toBeGreaterThanOrEqual(2);
    expect(catchups.at(-1)?.more).toBe(false);
  });
});

/**
 * Two instances, one database — the arrangement r1 had no answer for.
 *
 * Each has its own connection pool, its own in-memory `CoreState`, its own hub
 * and its own listener, which is the only way the question means anything. The
 * fan-out is Postgres `LISTEN`/`NOTIFY`; init.md forbids Redis and none is
 * needed, because a notification is a doorbell and the rows come from the
 * ledger.
 *
 * **Against r1 this section does not race — it simply never delivers.** The
 * client stays at `lastSeq = 0` until the timeout, because nothing on instance
 * A has any reason to believe the room has moved.
 */
describe('cross-instance fan-out', () => {
  it('delivers a second instance’s commits to the first instance’s subscribers', async () => {
    // Two real instances, each with its own pool, state, hub and listener. The
    // single-instance `server` from `beforeEach` carries no bus and nobody
    // connects to it here.
    const a = await startSecondInstance();
    const b = await startSecondInstance();
    teardown.push(a.close, b.close);

    // The reader is on A. Every writer is on B.
    const reader = productionClient(a.server.url, room.people.bob as string);
    await reader.connect();
    reader.join(room.roomId);
    await until(() => reader.room(room.roomId).subscribed, 15_000, 'the reader to subscribe');

    const writer = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(writer);
    await writer.subscribe(room.roomId);
    for (let i = 0; i < 10; i += 1) {
      const ack = await writer.command({
        name: 'send_message',
        roomId: room.roomId,
        body: `from-b-${i}`,
        clientMessageId: `from-b-${i}`,
        replyToId: null,
        attachments: [],
      });
      expect(ack.type).toBe('ack');
    }

    await until(
      () => reader.lastSeq(room.roomId) === 10,
      15_000,
      'instance A’s subscriber to receive instance B’s commits',
    );
    const entries = await a.server.ledger.since(room.roomId, 0);
    expect(
      JSON.stringify(
        reader.room(room.roomId).events.map((e) => ({ roomSeq: e.roomSeq, event: e.event })),
      ),
    ).toBe(JSON.stringify(entries.map((e) => ({ roomSeq: e.roomSeq, event: e.event }))));

    // And instance A folded them into its own core state, rather than merely
    // passing frames along: a relay that did not fold would answer `head`
    // correctly and `coreState()` wrongly.
    expect(a.server.ledger.lastSeq()).toBe(b.server.ledger.lastSeq());
    expect(a.server.ledger.serialize()).toBe(b.server.ledger.serialize());
  });

  it('relays presence, which has no ledger to be recovered from', async () => {
    // Two real instances, each with its own pool, state, hub and listener. The
    // single-instance `server` from `beforeEach` carries no bus and nobody
    // connects to it here.
    const a = await startSecondInstance();
    const b = await startSecondInstance();
    teardown.push(a.close, b.close);

    const watcher = await TestClient.connect(a.server.url, room.people.bob as string);
    open.push(watcher);
    await watcher.subscribe(room.roomId);

    const mover = await TestClient.connect(b.server.url, room.people.alice as string);
    open.push(mover);
    await mover.subscribe(room.roomId);
    await mover.command({ name: 'set_presence', roomId: room.roomId, state: 'online' });

    await until(
      () => watcher.frames.some((f) => f.type === 'presence' && f.userId === mover.userId),
      15_000,
      'presence to cross instances',
    );
    // Still never a ledger row (#14). Relayed as a frame precisely *because*
    // there is nothing durable to read it back from — the relay is not a
    // licence to start writing presence down.
    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coreEvents);
    expect(Number(count)).toBe(0);
    expect(await a.server.ledger.head(room.roomId)).toBe(0);
  });

  /**
   * The r6 gauntlet's blocking finding, executed (#22 gauntlet r6, major 1).
   *
   * `NOTIFY` requires **no privilege** in Postgres. Anything that can open a
   * connection can put a string on `atrium_ephemeral`, and until r7 the receiving
   * side cast it (`JSON.parse(raw) as T`) and `ws-server.ts` handed the result to
   * `hub.broadcast(note.roomId, note.frame as ServerFrame)` — no schema, no
   * membership check, no room-ownership check. The critic's probe:
   *
   * > a subscribed client received a forged `event` frame while
   * > `SELECT count(*) FROM core_events` was **0**
   *
   * and the damage is durable rather than cosmetic, because `applyEntry` commits
   * the entry to the client's journal and advances `lastSeq` — so the **real**
   * event at that `roomSeq` is thereafter permanently skipped
   * (`if (entry.roomSeq <= room.lastSeq) return`). Ledger/client divergence
   * without touching `core_events` at all.
   *
   * What the test asserts, in order: the forged event never reaches the socket;
   * the client's cursor does not move; and the room still works afterwards, so
   * the refusal is a refusal and not a wedged listener. Then the real event at
   * that very position arrives and *is* applied — which is the half that shows
   * the r6 exploit's actual consequence is gone rather than merely its frame.
   *
   * Two forgeries, because they fail for different reasons and a test for one is
   * not a test for the other: a durable `event` frame, which the ephemeral
   * channel's alphabet has no spelling for; and a well-formed `presence` frame
   * whose envelope names a different room than its body, which is the fan-out
   * key and the frame contents disagreeing.
   */
  it('drops a forged frame published on the ephemeral channel by anyone at all', async () => {
    const a = await startSecondInstance();
    teardown.push(a.close);

    const watcher = await TestClient.connect(a.server.url, room.people.bob as string);
    open.push(watcher);
    await watcher.subscribe(room.roomId);
    const other = await seedRoom(handle, ['dave'], { slug: 'forgery-target' });

    // Published straight onto the channel, with no application involved and no
    // privilege beyond a connection — which is the finding.
    const forgedEvent = {
      origin: 'attacker',
      roomId: room.roomId,
      frame: {
        type: 'event',
        entry: {
          roomId: room.roomId,
          roomSeq: 1,
          seq: 1,
          actor: { kind: 'human', userId: room.people.alice as string },
          event: {
            id: '00000000-0000-4000-8000-000000000001',
            at: '2026-08-01T00:00:00.000Z',
            type: 'message_posted',
            roomId: room.roomId,
            messageId: '00000000-0000-4000-8000-000000000002',
            body: 'this message is not in the ledger',
            replyToId: null,
            clientMessageId: null,
            attachments: [],
          },
        },
      },
    };
    const forgedPresence = {
      origin: 'attacker',
      roomId: room.roomId,
      frame: {
        type: 'presence',
        roomId: other.roomId,
        userId: other.people.dave as string,
        state: 'online',
        at: '2026-08-01T00:00:00.000Z',
      },
    };
    for (const forgery of [forgedEvent, forgedPresence]) {
      await handle.db.execute(
        sql`SELECT pg_notify('atrium_ephemeral', ${JSON.stringify(forgery)}::text)`,
      );
    }

    // Nothing to wait *for*, so wait for something that would arrive after it:
    // a real presence relay on the same channel, from the same instance, sent
    // after both forgeries. If the forgeries were going to be delivered they
    // would have been delivered first — NOTIFY is ordered per connection.
    const mover = await TestClient.connect(a.server.url, room.people.alice as string);
    open.push(mover);
    await mover.subscribe(room.roomId);
    await mover.command({ name: 'set_presence', roomId: room.roomId, state: 'online' });
    await until(
      () => watcher.frames.some((f) => f.type === 'presence' && f.userId === mover.userId),
      15_000,
      'a real presence frame to arrive behind the forgeries',
    );

    expect(watcher.frames.filter((f) => f.type === 'event')).toEqual([]);
    expect(
      watcher.frames.some((f) => f.type === 'presence' && f.userId === other.people.dave),
    ).toBe(false);
    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coreEvents);
    expect(Number(count)).toBe(0);

    // And the position the forgery claimed is still available to the real event,
    // which is the whole of the durable half of the finding.
    const ack = await post(mover, 'the real first message');
    expect(ack.type).toBe('ack');
    await until(
      () => watcher.frames.some((f) => f.type === 'event'),
      15_000,
      'the real event at roomSeq 1 to arrive',
    );
    const delivered = watcher.frames.filter((f) => f.type === 'event');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      entry: { roomSeq: 1, event: { body: 'the real first message' } },
    });
  });
});

/**
 * r1, major 4. Round 1 checked membership before opening the append
 * transaction, so a membership revoked in between was still good enough to
 * write durable history with.
 *
 * The window is made deterministic rather than raced for: the test holds the
 * ledger's advisory lock on a connection of its own, which parks the server's
 * append transaction *after* its outer membership check and *before* anything
 * is minted. The membership is then revoked and committed, and the lock
 * released. Under r1 the append proceeds on the strength of the check it
 * already passed; here it re-reads inside its own transaction and refuses.
 */
describe('authorization is inside the append transaction', () => {
  it('refuses an append whose membership was revoked while it waited for the lock', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    await post(alice, 'before');

    // A second connection, holding the ledger lock open across a transaction we
    // control. `reserve()` pins one connection, so the BEGIN, the lock and the
    // COMMIT are certainly the same backend — an advisory *xact* lock taken on
    // a pooled connection and released on another would prove nothing.
    const blocker = await handle.sql.reserve();
    await blocker.unsafe('BEGIN');
    await blocker.unsafe(`SELECT pg_advisory_xact_lock(${LEDGER_ADVISORY_LOCK_KEY}::bigint)`);

    // The append is now guaranteed to park: it passes the outer membership
    // check, opens its transaction, and waits on a lock this test holds.
    const parked = post(alice, 'during');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Revoked, committed, while the append is parked on the lock.
    await handle.db
      .delete(memberships)
      .where(
        and(
          eq(memberships.roomId, room.roomId),
          eq(memberships.userId, room.people.alice as string),
        ),
      );

    await blocker.unsafe('COMMIT');
    await blocker.release();

    const answer = await parked;
    expect(answer.type).toBe('nack');
    expect(answer).toMatchObject({ code: 'not_a_member' });

    // And nothing was written: the refusal took the transaction with it.
    const entries = await server.ledger.since(room.roomId, 0);
    expect(entries.map((entry) => entry.roomSeq)).toEqual([1]);
  });

  it('fails loudly when advance_seen matches no row', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    await post(alice, 'one');

    // The cursor moves while the membership exists...
    const ok = await alice.command({ name: 'advance_seen', roomId: room.roomId, roomSeq: 1 });
    expect(ok.type).toBe('ack');

    await handle.db
      .delete(memberships)
      .where(
        and(
          eq(memberships.roomId, room.roomId),
          eq(memberships.userId, room.people.alice as string),
        ),
      );

    // ...and afterwards it is refused rather than reported as having moved.
    // Round 1 fell back to the stale membership row it had read at the top of
    // the command and answered `seen`, which tells a client its cursor advanced
    // when the database says otherwise (r1, major 5).
    const refused = await alice.command({
      name: 'advance_seen',
      roomId: room.roomId,
      roomSeq: 1,
    });
    expect(refused.type).toBe('nack');
  });

  it('refuses a read cursor past the room’s head', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    await post(alice, 'one');

    const refused = await alice.command({
      name: 'advance_seen',
      roomId: room.roomId,
      roomSeq: 9,
    });
    expect(refused.type).toBe('nack');
    expect(refused).toMatchObject({ code: 'invalid' });

    const [row] = await handle.db
      .select({ seenSeq: memberships.seenSeq })
      .from(memberships)
      .where(
        and(
          eq(memberships.roomId, room.roomId),
          eq(memberships.userId, room.people.alice as string),
        ),
      );
    expect(Number(row?.seenSeq)).toBe(0);
  });
});
