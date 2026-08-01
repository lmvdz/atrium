import { randomUUID } from 'node:crypto';
import { reduce, serializeState } from '@atrium/core';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  corrections,
  memberships,
  messages,
  objectRelations,
  proposals,
} from '@atrium/db/schema';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, ProposalDraft } from '../../apps/server/src/commands.js';
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
 * The command layer end to end: membership, the transactional append, the
 * projections, and the live ≡ replay identity that the whole design exists to
 * make true.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const open: TestClient[] = [];

async function connect(userId: string): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId);
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice', 'bob']);
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

const send = (roomId: string, body: string, clientMessageId: string | null = null): Command => ({
  name: 'send_message',
  roomId,
  body,
  clientMessageId,
  replyToId: null,
  attachments: [],
});

/** The non-payload half of a model proposal — every draft below shares it. */
const modelDraft: Omit<ProposalDraft, 'type' | 'payload'> = {
  confidence: 0.7,
  proposer: { kind: 'model', model: 'test-model' },
  provenance: [],
  interpretationId: null,
};

async function ledgerCount(): Promise<number> {
  const [row] = await handle.db.select({ count: count() }).from(coreEvents);
  return Number(row?.count ?? 0);
}

/**
 * The newest event in a room, typed by the caller.
 *
 * A helper rather than `(...).at(-1)?.event as T` at each site: the optional
 * chain reads as "if there is one", but every caller means "there must be one,
 * I just wrote it" — so an empty ledger should say that, not throw
 * `undefined is not an object` three lines later.
 */
async function lastEvent<T>(roomId: string): Promise<T> {
  const entry = (await server.ledger.since(roomId, 0)).at(-1);
  if (!entry) throw new Error(`room "${roomId}" has no events`);
  return entry.event as unknown as T;
}

/** The first event in a room, same reasoning. */
async function firstEvent<T>(roomId: string): Promise<T> {
  const [entry] = await server.ledger.since(roomId, 0);
  if (!entry) throw new Error(`room "${roomId}" has no events`);
  return entry.event as unknown as T;
}

describe('membership', () => {
  it('refuses every command from a non-member, and writes nothing', async () => {
    const outsiders = await seedRoom(handle, ['mallory'], { slug: 'elsewhere' });
    const mallory = await connect(outsiders.people.mallory as string);

    const nack = await mallory.command(send(room.roomId, 'let me in'));
    expect(nack).toMatchObject({ type: 'nack', code: 'not_a_member' });
    expect(await ledgerCount()).toBe(0);
  });

  it('refuses a socket that names no user at all', async () => {
    await expect(TestClient.connect(server.url, '')).rejects.toThrow();
  });

  it('refuses a member of room A acting in room B', async () => {
    const other = await seedRoom(handle, ['bob'], { slug: 'bobs-room' });
    const alice = await connect(room.people.alice as string);
    const nack = await alice.command(send(other.roomId, 'not mine'));
    expect(nack).toMatchObject({ type: 'nack', code: 'not_a_member' });
  });
});

describe('send_message', () => {
  it('appends to the ledger and projects a message row, in one transaction', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);
    const ack = await alice.command(send(room.roomId, 'hello room', 'client-1'));
    expect(ack).toMatchObject({ type: 'ack', roomSeq: 1, seq: 1 });

    const entries = await server.ledger.since(room.roomId, 0);
    expect(entries).toHaveLength(1);
    const event = entries[0]?.event;
    expect(event?.type).toBe('message_posted');

    const rows = await handle.db.select().from(messages).where(eq(messages.roomId, room.roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('hello room');
    expect(rows[0]?.clientMessageId).toBe('client-1');
    expect(rows[0]?.authorId).toBe(room.people.alice);
  });

  it('broadcasts the event to every subscriber, sender included', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);

    await alice.command(send(room.roomId, 'to everyone'));
    await bob.waitFor((f) => f.type === 'event');
    expect(alice.events(room.roomId)).toHaveLength(1);
    expect(bob.events(room.roomId)).toHaveLength(1);
    expect(alice.events(room.roomId)[0]?.event).toEqual(bob.events(room.roomId)[0]?.event);
  });

  it('rolls the whole append back when a projection violates a constraint', async () => {
    // A reply to a message in another room: the composite FK refuses it, and
    // the ledger row must go with it. This is #22's "rejection = no write",
    // exercised through a real constraint rather than a mock.
    const other = await seedRoom(handle, ['alice'], { slug: 'other' });
    const aliceThere = await connect(other.people.alice as string);
    const there = await aliceThere.command(send(other.roomId, 'over here'));
    expect(there.type).toBe('ack');
    const foreignMessage = await firstEvent<{ messageId: string }>(other.roomId);

    const before = await ledgerCount();
    const alice = await connect(room.people.alice as string);
    const nack = await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'cross-room reply',
      clientMessageId: null,
      replyToId: foreignMessage.messageId,
      attachments: [],
    });
    expect(nack.type).toBe('nack');
    expect(await ledgerCount()).toBe(before);
    // ...and no orphaned room_seq: the next append gets the number the failed
    // one would have taken.
    const ack = await alice.command(send(room.roomId, 'a legal one'));
    expect(ack).toMatchObject({ type: 'ack', roomSeq: 1 });
  });
});

describe('the proposal → acceptance boundary, over the wire', () => {
  async function acceptedDecision(client: TestClient, statement: string) {
    const recorded = await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'decision',
        payload: { statement, decidedBy: null, status: 'active' },
        confidence: 0.8,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: [],
        interpretationId: null,
      },
    });
    expect(recorded.type).toBe('ack');
    const proposalId = (await lastEvent<{ proposal: { id: string } }>(room.roomId)).proposal.id;

    const accepted = await client.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    expect(accepted.type).toBe('ack');
    const objectId = (await lastEvent<{ object: { id: string } }>(room.roomId)).object.id;
    return { proposalId, objectId };
  }

  it('records a proposal as `proposed` and accepts it into an object', async () => {
    const alice = await connect(room.people.alice as string);
    const { proposalId, objectId } = await acceptedDecision(alice, 'ship on friday');

    const [proposal] = await handle.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(proposal?.status).toBe('accepted');
    expect(proposal?.decidedBy).toBe(room.people.alice);

    const [object] = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, objectId));
    expect(object?.type).toBe('decision');
    expect(object?.proposalId).toBe(proposalId);
    expect(object?.roomId).toBe(room.roomId);
  });

  it('refuses a second acceptance of the same proposal, and stores the refusal as an issue', async () => {
    const alice = await connect(room.people.alice as string);
    const { proposalId } = await acceptedDecision(alice, 'ship on friday');

    const again = await alice.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    // The event is *consumed* — it took a position in the log — but it applied
    // nothing and the reducer recorded why. That is `applied_with_issue`, not a
    // rejection: rejections are about position, and this one was in order.
    expect(again.type).toBe('ack');
    expect(again.type === 'ack' && again.issues.length).toBeGreaterThan(0);
    expect(again.type === 'ack' && again.issues.join(' ')).toMatch(/already accepted/);

    // One object, not two: an event with an issue writes no projection.
    const [row] = await handle.db.select({ count: count() }).from(acceptedObjects);
    expect(Number(row?.count)).toBe(1);
  });

  it('corrects an accepted object, bumping revision and logging the before/after', async () => {
    const alice = await connect(room.people.alice as string);
    const { objectId } = await acceptedDecision(alice, 'ship on friday');

    const ack = await alice.command({
      name: 'correct',
      roomId: room.roomId,
      objectId,
      action: 'amend',
      patch: { statement: 'ship on monday' },
      note: 'friday is a holiday',
    });
    expect(ack.type).toBe('ack');

    const [object] = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, objectId));
    expect(object).toBeDefined();
    expect((object?.payload as { statement: string } | undefined)?.statement).toBe(
      'ship on monday',
    );
    expect(object?.revision).toBe(1);

    const [correction] = await handle.db
      .select()
      .from(corrections)
      .where(eq(corrections.objectId, objectId));
    expect(correction?.action).toBe('amend');
    expect((correction?.before as { statement: string } | undefined)?.statement).toBe(
      'ship on friday',
    );
    expect((correction?.after as { statement: string } | undefined)?.statement).toBe(
      'ship on monday',
    );
    expect(correction?.roomId).toBe(room.roomId);
  });

  it('refuses a correction to an object that does not exist, before it takes a position', async () => {
    const alice = await connect(room.people.alice as string);
    const before = await ledgerCount();
    const ack = await alice.command({
      name: 'correct',
      roomId: room.roomId,
      objectId: randomUUID(),
      action: 'amend',
      patch: { statement: 'x' },
      note: null,
    });
    // `object_corrected` names its target rather than declaring a room, so the
    // ledger refuses it before the reducer ever sees it: an unknown object
    // cannot be resolved to a room, and an event with no room has no position.
    expect(ack).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(before);
  });

  it('binds an answer to an open question and flips its status', async () => {
    const alice = await connect(room.people.alice as string);

    const question = await alice.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'open_question',
        payload: { question: 'when do we ship?', status: 'open' },
        confidence: 0.9,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: [],
        interpretationId: null,
      },
    });
    expect(question.type).toBe('ack');
    const questionProposalId = (await lastEvent<{ proposal: { id: string } }>(room.roomId)).proposal
      .id;
    await alice.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId: questionProposalId,
      objectiveId: null,
    });
    const questionId = (await lastEvent<{ object: { id: string } }>(room.roomId)).object.id;

    const { objectId: decisionId } = await acceptedDecision(alice, 'ship on friday');

    const bound = await alice.command({
      name: 'answer_bind',
      roomId: room.roomId,
      questionId,
      answerObjectId: decisionId,
      note: null,
    });
    expect(bound.type).toBe('ack');

    const [relation] = await handle.db
      .select()
      .from(objectRelations)
      .where(eq(objectRelations.fromObjectId, questionId));
    expect(relation?.kind).toBe('answers');
    expect(relation?.toObjectId).toBe(decisionId);
    expect(relation?.roomId).toBe(room.roomId);

    const [question2] = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, questionId));
    expect((question2?.payload as { status: string } | undefined)?.status).toBe('answered');
  });
});

describe('resolve_attention', () => {
  it('resolves this person’s item and refuses someone else’s', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);

    // Attention items are produced by #21's routing; seed one directly.
    const objectId = randomUUID();
    await handle.db.insert(acceptedObjects).values({
      id: objectId,
      roomId: room.roomId,
      type: 'commitment',
      payload: {
        statement: 'write the migration',
        owner: room.people.alice as string,
        due: null,
        status: 'open',
      },
    });
    const attentionId = randomUUID();
    await handle.db.insert(attentionItems).values({
      id: attentionId,
      roomId: room.roomId,
      userId: room.people.alice as string,
      subjectKind: 'object',
      subjectId: objectId,
      class: 'owned_commitment',
      rationale: 'you own this commitment',
    });

    const wrongPerson = await bob.command({
      name: 'resolve_attention',
      roomId: room.roomId,
      attentionId,
      status: 'resolved',
    });
    expect(wrongPerson).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(0);

    const ack = await alice.command({
      name: 'resolve_attention',
      roomId: room.roomId,
      attentionId,
      status: 'resolved',
    });
    expect(ack.type).toBe('ack');
    const [item] = await handle.db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.id, attentionId));
    expect(item?.status).toBe('resolved');
    expect(item?.resolvedAt).not.toBeNull();
  });
});

describe('advance_seen', () => {
  it('moves the per-user cursor forward only, and never past the room head', async () => {
    const alice = await connect(room.people.alice as string);
    const subscribed = await alice.subscribe(room.roomId);
    expect(subscribed.seenSeq).toBe(0);

    for (let i = 0; i < 3; i += 1) await alice.command(send(room.roomId, `m${i}`));

    const ahead = await alice.command({ name: 'advance_seen', roomId: room.roomId, roomSeq: 99 });
    expect(ahead).toMatchObject({ type: 'nack', code: 'invalid' });

    expect(
      await alice.command({ name: 'advance_seen', roomId: room.roomId, roomSeq: 3 }),
    ).toMatchObject({
      type: 'ack',
    });
    const [row] = await handle.db
      .select({ seenSeq: memberships.seenSeq })
      .from(memberships)
      .where(
        and(
          eq(memberships.roomId, room.roomId),
          eq(memberships.userId, room.people.alice as string),
        ),
      );
    expect(Number(row?.seenSeq)).toBe(3);

    // Backwards is a no-op, not a rewind: two tabs must not un-read each other.
    await alice.command({ name: 'advance_seen', roomId: room.roomId, roomSeq: 1 });
    const [after] = await handle.db
      .select({ seenSeq: memberships.seenSeq })
      .from(memberships)
      .where(
        and(
          eq(memberships.roomId, room.roomId),
          eq(memberships.userId, room.people.alice as string),
        ),
      );
    expect(Number(after?.seenSeq)).toBe(3);

    // A cursor is per person: Bob's did not move.
    const [bobs] = await handle.db
      .select({ seenSeq: memberships.seenSeq })
      .from(memberships)
      .where(
        and(eq(memberships.roomId, room.roomId), eq(memberships.userId, room.people.bob as string)),
      );
    expect(Number(bobs?.seenSeq)).toBe(0);

    // And it is not room history — the ledger holds only the three messages.
    expect(await ledgerCount()).toBe(3);
  });
});

describe('live ≡ replay', () => {
  it('folds the ledger from scratch into byte-identical state', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);

    // Exercise every event type the reducer folds, plus the two it does not.
    await alice.command(send(room.roomId, 'we should ship friday'));

    const recordProposal = async (draft: ProposalDraft) => {
      await alice.command({
        name: 'record_proposal',
        roomId: room.roomId,
        proposal: draft,
      });
      return (await lastEvent<{ proposal: { id: string } }>(room.roomId)).proposal.id;
    };
    const accept = async (proposalId: string) => {
      await alice.command({
        name: 'accept_proposal',
        roomId: room.roomId,
        proposalId,
        objectiveId: null,
      });
      return (await lastEvent<{ object: { id: string } }>(room.roomId)).object.id;
    };

    const questionId = await accept(
      await recordProposal({
        ...modelDraft,
        type: 'open_question',
        payload: { question: 'when?', status: 'open' },
      }),
    );
    const decisionId = await accept(
      await recordProposal({
        ...modelDraft,
        type: 'decision',
        payload: { statement: 'friday', decidedBy: null, status: 'active' },
      }),
    );
    const rejected = await recordProposal({
      ...modelDraft,
      type: 'claim',
      payload: {
        statement: 'the build is green',
        claimant: room.people.alice as string,
        verification: 'unverified',
      },
    });
    await alice.command({
      name: 'reject_proposal',
      roomId: room.roomId,
      proposalId: rejected,
      reason: 'it is not',
    });
    await alice.command({
      name: 'answer_bind',
      roomId: room.roomId,
      questionId,
      answerObjectId: decisionId,
      note: null,
    });
    await alice.command({
      name: 'correct',
      roomId: room.roomId,
      objectId: decisionId,
      action: 'amend',
      patch: { statement: 'monday' },
      note: 'friday is a holiday',
    });
    await alice.command({ name: 'set_presence', roomId: room.roomId, state: 'online' });
    await alice.command(send(room.roomId, 'monday then'));

    // The live state — folded event by event as the commands arrived, in
    // whatever order the sockets delivered them.
    const live = server.ledger.serialize();

    // The replay — every core event read back out of the ledger and folded
    // from nothing, by a `reduce` that re-sorts into canonical order.
    const events = await server.ledger.replayCoreEvents();
    const replayed = serializeState(reduce(events));

    expect(replayed).toBe(live);

    // Not vacuous: there is real state in there, and the ledger holds the
    // non-core events too.
    const state = JSON.parse(live) as { objects: Record<string, unknown>; corrections: unknown[] };
    expect(Object.keys(state.objects)).toHaveLength(2);
    expect(state.corrections).toHaveLength(1);
    // 3 × proposal_recorded, 2 × object_accepted, proposal_rejected,
    // relation_added, object_corrected — and two messages the reducer does not
    // fold, plus a presence broadcast that reached the ledger not at all.
    expect(events).toHaveLength(8);
    expect(await ledgerCount()).toBe(10);
  });

  it('rebuilds the same state in a fresh process that only has the ledger', async () => {
    const alice = await connect(room.people.alice as string);
    for (let i = 0; i < 5; i += 1) await alice.command(send(room.roomId, `m${i}`));
    await alice.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'claim',
        payload: {
          statement: 'it works',
          claimant: room.people.alice as string,
          verification: 'unverified',
        },
        confidence: 0.6,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: [],
        interpretationId: null,
      },
    });
    const live = server.ledger.serialize();

    // A second server over the same database, hydrating from nothing — this is
    // what a restart is.
    const restarted = await startTestServer(handle);
    try {
      expect(restarted.ledger.serialize()).toBe(live);
      expect(restarted.ledger.lastSeq()).toBe(server.ledger.lastSeq());
    } finally {
      await restarted.close();
    }
  });
});
