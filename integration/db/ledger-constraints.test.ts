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
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

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
 * One event, as the append procedure takes it.
 *
 * Note what is *not* here: `room_seq`. It is minted inside
 * `atrium_append_core_event` under the ledger lock and cannot be supplied by a
 * caller — which is the r2 change these tests exist to hold. Everything else a
 * bypassing writer might have got wrong is still expressible, so the checks
 * below are reachable through the only path that exists.
 */
function ledgerRow(
  roomId: string,
  overrides: { id?: string; at?: string; occurredAt?: string; actor?: unknown } = {},
) {
  const id = overrides.id ?? randomUUID();
  const at = overrides.at ?? new Date().toISOString();
  return {
    roomId,
    id,
    type: 'message_posted',
    actor: overrides.actor ?? { kind: 'system' },
    payload: {
      id,
      at,
      type: 'message_posted',
      actor: { kind: 'system' },
      roomId,
      messageId: randomUUID(),
      body: 'hello',
      replyToId: null,
      clientMessageId: null,
      attachments: [],
    } as Record<string, unknown>,
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
async function append(row: LedgerRow) {
  return handle.db.transaction(async (tx) => {
    const result = await tx.execute<{ seq: string; room_seq: string }>(sql`
      SELECT "seq", "room_seq" FROM atrium_append_core_event(
        ${row.roomId}::uuid,
        ${row.id}::text,
        ${row.type}::event_type,
        ${JSON.stringify(row.actor)}::jsonb,
        ${JSON.stringify(row.payload)}::jsonb,
        ${row.occurredAt}::timestamptz
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
      at: '2026-07-31T12:00:09.000Z',
      occurredAt: '2026-07-31T12:00:03.000Z',
    });
    await violatesConstraint('core_events_payload_at_matches', () => append(row));
  });

  it('refuses an `at` with no timezone designator', async () => {
    // Without one, `::timestamptz` means different instants in different
    // sessions — so the equality above would be a check that could pass in one
    // connection and fail in another.
    const row = ledgerRow(roomA, { at: '2026-07-31T12:00:03', occurredAt: '2026-07-31T12:00:03Z' });
    await violatesConstraint('core_events_payload_at_has_offset', () => append(row));
  });

  it('refuses a lifted actor that disagrees with the payload', async () => {
    const row = ledgerRow(roomA, { actor: { kind: 'human', userId: 'somebody-else' } });
    await violatesConstraint('core_events_payload_actor_matches', () => append(row));
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
        actor: { kind: 'system' },
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
          INSERT INTO core_events (room_id, room_seq, id, type, actor, payload, occurred_at)
          VALUES ((p->>'roomId')::uuid, 1, p->>'id', 'message_posted',
                  p->'actor', p->'payload', (p->>'at')::timestamptz);
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
            actor: { kind: 'system' },
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
      handle.db.execute(sql`UPDATE core_events SET "actor" = '{"kind":"system"}'::jsonb`),
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
            AND pronargs = 6`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.src).toContain(String(LEDGER_ADVISORY_LOCK_KEY));
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
        rationale: 'you own this',
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
        rationale: 'you asked for this call',
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
        rationale: 'cross-room',
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
        rationale: 'mislabelled',
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
      rationale: 'both',
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
