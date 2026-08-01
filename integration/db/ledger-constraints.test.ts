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

function ledgerRow(roomId: string, roomSeq: number, overrides: { id?: string } = {}) {
  const id = overrides.id ?? randomUUID();
  const at = new Date().toISOString();
  return {
    roomId,
    roomSeq,
    id,
    type: 'message_posted' as const,
    actor: { kind: 'system' as const },
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
    occurredAt: at,
  };
}

describe('core_events — the append invariant, enforced by Postgres', () => {
  it('assigns a global seq and a per-room room_seq independently', async () => {
    await handle.db.insert(coreEvents).values(ledgerRow(roomA, 1));
    await handle.db.insert(coreEvents).values(ledgerRow(roomB, 1));
    await handle.db.insert(coreEvents).values(ledgerRow(roomA, 2));

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

  it('refuses two events at the same (room_id, room_seq)', async () => {
    await handle.db.insert(coreEvents).values(ledgerRow(roomA, 1));
    await violatesConstraint('core_events_room_seq_key', () =>
      handle.db.insert(coreEvents).values(ledgerRow(roomA, 1)),
    );
  });

  it('allows the same room_seq in different rooms', async () => {
    await handle.db.insert(coreEvents).values(ledgerRow(roomA, 1));
    await expect(handle.db.insert(coreEvents).values(ledgerRow(roomB, 1))).resolves.toBeDefined();
  });

  it('refuses a repeated event id anywhere in the ledger', async () => {
    const id = randomUUID();
    await handle.db.insert(coreEvents).values(ledgerRow(roomA, 1, { id }));
    await violatesConstraint('core_events_id_key', () =>
      handle.db.insert(coreEvents).values(ledgerRow(roomB, 1, { id })),
    );
  });

  it('refuses room_seq 0 — the client protocol is 1-based', async () => {
    await violatesConstraint('core_events_room_seq_positive', () =>
      handle.db.insert(coreEvents).values(ledgerRow(roomA, 0)),
    );
  });

  it('refuses a payload whose id disagrees with the lifted column', async () => {
    const row = ledgerRow(roomA, 1);
    row.payload.id = randomUUID();
    await violatesConstraint('core_events_payload_id_matches', () =>
      handle.db.insert(coreEvents).values(row),
    );
  });

  it('refuses a payload whose type disagrees with the lifted column', async () => {
    const row = ledgerRow(roomA, 1);
    row.payload.type = 'object_accepted';
    await violatesConstraint('core_events_payload_type_matches', () =>
      handle.db.insert(coreEvents).values(row),
    );
  });

  it('refuses a payload with no canonical timestamp', async () => {
    const row = ledgerRow(roomA, 1);
    delete row.payload.at;
    await violatesConstraint('core_events_payload_has_at', () =>
      handle.db.insert(coreEvents).values(row),
    );
  });

  it('refuses an event in a room that does not exist', async () => {
    await violatesConstraint('core_events_room_id_rooms_id_fk', () =>
      handle.db.insert(coreEvents).values(ledgerRow(randomUUID(), 1)),
    );
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
        objectId: foreign,
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

describe('memberships.seen_seq', () => {
  it('is a bigint, so a read cursor cannot overflow before the log it points into', async () => {
    const seeded = await seedRoom(handle, ['dana'], { slug: 'room-d' });
    const big = 5_000_000_000; // past int4, comfortably inside int8
    await handle.db.execute(
      sql.raw(`UPDATE memberships SET seen_seq = ${big} WHERE room_id = '${seeded.roomId}'`),
    );
    const rows = await handle.db.execute<{ seen_seq: string }>(
      sql.raw(`SELECT seen_seq FROM memberships WHERE room_id = '${seeded.roomId}'`),
    );
    expect(Number(rows[0]?.seen_seq)).toBe(big);
  });

  it('refuses a negative cursor', async () => {
    const seeded = await seedRoom(handle, ['erin'], { slug: 'room-e' });
    await violatesConstraint('memberships_seen_seq_nonnegative', () =>
      handle.db.execute(
        sql.raw(`UPDATE memberships SET seen_seq = -1 WHERE room_id = '${seeded.roomId}'`),
      ),
    );
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
