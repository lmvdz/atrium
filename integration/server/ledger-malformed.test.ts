import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import { coreEvents } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedger, isMalformedEntry } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startTestServer,
  TestClient,
  type TestServer,
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

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice']);
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

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
 * Plant a `message_posted` with `body: ""` straight into `core_events`,
 * bypassing the append guard. Returns the payload's event id.
 */
async function plantMalformedRow(): Promise<string> {
  const eventId = randomUUID();
  // Safely after every real row's `occurred_at`: the invariants trigger still
  // enforces canonical order, and nothing is appended after this.
  const at = new Date(Date.now() + 60_000).toISOString();
  const payload = {
    id: eventId,
    at,
    type: 'message_posted',
    roomId: room.roomId,
    messageId: randomUUID(),
    // The violation: RoomEvent's MessagePosted requires a non-empty body.
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
      // Overwritten by the invariants trigger (minted max+1); a placeholder that
      // satisfies the NOT NULL and the positivity CHECK before the trigger runs.
      roomSeq: 1,
      id: eventId,
      type: 'message_posted',
      actorKind: 'human',
      actorId: room.people.alice,
      payload,
      occurredAt: at,
    });
  } finally {
    await handle.db.execute(
      sql`ALTER TABLE "core_events" ENABLE TRIGGER "core_events_append_guard"`,
    );
  }
  return eventId;
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
