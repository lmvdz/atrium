import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import { coreEvents } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedger, isMalformedEntry } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
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
 * #46 — a malformed payload does not brick a room's hydration.
 *
 * This is the acceptance criterion, against a real Postgres. The write path
 * validates the CHECKs and nothing else — SQL runs no zod — so a
 * `message_posted` with `body: ""` (a `z.string().min(1)` violation) can land
 * durably through a bad migration, a manual fix, or a future non-participant
 * writer. The test plants exactly such a row **directly in `core_events`**,
 * bypassing the append boundary the way one gets there in reality, then asserts
 * both read doors — `hydrate` and `since(room, 0, 50)` — complete and *report*
 * the row rather than throwing on it forever.
 *
 * ## How the row is planted
 *
 * `core_events_append_guard` refuses an INSERT that did not come through
 * `atrium_append_core_event`; disabling it for one statement is the "operator
 * with the triggers off" case the schema names as the one writer every other
 * guarantee still has to survive. The `core_events_invariants` trigger stays on,
 * so the planted row still gets a real, contiguous `room_seq` and passes every
 * structural CHECK — it is a *well-formed row with an unreadable payload*,
 * which is the whole point.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];
const clients: RealtimeClient[] = [];

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice']);
  server = await startTestServer(handle);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

/** The production client (`apps/web/src/lib/realtime.ts`) wired over a real socket. */
function productionClient(userId: string): RealtimeClient {
  const client = createRealtimeClient({
    userId,
    url: server.url,
    reconnect: { initialDelayMs: 10, maxDelayMs: 40, factor: 1 },
    socketFactory: nodeSocketFactory({ userId }),
  });
  clients.push(client);
  return client;
}

/**
 * Plant one `message_posted` straight into `core_events`, bypassing the append
 * guard, at `occurredAt`. An empty `body` is the malformed case (a
 * `z.string().min(1)` violation SQL does not run); a non-empty one is an
 * ordinary readable row. The `core_events_invariants` trigger stays on, so the
 * row still gets a real, contiguous `room_seq` minted in insertion order.
 */
async function plantRow(body: string, occurredAt: string): Promise<string> {
  const eventId = randomUUID();
  const payload = {
    id: eventId,
    at: occurredAt,
    type: 'message_posted',
    roomId: room.roomId,
    messageId: randomUUID(),
    body,
    replyToId: null,
    clientMessageId: null,
    causeMessageId: null,
    attachments: [],
    references: [],
  };
  await handle.db.execute(
    sql`ALTER TABLE "core_events" DISABLE TRIGGER "core_events_append_guard"`,
  );
  try {
    await handle.db.insert(coreEvents).values({
      roomId: room.roomId,
      roomSeq: 1,
      id: eventId,
      type: 'message_posted',
      actorKind: 'human',
      actorId: room.people.alice,
      payload,
      occurredAt,
    });
  } finally {
    await handle.db.execute(
      sql`ALTER TABLE "core_events" ENABLE TRIGGER "core_events_append_guard"`,
    );
  }
  return eventId;
}

afterAll(async () => {
  await handle?.close();
});

async function connect(userId: string): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId);
  open.push(client);
  return client;
}

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
 * Plant a `message_posted` with `body: ""` (the malformed case) straight into
 * `core_events`, bypassing the append guard, safely *after* every real row's
 * `occurred_at`. Returns the payload's event id.
 */
function plantMalformedRow(): Promise<string> {
  // Future-dated on purpose: the invariants trigger still enforces canonical
  // order, and this is the fixture BLOCKER 2 needs — a bad row ahead of the
  // clock that the next append must be able to order after.
  return plantRow('', new Date(Date.now() + 60_000).toISOString());
}

describe('#46 a malformed row is survivable at read', () => {
  it('hydrate and since complete and report the bad row, folding every other event', async () => {
    const alice = await connect(room.people.alice as string);
    await post(alice, 'one');
    await post(alice, 'two');
    await post(alice, 'three');

    const badEventId = await plantMalformedRow();

    // The planted row exists and carries the empty body — proof it landed durably.
    const [planted] = await handle.db
      .select({ roomSeq: coreEvents.roomSeq, payload: coreEvents.payload })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.id, badEventId)));
    if (!planted) throw new Error('the planted malformed row was not found in core_events');
    expect((planted.payload as { body: string }).body).toBe('');
    const badRoomSeq = planted.roomSeq;

    // ── Door 1: hydrate. A fresh ledger folds the whole log from scratch — the
    // exact path that used to throw on the bad row and take the process down.
    const fresh = createLedger({ db: handle.db, logger: createLogger('error') });
    await expect(fresh.hydrate()).resolves.toBeUndefined();
    expect(fresh.malformedCount()).toBe(1);
    // Every readable event was still folded; only the malformed one was skipped.
    expect(fresh.lastSeq()).toBeGreaterThanOrEqual(4);

    // ── Door 2: since. The catch-up door every reconnecting client walks. It
    // resolves rather than rejecting, and it names the malformed row.
    const page = await server.ledger.since(room.roomId, 0, 50);
    const folded = page.filter((entry) => entry.kind === 'event');
    const malformed = page.filter(isMalformedEntry);

    expect(folded.map((entry) => (entry.kind === 'event' ? entry.event.type : null))).toEqual([
      'message_posted',
      'message_posted',
      'message_posted',
    ]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.roomSeq).toBe(badRoomSeq);
    expect(malformed[0]?.reason).toMatch(/body/);

    // The read door reported it, rather than the room going dark.
    expect(server.ledger.malformedCount()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * #46, BLOCKER 1 — the production client walks its cursor past a malformed row,
 * driven over a real socket rather than by calling the ledger directly.
 *
 * This is the test round 1 did not have: it asked the *ledger* whether it
 * survived a bad row, and it did, but the wire filtered the malformed marker off
 * the catch-up page — so the client got a page with a hole at that `room_seq`,
 * `applyEntry` accepted only `lastSeq + 1`, and it re-requested the gap forever.
 * The server outage moved to the client. Here the real client is asked, at each
 * of the three positions the gauntlet named: the malformed row at the HEAD, the
 * MIDDLE, and the TAIL of the page. In every case the client must reach the head
 * and hold every valid row, without the malformed one appearing in the timeline.
 *
 * Rows are planted directly so their `room_seq` order is exact; a `productionClient`
 * then joins and catches up. Under the round-1 wire this `until` times out with
 * the client stalled short of the head.
 */
describe('#46 the production client survives a malformed row on catch-up', () => {
  const base = Date.now() - 60_000;
  const at = (i: number) => new Date(base + i * 1000).toISOString();

  async function expectClientCatchesUp(expectedEvents: number[]): Promise<void> {
    const alice = productionClient(room.people.alice as string);
    await alice.connect();
    alice.join(room.roomId);
    await until(
      () => alice.lastSeq(room.roomId) === 3,
      15_000,
      'the production client to catch up past the malformed row',
    );
    // Reached the head (3), and the timeline holds exactly the valid rows — the
    // tombstone advanced the cursor but rendered nothing.
    expect(alice.room(room.roomId).events.map((e) => e.roomSeq)).toEqual(expectedEvents);
    expect(alice.room(room.roomId).events.every((e) => e.event.type === 'message_posted')).toBe(
      true,
    );
  }

  it('catches up past a malformed row at the HEAD of the page', async () => {
    await plantRow('', at(1)); // room_seq 1 — malformed
    await plantRow('two', at(2)); // room_seq 2
    await plantRow('three', at(3)); // room_seq 3
    await expectClientCatchesUp([2, 3]);
  });

  it('catches up past a malformed row in the MIDDLE of the page', async () => {
    await plantRow('one', at(1));
    await plantRow('', at(2)); // room_seq 2 — malformed
    await plantRow('three', at(3));
    await expectClientCatchesUp([1, 3]);
  });

  it('catches up past a malformed row at the TAIL of the page', async () => {
    await plantRow('one', at(1));
    await plantRow('two', at(2));
    await plantRow('', at(3)); // room_seq 3 — malformed
    await expectClientCatchesUp([1, 2]);
  });
});

/**
 * #46, BLOCKER 2 — an append immediately after a future-dated malformed row
 * succeeds.
 *
 * `catchUp` used to advance `lastSeq` past a malformed row but not `lastAtMs`
 * (the branch `continue`d before the watermark update, and the row select never
 * read `occurred_at`). So the next append minted `at = max(now, lastAtMs + 1)`,
 * which for a row future-dated an hour out is *behind* it — and Postgres's
 * canonical-order gate refuses it until wall-clock passes the bad row. A
 * far-future row makes that permanent: "process down" traded for "ledger nobody
 * can write to". The fix reads `occurred_at` for every physical row and advances
 * the watermark past the malformed one, so the mint clears it.
 *
 * Against the bug this test fails on the very next append: a `nack`, not an `ack`.
 */
describe('#46 an append after a future-dated malformed row is not bricked', () => {
  it('mints an ordering position past the bad row and the append is accepted', async () => {
    const alice = await connect(room.people.alice as string);
    await post(alice, 'before the bad row');

    // A malformed row dated a full minute into the future.
    await plantMalformedRow();

    // The server folds the planted row (advancing the watermark past it) the way
    // it folds any row it did not append — on its reconciliation read.
    await server.ledger.sync();

    // The append the bug bricks. `max(now, lastAtMs + 1)` now clears the
    // future-dated row's `occurred_at`, so the canonical-order gate accepts it.
    const ack = await post(alice, 'after the bad row');
    expect(ack.type).toBe('ack');

    // And it really landed: a fresh hydrate folds it, past the malformed row.
    const fresh = createLedger({ db: handle.db, logger: createLogger('error') });
    await expect(fresh.hydrate()).resolves.toBeUndefined();
    expect(fresh.malformedCount()).toBe(1);
    const page = await server.ledger.since(room.roomId, 0, 50);
    const bodies = page
      .filter((entry) => entry.kind === 'event')
      .map((entry) => (entry.kind === 'event' ? entry.event : null))
      .map((event) => (event && 'body' in event ? (event as { body: string }).body : null));
    expect(bodies).toContain('after the bad row');
  });
});

/**
 * #46 round 3 (Minor) — the mint CLAMP keeps the server from rejecting its own
 * mint when the watermark reaches the maximum legal `at`.
 *
 * The mint watermark `lastAtMs` advances past every physical row, malformed
 * included (BLOCKER 2). A malformed row can carry a canonical `occurred_at` right
 * at the bound `Timestamp` admits — `9999-12-31T23:59:59.999Z` — so the next mint
 * of `max(now, lastAtMs + 1)` would be `+010000-01-01T…`, an expanded-year form the
 * `RoomEvent` append guard refuses: the server rejecting its OWN mint, on every
 * append, globally (the watermark and the DB order gate are both process- and
 * table-wide). The clamp keeps the mint a legal `Timestamp`, and THAT is what this
 * test pins: the append is not refused by the server's own guard.
 *
 * ## What this test does NOT prove — and must not be read as proving (#46 r4)
 *
 * The malformed row here is planted with the MINIMAL event id (`MIN_ID`), and that
 * choice is load-bearing to what the assertion can honestly claim. With a minimal
 * id, the freshly minted random uuid sorts strictly after the bad row on the
 * `(at, id)` plateau, so the DB's canonical-order gate accepts on the tie-break and
 * the append lands. This exercises the ordinary future-timestamp / clamp case only.
 *
 * It does NOT show that a malformed row at the MAXIMAL `(at, id)` cursor is
 * writable — the opposite is true: a row at `MAX_AT` with a maximal `id` clamps
 * every later mint to `MAX_AT` and then WINS the `(at, id)` tie-break, so the gate
 * refuses every subsequent append globally and permanently. The clamp cannot solve
 * that; it is the append canonical-order boundary tracked in **#171**, not #46's
 * read path. `MIN_ID` is deliberately the case the clamp DOES cover, not a stand-in
 * for the maximal one. Against the clamp bug this test fails on the mint: a `nack`
 * naming the `RoomEvent` guard, not an `ack`.
 */
describe('#46 the mint clamp keeps a max-timestamp row from bricking the server’s own mint', () => {
  const MAX_AT = '9999-12-31T23:59:59.999Z';
  // Deliberately MINIMAL, not maximal: this pins the clamp/ordinary-future case.
  // A maximal id here would brick appends forever — that boundary is #171.
  const MIN_ID = '00000000-0000-4000-8000-000000000000';

  async function plantMalformedAtMax(): Promise<void> {
    const payload = {
      id: MIN_ID,
      at: MAX_AT,
      type: 'message_posted',
      roomId: room.roomId,
      messageId: randomUUID(),
      body: '',
      replyToId: null,
      clientMessageId: null,
      causeMessageId: null,
      attachments: [],
      references: [],
    };
    await handle.db.execute(
      sql`ALTER TABLE "core_events" DISABLE TRIGGER "core_events_append_guard"`,
    );
    try {
      await handle.db.insert(coreEvents).values({
        roomId: room.roomId,
        roomSeq: 1,
        id: MIN_ID,
        type: 'message_posted',
        actorKind: 'human',
        actorId: room.people.alice,
        payload,
        occurredAt: MAX_AT,
      });
    } finally {
      await handle.db.execute(
        sql`ALTER TABLE "core_events" ENABLE TRIGGER "core_events_append_guard"`,
      );
    }
  }

  it('mints a legal timestamp and the append is accepted rather than rejecting its own mint', async () => {
    const alice = await connect(room.people.alice as string);
    await post(alice, 'before the max-dated bad row');

    // A malformed row at the very last instant a Timestamp can spell.
    await plantMalformedAtMax();
    // Fold it, advancing the global mint watermark to the maximum.
    await server.ledger.sync();

    // The append the bug bricks: unclamped, `lastAtMs + 1` mints `+010000-…`, which
    // the server's own `RoomEvent` guard refuses. Clamped, the mint stays `MAX_AT`
    // and wins the `(at, id)` tie-break over the minimal-id bad row.
    const ack = await post(alice, 'after the max-dated bad row');
    expect(ack.type).toBe('ack');

    // It really landed, past the malformed row, with a legal `at`.
    const fresh = createLedger({ db: handle.db, logger: createLogger('error') });
    await expect(fresh.hydrate()).resolves.toBeUndefined();
    expect(fresh.malformedCount()).toBe(1);
    const page = await server.ledger.since(room.roomId, 0, 50);
    const bodies = page
      .filter((entry) => entry.kind === 'event')
      .map((entry) => (entry.kind === 'event' ? entry.event : null))
      .map((event) => (event && 'body' in event ? (event as { body: string }).body : null));
    expect(bodies).toContain('after the max-dated bad row');
  });
});

/**
 * grok's `trusted_messages` nuance, adjudicated end-to-end: a bad receipt window
 * on an event kind that never consults it does not discard the payload's fold.
 * The reducer reads the window for exactly one kind (`object_accepted`), so a
 * `message_posted` with an unreadable window folds and renders, with the window
 * dropped and reported — rather than losing a good message.
 *
 * ## Why the constraint has to be dropped to reach this
 *
 * A committed window is not just trigger-guarded, it is CHECK-guarded:
 * `core_events_trusted_messages_shape` requires an array whose every element has
 * `id`/`authorId`/`body` as strings — the *same shape* the read-side
 * `TrustedWindow` schema demands. So a bad window is genuinely unreachable on a
 * committed row unless the CHECK itself is bypassed (a pre-0005 row, a disabled
 * constraint, a restore with `--disable-triggers`). That is the operator vector
 * this whole ticket is about, and the finding worth recording: unlike the
 * payload, the window IS shape-constrained by SQL, so the read-side handling is
 * defense-in-depth for the residual rather than the primary guard. The test
 * reaches the residual the only way it exists — by dropping the CHECK for the
 * corrupt write, then restoring it once the window is put back.
 */
describe('#46 a bad trusted_messages window does not discard a non-acceptance fold', () => {
  it('folds and serves a message whose window is unreadable', async () => {
    const alice = await connect(room.people.alice as string);
    await post(alice, 'plain message');

    // Reach the residual: the shape CHECK is dropped and `core_events_no_update`
    // disabled for the corrupt write, then the window is restored to NULL and the
    // CHECK re-added (which re-validates cleanly against the restored row). This
    // leaves the schema exactly as it found it for every later suite.
    await handle.db.execute(
      sql`ALTER TABLE "core_events" DROP CONSTRAINT "core_events_trusted_messages_shape"`,
    );
    await handle.db.execute(sql`ALTER TABLE "core_events" DISABLE TRIGGER "core_events_no_update"`);
    try {
      await handle.db.execute(
        sql`UPDATE "core_events" SET "trusted_messages" = '[{"nope": 1}]'::jsonb WHERE "room_id" = ${room.roomId}`,
      );

      // The message is not lost: a fresh hydrate folds it (not malformed), and
      // `since` serves it as an ordinary event.
      const fresh = createLedger({ db: handle.db, logger: createLogger('error') });
      await expect(fresh.hydrate()).resolves.toBeUndefined();
      expect(fresh.malformedCount()).toBe(0);

      const page = await server.ledger.since(room.roomId, 0, 50);
      expect(page.filter(isMalformedEntry)).toHaveLength(0);
      const folded = page.filter((entry) => entry.kind === 'event');
      expect(folded).toHaveLength(1);
    } finally {
      // Put the window back to a CHECK-valid value, then restore the schema.
      await handle.db.execute(
        sql`UPDATE "core_events" SET "trusted_messages" = NULL WHERE "room_id" = ${room.roomId}`,
      );
      await handle.db.execute(
        sql`ALTER TABLE "core_events" ENABLE TRIGGER "core_events_no_update"`,
      );
      await handle.db.execute(
        sql`ALTER TABLE "core_events" ADD CONSTRAINT "core_events_trusted_messages_shape" CHECK ("core_events"."trusted_messages" IS NULL OR (
          jsonb_typeof("core_events"."trusted_messages") = 'array'
          AND jsonb_array_length("core_events"."trusted_messages") = jsonb_array_length(jsonb_path_query_array("core_events"."trusted_messages", '$[*] ? (@.id.type() == "string" && @.authorId.type() == "string" && @.body.type() == "string")'))
        ))`,
      );
    }
  });
});
