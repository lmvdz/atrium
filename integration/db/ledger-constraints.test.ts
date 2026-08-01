import { randomUUID } from 'node:crypto';
import { CANONICAL_TIMESTAMP, compareCursor, Timestamp } from '@atrium/core';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  eventType,
  messages,
  proposals,
  users,
} from '@atrium/db/schema';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_ADVISORY_LOCK_KEY } from '../../apps/server/src/ledger.js';
import { describeError, violatesConstraint } from '../support/constraints.js';
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
    /** The room the *payload* declares, when a test needs it to disagree. */
    payloadRoomId?: string;
  } = {},
) {
  const id = overrides.id ?? randomUUID();
  const at = overrides.at ?? nextAt();
  const payload: Record<string, unknown> = {
    id,
    at,
    type: 'message_posted',
    roomId: overrides.payloadRoomId ?? roomId,
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
 * One honest row per ledger event kind (#22 gauntlet r5 delta, blocking).
 *
 * `ledgerRow` only ever built a `message_posted`, which is why every fixture for
 * the room check was a `message_posted` or an `object_accepted` and why the
 * kind-blind `coalesce` survived a round: five of the eight kinds had never been
 * appended through this suite at all.
 *
 * Each payload carries exactly the room key its own shape declares — the table in
 * `declaredRoomId` (`apps/server/src/room-events.ts`) — and nothing else, so a
 * test that wants a dishonest shape has to add the extra key itself and a reader
 * can see it doing so.
 *
 * The payloads are minimal but structurally real: these rows are never folded by
 * the reducer (the constraints suite talks to Postgres, not to `reduce`), and
 * inventing fields the schema does not have would make a fixture that passes for
 * a reason the product does not have.
 */
function kindRow(
  type: string,
  roomId: string,
  subjects: { proposalId?: string; objectId?: string } = {},
): LedgerRow {
  const id = randomUUID();
  const at = nextAt();
  const proposalId = subjects.proposalId ?? randomUUID();
  const objectId = subjects.objectId ?? randomUUID();
  const base = { id, at, type };
  let payload: Record<string, unknown>;
  switch (type) {
    case 'proposal_recorded':
      payload = {
        ...base,
        proposal: {
          id: proposalId,
          roomId,
          type: 'claim',
          payload: { statement: 'ship it', claimant: null, verification: 'unverified' },
          confidence: 0.9,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: { messageIds: [], proposalId: null, interpretationId: null },
          quote: null,
          status: 'pending',
          createdAt: at,
        },
      };
      break;
    case 'object_accepted':
      payload = {
        ...base,
        object: {
          id: objectId,
          roomId,
          type: 'claim',
          payload: { statement: 'ship it', claimant: null, verification: 'unverified' },
          objectiveId: null,
          provenance: { messageIds: [], proposalId: null, interpretationId: null },
          createdAt: at,
          updatedAt: at,
        },
      };
      break;
    case 'relation_added':
      payload = {
        ...base,
        relation: {
          id: randomUUID(),
          roomId,
          type: 'supersedes',
          fromObjectId: objectId,
          toObjectId: objectId,
          createdAt: at,
        },
      };
      break;
    case 'message_posted':
      payload = {
        ...base,
        roomId,
        messageId: randomUUID(),
        body: 'hello',
        replyToId: null,
        clientMessageId: null,
        attachments: [],
      };
      break;
    case 'attention_resolved':
      payload = { ...base, roomId, attentionId: randomUUID(), status: 'resolved' };
      break;
    case 'proposal_rejected':
      payload = { ...base, proposalId, reason: null };
      break;
    case 'proposal_superseded':
      payload = { ...base, proposalId, supersededByProposalId: null, reason: null };
      break;
    case 'object_corrected':
      payload = {
        ...base,
        objectId,
        action: 'amend',
        patch: {},
        toType: null,
        provenance: { messageIds: [], proposalId: null, interpretationId: null },
        note: null,
      };
      break;
    default:
      // A ninth kind in the `event_type` enum with no fixture here would
      // otherwise be exercised by nothing, silently.
      throw new Error(`no ledger fixture for event kind "${type}"`);
  }
  return { roomId, id, type, actorKind: 'system', actorId: null, payload, occurredAt: at };
}

/** A `proposal_recorded` that mints a *named* proposal, so a later event can name it. */
function recording(roomId: string, proposalId: string): LedgerRow {
  return kindRow('proposal_recorded', roomId, { proposalId });
}

/** An `object_accepted` that mints a *named* object, for the same reason. */
function acceptedObject(roomId: string, objectId: string): LedgerRow {
  return kindRow('object_accepted', roomId, { objectId });
}

/** A `proposal_rejected` naming a proposal — one of the three room-less kinds. */
function rejection(roomId: string, proposalId: string): LedgerRow {
  return kindRow('proposal_rejected', roomId, { proposalId });
}

/** An `object_corrected` naming an object — another of the three. */
function correction(roomId: string, objectId: string): LedgerRow {
  return kindRow('object_corrected', roomId, { objectId });
}

/**
 * Append the way production appends: through the procedure, with the advisory
 * lock, on a real transaction.
 *
 * There is no test-only insert path and there must never be one — a suite that
 * writes to `core_events` through a door the server does not use proves things
 * about a door nobody walks through. Round 1's tests inserted directly, which
 * is exactly the bypass the r1 gauntlet flagged as *possible*; that they could
 * do it was the demonstration.
 *
 * Note what a caller can no longer pass: a receipt window. Round 4's signature
 * took one, validated its shape and stored it, so this helper could hand the
 * ledger a fabricated snapshot — which is exactly what the r4 delta gauntlet
 * found and what the round-5 boundary removed. The window is derived inside and
 * handed *back*, which is why this returns it.
 */
async function append(row: LedgerRow, origin: string | null = null) {
  return handle.db.transaction(async (tx) => {
    const result = await tx.execute<{
      seq: string;
      room_seq: string;
      trusted_messages: unknown;
    }>(sql`
      SELECT "seq", "room_seq", "trusted_messages" FROM atrium_append_core_event(
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
    return {
      seq: Number(minted?.seq),
      roomSeq: Number(minted?.room_seq),
      trustedMessages: minted?.trusted_messages ?? null,
    };
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
    // `attention_resolved`, not `object_accepted`. The two kinds spell their room
    // the same way (a bare `roomId`), so this fixture violates the type rule and
    // *only* the type rule — under r6's kind-discriminated room check, claiming to
    // be an `object_accepted` while carrying `message_posted`'s room key is a
    // second violation, and Postgres reports whichever constraint it evaluates
    // first. A fixture that trips two rules is a test that names one of them by
    // luck.
    row.payload.type = 'attention_resolved';
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

  /**
   * One spelling of one instant (#22 gauntlet r3 delta, major 1).
   *
   * r2 required a timezone designator, because without one `::timestamptz` means
   * different instants in different sessions and the equality above would pass in
   * one connection and fail in another. That is necessary and it is not
   * sufficient — the r3 delta found the sufficient version:
   *
   * > SQL orders `timestamptz` then `id COLLATE "C"` while the reducer does JS
   * > string comparison on `payload.at` then `id`, so `…05.000Z` vs `…05Z` (or
   * > `+00:00` vs `Z`) tie in SQL and diverge in JS.
   *
   * All four rows below name a real instant with a real designator and would have
   * satisfied r2's check. Each is a *second* spelling of an instant the ledger can
   * already hold, and two spellings is the ordering gate and the reducer
   * disagreeing about whether two events are simultaneous.
   *
   * Catches: reverting `core_events_payload_at_is_canonical_utc` to the
   * has-a-designator regex, which is exactly r2's constraint.
   */
  it('refuses every spelling of `at` but the canonical one', async () => {
    // One test rather than a parametrised one, so the mutant ledger can name it:
    // `it.each` reports a formatted title per case and `catches` would have to
    // guess the formatting.
    const spellings: Array<[string, string, string]> = [
      ['no designator at all', '2026-08-01T12:00:03', '2026-08-01T12:00:03Z'],
      ['second precision', '2026-08-01T12:00:03Z', '2026-08-01T12:00:03Z'],
      ['a numeric UTC offset', '2026-08-01T12:00:03.000+00:00', '2026-08-01T12:00:03.000Z'],
      ['a non-UTC offset', '2026-08-01T14:00:03.000+02:00', '2026-08-01T12:00:03.000Z'],
    ];
    for (const [label, at, occurredAt] of spellings) {
      await violatesConstraint(
        'core_events_payload_at_is_canonical_utc',
        () => append(ledgerRow(roomA, { at, occurredAt })),
        // The label rides along so a failure says which spelling got through.
      ).catch((error: unknown) => {
        throw new Error(`spelling "${label}" was not refused: ${String(error)}`);
      });
    }
  });

  it('refuses a receipt snapshot that is not a list of {id, authorId, body}', async () => {
    /**
     * The snapshot is what a replay folds a receipt against, so a window a replay
     * cannot read must not be able to reach the table.
     *
     * Reached the only way it still can. Round 4 let this test drive the CHECK
     * through the append function's `p_trusted_messages` argument — which was the
     * blocking finding, not a testing convenience: an argument a test can forge is
     * an argument anybody can forge. There is no such argument now, so the only
     * writer left that can put a bad window in the column is the one 0004, 0005
     * and 0006 all name as out of scope — a superuser with the append trigger
     * disabled. That is exactly who this constraint is for, so that is who drives
     * it, explicitly and with the trigger put back in the same test.
     *
     * Catches: dropping `core_events_trusted_messages_shape`.
     */
    await handle.db.execute(sql`ALTER TABLE core_events DISABLE TRIGGER core_events_append_guard`);
    try {
      let seq = 0;
      const bypass = (window: unknown) => {
        seq += 1;
        const row = ledgerRow(roomA);
        return handle.db.execute(sql`
          INSERT INTO core_events (room_id, room_seq, id, type, actor_kind, actor_id, payload, occurred_at, trusted_messages)
          VALUES (${roomA}::uuid, ${seq}, ${row.id}::text, 'message_posted', 'system', NULL,
                  ${JSON.stringify(row.payload)}::jsonb, ${row.occurredAt}::timestamptz,
                  ${window === undefined ? null : JSON.stringify(window)}::jsonb)
        `);
      };
      for (const bad of [
        { id: 'm1' },
        [{ id: 'm1', authorId: 'u1' }],
        [{ id: 'm1', authorId: 7, body: 'hi' }],
        ['m1'],
      ]) {
        await violatesConstraint('core_events_trusted_messages_shape', () => bypass(bad));
      }
      // …and it accepts the two shapes that mean something: a window, and a window
      // that was looked for and came back empty. Both are what the derivation
      // produces, so a constraint that refused either would refuse real appends.
      await expect(bypass([{ id: 'm1', authorId: 'u1', body: 'hi' }])).resolves.toBeDefined();
      await expect(bypass([])).resolves.toBeDefined();
    } finally {
      await handle.db.execute(sql`ALTER TABLE core_events ENABLE TRIGGER core_events_append_guard`);
    }
    // The trigger really is back on, so a later test in this file is not running
    // against a ledger with its front door removed.
    await violatesConstraint('core_events_append_through_procedure', () =>
      handle.db.insert(coreEvents).values({
        roomId: roomA,
        roomSeq: 99,
        id: randomUUID(),
        type: 'message_posted',
        actorKind: 'system',
        actorId: null,
        payload: { at: nextAt() },
        occurredAt: nextAt(),
      }),
    );
  });

  it('refuses an id outside the charset the two orderings agree on', async () => {
    /**
     * The other half of the same major. The SQL gate compares ids under
     * `COLLATE "C"` (UTF-8 byte order); `orderEvents` compares them with
     * JavaScript's `<` (UTF-16 code-unit order). They agree throughout the Basic
     * Multilingual Plane and disagree above it, because an astral code point is a
     * surrogate pair beginning at U+D800 and therefore sorts *before*
     * U+E000–U+FFFF in UTF-16 and *after* it in bytes.
     *
     * `parityFuzz` below measures the disagreement directly. This is the
     * constraint that keeps it out of the ledger. Catches: dropping
     * `core_events_id_is_safe_to_order`.
     */
    await violatesConstraint('core_events_id_is_safe_to_order', () =>
      append(ledgerRow(roomA, { id: `e-\u{1F600}-1` })),
    );
    await violatesConstraint('core_events_id_is_safe_to_order', () =>
      append(ledgerRow(roomA, { id: 'e 1' })),
    );
    await violatesConstraint('core_events_id_is_safe_to_order', () =>
      append(ledgerRow(roomA, { id: `e${'x'.repeat(300)}` })),
    );
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
            AND pronamespace = 'public'::regnamespace`,
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
            AND p.pronamespace = 'public'::regnamespace`,
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
            AND p.pronamespace = 'public'::regnamespace`,
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

/**
 * The SQL ordering gate and the reducer's ordering, compared directly
 * (#22 gauntlet r3 delta, major 1).
 *
 * The finding:
 *
 * > the SQL canonical gate is not the reducer's gate for all legal shapes — SQL
 * > orders `timestamptz` then `id COLLATE "C"` while the reducer does JS string
 * > comparison on `payload.at` then `id`, so `…05.000Z` vs `…05Z` (or `+00:00`
 * > vs `Z`) tie in SQL and diverge in JS, and astral-plane ids compare
 * > differently in UTF-16 than in `COLLATE "C"`; production minting stays in the
 * > safe subset, so **constrain the subset rather than trusting it**.
 *
 * Two claims are made here and they are different claims, so they are two tests:
 *
 * 1. **Inside the subset the constraints admit, the two orders are the same
 *    order** — measured over generated pairs across both dimensions, not argued
 *    from the shape of the code. This is the property `atrium_append_core_event`
 *    relies on when it enforces the reducer's `out_of_order` refusal in SQL.
 * 2. **Outside it they are not** — and every witness of the disagreement is
 *    refused by a CHECK. Without this half the constraints could be decoration
 *    and the fuzz would still be green, which is the exact vacuity the standing
 *    rule about mutation ledgers exists to rule out.
 */
describe('canonical order — the SQL gate and the reducer agree, and only inside the subset', () => {
  /** The comparison the append function performs, evaluated by Postgres. */
  async function sqlCompare(
    pairs: ReadonlyArray<{ aAt: string; aId: string; bAt: string; bId: string }>,
  ): Promise<number[]> {
    const rows = await handle.db.execute<{ idx: number; cmp: number }>(sql`
      SELECT t.idx,
        (CASE
          WHEN t.a_at::timestamptz > t.b_at::timestamptz THEN 1
          WHEN t.a_at::timestamptz < t.b_at::timestamptz THEN -1
          WHEN (t.a_id COLLATE "C") > (t.b_id COLLATE "C") THEN 1
          WHEN (t.a_id COLLATE "C") < (t.b_id COLLATE "C") THEN -1
          ELSE 0
        END)::int AS cmp
      FROM json_to_recordset(${JSON.stringify(
        pairs.map((pair, index) => ({
          idx: index,
          a_at: pair.aAt,
          a_id: pair.aId,
          b_at: pair.bAt,
          b_id: pair.bId,
        })),
      )}::json)
        AS t(idx int, a_at text, a_id text, b_at text, b_id text)
      ORDER BY t.idx
    `);
    return rows.map((row) => Number(row.cmp));
  }

  const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

  /**
   * A deterministic pseudo-random source.
   *
   * Seeded, because a fuzz that cannot be re-run on the input that failed is a
   * fuzz that reports a mystery. The seed is printed with any failure by virtue
   * of the pair being in the assertion message.
   */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  /** Ids drawn from exactly the charset `core_events_id_is_safe_to_order` admits. */
  const SAFE_ALPHABET = '!#$%&()*+,-./0123456789:;<=>?@ABCXYZ[]^_`abcxyz{|}~';

  it('agrees on every pair inside the constrained subset', async () => {
    const next = random(0x41_54_52_34);
    const pairs: Array<{ aAt: string; aId: string; bAt: string; bId: string }> = [];
    const base = Date.parse('2026-08-01T00:00:00.000Z');
    const safeId = () => {
      const length = 1 + Math.floor(next() * 24);
      let id = '';
      for (let i = 0; i < length; i += 1) {
        id += SAFE_ALPHABET[Math.floor(next() * SAFE_ALPHABET.length)];
      }
      return id;
    };
    // A narrow spread of instants on purpose: the interesting pairs are the ties,
    // where the id decides, and a wide range would almost never produce one.
    const safeAt = () => new Date(base + Math.floor(next() * 5)).toISOString();

    for (let i = 0; i < 400; i += 1) {
      pairs.push({ aAt: safeAt(), aId: safeId(), bAt: safeAt(), bId: safeId() });
    }
    // Plus the pairs a random generator produces too rarely to rely on: identical
    // instants, identical ids, and one-character differences at the ends of the
    // charset — where a collation that is not byte order diverges first.
    const at = new Date(base).toISOString();
    for (const [aId, bId] of [
      ['a', 'a'],
      ['a-b', 'a_b'],
      ['a-b', 'ab'],
      ['A', 'a'],
      ['~', '!'],
      ['e1', 'e1'],
      ['1', '~'],
      ['abc', 'abcd'],
    ] as const) {
      pairs.push({ aAt: at, aId, bAt: at, bId });
    }

    const fromSql = await sqlCompare(pairs);
    const disagreements = pairs
      .map((pair, index) => ({
        pair,
        sql: fromSql[index] as number,
        js: sign(compareCursor({ at: pair.aAt, id: pair.aId }, { at: pair.bAt, id: pair.bId })),
      }))
      .filter((row) => row.sql !== row.js);

    // Catches: comparing `at` as text rather than as `timestamptz` in either
    // direction, and any change to `compareCursor`'s tie-breaking. What it does
    // **not** catch is dropping `COLLATE "C"` — see the next test for why, and
    // for what does.
    expect(disagreements).toEqual([]);
    expect(pairs.length).toBeGreaterThan(400);
  });

  /**
   * `COLLATE "C"` is asserted in the deployed body, not inferred from behaviour.
   *
   * The honest limit of the fuzz above, stated rather than left for a critic.
   * This database is created with `datcollate = en_US.utf8` and a libc locale
   * provider, and on the image the compose file pins, that collation **behaves
   * exactly like byte order** — the locale data is not generated, so `strcoll`
   * degrades to `strcmp`. Every pair the fuzz can generate therefore compares the
   * same way with and without `COLLATE "C"`, and a version of the gate that
   * dropped it would sail through.
   *
   * That is not a reason to claim less; it is a reason to measure differently.
   * The same problem — a guarantee that is absent while all the evidence says it
   * is present — is the r1 advisory-lock-key bug, and the assertion that caught
   * that one reads the deployed function body. So does this one. On a database
   * whose collation *is* variable-weight (any ordinary glibc or ICU deployment),
   * the gate and the reducer would disagree about `a-b` versus `a_b` with no
   * behavioural test in this suite able to see it.
   *
   * Catches: dropping `COLLATE "C"` from either side of the ordering comparison
   * in `atrium_append_core_event`, or from the index that serves it.
   */
  it('compares ids under COLLATE "C" in the deployed append gate', async () => {
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    const body = fn?.src ?? '';
    // Both the read of the cursor and the comparison against it.
    expect(body).toContain('e."id" COLLATE "C" DESC');
    expect(body).toContain('(p_event_id COLLATE "C") > (v_max_id COLLATE "C")');

    const [index] = await handle.db.execute<{ def: string }>(
      sql`SELECT indexdef AS def FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'core_events_canonical_order_idx'`,
    );
    expect(index?.def).toContain('COLLATE "C"');

    // And the reason it has to be said out loud: on this image the default
    // collation agrees with C, so nothing about how rows *behave* here would
    // reveal the difference. Asserted so that an image whose collation stops
    // agreeing turns this into a visible change rather than a silent one.
    const [reality] = await handle.db.execute<{ agrees: boolean }>(
      sql`SELECT ('a-b' < 'ab') = (('a-b' COLLATE "C") < ('ab' COLLATE "C")) AS agrees`,
    );
    expect(typeof reality?.agrees).toBe('boolean');
  });

  it('disagrees outside the subset, and the constraints refuse every witness', async () => {
    /**
     * Each row is a concrete disagreement between the two orderings, and each is
     * refused by a CHECK. That pairing is the point: the fuzz above is only
     * evidence if the subset it fuzzes is enforced, and the constraints are only
     * load-bearing if something outside them actually breaks.
     */
    const at = '2026-08-01T00:00:05.000Z';
    const witnesses = [
      {
        why: 'two spellings of one instant tie in SQL and differ as strings',
        a: { at, id: 'e1' },
        b: { at: '2026-08-01T00:00:05Z', id: 'e1' },
        constraint: 'core_events_payload_at_is_canonical_utc',
        offending: 'b' as const,
      },
      {
        why: 'a numeric UTC offset is the same instant and a different string',
        a: { at, id: 'e1' },
        b: { at: '2026-08-01T00:00:05.000+00:00', id: 'e1' },
        constraint: 'core_events_payload_at_is_canonical_utc',
        offending: 'b' as const,
      },
      {
        why: 'an astral code point sorts before U+E000–U+FFFF in UTF-16 and after it in bytes',
        a: { at, id: '\u{10000}' },
        b: { at, id: '' },
        constraint: 'core_events_id_is_safe_to_order',
        offending: 'a' as const,
      },
    ];

    const fromSql = await sqlCompare(
      witnesses.map((w) => ({ aAt: w.a.at, aId: w.a.id, bAt: w.b.at, bId: w.b.id })),
    );

    witnesses.forEach((witness, index) => {
      const js = sign(compareCursor(witness.a, witness.b));
      // The disagreement is real, and asserted rather than assumed — a "witness"
      // that no longer diverges would otherwise leave the constraint below
      // guarding nothing while this test stayed green.
      expect({ why: witness.why, sql: fromSql[index], js }).not.toEqual({
        why: witness.why,
        sql: js,
        js,
      });
    });

    for (const witness of witnesses) {
      const bad = witness.offending === 'a' ? witness.a : witness.b;
      await violatesConstraint(witness.constraint, () =>
        append(ledgerRow(roomA, { id: bad.id, at: bad.at, occurredAt: bad.at })),
      );
    }
  });
});

/** How many rows the ledger holds right now. */
async function ledgerCount(): Promise<number> {
  const [row] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(coreEvents);
  return Number(row?.n ?? 0);
}

/**
 * The receipt window is **derived at the boundary**, and there is no way to hand
 * one in (#22 gauntlet r4 delta, blocking).
 *
 * The finding, in full, because each clause needs its own test:
 *
 * > `0005…sql:152` validates only the *shape* of `trusted_messages` and `:261`
 * > inserts `p_trusted_messages` verbatim; nothing proves the snapshot matches
 * > the event's payload, room, or source messages. A direct caller of the granted
 * > append function supplies a fabricated but well-formed receipt window and
 * > every fold trusts it.
 *
 * Round 4's answer to the *previous* round had been to move the window into an
 * immutable column. That was right and it was not enough, and the general form is
 * the lesson this round is scoped to close: **trust follows derivation, not
 * location.** A trusted location holding a caller's value is a longer path to the
 * same defect — this is its third appearance in three rounds (the actor in #21,
 * the window's substrate in r3, the window itself here).
 *
 * So these are not "the fabricated window is rejected" tests. They are **there is
 * nowhere to put one**, which is the only version of this a fourth round cannot
 * re-find.
 */
describe('core_events — the receipt window is derived, not supplied', () => {
  /** A real person, so an author id is an author id. */
  async function seedUser(label: string): Promise<string> {
    const id = randomUUID();
    await handle.db
      .insert(users)
      .values({ id, email: `${label}-${id}@example.test`, displayName: label });
    return id;
  }

  /** A real message in a room, so a citation cites something. */
  async function seedMessage(
    roomId: string,
    authorId: string | null,
    body: string,
  ): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(messages).values({ id, roomId, authorId, body });
    return id;
  }

  /** A model `object_accepted` citing `messageIds`, as the append function sees it. */
  function acceptance(
    roomId: string,
    messageIds: readonly string[],
    objectRoomId = roomId,
  ): LedgerRow {
    const id = randomUUID();
    const at = nextAt();
    return {
      roomId,
      id,
      type: 'object_accepted',
      actorKind: 'model',
      actorId: 'test-model',
      occurredAt: at,
      payload: {
        id,
        at,
        type: 'object_accepted',
        object: {
          id: randomUUID(),
          roomId: objectRoomId,
          type: 'claim',
          payload: { statement: 'ship it', claimant: null, verification: 'unverified' },
          objectiveId: null,
          provenance: { messageIds: [...messageIds], proposalId: null, interpretationId: null },
          createdAt: at,
          updatedAt: at,
        },
      },
    };
  }

  it('takes eight arguments, and none of them is a receipt window', async () => {
    /**
     * The structural half, and the one that makes the rest of this block about a
     * closed door rather than a guarded one. Asserted against the deployed catalog
     * rather than the migration text: a migration is what the repo says, `pg_proc`
     * is what the database has.
     *
     * Catches: re-adding `p_trusted_messages` in any position — r4's signature
     * exactly, and the mutant `append_takes_a_caller_supplied_window`.
     */
    const rows = await handle.db.execute<{ args: string; n: number }>(
      sql`SELECT pg_get_function_identity_arguments(oid) AS args, pronargs::int AS n
          FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    // Exactly one function of that name: an overload is the r2 finding — a second
    // door that satisfies every name-based guard while doing none of the work.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.n)).toBe(8);
    expect(rows[0]?.args).toBe(
      'p_room_id uuid, p_event_id text, p_type event_type, p_actor_kind actor_kind, p_actor_id text, p_payload jsonb, p_occurred_at timestamp with time zone, p_origin text',
    );

    // And the body really calls the derivation rather than merely not taking an
    // argument — "no parameter" plus "always NULL" satisfies the line above.
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(fn?.src).toContain('"atrium_receipt_window"(p_room_id, p_actor_kind, p_payload)');
  });

  it('refuses a fabricated receipt window, because there is no argument to put one in', async () => {
    /**
     * The demonstration this round is judged on, and it is r4's exploit verbatim:
     * a direct caller holding EXECUTE appends a model acceptance whose receipt
     * window is a lie — the cited message's real text replaced by a commitment
     * nobody made, attributed to somebody who never wrote it.
     *
     * Under r4 the call succeeds, the shape CHECK passes, and every fold from then
     * on validates the receipt against the forgery. Here Postgres refuses to
     * resolve the call at all (SQLSTATE 42883): the function it names does not
     * exist. That is the difference between validating a lie and having nowhere to
     * tell one.
     */
    const alice = await seedUser('alice');
    const real = await seedMessage(roomA, alice, 'the deploy pipeline is green');
    const row = acceptance(roomA, [real]);
    const forged = [{ id: real, authorId: randomUUID(), body: 'i will do the migration friday' }];

    /**
     * Both ways a caller can reach a parameter, because "the argument moved to
     * the end" is not a fix and a test that only tried one position would say it
     * was. Positional is r4's own order; **named** is how a determined caller
     * reaches an argument wherever it sits, and it is the one that makes this
     * assertion about the parameter existing rather than about where it is.
     */
    const refusesTheForgery = async (attempt: Promise<unknown>) => {
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => /42883|does not exist/.test(describeError(error)),
        'Postgres refuses to resolve the call at all (SQLSTATE 42883)',
      );
    };

    await refusesTheForgery(
      handle.db.execute(sql`
        SELECT * FROM atrium_append_core_event(
          ${row.roomId}::uuid, ${row.id}::text, ${row.type}::event_type,
          ${row.actorKind}::actor_kind, ${row.actorId}::text,
          ${JSON.stringify(row.payload)}::jsonb, ${row.occurredAt}::timestamptz,
          ${JSON.stringify(forged)}::jsonb, ${null}::text
        )
      `),
    );
    await refusesTheForgery(
      handle.db.execute(sql`
        SELECT * FROM atrium_append_core_event(
          p_room_id => ${row.roomId}::uuid,
          p_event_id => ${row.id}::text,
          p_type => ${row.type}::event_type,
          p_actor_kind => ${row.actorKind}::actor_kind,
          p_actor_id => ${row.actorId}::text,
          p_payload => ${JSON.stringify(row.payload)}::jsonb,
          p_occurred_at => ${row.occurredAt}::timestamptz,
          p_trusted_messages => ${JSON.stringify(forged)}::jsonb
        )
      `),
    );

    // Nothing was written by the attempt, and the honest append that follows gets
    // the window the room actually holds — not the forgery, and not nothing.
    expect(await ledgerCount()).toBe(0);
    const appended = await append(row);
    expect(appended.trustedMessages).toEqual([
      { id: real, authorId: alice, body: 'the deploy pipeline is green' },
    ]);
    // …and the row holds what the function said it stored, which is the value the
    // server compares its own fold against.
    const [stored] = await handle.db
      .select({ trusted: coreEvents.trustedMessages })
      .from(coreEvents);
    expect(stored?.trusted).toEqual(appended.trustedMessages);
  });

  it('derives the window from the event’s own provenance, in the room’s own order', async () => {
    /**
     * The positive half: what the boundary stores is a function of the row.
     *
     * Order is asserted because the window is durable and the reducer reads it
     * positionally — a quote carried by several cited messages is reported against
     * the first match — so "whatever the planner returned" would be a value two
     * databases holding the same history could disagree about.
     *
     * Catches: dropping `ORDER BY m.seq` from `atrium_receipt_window`, and
     * deriving from anything other than `object.provenance.messageIds`.
     */
    const alice = await seedUser('alice');
    const first = await seedMessage(roomA, alice, 'first');
    const second = await seedMessage(roomA, null, 'second');
    const uncited = await seedMessage(roomA, alice, 'not cited');

    // Cited in the wrong order on purpose: the window is the room's order, not the
    // payload's.
    const appended = await append(acceptance(roomA, [second, first]));
    expect(appended.trustedMessages).toEqual([
      { id: first, authorId: alice, body: 'first' },
      // A message whose author is gone keeps its text and loses its name — '' and
      // not null, because attribution to '' matches no actor.
      { id: second, authorId: '', body: 'second' },
    ]);
    expect(JSON.stringify(appended.trustedMessages)).not.toContain(uncited);
  });

  it('will not put another room’s message in a room’s receipt window', async () => {
    /**
     * The room-scoping half, and a defect in its own right: the TypeScript
     * derivation this replaced looked messages up **by id alone**, so a model
     * acceptance in room A could be handed the text of a message from room B and
     * check its receipt against a conversation the room never had. @atrium/core's
     * own `TrustedContext` doc says "the room's own message table"; the derivation
     * did not say it until now.
     *
     * Catches: dropping `WHERE m.room_id = p_room_id` from `atrium_receipt_window`
     * — the mutant `receipt_window_ignores_the_room`.
     */
    const bob = await seedUser('bob');
    const foreign = await seedMessage(roomB, bob, 'said in another room entirely');

    const appended = await append(acceptance(roomA, [foreign]));
    // `[]`, not the foreign message: the citation was looked for in this room and
    // found nothing. `[]` rather than NULL matters — #21's reducer refuses an
    // empty window and an absent one for different reasons, and a replay has to be
    // able to report the same one.
    expect(appended.trustedMessages).toEqual([]);
  });

  it('gives a human acceptance no window at all', async () => {
    // A person reading the room is the receipt, so #21's gate does not run and the
    // column stays NULL. Catches: deriving a window for every actor kind, which
    // would make `null` unreachable and collapse two refusal reasons into one.
    const room = await seedRoom(handle, ['yves'], { slug: 'room-y' });
    const yves = room.people.yves as string;
    const message = await seedMessage(room.roomId, yves, 'a thing');

    const human = acceptance(room.roomId, [message]);
    human.actorKind = 'human';
    human.actorId = yves;
    expect((await append(human)).trustedMessages).toBeNull();

    // …and a plain ledger event, which has no receipt of any kind.
    expect((await append(ledgerRow(room.roomId))).trustedMessages).toBeNull();
  });

  it('gives an acceptance that cites nothing a null window rather than an empty one', async () => {
    // Absent and empty are different facts: "no window was called for" against
    // "one was looked for and came back empty". Catches: returning `'[]'::jsonb`
    // for an acceptance with no citations, which would make every uncited model
    // acceptance replay as a receipt failure instead of as no receipt at all.
    expect((await append(acceptance(roomA, []))).trustedMessages).toBeNull();
  });

  it('refuses a lifted room that disagrees with the room the payload declares', async () => {
    /**
     * The other half of the round-5 append-surface audit, and the same class as
     * `payload_id_matches` and `payload_type_matches`: `room_id` was a lifted
     * column nothing compared to the payload.
     *
     * A direct caller could file an event under room A whose payload says room B.
     * The fan-out reads the column and delivers to A's subscribers; the fold reads
     * the payload and files the object under B; `since(A, n)` then serves a row
     * that folded into another room. Catches: dropping
     * `core_events_payload_room_matches`.
     */
    await violatesConstraint('core_events_payload_room_matches', () =>
      append(ledgerRow(roomA, { payloadRoomId: roomB })),
    );
    // The nested spellings too: an object, a proposal and a relation each carry
    // their room one level down, and a check that only read the bare `roomId`
    // would cover two of the eight event kinds.
    await violatesConstraint('core_events_payload_room_matches', () =>
      append(acceptance(roomA, [], roomB)),
    );
    // …and the three kinds that declare no room at all are still appendable, so
    // long as the room they are filed into is the one their subject lives in.
    // That half moved into the append boundary in 0007 and has its own block
    // below; here it is only the check being total rather than a ban on half the
    // union.
    const proposalId = randomUUID();
    await append(recording(roomA, proposalId));
    await expect(append(rejection(roomA, proposalId))).resolves.toBeDefined();
  });
});

/**
 * The room is decided by the event's **kind**, not by which room key happens to
 * be in the payload (#22 gauntlet r5 delta, blocking).
 *
 * The finding, in full, because the exploit is the whole argument:
 *
 * > `core_events_payload_room_matches` coalesces over every nested room key a
 * > payload might carry, and coalesce is order-of-keys rather than order-of-kind.
 * > JSONB accepts extra keys; Zod strips them only after the row exists. So
 * > `object_accepted` with `p_room_id = B`, a real `object.roomId = A`, and a
 * > smuggled `proposal: {roomId: B}` passes on the smuggled key — fan-out uses B,
 * > the fold uses A, and `since(B, n)` serves a row that folded into another room.
 *
 * Round 5's own test for this constraint is directly above, and it is why the
 * defect survived a round: **it only ever exercised honest shapes.** Every case
 * it drove had exactly the room key its kind declares, so a check that reads the
 * *first* room key and a check that reads the *right* one are the same check
 * against it. The mutant was no better — it dropped the constraint outright,
 * which is the loud failure, and said nothing about the shape of what replaced it.
 *
 * So the fixtures here are the dishonest shapes, and they are exhaustive rather
 * than illustrative: **every kind, crossed with every room key belonging to some
 * other kind's shape.** A check that reads any key but its own fails at least one
 * cell of that product, whichever key it happens to prefer.
 *
 * Both values are tried for each smuggled key — the row's own room and the other
 * room — because the refusal is about the key being *present*, not about its
 * value. A check that compared values and ignored provenance would pass the first
 * half of every pair and leave the exploit intact for the second.
 */
describe('core_events — the room key is the one this kind declares, and no other', () => {
  /** The four places a room can be spelled in a ledger payload. */
  const ROOM_KEYS = ['proposal.roomId', 'object.roomId', 'relation.roomId', 'roomId'] as const;
  type RoomKey = (typeof ROOM_KEYS)[number];

  /**
   * The room key each kind's shape actually carries, or `null` for the three that
   * name a subject instead. This is `declaredRoomId` in
   * `apps/server/src/room-events.ts`, as a table.
   */
  const OWN_KEY: Record<string, RoomKey | null> = {
    proposal_recorded: 'proposal.roomId',
    object_accepted: 'object.roomId',
    relation_added: 'relation.roomId',
    message_posted: 'roomId',
    attention_resolved: 'roomId',
    proposal_rejected: null,
    proposal_superseded: null,
    object_corrected: null,
  };

  /** Write a room key into a payload at one of the four spellings. */
  function smuggle(payload: Record<string, unknown>, key: RoomKey, value: string): void {
    if (key === 'roomId') {
      payload.roomId = value;
      return;
    }
    const [container] = key.split('.') as [string];
    const existing = (payload[container] ?? {}) as Record<string, unknown>;
    payload[container] = { ...existing, roomId: value };
  }

  /**
   * The subjects the three room-less kinds name.
   *
   * They have to be real: 0007's boundary resolves a rejection or a correction
   * back to the room its proposal or object was minted in, so a fixture with an
   * invented subject would be refused for that reason and never reach the CHECK
   * this block is about. Seeded in `roomA` once per test.
   */
  let proposalId: string;
  let objectId: string;

  beforeEach(async () => {
    proposalId = randomUUID();
    objectId = randomUUID();
    await append(recording(roomA, proposalId));
    await append(acceptedObject(roomA, objectId));
  });

  it('refuses every kind a room key smuggled from another kind’s shape', async () => {
    /**
     * The five kinds that declare a room, each crossed with the three room keys
     * that belong to somebody else's shape, at both values.
     *
     * Catches: `payload_room_check_is_kind_blind` — r5's `coalesce`, which reads
     * whichever key comes first in its list. Concretely, the first cell of this
     * product is the finding's own exploit: an `object_accepted` whose real room
     * is A, filed into A, carrying `proposal: {roomId: A}` — under the coalesce
     * that row installs, and so does the version of it where the column says B.
     */
    let refused = 0;
    for (const [type, own] of Object.entries(OWN_KEY)) {
      if (own === null) continue;
      for (const key of ROOM_KEYS) {
        if (key === own) continue;
        for (const value of [roomA, roomB]) {
          const row = kindRow(type, roomA, { proposalId, objectId });
          smuggle(row.payload as Record<string, unknown>, key, value);
          await violatesConstraint('core_events_payload_room_matches', () => append(row));
          refused += 1;
        }
      }
    }
    // Non-vacuous, and the count is the product: 5 kinds × 3 foreign keys × 2
    // values. A loop that silently stopped iterating would otherwise pass.
    expect(refused).toBe(30);
  });

  it('refuses a room key on the three kinds that declare none', async () => {
    /**
     * The other half, and the one r5's `coalesce` could not refuse at all:
     * `proposal_rejected`, `proposal_superseded` and `object_corrected` reach the
     * fall-through, so `room_id = room_id` held for *any* payload — including one
     * carrying a room key naming another room entirely.
     *
     * Catches: `payload_room_check_is_kind_blind`.
     */
    let refused = 0;
    for (const [type, own] of Object.entries(OWN_KEY)) {
      if (own !== null) continue;
      for (const key of ROOM_KEYS) {
        for (const value of [roomA, roomB]) {
          const row = kindRow(type, roomA, { proposalId, objectId });
          smuggle(row.payload as Record<string, unknown>, key, value);
          await violatesConstraint('core_events_payload_room_matches', () => append(row));
          refused += 1;
        }
      }
    }
    // 3 kinds × 4 keys × 2 values.
    expect(refused).toBe(24);
  });

  it('accepts every kind carrying exactly the room key its own shape declares', async () => {
    /**
     * The non-vacuity half, and it is load-bearing: a constraint that refused
     * everything would satisfy both tests above. Every one of the eight kinds is
     * appended honestly into `roomA` and lands.
     *
     * Catches: a check that requires a room key of the wrong kind, or requires one
     * of the three room-less kinds to carry a room after all — the mirror-image
     * mistake of the one this round fixed, and the one an over-tightened `CASE`
     * would make.
     */
    let landed = 0;
    for (const type of Object.keys(OWN_KEY)) {
      const row = kindRow(type, roomA, { proposalId, objectId });
      await expect(append(row)).resolves.toBeDefined();
      landed += 1;
    }
    expect(landed).toBe(8);
    // …and the whole union is covered rather than the half somebody remembered.
    // Against the database's own enum, so a ninth kind added to `event_type`
    // fails here rather than quietly going untested by both loops above.
    expect(new Set(Object.keys(OWN_KEY))).toEqual(new Set(eventType.enumValues));
  });

  it('refuses a rejection filed into a room its proposal does not live in', async () => {
    /**
     * The half no CHECK can reach (#22 gauntlet r5 delta, major 2).
     *
     * > Room-less kinds still admit a `room_id` lie via direct SQL […]
     * > `resolveRoomId` covers the command path only.
     *
     * "Which room is proposal P in" is a fact about *another row*, and a CHECK
     * sees one row. So the boundary answers it: `atrium_append_core_event`
     * resolves the named proposal back to the room its own `proposal_recorded`
     * landed in. The proposal here is `roomA`'s; filing its rejection into `roomB`
     * would give the fan-out one room and the fold another.
     *
     * Catches: `append_trusts_a_room_less_kind`.
     */
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(rejection(roomB, proposalId)),
    );
    // The superseding spelling of the same event takes the same path.
    const superseded = rejection(roomB, proposalId);
    superseded.type = 'proposal_superseded';
    (superseded.payload as Record<string, unknown>).type = 'proposal_superseded';
    await violatesConstraint('core_events_subject_room_matches', () => append(superseded));
    // …and the honest one lands, so this is a check and not a ban.
    await expect(append(rejection(roomA, proposalId))).resolves.toBeDefined();
  });

  it('refuses a correction filed into a room its object does not live in', async () => {
    // The `object_corrected` arm of the same resolution — a separate branch in the
    // boundary reading a separate index, so a test for one is not a test for the
    // other. Catches: `append_trusts_a_room_less_kind`.
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(correction(roomB, objectId)),
    );
    await expect(append(correction(roomA, objectId))).resolves.toBeDefined();
  });

  it('refuses a rejection whose proposal is not in the ledger at all', async () => {
    /**
     * An unresolvable subject is a refusal, not a default — the same answer
     * `resolveRoomId` gives on the command path ("unknown proposal"), which the
     * server already returns as a nack before the append. Falling back to the
     * lifted column instead would be the fail-open: an event nobody can place
     * would be placed wherever its caller said.
     *
     * Catches: `append_trusts_a_room_less_kind`.
     */
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(rejection(roomA, randomUUID())),
    );
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(correction(roomA, randomUUID())),
    );
  });

  it('returns the window by RETURNING of the stored column, not the value it meant to store', async () => {
    /**
     * A **structural** pin, and it is called one because it cannot be anything
     * else (#22 gauntlet r5 delta, polish).
     *
     * > the append returns the *intended* window rather than a `RETURNING` of the
     * > stored column, which overclaims "returns what it stored".
     *
     * Granted, and fixed — but the two values are identical today, because nothing
     * sits between the intent and the row: no BEFORE trigger rewrites
     * `trusted_messages` and no DEFAULT applies to it. So no behavioural test can
     * tell the corrected version from the overclaiming one, and a test that
     * pretended to would be measuring something else. What is asserted is exactly
     * what changed: the value leaves the function through the row.
     *
     * Read off `prosrc` — what the database has — rather than the migration text.
     *
     * Catches: `append_returns_the_window_it_meant_to_store`.
     */
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(fn?.src).toContain(
      'RETURNING "core_events"."seq", "core_events"."trusted_messages" INTO v_seq, v_stored',
    );
    expect(fn?.src).toContain('"trusted_messages" := v_stored;');
    // And the value it meant to store is not what leaves: `v_window` is written
    // into the row and never assigned to the OUT parameter.
    expect(fn?.src).not.toContain('"trusted_messages" := v_window;');
  });
});

/**
 * The `at` type and the `at` CHECK admit exactly the same strings
 * (#22 gauntlet r4 delta, major 1).
 *
 * > `at` type/CHECK parity is false — `z.iso.datetime({ offset: true })` accepts
 * > non-`Z` offsets and other spellings while the CHECK accepts only `…SS.mmmZ`,
 * > so "one ISO spelling on both sides" does not hold.
 *
 * The fix is not two rules that agree: `CANONICAL_TIMESTAMP` in @atrium/core is
 * the pattern, and `packages/db/src/schema.ts` interpolates its `source` into the
 * CHECK. This measures that the two *engines* agree about it, which is the part
 * sharing a string does not buy — Postgres's advanced regular expressions and
 * JavaScript's are different implementations of overlapping languages.
 *
 * **The pattern it asks Postgres about is read off the deployed CHECK**, not
 * handed to Postgres by the test. The first draft did the latter and the mutant
 * ledger caught it: `at_check_is_shape_only` and
 * `canonical_timestamp_edited_without_a_migration` each moved one side of the
 * real rule and this fuzz stayed green, because both of *its* sides came from the
 * same constant. A parity test whose two operands are the same value is a test
 * that the value equals itself — the #10 r7 lesson (a guard over a relationship
 * is only as good as the provenance of its operands) arriving in the shape of a
 * regular expression.
 */
describe('canonical `at` — the type and the CHECK are one rule', () => {
  /**
   * The pattern the database is enforcing right now, out of `pg_constraint`.
   *
   * `pg_get_constraintdef` renders the CHECK as `… ~ '<pattern>'::text`, and
   * Postgres doubles any embedded quote on the way out.
   */
  async function deployedPattern(): Promise<string> {
    const [row] = await handle.db.execute<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'core_events'::regclass
            AND conname = 'core_events_payload_at_is_canonical_utc'`,
    );
    const matched = /~ '(.*)'::text/s.exec(row?.def ?? '');
    if (!matched) throw new Error(`no pattern in the deployed CHECK: ${row?.def}`);
    return (matched[1] as string).replace(/''/g, "'");
  }

  /** Ask Postgres, one round trip for the whole corpus. */
  async function sqlAccepts(values: readonly string[]): Promise<boolean[]> {
    const pattern = await deployedPattern();
    const rows = await handle.db.execute<{ idx: number; ok: boolean }>(sql`
      SELECT t.idx, (t.s ~ ${sql.raw(`'${pattern.replace(/'/g, "''")}'`)}) AS ok
      FROM json_to_recordset(${JSON.stringify(
        values.map((s, idx) => ({ idx, s })),
      )}::json) AS t(idx int, s text)
      ORDER BY t.idx
    `);
    return rows.map((row) => row.ok);
  }

  it('accepts and refuses exactly the same strings as @atrium/core’s Timestamp', async () => {
    /**
     * Generated across the area the two sides ever disagreed about, plus the
     * hand-picked cases a generator produces too rarely to rely on: every ISO
     * spelling r4's type admitted and its CHECK refused, both leap-year rules, the
     * ends of every field's range, and the impossible dates a shape-only check
     * lets through.
     *
     * The assertion is on the *disagreements*, so this is not a test that the
     * pattern is right — it is a test that there is one pattern, being enforced
     * in two places. Catches: loosening either side — `core_timestamp_accepts_any_iso`
     * moves the type, `at_check_is_shape_only` moves the deployed CHECK, and
     * `canonical_timestamp_edited_without_a_migration` moves the constant without
     * moving the database.
     *
     * ## What "exact parity" is, for the values nobody can represent
     * (#22 gauntlet r5 delta, polish)
     *
     * > leap-second and non-Gregorian parity is exact only by joint refusal, not
     * > correct acceptance — worth stating as the property it is.
     *
     * Correct, and the distinction is worth keeping because the two look identical
     * in an empty `disagreements` array. `:60` as a seconds field is a real UTC
     * value (`2016-12-31T23:59:60.000Z` happened); both sides refuse it, so they
     * agree, and neither is *right* about it — the ledger simply cannot represent a
     * leap second, and `Date` cannot either. Dates before the Gregorian cutover are
     * the same shape: `1582-10-05` never existed in the calendar the pattern's
     * leap-year rule describes, both sides accept it, and both are wrong together.
     *
     * So the property this asserts is **agreement, not correctness**, and the
     * corpus deliberately contains cases where agreement is joint refusal (`:60`
     * above, in the seconds sweep) and cases where it is joint acceptance of
     * something the calendar never had. Neither is a defect in this test; claiming
     * the test proves the pattern is *right about time* would be. What the ledger
     * needs is that one spelling of one instant reaches both engines, and it does.
     */
    const candidates: string[] = [];
    const pad = (n: number, width: number) => String(n).padStart(width, '0');

    // The spellings a caller might reasonably send. Every one of these was legal
    // to `z.iso.datetime({ offset: true })` and refused by the CHECK.
    candidates.push(
      '2026-08-01T12:00:03.000Z',
      '2026-08-01T12:00:03Z',
      '2026-08-01T12:00:03.00Z',
      '2026-08-01T12:00:03.0000Z',
      '2026-08-01T12:00:03.000+00:00',
      '2026-08-01T14:00:03.000+02:00',
      '2026-08-01T12:00:03.000-05:00',
      '2026-08-01T12:00:03',
      '2026-08-01 12:00:03.000Z',
      '2026-08-01t12:00:03.000Z',
      '2026-08-01T12:00:03.000z',
      ' 2026-08-01T12:00:03.000Z',
      '2026-08-01T12:00:03.000Z ',
      '2026-08-01T12:00:03.000Z\n',
    );

    // Every field walked past both of its edges, so a range written `[0-9]{2}` on
    // one side and `[0-5]\d` on the other cannot survive.
    for (const month of [0, 1, 9, 10, 12, 13, 19, 99]) {
      candidates.push(`2026-${pad(month, 2)}-15T00:00:00.000Z`);
    }
    for (const day of [0, 1, 28, 29, 30, 31, 32, 39]) {
      candidates.push(`2026-01-${pad(day, 2)}T00:00:00.000Z`);
      // …and against a 30-day month, which is where a month-agnostic day range
      // and a month-aware one part company.
      candidates.push(`2026-04-${pad(day, 2)}T00:00:00.000Z`);
      candidates.push(`2026-02-${pad(day, 2)}T00:00:00.000Z`);
    }
    for (const hour of [0, 12, 23, 24, 25, 99]) {
      candidates.push(`2026-01-15T${pad(hour, 2)}:00:00.000Z`);
    }
    for (const minute of [0, 59, 60, 99]) {
      candidates.push(`2026-01-15T00:${pad(minute, 2)}:00.000Z`);
    }
    for (const second of [0, 59, 60, 99]) {
      candidates.push(`2026-01-15T00:00:${pad(second, 2)}.000Z`);
    }
    // The leap-year rule, in all four of its cases.
    for (const year of [1900, 2000, 2024, 2026, 2027, 2028, 2100, 2400]) {
      candidates.push(`${year}-02-29T00:00:00.000Z`);
      candidates.push(`${year}-02-28T00:00:00.000Z`);
    }
    // And a deterministic sweep, so the corpus is not only what a person thought
    // of. Seeded: a fuzz that cannot be re-run on the input that failed reports a
    // mystery.
    let state = 0x41_54_52_35;
    const next = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const pick = <T>(options: readonly T[]) => options[Math.floor(next() * options.length)] as T;
    for (let i = 0; i < 400; i += 1) {
      const year = 1970 + Math.floor(next() * 80);
      const month = 1 + Math.floor(next() * 13);
      const day = 1 + Math.floor(next() * 32);
      const hour = Math.floor(next() * 25);
      const minute = Math.floor(next() * 61);
      const second = Math.floor(next() * 61);
      const fraction = pick(['', '.0', '.00', '.000', '.0000', '.123', '.12']);
      const zone = pick(['Z', 'z', '', '+00:00', '-03:00', '+0000', 'UTC']);
      candidates.push(
        `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${fraction}${zone}`,
      );
    }

    const fromSql = await sqlAccepts(candidates);
    const disagreements = candidates
      .map((value, index) => ({
        value,
        sql: fromSql[index] === true,
        zod: Timestamp.safeParse(value).success,
      }))
      .filter((row) => row.sql !== row.zod);

    // The whole finding, as an empty array.
    expect(disagreements).toEqual([]);
    // Not vacuous in either direction: the corpus contains values both sides take
    // and values both sides refuse, so a pattern that matched everything or
    // nothing would fail here rather than pass silently.
    expect(candidates.filter((v) => Timestamp.safeParse(v).success).length).toBeGreaterThan(20);
    expect(candidates.filter((v) => !Timestamp.safeParse(v).success).length).toBeGreaterThan(100);
  });

  it('is the same pattern in the deployed CHECK as in @atrium/core', async () => {
    // The two engines agreeing is only worth something if they are reading the
    // same string. Read off the deployed constraint rather than the migration
    // file: a migration is what the repo says, `pg_get_constraintdef` is what the
    // database has. Catches: editing `CANONICAL_TIMESTAMP` without a migration,
    // and writing the CHECK out by hand again.
    const [row] = await handle.db.execute<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'core_events'::regclass
            AND conname = 'core_events_payload_at_is_canonical_utc'`,
    );
    expect(row?.def).toContain(CANONICAL_TIMESTAMP.source);
  });

  it('refuses every spelling the boundary can be handed', async () => {
    // The parity fuzz compares two regular expressions; this drives the real
    // append. Catches: a CHECK that is correct and not attached to the column the
    // boundary writes.
    for (const at of [
      '2026-08-01T12:00:03Z',
      '2026-08-01T12:00:03.000+00:00',
      '2026-13-45T00:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2026-01-01T25:00:00.000Z',
    ]) {
      await violatesConstraint('core_events_payload_at_is_canonical_utc', () =>
        append(ledgerRow(roomA, { at, occurredAt: '2026-08-01T12:00:03.000Z' })),
      );
    }
  });
});

/**
 * The structural pin, extended to the CHECK (#22 gauntlet r4 delta, major).
 *
 * > the ID ASCII CHECK is locale-dependent — Postgres bracket ranges are
 * > collation-dependent, so `[!-~]` without `COLLATE "C"` is not a durable ASCII
 * > guarantee, and the `prosrc`/`indexdef` structural pin covers the function and
 * > index but not this CHECK.
 *
 * Both halves granted. r4's own receipt already recorded why a behavioural test
 * cannot see this: the compose image's `en_US.utf8` behaves as byte order because
 * the locale data is not generated, so `strcoll` degrades to `strcmp` and every
 * value this suite can generate compares identically with and without the
 * collation. The same is true of a bracket range. So it is measured the way the
 * r1 advisory-lock key was — by reading what is deployed.
 */
describe('COLLATE "C" — asserted in the deployed objects, because behaviour cannot show it', () => {
  it('evaluates the id charset CHECK under COLLATE "C"', async () => {
    /**
     * A regex bracket range is resolved in the collation of its input. Under a
     * generated glibc or an ICU locale `[!-~]` means "everything that sorts
     * between `!` and `~`", which admits accented letters and much else — so the
     * constraint would stop enforcing the subset in which the reducer's UTF-16
     * order and the gate's byte order are one order, on every deployment except
     * this image.
     *
     * Catches: re-adding `core_events_id_is_safe_to_order` without the collation —
     * the mutant `id_charset_check_loses_its_collation`, which no behavioural test
     * in this suite can see.
     */
    const [row] = await handle.db.execute<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'core_events'::regclass
            AND conname = 'core_events_id_is_safe_to_order'`,
    );
    expect(row?.def).toContain('COLLATE "C"');
    // Positioned on the subject rather than anywhere in the expression: a
    // collation on the pattern would parse and would do nothing.
    expect(row?.def).toMatch(/\(id COLLATE "C"\)\s*~/);
  });

  it('says out loud that this image cannot tell the difference', async () => {
    // The honest limit, asserted rather than left in a comment. If a future image
    // ships a collation that really is variable-weight, this flips and somebody
    // finds out from a test rather than from a divergent ledger.
    const [row] = await handle.db.execute<{ agrees: boolean; collation: string }>(
      sql`SELECT ('a-b' < 'ab') = (('a-b' COLLATE "C") < ('ab' COLLATE "C")) AS agrees,
                 (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collation`,
    );
    expect(typeof row?.agrees).toBe('boolean');
    expect(typeof row?.collation).toBe('string');
  });
});

/**
 * The FK audit in `0006_derived_receipt_snapshot.sql`, derived from the catalog.
 *
 * 0005 shipped a "full FK audit" that named `attention_items.created_by` — a
 * column that does not exist, under a delete action it does not have, while
 * omitting `relations.created_by` entirely. The finding is right that this makes
 * the whole audit worthless: nothing in a prose list tells a reader which of its
 * other rows are also wrong.
 *
 * So the audit is pinned to the database rather than maintained by hand. A schema
 * change that adds, removes or retypes a delete action fails here, in the same
 * commit, with the message that the migration header has to be updated too.
 */
describe('foreign keys — the audit is the catalog, not a paragraph', () => {
  it('has exactly the delete actions 0006’s audit lists', async () => {
    const rows = await handle.db.execute<{ name: string; action: string }>(
      sql`SELECT c.conname AS name, c.confdeltype AS action
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.contype = 'f' AND n.nspname = 'public' AND c.confdeltype <> 'a'
          ORDER BY c.confdeltype, c.conname`,
    );
    const of = (action: string) =>
      rows.filter((row) => row.action === action).map((row) => row.name);

    // `n` = SET NULL. Every one is a projection column written *from* the ledger's
    // trusted actor columns and read back for display; the authority lives in
    // `core_events.actor_kind`/`actor_id`, which have no FK to `users` at all.
    expect(of('n')).toEqual([
      'accepted_objects_accepted_by_users_id_fk',
      'corrections_by_user_id_users_id_fk',
      'messages_author_id_users_id_fk',
      'proposals_decided_by_users_id_fk',
      'proposals_interpretation_id_interpretations_id_fk',
      'proposals_proposer_user_id_users_id_fk',
      'relations_created_by_users_id_fk',
      'rooms_created_by_users_id_fk',
    ]);

    // `c` = CASCADE. Room deletes take the ledger with them (the row is gone, not
    // misremembered), user deletes take per-person rows, and the rest are
    // provenance link tables the reducer never reads.
    expect(of('c')).toEqual([
      'accepted_objects_room_id_rooms_id_fk',
      'attention_items_object_same_room_fk',
      'attention_items_proposal_same_room_fk',
      'attention_items_room_id_rooms_id_fk',
      'attention_items_user_id_users_id_fk',
      'core_events_room_id_rooms_id_fk',
      'corrections_object_same_room_fk',
      'corrections_room_id_rooms_id_fk',
      'interpretations_message_id_messages_id_fk',
      'memberships_room_id_rooms_id_fk',
      'memberships_user_id_users_id_fk',
      'messages_room_id_rooms_id_fk',
      'object_sources_message_same_room_fk',
      'object_sources_object_same_room_fk',
      'object_sources_room_id_rooms_id_fk',
      'proposal_sources_message_same_room_fk',
      'proposal_sources_proposal_same_room_fk',
      'proposal_sources_room_id_rooms_id_fk',
      'proposals_room_id_rooms_id_fk',
      'relations_from_object_same_room_fk',
      'relations_room_id_rooms_id_fk',
      'relations_to_message_same_room_fk',
      'relations_to_object_same_room_fk',
    ]);

    // And the stale row, named so the correction cannot be quietly re-broken:
    // there is no `attention_items.created_by` anywhere in the schema.
    const [column] = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'attention_items' AND column_name = 'created_by'`,
    );
    expect(Number(column?.n)).toBe(0);
  });

  it('leaves nothing downstream of reduce behind a delete action', async () => {
    // The rule the audit exists to enforce, stated as a query rather than as a
    // sentence: `core_events` is what `reduce` folds, and the only delete action
    // touching it removes whole rows with their room. A `SET NULL` on any
    // `core_events` column would be a fold whose inputs a later DELETE can rewrite
    // — the r3-delta class, exactly.
    const rows = await handle.db.execute<{ name: string; action: string }>(
      sql`SELECT c.conname AS name, c.confdeltype AS action
          FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid = 'core_events'::regclass`,
    );
    expect(rows.map((row) => [row.name, row.action])).toEqual([
      ['core_events_room_id_rooms_id_fk', 'c'],
    ]);
  });
});
