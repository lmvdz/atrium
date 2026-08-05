import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICAL_TIMESTAMP,
  compareCursor,
  isAboutTheWindow,
  type ProvenanceMessage,
  RECEIPT_POLICY,
  Timestamp,
  validateProposalProvenance,
} from '@atrium/core';
import { type DatabaseHandle, migrationsFolder } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  eventType,
  messages,
  proposals,
  users,
} from '@atrium/db/schema';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_ADVISORY_LOCK_KEY } from '../../apps/server/src/ledger.js';
import { describeError, violatesConstraint } from '../support/constraints.js';
import { databaseUrl } from '../support/env.js';
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

/**
 * The statements of one migration, from the file the server ships.
 *
 * Used by the privileges test to **replay the migration's own `DO` block** rather
 * than to restate the rule it encodes. A test that spelled the loop out again
 * would be a test that the test's copy of the rule does what the test's copy of
 * the rule does — the vacuity the mutant ledger's restore-from-the-migration rule
 * exists to rule out, arriving in a test instead of in an instrument.
 */
function statementsOf(file: string): string[] {
  return readFileSync(join(migrationsFolder(), file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

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
     * and 0006 all name as out of scope — a superuser with the append triggers
     * disabled. That is exactly who this constraint is for, so that is who drives
     * it, explicitly and with the triggers put back in the same test.
     *
     * **Two** triggers now, and the second one is r7's (#22 gauntlet r6, major 3):
     * `core_events_invariants` *derives* `trusted_messages` on the way in, so with
     * it enabled there is no value here for the CHECK to refuse — the column is
     * whatever `atrium_receipt_window` returned, never what the INSERT said. That
     * makes the CHECK a second line rather than the first one, which is the right
     * shape and is exactly why it still has to be tested behind the trigger that
     * now shadows it.
     *
     * Catches: dropping `core_events_trusted_messages_shape`.
     */
    await handle.db.execute(
      sql`ALTER TABLE core_events DISABLE TRIGGER core_events_append_guard, DISABLE TRIGGER core_events_invariants`,
    );
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
      await handle.db.execute(
        sql`ALTER TABLE core_events ENABLE TRIGGER core_events_append_guard, ENABLE TRIGGER core_events_invariants`,
      );
    }
    // The triggers really are back on, so a later test in this file is not running
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
   * A frame that borrows the append function's *name* is no longer a frame that
   * satisfies the guard (#22 gauntlet r6, major 3).
   *
   * Until r7 the guard read `position('function atrium_append_core_event(' in
   * PG_CONTEXT)`, and the r6 critic took that apart precisely: PL/pgSQL builds
   * each frame's label from `format_procedure` **at compile time**, which omits
   * the schema qualifier iff that schema is on `search_path` at that moment, and
   * caches it for the session. So an overload in the same schema matched, and so
   * did a function in a *different* schema compiled with that schema on the path
   * — which is `refuses an append smuggled in from another schema’s
   * atrium_append_core_event` below, the executed exploit.
   *
   * The guard now compares against `to_regprocedure(…)::text` under its own
   * `search_path = pg_catalog, pg_temp`, which renders the schema-qualified
   * signature `public.atrium_append_core_event(uuid,text,public.event_type,…)`.
   * Both the overload here (wrong argument list) and any function outside
   * `public` (wrong schema, and no search path can make `format_procedure` print
   * `public.` in front of an `evil2` function) miss it.
   *
   * **The limit is far larger than this comment said until r8, and the sentence
   * it said it in was false.** It read: "the limit that remains is stated rather
   * than hidden: a role holding CREATE on schema `public` could define the
   * colliding function there". It costs no CREATE anywhere. `PG_CONTEXT` carries
   * the verbatim statement text of every caller frame and this guard is a
   * substring search over it, so a bare `DO` block with the expected frame label
   * in a comment inside its own INSERT satisfies it — executed by r7's gauntlet,
   * and reproduced by `satisfies the call-stack check with one SQL comment` below.
   *
   * So what this test still proves is narrower than the name suggests, and worth
   * being precise about: the *name collision* of r6 is dead — an overload and a
   * function in another schema both miss the schema-qualified signature, at any
   * search path. What it does not prove, and no test of this guard could, is that
   * a caller cannot satisfy it. See `drizzle/0009` for why no rewrite fixes that
   * and what the actual boundary is.
   */
  it('refuses a spoofed call frame that borrows the append function’s name', async () => {
    await handle.db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION atrium_append_core_event(p jsonb) RETURNS void
        LANGUAGE plpgsql AS $spoof$
        BEGIN
          PERFORM pg_advisory_xact_lock(1096045106::bigint);
          INSERT INTO core_events (room_id, room_seq, id, type, actor_kind, actor_id, payload, occurred_at)
          VALUES ((p->>'roomId')::uuid, 1, p->>'id', 'message_posted',
                  'system', NULL, p->'payload', (p->>'at')::timestamptz);
        END $spoof$;
      `),
    );
    try {
      const row = ledgerRow(roomA);
      // The spoof takes the real advisory lock, so the lock half of the guard is
      // satisfied and the refusal below can only be the signature half. Under r6
      // this INSERT landed.
      await violatesConstraint('core_events_append_through_procedure', () =>
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
    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(coreEvents);
    expect(Number(count)).toBe(0);
  });

  /**
   * The exploit the r6 gauntlet executed against a real Postgres 16, run here.
   *
   * > `CREATE SCHEMA evil2; CREATE FUNCTION evil2.atrium_append_core_event(...)`
   * > … `SET search_path = evil2, public;` **before the first compile**
   * > → seq 51, room_id = room B, room_seq 9999, occurred_at 2020, for a proposal
   * > minted in room A
   *
   * Two independent things now stop it, and the test asserts both, because either
   * one alone would leave the other's sentence load-bearing:
   *
   *  1. the guard refuses the frame, because `format_procedure` can never print
   *     `public.` in front of an `evil2` function whatever the search path;
   *  2. with the guard disabled — the operator bypass everything here concedes —
   *     `core_events_invariants` still refuses it, because the rejection names a
   *     proposal minted in room A and is being filed into room B. That is the
   *     half that matters, since it is the half a call stack cannot lie its way
   *     past.
   *
   * The `search_path` is set on the same connection *before* the evil function is
   * ever called, which is what the finding turns on: the qualifier is decided at
   * compile time and cached for the session.
   */
  it('refuses an append smuggled in from another schema’s atrium_append_core_event', async () => {
    const minted = randomUUID();
    await append(recording(roomA, minted));

    // Its own connection, because the exploit is about one session's search path
    // at one moment, and the pool the rest of this file uses is shared.
    const client = postgres(databaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      await client.unsafe('CREATE SCHEMA evil2');
      await client.unsafe(`
        CREATE FUNCTION evil2.atrium_append_core_event(
          p_room_id uuid, p_event_id text, p_payload jsonb, p_room_seq bigint, p_at timestamptz
        ) RETURNS bigint LANGUAGE plpgsql AS $evil$
        DECLARE v_seq bigint;
        BEGIN
          PERFORM pg_advisory_xact_lock(1096045106::bigint);
          INSERT INTO public.core_events (room_id, room_seq, id, type, actor_kind, actor_id, payload, occurred_at)
          VALUES (p_room_id, p_room_seq, p_event_id, (p_payload->>'type')::public.event_type,
                  'system'::public.actor_kind, NULL, p_payload, p_at)
          RETURNING seq INTO v_seq;
          RETURN v_seq;
        END; $evil$;
      `);
      // Before the first compile. This is the whole mechanism of the finding.
      await client.unsafe('SET search_path = evil2, public');

      const smuggled = {
        id: randomUUID(),
        at: '2020-01-01T00:00:00.000Z',
        type: 'proposal_rejected',
        proposalId: minted,
        reason: 'no',
      };
      const call = () =>
        client.unsafe(
          `SELECT evil2.atrium_append_core_event('${roomB}'::uuid, '${smuggled.id}', '${JSON.stringify(
            smuggled,
          )}'::jsonb, 9999, '${smuggled.at}'::timestamptz)`,
        );

      // 1. the guard, on its own.
      await violatesConstraint('core_events_append_through_procedure', call);

      // 2. and the invariants, with the guard taken out of the way entirely —
      //    which is the operator bypass this file has always conceded, and the
      //    reason the guarantee could not be allowed to live in the guard.
      await client.unsafe(
        'ALTER TABLE public.core_events DISABLE TRIGGER core_events_append_guard',
      );
      try {
        await violatesConstraint('core_events_subject_room_matches', call);
      } finally {
        await client.unsafe(
          'ALTER TABLE public.core_events ENABLE TRIGGER core_events_append_guard',
        );
      }

      // Nothing landed either way: one row in the ledger, the honest one. Under
      // r6 the first call alone landed a `proposal_rejected` in room B, at
      // room_seq 9999, dated 2020, for a proposal minted in room A.
      const [{ count } = { count: 0 }] = await handle.db
        .select({ count: sql<number>`count(*)::int` })
        .from(coreEvents);
      expect(Number(count)).toBe(1);
    } finally {
      await client.unsafe('DROP SCHEMA IF EXISTS evil2 CASCADE').catch(() => undefined);
      await client.end({ timeout: 5 });
    }
  });

  /**
   * The guard is an accident check, and this is the test that says so out loud
   * (#22 gauntlet r7, defect 1 — executed).
   *
   * `GET DIAGNOSTICS … PG_CONTEXT` is the live PL/pgSQL call stack, and every
   * frame in it carries **the verbatim SQL text of the statement executing in
   * that frame**. The guard substring-searches that text for the append
   * function's label. So the evidence it reads is a document the caller wrote,
   * and the caller writes it with a comment. No CREATE, no schema, no function —
   * a bare `DO` block.
   *
   * This test asserts the bypass **works**, which is an unusual shape and the
   * right one: the defect was never the code, it was three sentences claiming
   * this guard bound an author. Those sentences are gone (`drizzle/0009`,
   * `0008`'s header, `schema.ts`, and the comment on the r6 test above). What
   * remains is a check that has to keep being *described* accurately, and a test
   * that fails the moment somebody "hardens" the substring and re-earns the
   * belief will keep it that way. If this test ever fails, the fix is not to
   * delete it — it is to read `0009` and decide whether the new claim is true.
   */
  it('satisfies the call-stack check with one SQL comment, and no privilege at all', async () => {
    const row = ledgerRow(roomA);
    const label =
      'function public.atrium_append_core_event(uuid,text,public.event_type,' +
      'public.actor_kind,text,jsonb,timestamp with time zone,text) line 1';
    // Two statements differing by exactly one comment. `body` is built once so
    // the pair genuinely cannot differ anywhere else.
    const body = (id: string, at: string, frame: string) => `
      DO $pwn$ BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(${LEDGER_ADVISORY_LOCK_KEY}::bigint);
        INSERT INTO public.core_events (room_id, id, type, actor_kind, actor_id, payload, occurred_at)
        ${frame}
        VALUES ('${roomA}'::uuid, '${id}', 'message_posted', 'system', NULL,
                '${JSON.stringify({ ...row.payload, id, at })}'::jsonb, '${at}'::timestamptz);
      END $pwn$;`;

    const controlId = randomUUID();
    const controlAt = nextAt();
    // Control: no comment, refused.
    await violatesConstraint('core_events_append_through_procedure', () =>
      handle.db.execute(sql.raw(body(controlId, controlAt, ''))),
    );

    const pwnId = randomUUID();
    const pwnAt = nextAt();
    // Exploit: the same statement with the frame label in a comment. It lands.
    await handle.db.execute(sql.raw(body(pwnId, pwnAt, `/* ${label} */`)));
    const landed = await handle.db
      .select({ id: coreEvents.id, roomSeq: coreEvents.roomSeq })
      .from(coreEvents)
      .where(eq(coreEvents.id, pwnId));
    expect(landed).toHaveLength(1);

    // And the bound that makes this MEDIUM rather than blocking: `room_seq` was
    // still minted by `core_events_invariants`, from the table, not by the
    // caller. Getting past the guard buys nothing against the rules.
    expect(Number(landed[0]?.roomSeq)).toBe(1);
  });

  /**
   * There is no unforgeable replacement, and this is the proof rather than the
   * assertion (`drizzle/0009` §"Why there is no unforgeable replacement").
   *
   * Every tempting fix for the above is session state minted inside the append
   * function and read back by the trigger. Each one is run here by a bare caller
   * in a bare `DO` block. If any of these ever stops being caller-authorable,
   * this test fails and the guard has a real option it did not have — which is
   * the only thing that would justify reopening the choice made in 0009.
   */
  it('cannot be fixed by a token, because the caller mints every one of them', async () => {
    // A transaction-local GUC — the caller sets it.
    const [guc] = await handle.db.execute<{ v: string }>(
      sql`SELECT set_config('atrium.appending', 'yes', true) AS v`,
    );
    expect(guc?.v).toBe('yes');

    // An advisory-lock token minted "inside the function" — the caller takes it,
    // exactly as the exploit above already takes the ledger lock itself.
    const [lock] = await handle.db.execute<{ held: number }>(
      sql`SELECT pg_advisory_xact_lock(8675309::bigint),
                 (SELECT count(*)::int FROM pg_locks
                   WHERE locktype='advisory' AND pid=pg_backend_pid()
                     AND objid=8675309 AND granted) AS held`,
    );
    expect(Number(lock?.held)).toBeGreaterThan(0);

    // A temp-table witness — the caller creates it. `TEMPORARY` is granted to
    // PUBLIC on every database by default, so this costs no privilege either.
    await handle.db.execute(
      sql.raw(`DO $t$ BEGIN
        CREATE TEMP TABLE atrium_append_witness(token uuid) ON COMMIT DROP;
        INSERT INTO atrium_append_witness VALUES (gen_random_uuid());
      END $t$;`),
    );

    // An unpredictable nonce — the caller mints its own and publishes it, because
    // nothing can check *which* nonce without a store the caller cannot write,
    // and caller and function are the same session and the same role.
    const [nonce] = await handle.db.execute<{ v: string }>(
      sql`SELECT set_config('atrium.append_nonce', gen_random_uuid()::text, true) AS v`,
    );
    expect(nonce?.v).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * What the guard is worth keeping for: the one accident the lock check cannot
   * see.
   *
   * A stray direct INSERT in a transaction that has already made a legitimate
   * append. The ledger advisory lock is transaction-scoped and still held, so
   * `core_events_append_lock_held` passes it — only the frame half refuses,
   * because the append function has returned and its frame is off the stack.
   *
   * This is the non-vacuity for keeping two lines that bind no adversary, and it
   * is why 0009 narrows the claim instead of deleting the check.
   */
  it('refuses a stray second write in a transaction that already appended', async () => {
    const row = ledgerRow(roomA);
    const strayId = randomUUID();
    const strayAt = nextAt();
    await violatesConstraint('core_events_append_through_procedure', () =>
      handle.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT * FROM atrium_append_core_event(${row.roomId}::uuid, ${row.id}, ${row.type}::event_type,
              ${row.actorKind}::actor_kind, ${row.actorId}, ${JSON.stringify(row.payload)}::jsonb,
              ${row.occurredAt}::timestamptz, NULL)`,
        );
        // The lock is held by this transaction now, so the lock half is satisfied
        // and any refusal below can only be the frame half.
        const [held] = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype='advisory' AND pid=pg_backend_pid()
                AND objid=${LEDGER_ADVISORY_LOCK_KEY} AND granted`,
        );
        expect(Number(held?.n)).toBeGreaterThan(0);
        await tx.execute(
          sql.raw(`
          INSERT INTO public.core_events (room_id, id, type, actor_kind, actor_id, payload, occurred_at)
          VALUES ('${roomA}'::uuid, '${strayId}', 'message_posted', 'system', NULL,
                  '${JSON.stringify({ ...row.payload, id: strayId, at: strayAt })}'::jsonb,
                  '${strayAt}'::timestamptz)`),
        );
      }),
    );
  });

  /**
   * The boundary, since it is not the guard: **INSERT privilege on the table**
   * (`drizzle/0009` §"What actually separates them").
   *
   * A role outside {owner, superuser} never reaches the trigger at all. Run as
   * such a role, the comment exploit is refused by the `REVOKE` one layer
   * earlier — while the legitimate call through the SECURITY DEFINER function
   * still works, which is what makes this a boundary rather than a ban.
   */
  it('refuses the comment exploit outright for a role that is not the table owner', async () => {
    const roleName = `atrium_guard_probe_${randomUUID().slice(0, 8)}`;
    await handle.db.execute(sql.raw(`CREATE ROLE ${roleName} LOGIN PASSWORD 'probe'`));
    try {
      await handle.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${roleName}`));
      await handle.db.execute(
        sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleName}`),
      );
      await handle.db.execute(
        sql.raw(`GRANT EXECUTE ON FUNCTION public.atrium_append_core_event(
          uuid, text, event_type, actor_kind, text, jsonb, timestamptz, text) TO ${roleName}`),
      );
      // 0003's own rule, restated for a role created after it ran.
      await handle.db.execute(
        sql.raw(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.core_events FROM ${roleName}`,
        ),
      );

      const url = new URL(databaseUrl());
      url.username = roleName;
      url.password = 'probe';
      const asRole = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        const row = ledgerRow(roomA);
        const label =
          'function public.atrium_append_core_event(uuid,text,public.event_type,' +
          'public.actor_kind,text,jsonb,timestamp with time zone,text) line 1';
        const pwnId = randomUUID();
        const pwnAt = nextAt();
        // The exploit that lands as the owner. As this role it never reaches the
        // guard — the table refuses it first.
        await expect(
          asRole.unsafe(`
            DO $pwn$ BEGIN
              PERFORM pg_catalog.pg_advisory_xact_lock(${LEDGER_ADVISORY_LOCK_KEY}::bigint);
              INSERT INTO public.core_events (room_id, id, type, actor_kind, actor_id, payload, occurred_at)
              /* ${label} */
              VALUES ('${roomA}'::uuid, '${pwnId}', 'message_posted', 'system', NULL,
                      '${JSON.stringify({ ...row.payload, id: pwnId, at: pwnAt })}'::jsonb,
                      '${pwnAt}'::timestamptz);
            END $pwn$;`),
        ).rejects.toThrow(/permission denied for table core_events/);

        // Non-vacuity, and the half that makes it a boundary and not a wall: the
        // door still opens for this role, because the function is SECURITY
        // DEFINER and runs as the owner.
        const legit = ledgerRow(roomA);
        const landed = await asRole.unsafe(
          `SELECT * FROM atrium_append_core_event('${legit.roomId}'::uuid, '${legit.id}',
             '${legit.type}'::event_type, '${legit.actorKind}'::actor_kind, NULL,
             '${JSON.stringify(legit.payload)}'::jsonb, '${legit.occurredAt}'::timestamptz, NULL)`,
        );
        expect(landed).toHaveLength(1);
      } finally {
        await asRole.end({ timeout: 5 });
      }
    } finally {
      await handle.db.execute(
        sql.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleName}`),
      );
      await handle.db.execute(
        sql.raw(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${roleName}`),
      );
      await handle.db.execute(sql.raw(`REVOKE ALL ON SCHEMA public FROM ${roleName}`));
      await handle.db.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
    }
  });

  /**
   * The claim in the database matches the claim in the source.
   *
   * The sentence is the thing that was wrong, and a sentence with no test rots.
   * `COMMENT ON FUNCTION` is what an operator reads from `\df+` at 3am, so it is
   * the copy most worth pinning.
   */
  it('says in its own COMMENT that the guard is an accident check, not a boundary', async () => {
    // The defect, first and in the words it was written in. On r7 the migration
    // said the remaining bypass "costs CREATE on schema `public`"; it costs one
    // SQL comment, which the test above executes.
    const migrations = [
      '0008_invariants_on_the_table.sql',
      '0009_the_guard_stops_claiming_an_author.sql',
    ]
      .map((f) => readFileSync(join(migrationsFolder(), f), 'utf8'))
      .join('\n');
    expect(migrations).not.toContain('What is left costs CREATE on schema\n-- `public`');

    // And the database's own copy, which is what an operator reads from `\df+`
    // at 3am with no migration header in front of them. On r7 this function had
    // no COMMENT at all, so the only claim about it available in the database was
    // the refusal message — which asserted append-only-ness.
    const [guard] = await handle.db.execute<{ c: string | null }>(
      sql`SELECT obj_description('public.atrium_core_events_append_guard()'::regprocedure, 'pg_proc') AS c`,
    );
    expect(guard?.c, 'the append guard has no COMMENT describing what it is').toEqual(
      expect.any(String),
    );
    expect(guard?.c).toContain('ACCIDENT CHECK');
    expect(guard?.c).toContain('does NOT bind an adversary');
    expect(guard?.c).toContain('one SQL comment');
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
describe('core_events — the table is the authorization boundary', () => {
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

  it('grants the door to exactly the roles its own heuristic names', async () => {
    /**
     * The migration's privilege loop is `rolcanlogin AND NOT rolsuper AND
     * rolname <> owner AND has_table_privilege(role, 'core_events', 'SELECT')`,
     * and what it grants is EXECUTE on the append function. That is how 0004
     * identifies the application role without being told its name.
     *
     * The function's `COMMENT` said "EXECUTE is granted to the application role
     * only", which is **not what that loop does**: a read-only LOGIN role that
     * already holds SELECT — an auditor, a metrics scraper — matches it too, and
     * comes out able to append a `system`-actor event into any room it can name.
     * A foreign-lineage review of r7's own diff found the sentence, and found
     * that r7's first attempt at this test passed for the wrong reason twice: it
     * created the role `NOLOGIN` and *after* the migrations, so it could never
     * have matched the loop it claimed to be about.
     *
     * So this runs the real rule against real roles: two of them, differing only
     * in the thing the heuristic keys on, with the migration's own block replayed
     * over them. The point is not that the posture is *good* — it is wider than
     * the comment claimed and that is now written down in 0008 and routed — but
     * that it is **known**, and that nobody has to re-derive it from a `DO` block
     * to find out what a `GRANT SELECT` costs.
     */
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const reader = `atrium_reader_${suffix}`;
    const stranger = `atrium_stranger_${suffix}`;
    const privileges = statementsOf('0008_invariants_on_the_table.sql').find((statement) =>
      statement.includes('$privileges$'),
    );
    if (!privileges) throw new Error('0008 has no privileges block to replay');

    await handle.db.execute(sql.raw(`CREATE ROLE "${reader}" LOGIN`));
    await handle.db.execute(sql.raw(`CREATE ROLE "${stranger}" LOGIN`));
    try {
      // The only difference between them, and the only thing the loop reads.
      await handle.db.execute(sql.raw(`GRANT SELECT ON TABLE public.core_events TO "${reader}"`));
      await handle.db.execute(sql.raw(privileges));

      const [granted] = await handle.db.execute<Record<string, boolean>>(
        sql`SELECT
              has_function_privilege(${reader}, p.oid, 'EXECUTE') AS "reader",
              has_function_privilege(${stranger}, p.oid, 'EXECUTE') AS "stranger",
              has_function_privilege('public', p.oid, 'EXECUTE') AS "everyone"
            FROM pg_proc p
            WHERE p.proname = 'atrium_append_core_event'
              AND p.pronamespace = 'public'::regnamespace`,
      );
      // The posture as it actually is: SELECT buys the door; nothing buys it for
      // a role without SELECT; PUBLIC never holds it.
      expect(granted).toEqual({ reader: true, stranger: false, everyone: false });

      // And the table itself stays read-only for both, which is the half the
      // `REVOKE` in 0003 is responsible for and which nothing had asserted.
      for (const role of [reader, stranger]) {
        const [table] = await handle.db.execute<Record<string, boolean>>(
          sql`SELECT
                has_table_privilege(${role}, 'public.core_events', 'INSERT') AS "insert",
                has_table_privilege(${role}, 'public.core_events', 'UPDATE') AS "update",
                has_table_privilege(${role}, 'public.core_events', 'DELETE') AS "delete",
                has_table_privilege(${role}, 'public.core_events', 'TRUNCATE') AS "truncate"`,
        );
        expect(table).toEqual({
          insert: false,
          update: false,
          delete: false,
          truncate: false,
        });
      }
      const [pub] = await handle.db.execute<Record<string, boolean>>(
        sql`SELECT has_table_privilege('public', 'public.core_events', 'INSERT') AS "insert"`,
      );
      expect(pub).toEqual({ insert: false });
    } finally {
      await handle.db.execute(sql.raw(`REVOKE ALL ON TABLE public.core_events FROM "${reader}"`));
      for (const role of [reader, stranger]) {
        await handle.db.execute(
          sql.raw(
            `REVOKE ALL ON FUNCTION public.atrium_append_core_event(uuid, text, event_type, actor_kind, text, jsonb, timestamptz, text) FROM "${role}"`,
          ),
        );
        await handle.db.execute(
          sql.raw(
            `REVOKE ALL ON FUNCTION public.atrium_receipt_window(uuid, actor_kind, jsonb) FROM "${role}"`,
          ),
        );
        await handle.db.execute(sql.raw(`DROP ROLE "${role}"`));
      }
    }
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
   * database can check, so both are checked — the ordering gate in the
   * `core_events_invariants` trigger since r7, the duplicate gate by
   * `core_events_id_key` — and with them enforced, no caller can put a row in
   * this table that a replay would refuse **for position**, which is the
   * invariant the whole ticket rests on. Not "refuse to fold": a replay also
   * refuses a payload `RoomEvent.parse` rejects, and SQL runs no zod. That
   * residue is #46 and the claim is scoped to exclude it (r6 major 2's sweep).
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
  it('emits the doorbell for every row that reaches the table, with the appending origin', async () => {
    /**
     * `apps/server/src/event-bus.ts` says "no writer can insert a row silently —
     * including a writer that is not this application", and until r7 the
     * `pg_notify` was inside `atrium_append_core_event`, which made that sentence
     * false for exactly the writer it named: the r6 gauntlet landed a row through
     * a different function and nothing rang. It is an AFTER INSERT trigger now
     * (`core_events_doorbell`), so the second half of this test is the sentence.
     *
     * Catches: moving `pg_notify` back into the application, and moving it back
     * into the append function.
     */
    const notifications: string[] = [];
    const listener = await handle.sql.listen('atrium_ledger', (raw) => {
      notifications.push(raw);
    });
    try {
      const appended = await append(ledgerRow(roomA), 'instance-under-test');
      await until(() => notifications.length > 0, 5_000, 'a ledger notification');
      const note = JSON.parse(notifications[0] as string) as Record<string, unknown>;
      expect(note).toMatchObject({
        origin: 'instance-under-test',
        roomId: roomA,
        seq: appended.seq,
        roomSeq: appended.roomSeq,
      });

      // And a writer that is not the append function at all — in the **same
      // transaction** as an append that did name itself, which is the only case
      // where "the doorbell consumes the origin" is a claim rather than a
      // description. `atrium.origin` is a transaction-local GUC; without the
      // clear inside the doorbell, this row would inherit `instance-under-test`
      // and be ignored by the one instance that most needs to fold it.
      //
      // The guard is the thing being stepped around, so it is stepped around
      // explicitly. The invariants trigger is left on, which is why this row is
      // legal at all — it gets its `room_seq` and its window from the table.
      await handle.db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE core_events DISABLE TRIGGER core_events_append_guard`);
        const named = ledgerRow(roomA);
        await tx.execute(sql`
          SELECT "seq" FROM atrium_append_core_event(
            ${roomA}::uuid, ${named.id}::text, 'message_posted'::event_type, 'system'::actor_kind,
            NULL::text, ${JSON.stringify(named.payload)}::jsonb, ${named.occurredAt}::timestamptz,
            'instance-under-test'::text)
        `);
        const stranger = ledgerRow(roomA);
        await tx.execute(sql`
          INSERT INTO core_events (room_id, id, type, actor_kind, actor_id, payload, occurred_at)
          VALUES (${roomA}::uuid, ${stranger.id}::text, 'message_posted', 'system', NULL,
                  ${JSON.stringify(stranger.payload)}::jsonb, ${stranger.occurredAt}::timestamptz)
        `);
        await tx.execute(sql`ALTER TABLE core_events ENABLE TRIGGER core_events_append_guard`);
      });
      await until(() => notifications.length > 2, 5_000, 'the stranger’s doorbell');
      // The named append still names itself…
      expect(JSON.parse(notifications[1] as string)).toMatchObject({
        origin: 'instance-under-test',
        roomSeq: appended.roomSeq + 1,
      });
      // …and the stranger, one statement later in the same transaction, is
      // `null`: it named no instance, which matches none of them, so every
      // instance folds it. That is the direction to be wrong in.
      expect(JSON.parse(notifications[2] as string)).toMatchObject({
        origin: null,
        roomId: roomA,
        roomSeq: appended.roomSeq + 2,
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
      // The stager (r9): who typed the proposal, as against what the reading
      // claims to be. NOT NULL, so a direct insert has to say.
      stagedByKind: 'model',
      stagedById: 'test',
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
      // The stager (r9): who typed the proposal, as against what the reading
      // claims to be. NOT NULL, so a direct insert has to say.
      stagedByKind: 'model',
      stagedById: 'test',
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
  /** The comparison the `core_events_invariants` trigger performs, in Postgres. */
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
   * in `atrium_core_events_invariants`, or from the index that serves it.
   *
   * The gate moved out of `atrium_append_core_event` and onto the table in 0008
   * (#22 gauntlet r6, major 3), so this reads the trigger function's body. That
   * is not a cosmetic follow: a gate inside the append function only binds
   * callers of the append function, which is the assumption the r6 exploit broke.
   */
  it('compares ids under COLLATE "C" in the deployed append gate', async () => {
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_core_events_invariants'
            AND pronamespace = 'public'::regnamespace`,
    );
    const body = fn?.src ?? '';
    // Both the read of the cursor and the comparison against it.
    expect(body).toContain('e."id" COLLATE "C" DESC');
    expect(body).toContain('(NEW."id" COLLATE "C") > (v_max_id COLLATE "C")');

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
    /* WHY TWO KINDS NOW, AND WHY THAT IS STRONGER THAN ONE.
     *
     * This case was written when every witness diverged: SQL compared the
     * instant and JavaScript compared the STRING, so two spellings of one
     * moment tied in one and differed in the other. The core lane closed the
     * JavaScript half independently — `compareCursor` reads `instantKey`, which
     * parses the fields instead of the characters — so on the merged tree the
     * first two witnesses AGREE. Two lanes fixed one defect class from two
     * sides, which is a good outcome and a bad thing to discover by way of an
     * assertion that quietly stopped meaning anything.
     *
     * So the witnesses declare which they are. `diverges: true` keeps the
     * original claim exactly. `diverges: false` asserts the CONVERGENCE, which
     * is the thing that would break if `instantKey` were reverted to a string
     * compare — the old assertion could not tell "the two orderings agree" from
     * "this witness rotted", and this one has to be right about which.
     *
     * The constraint half is unchanged for both: the CHECK is what stops the
     * spelling entering the ledger at all, and it is still the only thing that
     * does. A value type and a comparator agreeing about a string is not the
     * same guarantee as the string never being written.
     */
    const witnesses = [
      {
        why: 'two spellings of one instant tie in SQL, and now tie in JS too',
        diverges: false,
        a: { at, id: 'e1' },
        b: { at: '2026-08-01T00:00:05Z', id: 'e1' },
        constraint: 'core_events_payload_at_is_canonical_utc',
        offending: 'b' as const,
      },
      {
        why: 'a numeric UTC offset is the same instant, and now the same order',
        diverges: false,
        a: { at, id: 'e1' },
        b: { at: '2026-08-01T00:00:05.000+00:00', id: 'e1' },
        constraint: 'core_events_payload_at_is_canonical_utc',
        offending: 'b' as const,
      },
      {
        why: 'an astral code point sorts before U+E000–U+FFFF in UTF-16 and after it in bytes',
        diverges: true,
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
      if (witness.diverges) {
        // The disagreement is real, and asserted rather than assumed — a
        // "witness" that no longer diverges would otherwise leave the constraint
        // below guarding nothing while this test stayed green.
        expect({ why: witness.why, sql: fromSql[index], js }).not.toEqual({
          why: witness.why,
          sql: js,
          js,
        });
      } else {
        // …and the agreement is asserted for the same reason, from the other
        // side: this is the pair the core lane's `instantKey` converged, and if
        // `compareCursor` goes back to comparing characters this fails here
        // rather than silently reinstating the divergence.
        expect({ why: witness.why, sql: fromSql[index] }).toEqual({
          why: witness.why,
          sql: js,
        });
      }
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

    // And something really calls the derivation rather than merely not taking an
    // argument — "no parameter" plus "always NULL" satisfies the line above.
    //
    // Since 0008 the caller is the `core_events_invariants` trigger, not the
    // append function: the window is assigned onto the row on its way into the
    // table, so it is derived for *every* writer rather than for callers of one
    // function (#22 gauntlet r6, major 3). The append function is asserted not to
    // mention the derivation at all, which is what "it moved" means as opposed to
    // "it is in two places now".
    const [derivation] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_core_events_invariants'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(derivation?.src).toContain(
      'NEW."trusted_messages" := public."atrium_receipt_window"(NEW."room_id", NEW."actor_kind", NEW."payload")',
    );
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(fn?.src).not.toContain('atrium_receipt_window');
    // …and it does not name `trusted_messages` in the INSERT either, so there is
    // no column list a later edit could quietly add a caller-supplied value to.
    expect(fn?.src).toContain(
      'INSERT INTO public."core_events" ("room_id", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at")',
    );
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
    const before = await seedMessage(roomA, alice, 'said before either citation');
    const first = await seedMessage(roomA, alice, 'first');
    const second = await seedMessage(roomA, null, 'second');
    const after = await seedMessage(roomA, alice, 'said after both citations');

    // Cited in the wrong order on purpose: the window is the room's order, not the
    // payload's.
    const appended = await append(acceptance(roomA, [second, first]));
    expect(appended.trustedMessages).toEqual([
      { id: first, authorId: alice, body: 'first' },
      // A message whose author is gone keeps its text and loses its name — '' and
      // not null, because attribution to '' matches no actor.
      { id: second, authorId: '', body: 'second' },
      // …and what the room said afterwards — #86. See the block below for why.
      { id: after, authorId: alice, body: 'said after both citations' },
    ]);
    // Uncited chatter from BEFORE the citations stays out. The widening is
    // directional and this is the half of it that did not change: nothing before
    // the sentence can be a correction of it, and a window is not "the room".
    expect(JSON.stringify(appended.trustedMessages)).not.toContain(before);
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

  /* -------------------------------------------------------------------------
   * #86 — THE WINDOW REACHES PAST THE CITATIONS, AND STOPS ONE MESSAGE LATE.
   *
   * Two lanes shipped rules that were each internally consistent, each verified
   * in isolation, and each right. `0006` made the window exactly the cited
   * messages; `laterRevision` refuses any window that ends at the citations,
   * because it carries no evidence about what came after the quoted sentence.
   * Merged, the SQL could not produce a window the TypeScript would certify, so
   * every non-human acceptance was refused and the model path was dead — and
   * git produced no conflict marker, because the two rules are in different
   * files and different languages.
   *
   * Asserted here, against a real database, rather than by reading the
   * migration: `packages/db/test/schema.test.ts` holds the migration's LITERAL
   * against `policy.ts`, and this holds the deployed FUNCTION against what the
   * literal claims. A constraint that exists in a string but not in the database
   * is the #19 finding this whole suite answers.
   * ---------------------------------------------------------------------- */
  it('is still one function after 0011 replaced it, with its grants intact', async () => {
    /**
     * `drizzle/0011` is the only migration in this chain that redefines a
     * function with `CREATE OR REPLACE` instead of `DROP` + `CREATE`. Every
     * other one uses DROP for the r2 reason `0005` states: Postgres cannot
     * change a parameter list in place, so `CREATE OR REPLACE` with a different
     * one creates an **overload** — a second door that satisfies every
     * name-based guard while doing none of the work.
     *
     * 0011 changes the body and not the signature, so REPLACE rebinds the one
     * function that exists, and it is the correct choice rather than merely a
     * safe one: `DROP` takes the grants with it, and 0006 and 0008 both revoke
     * PUBLIC and grant this function to the owner and to every app role. A DROP
     * would silently reset that ACL to the default — EXECUTE to PUBLIC — unless
     * every grant were restated.
     *
     * Both halves of that argument are asserted here rather than left in the
     * migration's prose, because a prose argument about a door is the thing this
     * suite exists to replace with the catalog.
     *
     * Catches: giving 0011's replacement a different parameter list (two
     * functions, one of them the old narrow window, and every name-based guard
     * still green), and swapping REPLACE for DROP + CREATE without restating the
     * grants (EXECUTE to PUBLIC on the derivation, which is a read primitive
     * over every room's message bodies).
     */
    const rows = await handle.db.execute<{ args: string; acl: string | null }>(
      sql`SELECT pg_get_function_identity_arguments(oid) AS args, proacl::text AS acl
          FROM pg_proc
          WHERE proname = 'atrium_receipt_window'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(rows, 'exactly one atrium_receipt_window — an overload is a second door').toHaveLength(
      1,
    );
    expect(rows[0]?.args).toBe('p_room_id uuid, p_actor_kind actor_kind, p_payload jsonb');
    // A non-null ACL is half the claim: `proacl` is NULL only when the function
    // carries the *default* privileges, which for a function is EXECUTE to
    // PUBLIC. 0006 revoked that and granted explicitly; if 0011 had dropped and
    // recreated without restating the grants, this comes back NULL.
    const acl = rows[0]?.acl ?? null;
    expect(acl, 'a NULL proacl is EXECUTE to PUBLIC — the door 0006 closed').not.toBeNull();

    // The other half, and it is parsed rather than grepped. An aclitem is
    // `grantee=privileges/grantor`, and **PUBLIC is spelled as the empty
    // grantee** — `=X/owner`. The first draft of this line asserted the string
    // did not contain `=X/`, which is a substring of every ordinary grant
    // (`atrium_test=X/atrium_test`), so it failed on a correct database and
    // would have been "fixed" by deleting it. Splitting on the delimiter is the
    // difference between asking "is PUBLIC in this list" and "does this text
    // have those three characters in it anywhere".
    const grantees = (acl ?? '')
      .replace(/^\{|\}$/g, '')
      .split(',')
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(0, entry.indexOf('=')));
    expect(grantees.length, 'the ACL must list somebody, or it is not an ACL').toBeGreaterThan(0);
    expect(
      grantees,
      'an empty grantee is PUBLIC — EXECUTE on the derivation for anyone',
    ).not.toContain('');
  });

  it('carries what the room said after the newest citation, in the room’s order', async () => {
    /**
     * The headline of #86, and the smallest room that shows it: cite the
     * sentence, then say something after it.
     *
     * Catches: `receipt_window_ends_at_the_citations` — reverting to 0006's
     * cited-only SELECT, which is the merged tree's dead model path. Also
     * `receipt_window_tail_ignores_the_room`, since the foreign message is
     * newer than the citation in the global `messages.seq` and would be picked
     * up by a tail that forgot `WHERE m.room_id = p_room_id`.
     */
    const alice = await seedUser('alice-tail');
    const cited = await seedMessage(roomA, alice, 'the deploy pipeline is green');
    // Another room's message, newer than the citation. `messages.seq` is global,
    // so an unscoped tail reaches it.
    await seedMessage(roomB, alice, 'said in another room after the citation');
    const correction = await seedMessage(roomA, alice, 'Correction: it is not green.');

    const appended = await append(acceptance(roomA, [cited]));
    expect(appended.trustedMessages).toEqual([
      { id: cited, authorId: alice, body: 'the deploy pipeline is green' },
      { id: correction, authorId: alice, body: 'Correction: it is not green.' },
    ]);
  });

  it('stops the tail at the bound `policy.ts` names, and takes the earliest', async () => {
    /**
     * The bound, measured rather than read. Two claims in one room:
     *
     *  1. the tail is cut at `RECEIPT_POLICY.maxLaterMessagesCarried` exactly —
     *     catches `receipt_window_tail_is_unbounded` (dropping the LIMIT, which
     *     makes an append cost the room's whole history) and any drift in the
     *     migration's literal that `schema.test.ts` somehow let through;
     *  2. it is the room's EARLIEST messages after the citation, not an
     *     arbitrary N of them. Without the `ORDER BY m."seq"` that precedes the
     *     LIMIT the planner may return any N rows, and the correction this
     *     window exists to make findable is usually the very next message.
     *
     * The second claim is the one a smaller room could not make: with a tail
     * exactly at the bound, "cut at N" and "cut at the earliest N" are the same
     * answer. This room posts one message MORE than the bound, so the two
     * differ by exactly the last message — which must be the one left out.
     *
     * ── WHAT THIS TEST DOES NOT CATCH, MEASURED RATHER THAN ASSUMED ─────────
     *
     * `receipt_window_tail_is_unordered` — deleting that `ORDER BY` — was made
     * and this suite stayed GREEN. On 202 rows Postgres walks
     * `messages_room_seq_idx` and hands back the earliest 201 regardless, so the
     * mutant is latent rather than dead: the property below is asserted and the
     * plan happens to satisfy it. A bigger table, a parallel scan or a bitmap
     * heap scan is free to choose differently, and nothing here would notice.
     *
     * So the instrument that actually holds the ordering is the textual one —
     * `packages/db/test/schema.test.ts` requires `ORDER BY m."seq"` immediately
     * before the LIMIT and fails without it (verified by the same mutation).
     * Recorded here rather than left as a claim this test cannot support,
     * because a comment naming a mutant it does not kill is worse than no
     * comment: it retires the mutant from somebody else's list.
     */
    const alice = await seedUser('alice-bound');
    const room = await seedRoom(handle, ['zoe'], { slug: 'room-bound' });
    const cited = await seedMessage(room.roomId, alice, 'the sentence being cited');

    const carried = RECEIPT_POLICY.maxLaterMessagesCarried;
    const tail: string[] = [];
    for (let i = 0; i < carried + 1; i += 1) {
      tail.push(await seedMessage(room.roomId, alice, `after ${i}`));
    }

    const window = (await append(acceptance(room.roomId, [cited]))).trustedMessages as {
      id: string;
    }[];
    // The citation plus exactly `carried` after it, and not one more.
    expect(window).toHaveLength(1 + carried);
    expect(window.map((message) => message.id)).toEqual([cited, ...tail.slice(0, carried)]);
    // Stated as its own assertion because it is the whole of the ordering claim:
    // the message left out is the room's NEWEST, never an arbitrary one.
    expect(window.map((message) => message.id)).not.toContain(tail.at(-1));
  });

  it('is the window @atrium/core certifies, for every shape the SQL can snapshot', async () => {
    /**
     * #86's acceptance criterion, and the reason it is written this way.
     *
     * > for every proposal shape the SQL can snapshot, the TypeScript either
     * > certifies or refuses **for a reason about the reading rather than about
     * > the window**.
     *
     * A test that only asserted "some acceptances succeed" would pass on a
     * window one message too wide, and a test that asserted "no problems" would
     * pass on a window that happened to dodge the one check being fixed. The
     * property is about the SUBJECT of whatever verdict comes back — the
     * `ProblemSubject` distinction `fix/core-engine-r11` introduced, where a
     * window-fact must refer and may never conclude. A window-shaped refusal on
     * every input is exactly the failure being fixed.
     *
     * Catches: `receipt_window_ends_at_the_citations` (every shape below comes
     * back `the_window`, which is the merged tree), and any future narrowing of
     * the window that trades a dead path for a wrong one.
     *
     * The two sides are joined here and nowhere else: the window comes out of
     * the real `atrium_receipt_window` through the real append, and goes into
     * the real `validateProposalProvenance`. No hand-built array in between —
     * that is the seam the merge broke, so it is the seam the test has to cross.
     */
    const room = await seedRoom(handle, ['wren'], { slug: 'room-subject' });
    const author = room.people.wren as string;
    const QUOTE = 'the deploy pipeline is green after the migration landed';

    const shapes = [
      { label: 'one citation, ordinary room traffic after it', cites: 1, after: 1 },
      { label: 'one citation, several messages after it', cites: 1, after: 4 },
      { label: 'two citations, ordinary room traffic after them', cites: 2, after: 1 },
      { label: 'two citations, several messages after them', cites: 2, after: 3 },
    ];

    for (const shape of shapes) {
      const cited: string[] = [];
      // The bearing message carries the quote; the extra citation is ordinary
      // chatter, which is the shape that made `firstCited` a padding lever.
      cited.push(await seedMessage(room.roomId, author, QUOTE));
      for (let i = 1; i < shape.cites; i += 1) {
        cited.push(await seedMessage(room.roomId, author, `and a further note ${i}`));
      }
      for (let i = 0; i < shape.after; i += 1) {
        await seedMessage(room.roomId, author, `unrelated standup line ${i}`);
      }

      const window = (await append(acceptance(room.roomId, cited)))
        .trustedMessages as ProvenanceMessage[];
      expect(window, shape.label).not.toBeNull();

      const problems = validateProposalProvenance(
        {
          type: 'claim',
          provenance: cited,
          quote: QUOTE,
          statement: QUOTE,
          proposer: { kind: 'model' },
          attributedTo: author,
        },
        window,
      );
      // The criterion, stated as the criterion: not "no problems", but "no
      // problem that is a fact about the window". A reading-fact here would be a
      // real finding about a real proposal and is not what #86 is about.
      expect(
        problems.filter((problem) => problem.about === 'the_window'),
        `${shape.label} — refused for a window-reason, which is the #86 deadlock`,
      ).toEqual([]);
      expect(isAboutTheWindow(problems), shape.label).toBe(false);
    }
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
  function smuggle(payload: Record<string, unknown>, key: RoomKey, value: string | null): void {
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
  });

  /**
   * The union this file loops over is the **database's**, not TypeScript's
   * (#22 gauntlet r6, minor 4).
   *
   * The line here used to say "against the database's own enum, so a ninth kind
   * added to `event_type` fails here" while comparing `Object.keys(OWN_KEY)` to
   * `eventType.enumValues` — the drizzle constant, on *both* sides. The critic
   * added `ninth_kind` to the live enum and the suite stayed green, because
   * nothing in the repo read `pg_enum`. Migrations 0003–0008 are hand-written
   * SQL, so that drift is writable.
   *
   * Two comparisons now, and they are different comparisons:
   *
   *  1. the deployed enum against `OWN_KEY`, so a ninth kind is a kind this file
   *     has no room policy for and says so;
   *  2. the deployed enum against `eventType.enumValues`, so a ninth kind added
   *     in SQL without the drizzle schema following is caught where it happens
   *     rather than wherever it is first read back.
   *
   * `enum_range` rather than a `pg_enum` join, because it is the value the type
   * actually has, in `enumsortorder`.
   *
   * ## Half of this is not mutatable, and that is stated rather than papered over
   *
   * The mutant `event_type_drifts_from_the_deployed_enum` adds a value to the
   * drizzle constant, which trips comparison 2 — but it tripped r6's assertion
   * too, so it is a pin, not evidence that r7 fixed anything. The direction that
   * *is* r7's is the database growing a kind TypeScript has not heard of, and
   * that cannot be a mutant: `ALTER TYPE … ADD VALUE` cannot be undone, so a
   * mutation using it would leak a ninth kind into every later file in the run.
   *
   * It was therefore verified by hand, twice, on throwaway instances: the r6
   * critic added `ninth_kind` to a live enum and `pnpm test:integration` exited 0
   * on r6; this round reproduced that (r6 tree, 9 values confirmed, r6's own
   * `integration/db` file still 71/71 green) and confirmed this test goes red
   * against the same database. Recorded here because "verified by hand" that is
   * not written down is indistinguishable from not verified.
   */
  it('accepts a smuggled key whose value is JSON null, because it carries no room', async () => {
    /**
     * The one shape both `schema.ts` and 0007 explicitly say is *accepted*, and
     * which nothing exercised until r7 — the `smuggle` helper above only ever
     * wrote strings (#22 gauntlet r6, major 2's sweep).
     *
     * > A smuggled key whose value is JSON `null` (`proposal: {roomId: null}`) is
     * > accepted, and that is not a gap: `->>'roomId'` is SQL NULL either way, the
     * > key carries no room, and no fan-out or fold can read one out of it.
     *
     * A sentence claiming a *permission* is as much a claim as one claiming a
     * refusal, and it is the easier one to break by accident: any tightening of
     * clause 1 from "is not null" to "exists" turns every one of these into a
     * refusal, and the shape is legal JSON that a client could produce.
     *
     * So it is asserted both ways round — the row lands, **and** the room it
     * lands in is still the one its own kind's key names, which is the property
     * the acceptance is only safe because of.
     */
    let landed = 0;
    for (const [type, own] of Object.entries(OWN_KEY)) {
      for (const key of ROOM_KEYS) {
        if (key === own) continue;
        const row = kindRow(type, roomA, { proposalId, objectId });
        smuggle(row.payload as Record<string, unknown>, key, null);
        const appended = await append(row);
        expect(appended.seq).toBeGreaterThan(0);
        landed += 1;
      }
    }
    // 5 kinds × 3 foreign keys + 3 room-less kinds × 4 keys.
    expect(landed).toBe(27);
    const filed = await handle.db
      .select({ roomId: coreEvents.roomId })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, roomB));
    expect(filed).toEqual([]);
  });

  it('takes its list of kinds from the deployed enum, not from a TypeScript constant', async () => {
    const [row] = await handle.db.execute<{ kinds: string[] }>(
      sql`SELECT enum_range(NULL::event_type)::text[] AS kinds`,
    );
    const deployed = row?.kinds ?? [];
    expect(deployed.length).toBeGreaterThan(0);
    // 1. every kind the database has, has a room policy in this file.
    expect(new Set(Object.keys(OWN_KEY))).toEqual(new Set(deployed));
    // 2. …and drizzle's constant is the same list, so SQL and TypeScript cannot
    //    drift apart silently in either direction.
    expect(new Set(eventType.enumValues)).toEqual(new Set(deployed));
  });

  /**
   * The two decisions in `core_events_payload_room_matches` that nothing pinned
   * (#22 gauntlet r6, major 2).
   *
   * > Nothing pins `core_events_payload_room_matches` structurally —
   * > `pg_get_constraintdef` is asserted for the `at` pattern and for COLLATE,
   * > never for this one — and no mutant covers either.
   *
   * **(a) `coalesce(…, false)`** — the wrapper both `schema.ts` and the migration
   * say makes an unknown ninth kind fail closed. Dropping it left the whole suite
   * green, and it is behaviourally real: with the wrapper gone, a ninth kind with
   * `room_id` = B and `object.roomId` = A lands.
   *
   * The test below is behavioural without touching the enum. `ALTER TYPE … ADD
   * VALUE` cannot be undone, so adding `ninth_kind` to the shared test database
   * would leak into every later file; instead the **deployed expression** is read
   * out of `pg_constraint` and evaluated against a fabricated row. That is the
   * same expression Postgres evaluates at INSERT, on a payload of a type the
   * `CASE` does not enumerate — and the whole point is the difference between
   * `false` and NULL, which a CHECK cannot show you from the outside because it
   * treats them the same.
   *
   * **(b) `IS NOT DISTINCT FROM`** — and here the finding is that the *stated
   * reason* is no longer true:
   *
   * > Clause 1 already guarantees the key is present for the five room kinds and
   * > the `ELSE room_id::text` covers the rest, so the stated justification is no
   * > longer true of the shipped shape.
   *
   * Granted. The two spellings are behaviourally identical under the shipped
   * constraint and no test can separate them, so the comments now say that rather
   * than the old justification, and this is a **structural** pin — the same
   * treatment, and for the same reason, as `returns the window by RETURNING of
   * the stored column`. It is here so the operator cannot be changed silently
   * while the comment explaining why it is redundant stays behind.
   *
   * Catches: `payload_room_check_does_not_fail_closed`,
   * `payload_room_check_uses_equality`.
   */
  it('fails closed on a kind it does not enumerate, and says so structurally', async () => {
    const [row] = await handle.db.execute<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'core_events'::regclass
            AND conname = 'core_events_payload_room_matches'`,
    );
    const def = row?.def ?? '';

    // (a), behavioural: the deployed expression, evaluated on a row of a kind the
    // `CASE` has never heard of. `pg_get_constraintdef` renders the columns
    // unqualified, so a one-row subquery supplying `payload` and `room_id` is
    // exactly the environment the CHECK runs in.
    const expression = /^CHECK \((.*)\)$/s.exec(def)?.[1];
    if (!expression) throw new Error(`could not read the deployed expression: ${def}`);
    const evaluate = async (payload: unknown, roomId: string): Promise<boolean | null> => {
      const [verdict] = await handle.db.execute<{ ok: boolean | null }>(
        sql`SELECT (${sql.raw(expression)}) AS ok
            FROM (SELECT ${JSON.stringify(payload)}::jsonb AS payload, ${roomId}::uuid AS room_id) t`,
      );
      return verdict?.ok ?? null;
    };

    // A ninth kind, filed into room B, whose own shape names room A. Without the
    // `coalesce` this is NULL — and a CHECK passes on NULL, so the row lands.
    expect(
      await evaluate({ type: 'ninth_kind', object: { roomId: roomA }, roomId: roomA }, roomB),
    ).toBe(false);
    // …with no room key at all, and with only the column's own room, which are
    // the other two ways a new kind can arrive without a policy.
    expect(await evaluate({ type: 'ninth_kind' }, roomB)).toBe(false);
    expect(await evaluate({ type: 'ninth_kind', roomId: roomB }, roomB)).toBe(false);

    // Non-vacuity: the same harness says `true` for an honest enumerated kind, so
    // a `false` above is the `CASE` falling through rather than the evaluation
    // being broken.
    expect(await evaluate({ type: 'message_posted', roomId: roomB }, roomB)).toBe(true);
    expect(await evaluate({ type: 'message_posted', roomId: roomA }, roomB)).toBe(false);

    // (b), structural — and it is second on purpose, so that dropping the
    // `coalesce` fails above, on what the constraint *does*, rather than here on
    // what it looks like. Postgres re-renders `a IS NOT DISTINCT FROM b` as
    // `NOT (a IS DISTINCT FROM b)`, so that — not the source spelling — is what a
    // reader of the catalog sees; `=` renders as `(room_id)::text = CASE …`,
    // which this refuses.
    expect(def).toContain('NOT ((room_id)::text IS DISTINCT FROM');
    expect(def).toMatch(/^CHECK \(\(*COALESCE\(/);
    expect(def).toMatch(/,\s*false\)\)*\)$/s);
  });

  it('refuses a rejection filed into a room its proposal does not live in', async () => {
    /**
     * The half no CHECK can reach (#22 gauntlet r5 delta, major 2).
     *
     * > Room-less kinds still admit a `room_id` lie via direct SQL […]
     * > `resolveRoomId` covers the command path only.
     *
     * "Which room is proposal P in" is a fact about *another row*, and a CHECK
     * sees one row. So the table answers it: the `core_events_invariants` trigger
     * resolves the named proposal back to the room its own `proposal_recorded`
     * landed in. (It was `atrium_append_core_event` until r7, which bound callers
     * of that function and nobody else — see `refuses an append smuggled in from
     * another schema’s atrium_append_core_event`.) The proposal here is `roomA`'s;
     * filing its rejection into `roomB` would give the fan-out one room and the
     * fold another.
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

  it('refuses a subject the ledger says was minted in two different rooms', async () => {
    /**
     * The third refusal, and the only one the command path has no counterpart
     * for: `resolveRoomId` reads a folded `CoreState`, where a proposal id is a
     * key and cannot name two rooms at once. The **log** can hold two mintings —
     * a direct caller records the same proposal id in `roomA` and in `roomB`, each
     * honest about its own room and so each accepted by the room CHECK — and then
     * "which room is this proposal in" has two answers.
     *
     * `array_agg(DISTINCT …)` rather than `LIMIT 1` is what makes this a refusal
     * instead of a decision: arbitrating would make the boundary the place that
     * chose, and a replay would choose differently (the reducer takes the first
     * minting that applies and records an issue for the rest).
     *
     * Availability against a caller that already holds `EXECUTE` is deliberately
     * not a property of this boundary and never has been — since 0003 a single row
     * with a far-future `occurred_at` refuses every later append to the whole
     * ledger — so a refusal scoped to one poisoned subject is strictly weaker than
     * what the boundary already concedes.
     *
     * Catches: `append_trusts_a_room_less_kind`.
     */
    const contested = randomUUID();
    await expect(append(recording(roomA, contested))).resolves.toBeDefined();
    await expect(append(recording(roomB, contested))).resolves.toBeDefined();

    // Neither room can now file a rejection for it, including the room that
    // minted it first. That is the point: there is no right answer to pick.
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(rejection(roomA, contested)),
    );
    await violatesConstraint('core_events_subject_room_matches', () =>
      append(rejection(roomB, contested)),
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
     * Since 0008 this is no longer only about the *window*: `room_seq` travels the
     * same way, because the `core_events_invariants` trigger mints it onto the row
     * and the function has no variable holding an intended value to return
     * instead. The function cannot report a position it did not get, because it
     * never had one.
     *
     * Catches: `append_returns_the_window_it_meant_to_store`.
     */
    const [fn] = await handle.db.execute<{ src: string }>(
      sql`SELECT prosrc AS src FROM pg_proc
          WHERE proname = 'atrium_append_core_event'
            AND pronamespace = 'public'::regnamespace`,
    );
    expect(fn?.src).toContain(
      'RETURNING "core_events"."seq", "core_events"."room_seq", "core_events"."trusted_messages"\n  INTO v_seq, v_room_seq, v_stored',
    );
    expect(fn?.src).toContain('"trusted_messages" := v_stored;');
    expect(fn?.src).toContain('"room_seq" := v_room_seq;');
    // And the value it meant to store is not what leaves: there is no `v_window`
    // in this function at all any more, because the derivation is the table's.
    expect(fn?.src).not.toContain('v_window');
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

    /* THE AUDIT MOVED HERE, AND `0006`'s HEADER WAS DELIBERATELY NOT EDITED.
     *
     * `0006_derived_receipt_snapshot.sql` carries the prose version of this
     * audit and says a schema change "fails that test, which is what makes the
     * audit below true for longer than the day it was written". Merging
     * `fix/auth-r11` added workspaces, workspace members, invitations and Better
     * Auth's accounts/sessions, and with them five more foreign keys with a
     * delete action — so the test failed on the merge commit, exactly as
     * promised.
     *
     * The header was NOT updated to match, and that is the deliberate half:
     * drizzle records an applied migration by a HASH OF THE FILE, so editing
     * even a comment in a shipped migration makes it read as unapplied and
     * re-run its DDL against a database that already has it. The audit's
     * authority was always the catalog rather than the paragraph — that is this
     * describe block's own title — so the paragraph stays frozen with its
     * migration and the additions are recorded here, where the assertion is.
     *
     * `n` = SET NULL. Every one is a projection column written *from* the
     * ledger's trusted actor columns and read back for display; the authority
     * lives in `core_events.actor_kind`/`actor_id`, which have no FK to `users`
     * at all. */
    expect(of('n')).toEqual([
      'accepted_objects_accepted_by_users_id_fk',
      // #26's. A session pins an "active workspace" for convenience; deleting
      // the workspace must not delete the session, and must not leave it
      // pointing at a workspace that is gone. Exactly this list's own rule —
      // a display column nulls, the authority is elsewhere — one table over.
      'auth_sessions_active_organization_id_workspaces_id_fk',
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
      // #26's four, and they are cascades for the reason the ones above are:
      // each row is meaningless without its parent. A deleted user has no
      // credentials and no sessions; a deleted workspace has no members and no
      // outstanding invitations. None of them is authority the ledger reads —
      // `core_events.actor_kind`/`actor_id` still have no FK to `users` at all.
      'auth_accounts_user_id_users_id_fk',
      'auth_sessions_user_id_users_id_fk',
      // A command receipt has no meaning after its room history is deleted.
      'command_receipts_room_id_rooms_id_fk',
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
      // …and the rest of #26's. `rooms.workspace_id` is the one that changes
      // the shape of the room table itself: a room now belongs to a workspace,
      // and deleting the workspace takes its rooms — and, through the cascades
      // above, everything filed under them.
      'rooms_workspace_id_workspaces_id_fk',
      'workspace_invitations_inviter_id_users_id_fk',
      'workspace_invitations_organization_id_workspaces_id_fk',
      'workspace_members_organization_id_workspaces_id_fk',
      'workspace_members_user_id_users_id_fk',
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
