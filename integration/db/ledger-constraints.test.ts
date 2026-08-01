import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  messages,
  proposals,
} from '@atrium/db/schema';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_ADVISORY_LOCK_KEY } from '../../apps/server/src/ledger.js';
import { violatesConstraint } from '../support/constraints.js';
import { openDatabase, resetDatabase, seedRoom, until } from '../support/harness.js';

/**
 * The ledger's constraints, against a real Postgres with the real migrations
 * applied.
 *
 * #19's gauntlet routed this specifically: constraint tests that grep the
 * generated SQL prove that a string contains a word. They cannot tell you that
 * the migration applied, that the constraint is enabled, that a composite
 * foreign key matches the way SQL says it does with a NULL in it, or that
 * `UNIQUE(room_id, room_seq)` actually stops a second writer. Every refusal
 * below is Postgres's, and every assertion names the constraint that did it —
 * see `violatesConstraint` for why the name rather than the message.
 */

let handle: DatabaseHandle;
let roomA: string;
let roomB: string;

beforeEach(async () => {
  handle ??= openDatabase(5);
  await resetDatabase(handle);
  roomA = (await seedRoom(handle, ['alice'], { slug: 'room-a' })).roomId;
  roomB = (await seedRoom(handle, ['bob'], { slug: 'room-b' })).roomId;
});

afterAll(async () => {
  await handle?.close();
});

/**
 * A monotonic clock for the fixtures.
 *
 * Not decoration. r3's append function refuses any row that does not sort
 * strictly after the ledger's own maximum in canonical `(at, id)` order — the
 * reducer's `out_of_order` refusal, moved into the boundary — so two fixtures
 * minted inside the same millisecond would tie on `at` and be arbitrated by two
 * random uuids, which loses about half the time. The server solves this the same
 * way (`nextTimestamp`, `max(now, last + 1ms)`); the tests must not solve it a
 * different way, or they would be exercising a clock production does not have.
 */
let clock = Date.parse('2026-08-01T00:00:00.000Z');
function nextAt(): string {
  clock += 1;
  return new Date(clock).toISOString();
}

/**
 * One event, as the append procedure takes it.
 *
 * Note what is *not* here. `room_seq` is minted inside
 * `atrium_append_core_event` under the ledger lock and cannot be supplied by a
 * caller — the r2 change these tests exist to hold. And the payload has no
 * `actor`: #21 took it out of the event entirely, so it arrives as its own two
 * arguments and lands in its own two columns. Everything else a bypassing writer
 * might have got wrong is still expressible, so the checks below are reachable
 * through the only path that exists.
 */
function ledgerRow(
  roomId: string,
  overrides: {
    id?: string;
    at?: string;
    occurredAt?: string;
    actorKind?: string;
    actorId?: string | null;
    payloadActor?: unknown;
  } = {},
) {
  const id = overrides.id ?? randomUUID();
  const at = overrides.at ?? nextAt();
  const payload: Record<string, unknown> = {
    id,
    at,
    type: 'message_posted',
    roomId,
    messageId: randomUUID(),
    body: 'hello',
    replyToId: null,
    clientMessageId: null,
    attachments: [],
  };
  if (overrides.payloadActor !== undefined) payload.actor = overrides.payloadActor;
  return {
    roomId,
    id,
    type: 'message_posted',
    actorKind: overrides.actorKind ?? 'system',
    actorId: overrides.actorId ?? null,
    payload,
    occurredAt: overrides.occurredAt ?? at,
  };
}

type LedgerRow = ReturnType<typeof ledgerRow>;

/**
 * Append the way production appends: through the procedure, with the advisory
 * lock, on a real transaction.
 *
 * There is no test-only insert path and there must never be one — a suite that
 * writes to `core_events` through a door the server does not use proves things
 * about a door nobody walks through. Round 1's tests inserted directly, which
 * is exactly the bypass the r1 gauntlet flagged as *possible*; that they could
 * do it was the demonstration.
 */
async function append(row: LedgerRow, origin: string | null = null) {
  return handle.db.transaction(async (tx) => {
    const result = await tx.execute<{ seq: string; room_seq: string }>(sql`
      SELECT "seq", "room_seq" FROM atrium_append_core_event(
        ${row.roomId}::uuid,
        ${row.id}::text,
        ${row.type}::event_type,
        ${row.actorKind}::actor_kind,
        ${row.actorId}::text,
        ${JSON.stringify(row.payload)}::jsonb,
        ${row.occurredAt}::timestamptz,
        ${origin}::text
      )
    `);
    const minted = result[0];
    return { seq: Number(minted?.seq), roomSeq: Number(minted?.room_seq) };
  });
}

describe('core_events — the append invariant, enforced by Postgres', () => {
  it('assigns a global seq and a per-room room_seq independently', async () => {
    await append(ledgerRow(roomA));
    await append(ledgerRow(roomB));
    await append(ledgerRow(roomA));

    const rows = await handle.db
      .select({ seq: coreEvents.seq, roomSeq: coreEvents.roomSeq, roomId: coreEvents.roomId })
      .from(coreEvents)
      .orderBy(coreEvents.seq);

    // The global order is total across rooms — the #19 r3 consequence, made
    // concrete: room B's first event sits between room A's first and second.
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(rows.map((r) => Number(r.roomSeq))).toEqual([1, 1, 2]);
    expect(rows.map((r) => r.roomId)).toEqual([roomA, roomB, roomA]);
  });

  it('mints room_seq itself, so no caller can choose or repeat one', async () => {
    expect((await append(ledgerRow(roomA))).roomSeq).toBe(1);
    expect((await append(ledgerRow(roomA))).roomSeq).toBe(2);
    // A second room starts again at 1, and the two never interfere.
    expect((await append(ledgerRow(roomB))).roomSeq).toBe(1);
  });

  it('refuses a repeated event id anywhere in the ledger', async () => {
    const id = randomUUID();
    await append(ledgerRow(roomA, { id }));
    await violatesConstraint('core_events_id_key', () => append(ledgerRow(roomB, { id })));
  });

  it('refuses a payload whose id disagrees with the lifted column', async () => {
    const row = ledgerRow(roomA);
    row.payload.id = randomUUID();
    await violatesConstraint('core_events_payload_id_matches', () => append(row));
  });

  it('refuses a payload whose type disagrees with the lifted column', async () => {
    const row = ledgerRow(roomA);
    row.payload.type = 'object_accepted';
    await violatesConstraint('core_events_payload_type_matches', () => append(row));
  });

  it('refuses a payload with no canonical timestamp', async () => {
    const row = ledgerRow(roomA);
    delete row.payload.at;
    await violatesConstraint('core_events_payload_has_at', () => append(row));
  });

  /**
   * r1, major 2. Round 1 checked that `payload.at` and `payload.actor` were
   * *present*. Presence is not the property that matters: what matters is that
   * the durable order (`occurred_at`) and the order a replay re-sorts into
   * (`payload.at`) are the same order, and that the lifted actor is the actor
   * inside the event. A row that disagreed would occupy one position live and
   * a different one on replay, which is the divergence the whole design exists
   * to exclude — and it would look completely ordinary in the table.
   */
  it('refuses a payload whose `at` disagrees with occurred_at', async () => {
    const row = ledgerRow(roomA, {
      at: '2026-08-01T12:00:09.000Z',
      occurredAt: '2026-08-01T12:00:03.000Z',
    });
    await violatesConstraint('core_events_payload_at_matches', () => append(row));
  });

  it('refuses an `at` with no timezone designator', async () => {
    // Without one, `::timestamptz` means different instants in different
    // sessions — so the equality above would be a check that could pass in one
    // connection and fail in another.
    const row = ledgerRow(roomA, { at: '2026-08-01T12:00:03', occurredAt: '2026-08-01T12:00:03Z' });
    await violatesConstraint('core_events_payload_at_has_offset', () => append(row));
  });

  /**
   * r1's major 2, in the shape #21 inverted it into.
   *
   * r2 asserted `payload->'actor' = actor`: a lifted column that disagrees with
   * the payload lets a writer mint a row that replays as something other than
   * what it is. #21 then removed the actor from `CoreEvent` entirely, so that
   * equality became unsatisfiable — and deleting it would have deleted the
   * finding, leaving a payload free to carry a stray `actor` key that the live
   * path refuses at parse time and that nothing stops from sitting in the ledger
   * looking authoritative to the next reader.
   *
   * So the equality survives as the only one left that says the same thing:
   * exactly one actor per row, in exactly one place. Catches: dropping
   * `core_events_payload_has_no_actor` from the schema and the migration.
   */
  it('refuses an actor inside the payload — there is exactly one, and it is a column', async () => {
    const row = ledgerRow(roomA, { payloadActor: { kind: 'human', userId: 'somebody-else' } });
    await violatesConstraint('core_events_payload_has_no_actor', () => append(row));
  });

  it('refuses an actor_id that disagrees with its kind', async () => {
    // `{kind:'system', actor_id:'alice'}` is a row that reads as a person having
    // done what the process did; `{kind:'human', actor_id:null}` is history with
    // nobody's name on it. Catches: dropping
    // `core_events_actor_id_matches_kind`, which is the only thing standing
    // between those two spellings and the audit trail.
    await violatesConstraint('core_events_actor_id_matches_kind', () =>
      append(ledgerRow(roomA, { actorKind: 'system', actorId: 'alice' })),
    );
    await violatesConstraint('core_events_actor_id_matches_kind', () =>
      append(ledgerRow(roomA, { actorKind: 'model', actorId: null })),
    );
  });

  it('refuses a blank actor_id, which is how NULL gets spelled by accident', async () => {
    await violatesConstraint('core_events_actor_id_not_blank', () =>
      append(ledgerRow(roomA, { actorKind: 'model', actorId: '' })),
    );
  });

  it('refuses an event in a room that does not exist', async () => {
    await violatesConstraint('core_events_room_id_rooms_id_fk', () =>
      append(ledgerRow(randomUUID())),
    );
  });
});

/**
 * The r1 blocking major: the advisory lock was **cooperative**. Any writer with
 * the app's database role could INSERT straight into `core_events`, skipping
 * canonical minting, the reducer and gap-free assignment.
 *
 * These run as the compose Postgres image's `POSTGRES_USER`, which owns every
 * table and is a superuser — the hardest case, and the one a `REVOKE` cannot
 * touch. Every refusal below is therefore the trigger's, which is the point:
 * enforcement that does not depend on the writer being unprivileged, or
 * well-behaved, or ours.
 */
describe('core_events — the append path is structural, not cooperative', () => {
  it('refuses a direct INSERT, even from the table owner', async () => {
    const row = ledgerRow(roomA);
    await violatesConstraint('core_events_append_through_procedure', () =>
      handle.db.insert(coreEvents).values({
        roomId: row.roomId,
        roomSeq: 1,
        id: row.id,
        type: 'message_posted',
        actorKind: 'system',
        actorId: null,
        payload: row.payload,
        occurredAt: row.occurredAt,
      }),
    );
    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coreEvents);
    expect(Number(count)).toBe(0);
  });

  /**
   * The honest limit of the call-stack check, tested rather than only admitted.
   *
   * A role with CREATE privilege can define a function with the same *name* — an
   * overload, in the same schema, so the stack frame reads unqualified — and
   * satisfy `position('function atrium_append_core_event(' in PG_CONTEXT)`.
   * That is why the guard also asserts the ledger lock, and why the second
   * check is not decoration: a spoofed frame that did not take the lock is
   * still refused, by the lock.
   *
   * Anyone able to do this can also drop the trigger, so the guard is aimed at
   * the accidental bypass — the migration, the fix-up script, the well-meant
   * backfill — and not at a DBA determined to lie to the log. Stating that is
   * cheap; demonstrating exactly where the line falls is not.
   */
  it('refuses a spoofed call frame that does not hold the ledger lock', async () => {
    await handle.db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION atrium_append_core_event(p jsonb) RETURNS void
        LANGUAGE plpgsql AS $spoof$
        BEGIN
          INSERT INTO core_events (room_id, room_seq, id, type, actor_kind, actor_id, payload, occurred_at)
          VALUES ((p->>'roomId')::uuid, 1, p->>'id', 'message_posted',
                  'system', NULL, p->'payload', (p->>'at')::timestamptz);
        END $spoof$;
      `),
    );
    try {
      const row = ledgerRow(roomA);
      await violatesConstraint('core_events_append_lock_held', () =>
        handle.db.execute(
          sql`SELECT atrium_append_core_event(${JSON.stringify({
            roomId: row.roomId,
            id: row.id,
            at: row.occurredAt,
            payload: row.payload,
          })}::jsonb)`,
        ),
      );
    } finally {
      await handle.db.execute(sql.raw('DROP FUNCTION atrium_append_core_event(jsonb)'));
    }
  });

  it('refuses to rewrite a ledger row after the fact', async () => {
    await append(ledgerRow(roomA));
    await violatesConstraint('core_events_append_only', () =>
      handle.db.execute(sql`UPDATE core_events SET "actor_kind" = 'system'`),
    );
  });

  it('uses the same advisory lock key the server does', async () => {
    // A lock key that drifts is the worst kind of bug in this design: both
    // sides take *a* lock, neither contends with the other, and appends from
    // two processes interleave while every test that only ever runs one process
    // stays green. (This assertion is not hypothetical — it caught exactly that
    // typo in the migration during r2.)
    const rows = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace
            AND pronargs = 8`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.src).toContain(String(LEDGER_ADVISORY_LOCK_KEY));
  });
});

/**
 * The append function is an **authorization boundary**, not merely a path
 * (#22 gauntlet r2 delta, blocking 2).
 *
 * The finding, in full, because each clause needs its own test:
 *
 * > the `SECURITY DEFINER` append function is executable by `PUBLIC`, accepts
 * > arbitrary event JSON, and performs neither membership authorization nor
 * > reducer validation; calling it directly satisfies both the call-stack and
 * > lock checks, inserts a ledger row, and emits no doorbell.
 *
 * Round 2's guard asked "did you come through the front door", and the door was
 * unlocked. These four tests are the four locks.
 *
 * What is deliberately *not* tested here, because it cannot be: a superuser who
 * sets `session_replication_role = replica`, or restores with
 * `pg_restore --disable-triggers`, walks past every trigger in the schema. That
 * is operator territory — see the head of
 * `drizzle/0004_trusted_actor_and_append_boundary.sql`, which says so in as many
 * words rather than implying coverage it cannot have.
 */
describe('core_events — the append function is the authorization boundary', () => {
  it('is not executable by PUBLIC', async () => {
    // Catches: the r2 privilege block, which granted EXECUTE to PUBLIC on the
    // reasoning that the trigger was the real guard. It made the door the guard.
    const [row] = await handle.db.execute<{ granted: boolean }>(
      sql`SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS granted
          FROM pg_proc p
          WHERE p.proname = 'atrium_append_core_event'
            AND p.pronamespace = 'public'::regnamespace
            AND p.pronargs = 8`,
    );
    expect(row?.granted).toBe(false);
  });

  it('is executable by the role the application connects as', async () => {
    // The other half, and not a formality: a REVOKE that also locked out the app
    // would be caught by every other test in the suite failing, but stating it
    // here is what makes the grant deliberate rather than incidental.
    const [row] = await handle.db.execute<{ granted: boolean }>(
      sql`SELECT has_function_privilege(current_user, p.oid, 'EXECUTE') AS granted
          FROM pg_proc p
          WHERE p.proname = 'atrium_append_core_event'
            AND p.pronamespace = 'public'::regnamespace
            AND p.pronargs = 8`,
    );
    expect(row?.granted).toBe(true);
  });

  it('refuses a human actor who holds no membership in the room', async () => {
    // Catches: removing the membership block from the function. Without it, any
    // caller that can execute the function writes durable history into any room
    // as any user — the command layer's checks are the caller's own, and this is
    // the path a caller that is not the command layer takes.
    const stranger = randomUUID();
    await violatesConstraint('core_events_append_actor_authorized', () =>
      append(ledgerRow(roomA, { actorKind: 'human', actorId: stranger })),
    );
    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coreEvents);
    expect(Number(count)).toBe(0);
  });

  it('accepts a human actor who does hold one', async () => {
    const room = await seedRoom(handle, ['carol'], { slug: 'room-c' });
    const carol = room.people.carol as string;
    const appended = await append(ledgerRow(room.roomId, { actorKind: 'human', actorId: carol }));
    expect(appended.roomSeq).toBe(1);
  });

  it('refuses a human actor id that could not be a member at all', async () => {
    // `memberships.user_id` is a uuid. Without this the cast raises SQLSTATE
    // 22P02 and the caller gets "invalid input syntax for type uuid", which is
    // true and says nothing about what was actually refused.
    await violatesConstraint('core_events_append_actor_authorized', () =>
      append(ledgerRow(roomA, { actorKind: 'human', actorId: 'not-a-uuid' })),
    );
  });

  /**
   * The reducer's refusals, enforced in SQL.
   *
   * @atrium/core refuses an event for exactly two reasons and both are
   * properties of *position*: `out_of_order` (it does not sort strictly after
   * the state's cursor) and `duplicate` (its id is spent). Position is what a
   * database can check, so both are checked in the function — and with them
   * enforced, no caller can put a row in this table that a replay would refuse
   * to fold, which is the invariant the whole ticket rests on.
   *
   * The reducer's third verdict, `applied_with_issue`, is not a refusal: the
   * event happened and the problem is recorded beside it, so there is nothing
   * for a boundary to reject.
   */
  it('refuses an event that does not sort strictly after the ledger cursor', async () => {
    await append(ledgerRow(roomA, { at: '2026-08-01T10:00:05.000Z' }));
    // Catches: removing the canonical-order gate from the function. Without it
    // this row lands durably, and the next `catchUp` folds it, gets `rejected`
    // back from the reducer, and throws the ledger-integrity error — a server
    // that cannot start against its own log.
    await violatesConstraint('core_events_append_canonical_order', () =>
      append(ledgerRow(roomA, { at: '2026-08-01T10:00:04.000Z' })),
    );
    await violatesConstraint('core_events_append_canonical_order', () =>
      append(ledgerRow(roomB, { at: '2026-08-01T10:00:04.000Z' })),
    );
  });

  it('breaks an exact timestamp tie on the event id, the way the reducer does', async () => {
    const at = '2026-08-01T11:00:00.000Z';
    await append(ledgerRow(roomA, { at, id: 'bbbb' }));
    // Same instant, an id that sorts before: the reducer would refuse it, so the
    // boundary does. Catches: comparing on `occurred_at` alone, which lets a
    // whole millisecond's worth of ids land in any order.
    await violatesConstraint('core_events_append_canonical_order', () =>
      append(ledgerRow(roomA, { at, id: 'aaaa' })),
    );
    // …and one that sorts after is fine, which is what makes the rule a tie-break
    // rather than a ban on sharing a timestamp.
    expect((await append(ledgerRow(roomA, { at, id: 'cccc' }))).roomSeq).toBe(2);
  });

  /**
   * The doorbell is rung by the database, so no writer can insert in silence.
   *
   * This is the clause of the finding with the widest blast radius: r2 emitted
   * `pg_notify` from the application, so a row written by anything else landed
   * durably and told nobody — and every other instance's subscribers sat at
   * their cursors indefinitely with no gap to notice.
   */
  it('emits the doorbell from inside the function, with the appending origin', async () => {
    const notifications: string[] = [];
    const listener = await handle.sql.listen('atrium_ledger', (raw) => {
      notifications.push(raw);
    });
    try {
      const appended = await append(ledgerRow(roomA), 'instance-under-test');
      await until(() => notifications.length > 0, 5_000, 'a ledger notification');
      const note = JSON.parse(notifications[0] as string) as Record<string, unknown>;
      // Catches: moving `pg_notify` back into the application. A row appended by
      // this test — which is not the application — must still ring the bell.
      expect(note).toMatchObject({
        origin: 'instance-under-test',
        roomId: roomA,
        seq: appended.seq,
        roomSeq: appended.roomSeq,
      });
    } finally {
      await listener.unlisten();
    }
  });

  it('rings for everybody when the appender did not name itself', async () => {
    // A null origin matches no instance, so every instance folds it. That is the
    // direction to be wrong in: a script or a second application that appends
    // without an instance id must wake everyone rather than nobody. Catches:
    // defaulting `p_origin` to a literal, or filtering on truthiness in the bus
    // (`note.origin && note.origin !== id`) rather than on inequality.
    const notifications: string[] = [];
    const listener = await handle.sql.listen('atrium_ledger', (raw) => {
      notifications.push(raw);
    });
    try {
      await append(ledgerRow(roomA));
      await until(() => notifications.length > 0, 5_000, 'a ledger notification');
      expect(JSON.parse(notifications[0] as string)).toMatchObject({ origin: null });
    } finally {
      await listener.unlisten();
    }
  });

  /**
   * The claim in `schema.ts` and `ledger.ts`, made checkable: the *global* seq
   * gaps on a rolled-back append and the *per-room* one does not. Only the
   * per-room sequence is ever advertised as gap-free, and this is why the
   * distinction is worth stating rather than glossing (r1 polish).
   */
  it('gaps the global seq on a rollback, and does not gap room_seq', async () => {
    await append(ledgerRow(roomA));
    // A doomed append: the payload id disagrees with the lifted one, so the
    // check constraint aborts the transaction *after* the sequence handed out
    // its next value.
    const doomed = ledgerRow(roomA);
    doomed.payload.id = randomUUID();
    await expect(append(doomed)).rejects.toThrow();
    await append(ledgerRow(roomA));

    const rows = await handle.db
      .select({ seq: coreEvents.seq, roomSeq: coreEvents.roomSeq })
      .from(coreEvents)
      .orderBy(coreEvents.seq);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 3]);
    expect(rows.map((r) => Number(r.roomSeq))).toEqual([1, 2]);
  });
});

describe('composite (room_id, id) foreign keys — rooms are the isolation boundary', () => {
  async function object(roomId: string, type: 'decision' | 'open_question' = 'decision') {
    const id = randomUUID();
    await handle.db.insert(acceptedObjects).values({
      id,
      roomId,
      type,
      payload:
        type === 'decision'
          ? { statement: 'ship it', decidedBy: null, status: 'active' }
          : { question: 'ship it?', status: 'open' },
    });
    return id;
  }

  async function message(roomId: string) {
    const id = randomUUID();
    await handle.db.insert(messages).values({ id, roomId, body: 'hi' });
    return id;
  }

  it('refuses a relation whose source object lives in another room', async () => {
    const foreign = await object(roomB);
    const local = await object(roomA);
    // Raw SQL so the refusal is Postgres's, not drizzle's: this is the write a
    // buggy service — or a psql session — would make.
    await violatesConstraint('relations_from_object_same_room_fk', () =>
      handle.db.execute(insertRelation(roomA, foreign, local)),
    );
  });

  it('refuses a relation whose target object lives in another room', async () => {
    const local = await object(roomA, 'open_question');
    const foreign = await object(roomB);
    await violatesConstraint('relations_to_object_same_room_fk', () =>
      handle.db.execute(insertRelation(roomA, local, foreign)),
    );
  });

  it('refuses a relation whose evidence message lives in another room', async () => {
    const local = await object(roomA);
    const foreign = await message(roomB);
    await violatesConstraint('relations_to_message_same_room_fk', () =>
      handle.db.execute(
        sql.raw(
          `INSERT INTO relations (id, room_id, kind, from_object_id, to_message_id)
           VALUES ('${randomUUID()}', '${roomA}', 'evidence', '${local}', '${foreign}')`,
        ),
      ),
    );
  });

  it('accepts a relation entirely inside one room', async () => {
    const from = await object(roomA, 'open_question');
    const to = await object(roomA);
    await expect(handle.db.execute(insertRelation(roomA, from, to))).resolves.toBeDefined();
  });

  it('refuses an attention item pointing at another room’s object', async () => {
    const seeded = await seedRoom(handle, ['carol'], { slug: 'room-c' });
    const foreign = await object(roomB);
    await violatesConstraint('attention_items_object_same_room_fk', () =>
      handle.db.insert(attentionItems).values({
        roomId: seeded.roomId,
        userId: seeded.people.carol as string,
        subjectKind: 'object',
        subjectId: foreign,
        class: 'owned_commitment',
        reason: { kind: 'commitment_open', statement: 'you own this', due: null } as const,
      }),
    );
  });

  it('refuses an object accepted from another room’s proposal', async () => {
    const proposalId = randomUUID();
    await handle.db.insert(proposals).values({
      id: proposalId,
      roomId: roomB,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
      confidence: 0.9,
      proposerKind: 'model',
      proposerModel: 'test',
    });
    await violatesConstraint('accepted_objects_proposal_same_room_fk', () =>
      handle.db.insert(acceptedObjects).values({
        roomId: roomA,
        type: 'decision',
        payload: { statement: 'ship it', decidedBy: null, status: 'active' },
        proposalId,
      }),
    );
  });

  it('refuses a reply to a message in another room', async () => {
    const foreign = await message(roomB);
    await violatesConstraint('messages_reply_to_same_room_fk', () =>
      handle.db.insert(messages).values({ roomId: roomA, body: 'reply', replyToId: foreign }),
    );
  });

  it('refuses a cross-room objective link, and allows one inside a room', async () => {
    const foreignObjective = await object(roomB);
    await violatesConstraint('accepted_objects_objective_same_room_fk', () =>
      handle.db.insert(acceptedObjects).values({
        roomId: roomA,
        type: 'decision',
        payload: { statement: 'x', decidedBy: null, status: 'active' },
        objectiveId: foreignObjective,
      }),
    );

    const localObjective = await object(roomA);
    await expect(
      handle.db.insert(acceptedObjects).values({
        roomId: roomA,
        type: 'decision',
        payload: { statement: 'x', decidedBy: null, status: 'active' },
        objectiveId: localObjective,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a cross-room supersession link', async () => {
    const foreign = await object(roomB);
    await violatesConstraint('accepted_objects_superseded_by_same_room_fk', () =>
      handle.db.insert(acceptedObjects).values({
        roomId: roomA,
        type: 'decision',
        payload: { statement: 'x', decidedBy: null, status: 'active' },
        supersededById: foreign,
      }),
    );
  });

  it('refuses provenance that cites another room’s message', async () => {
    const local = await object(roomA);
    const foreign = await message(roomB);
    await violatesConstraint('object_sources_message_same_room_fk', () =>
      handle.db.execute(
        sql.raw(
          `INSERT INTO object_sources (room_id, object_id, message_id)
           VALUES ('${roomA}', '${local}', '${foreign}')`,
        ),
      ),
    );
  });

  it('still lets a nullable composite reference be null (MATCH SIMPLE, deliberately)', async () => {
    await expect(
      handle.db.insert(acceptedObjects).values({
        roomId: roomA,
        type: 'decision',
        payload: { statement: 'x', decidedBy: null, status: 'active' },
        objectiveId: null,
        proposalId: null,
        supersededById: null,
      }),
    ).resolves.toBeDefined();
  });
});

/**
 * The polymorphic subject, routed from #21 and owned by this ticket.
 *
 * `needs_decision` points at a PROPOSAL — a decision never auto-accepts, so at
 * the moment somebody has to rule on one there is no accepted object yet. What
 * makes this worth a test rather than a column comment is the part that is easy
 * to lose: going polymorphic must not cost the room-scoping. Both edges are
 * still composite, and the discriminator cannot disagree with the target it
 * selects, because the FK-bearing columns are generated from it.
 */
describe('attention_items — a polymorphic subject that is still room-scoped', () => {
  async function proposal(roomId: string) {
    const id = randomUUID();
    await handle.db.insert(proposals).values({
      id,
      roomId,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
      confidence: 0.9,
      proposerKind: 'model',
      proposerModel: 'test',
    });
    return id;
  }

  async function acceptedObject(roomId: string) {
    const id = randomUUID();
    await handle.db.insert(acceptedObjects).values({
      id,
      roomId,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
    });
    return id;
  }

  it('stores a needs_decision item against a proposal — the case that was impossible', async () => {
    const seeded = await seedRoom(handle, ['frank'], { slug: 'room-f' });
    const subjectId = await proposal(seeded.roomId);
    await expect(
      handle.db.insert(attentionItems).values({
        roomId: seeded.roomId,
        userId: seeded.people.frank as string,
        subjectKind: 'proposal',
        subjectId,
        class: 'needs_decision',
        reason: {
          kind: 'decision_pending',
          statement: 'you asked for this call',
          assigned: true,
        } as const,
      }),
    ).resolves.toBeDefined();

    const [row] = await handle.db
      .select({
        kind: attentionItems.subjectKind,
        subject: attentionItems.subjectId,
        asObject: attentionItems.subjectObjectId,
        asProposal: attentionItems.subjectProposalId,
      })
      .from(attentionItems);
    // Exactly one target column is populated, and it is the one the
    // discriminator names — by construction, not by a check somebody maintains.
    expect(row).toMatchObject({ kind: 'proposal', subject: subjectId, asObject: null });
    expect(row?.asProposal).toBe(subjectId);
  });

  it('refuses a proposal subject from another room', async () => {
    const seeded = await seedRoom(handle, ['gail'], { slug: 'room-g' });
    const foreign = await proposal(roomB);
    await violatesConstraint('attention_items_proposal_same_room_fk', () =>
      handle.db.insert(attentionItems).values({
        roomId: seeded.roomId,
        userId: seeded.people.gail as string,
        subjectKind: 'proposal',
        subjectId: foreign,
        class: 'needs_decision',
        reason: { kind: 'mention', request: 'cross-room' } as const,
      }),
    );
  });

  it('refuses a subject whose kind does not match where it actually lives', async () => {
    const seeded = await seedRoom(handle, ['hank'], { slug: 'room-h' });
    const proposalId = await proposal(seeded.roomId);
    // Same room, real id — but declared as an object, so the object edge is the
    // one that has to resolve, and it does not.
    await violatesConstraint('attention_items_object_same_room_fk', () =>
      handle.db.insert(attentionItems).values({
        roomId: seeded.roomId,
        userId: seeded.people.hank as string,
        subjectKind: 'object',
        subjectId: proposalId,
        class: 'needs_decision',
        reason: { kind: 'mention', request: 'mislabelled' } as const,
      }),
    );
  });

  it('lets one person hold an item on a proposal and on the object it became', async () => {
    const seeded = await seedRoom(handle, ['iris'], { slug: 'room-i' });
    const userId = seeded.people.iris as string;
    const proposalId = await proposal(seeded.roomId);
    const objectId = await acceptedObject(seeded.roomId);
    const item = (subjectKind: 'object' | 'proposal', subjectId: string) => ({
      roomId: seeded.roomId,
      userId,
      subjectKind,
      subjectId,
      class: 'needs_decision' as const,
      reason: { kind: 'mention', request: 'both' } as const,
    });
    await handle.db.insert(attentionItems).values(item('proposal', proposalId));
    // The kind is part of the uniqueness key: these are different subjects, and
    // collapsing them would drop one of two legitimate items.
    await expect(
      handle.db.insert(attentionItems).values(item('object', objectId)),
    ).resolves.toBeDefined();
    // The same subject twice is still one item.
    await violatesConstraint('attention_items_user_subject_class_key', () =>
      handle.db.insert(attentionItems).values(item('proposal', proposalId)),
    );
  });
});

describe('memberships.seen_seq', () => {
  it('is a bigint, so a read cursor cannot overflow before the log it points into', async () => {
    // The column's width, checked without tripping the head bound below: a
    // cursor past the room's head is refused on principle, so the bigint claim
    // is read off the catalog rather than by writing an impossible value.
    const rows = await handle.db.execute<{ data_type: string }>(
      sql`SELECT data_type FROM information_schema.columns
          WHERE table_name = 'memberships' AND column_name = 'seen_seq'`,
    );
    expect(rows[0]?.data_type).toBe('bigint');
  });

  it('refuses a negative cursor', async () => {
    const seeded = await seedRoom(handle, ['erin'], { slug: 'room-e' });
    await violatesConstraint('memberships_seen_seq_nonnegative', () =>
      handle.db.execute(
        sql.raw(`UPDATE memberships SET seen_seq = -1 WHERE room_id = '${seeded.roomId}'`),
      ),
    );
  });

  /**
   * r1, major 5. A cursor past the room's head claims to have read history that
   * does not exist: the client trusting it asks `since(room, n)` for a gap that
   * will never arrive, and its "since you left" divider sits in the future
   * permanently. The command layer refuses it too; this is the half that also
   * binds a writer that is not the command layer.
   */
  it('refuses a cursor past the room’s head, and allows one at it', async () => {
    const seeded = await seedRoom(handle, ['dana'], { slug: 'room-d' });
    const set = (value: number) =>
      handle.db.execute(
        sql.raw(`UPDATE memberships SET seen_seq = ${value} WHERE room_id = '${seeded.roomId}'`),
      );

    // An empty room has a head of 0, so anything above it is already too far.
    await violatesConstraint('memberships_seen_seq_within_room_head', () => set(1));

    await append(ledgerRow(seeded.roomId));
    await append(ledgerRow(seeded.roomId));
    await expect(set(2)).resolves.toBeDefined();
    await violatesConstraint('memberships_seen_seq_within_room_head', () => set(3));
  });
});

/**
 * Raw INSERT for a relation. Every interpolated value is a uuid this file
 * generated one line earlier, so nothing here reaches anywhere a caller could.
 */
function insertRelation(roomId: string, fromId: string, toId: string) {
  return sql.raw(
    `INSERT INTO relations (id, room_id, kind, from_object_id, to_object_id)
     VALUES ('${randomUUID()}', '${roomId}', 'answers', '${fromId}', '${toId}')`,
  );
}
