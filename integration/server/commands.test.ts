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
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, ProposalDraft } from '../../apps/server/src/commands.js';
import { projectRoomEvent } from '../../apps/server/src/projections.js';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startSecondInstance,
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

const send = (
  roomId: string,
  body: string,
  clientMessageId: string | null = null,
): Extract<Command, { name: 'send_message' }> => ({
  name: 'send_message',
  roomId,
  body,
  clientMessageId,
  replyToId: null,
  attachments: [],
});

/**
 * The non-payload half of a proposal staged over a socket — every draft below
 * shares it.
 *
 * It takes the cited message rather than defaulting to none because that is what
 * a receipt is, and the citation is projected into `proposal_sources` whose
 * composite FK refuses a message from another room or no message at all.
 *
 * **It no longer names a proposer.** Until r9 this helper was `modelDraft` and
 * said `proposer: {kind:'model', model:'test-model'}`, because the command layer
 * took the proposer from the caller — which is the D1 defect, and a fixture
 * asserting the shape of the thing that was wrong. `ProposalDraft` has no
 * `proposer` field now: everything staged over a socket is a human proposal by
 * the session's own user. The schema rules that apply only to a *model* proposal
 * — non-empty provenance, a mandatory quote on a claim or commitment — are
 * therefore not reachable from the wire at all, and are covered where they live,
 * in `packages/core/test/schemas.test.ts`.
 */
function citedDraft(messageId: string, quote: string): Omit<ProposalDraft, 'type' | 'payload'> {
  return {
    confidence: 0.7,
    provenance: [messageId],
    quote,
    interpretationId: null,
  };
}

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

describe('projection invalidation', () => {
  /**
   * Mutation: broadcast projection_changed globally instead of through the
   * room subscription set. A member of another room is then prompted to reread
   * state they were never authorized to observe.
   */
  it('reaches only subscribers of the invalidated room', async () => {
    const other = await seedRoom(handle, ['mallory'], { slug: 'projection-elsewhere' });
    const alice = await connect(room.people.alice as string);
    const mallory = await connect(other.people.mallory as string);
    await alice.subscribe(room.roomId);
    await mallory.subscribe(other.roomId);
    const mark = alice.frames.length;

    server.realtime.projectionChanged(room.roomId, '2026-08-03T12:00:00.000Z');
    await alice.waitFor(
      (frame) => frame.type === 'projection_changed' && frame.roomId === room.roomId,
      15_000,
      mark,
    );
    expect(mallory.frames.some((frame) => frame.type === 'projection_changed')).toBe(false);
  });

  /**
   * Mutation: notify only this process's hub and omit the event-bus relay. A
   * subscriber on another ordinary server instance never refreshes.
   */
  it('relays an ordinary projection invalidation across server instances', async () => {
    const first = await startSecondInstance();
    const second = await startSecondInstance();
    const alice = await TestClient.connect(second.server.url, room.people.alice as string);
    try {
      await alice.subscribe(room.roomId);
      const mark = alice.frames.length;
      first.server.realtime.projectionChanged(room.roomId, '2026-08-03T12:00:00.000Z');
      await alice.waitFor(
        (frame) => frame.type === 'projection_changed' && frame.roomId === room.roomId,
        15_000,
        mark,
      );
    } finally {
      await alice.close();
      await first.close();
      await second.close();
    }
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

  /** CATCHES: accepting same-room attachment metadata without verifying the upload grant. */
  it('persists only metadata bound by a server-minted capability, never the capability', async () => {
    await server.close();
    server = await startTestServer(handle, {
      attachmentCapabilities: {
        verify: (attachment) =>
          attachment.capability === 'real-grant' &&
          attachment.roomId === room.roomId &&
          attachment.name === 'proof.txt' &&
          attachment.size === 5,
      },
    });
    const alice = await connect(room.people.alice as string);
    const attachment = {
      key: `${room.roomId}/object`,
      name: 'proof.txt',
      contentType: 'text/plain',
      size: 5,
      capability: 'real-grant',
    };

    const refused = await alice.command({
      ...send(room.roomId, 'forged metadata'),
      attachments: [{ ...attachment, name: 'invoice.exe' }],
    });
    expect(refused).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(0);

    const accepted = await alice.command({
      ...send(room.roomId, 'bound metadata'),
      attachments: [attachment],
    });
    expect(accepted.type).toBe('ack');
    const event = await lastEvent<{ attachments: unknown[] }>(room.roomId);
    expect(event.attachments).toEqual([
      { key: attachment.key, name: 'proof.txt', contentType: 'text/plain', size: 5 },
    ]);
    expect(JSON.stringify(event)).not.toContain('real-grant');
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

  /** CATCHES: committing the first rows of appendBatch before a later projection fails. */
  it('rolls back every row and the live fold when the third event in a batch fails', async () => {
    const beforeCount = await ledgerCount();
    const beforeState = server.ledger.serialize();
    let projected = 0;
    await expect(
      server.ledger.appendBatch({
        roomId: room.roomId,
        actor: { kind: 'human', userId: room.people.alice as string },
        builds: [0, 1, 2].map((index) => ({ id, at }: { id: string; at: string }) => ({
          id,
          at,
          type: 'message_posted' as const,
          roomId: room.roomId,
          messageId: randomUUID(),
          body: `batch row ${index}`,
          replyToId: null,
          clientMessageId: `batch-${index}`,
          attachments: [],
        })),
        project: async (context) => {
          projected += 1;
          await projectRoomEvent(context);
          if (projected === 3) throw new Error('third projection failed');
        },
      }),
    ).rejects.toThrow(/third projection failed/);
    expect(await ledgerCount()).toBe(beforeCount);
    expect(server.ledger.serialize()).toBe(beforeState);
    expect(await handle.db.select().from(messages).where(eq(messages.roomId, room.roomId))).toEqual(
      [],
    );
  });
});

describe('the proposal → acceptance boundary, over the wire', () => {
  /**
   * The message a staged reading cites.
   *
   * A human proposer may cite nothing — a person staging their own reading is
   * the receipt — so this is not a schema requirement on the wire path. It is
   * here because the acceptance projects `object_sources`, whose composite
   * `(room_id, message_id)` foreign key refuses a citation of a message from
   * another room or of a message that does not exist, and because a proposal with
   * a receipt is the shape a reader can actually check.
   */
  async function citedMessage(client: TestClient, body: string): Promise<string> {
    const ack = await client.command(send(room.roomId, body));
    expect(ack.type).toBe('ack');
    const posted = await lastEvent<{ messageId: string }>(room.roomId);
    return posted.messageId;
  }

  async function acceptedQuestion(client: TestClient, question: string): Promise<string> {
    const asked = await citedMessage(client, question);
    await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'open_question',
        payload: { question, status: 'open' },
        confidence: 0.9,
        provenance: [asked],
        quote: question,
        interpretationId: null,
      },
    });
    const proposalId = (await lastEvent<{ proposal: { id: string } }>(room.roomId)).proposal.id;
    await client.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    return (await lastEvent<{ object: { id: string } }>(room.roomId)).object.id;
  }

  async function acceptedDecision(client: TestClient, statement: string) {
    const messageId = await citedMessage(client, `we should ${statement}`);
    const recorded = await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'decision',
        payload: { statement, decidedBy: null, status: 'active' },
        confidence: 0.8,
        provenance: [messageId],
        quote: `we should ${statement}`,
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

  /**
   * Mutation: expose no production supersession command, reverse its relation,
   * or acknowledge it without projecting the fold. The older decision then
   * remains active (or the newer one is retired) despite the durable command.
   */
  it('supersedes an accepted object through the authenticated production command', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);
    const older = await acceptedDecision(alice, 'ship on friday');
    const newer = await acceptedDecision(alice, 'ship on monday');
    const aliceMark = alice.frames.length;
    const bobMark = bob.frames.length;

    const ack = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: newer.objectId,
      retiredObjectId: older.objectId,
      clientSupersessionId: 'replace-friday-with-monday',
      note: 'monday replaces friday',
    });
    expect(ack.type).toBe('ack');
    expect(ack.type === 'ack' && ack.issues).toEqual([]);
    const [aliceEvent, bobEvent] = await Promise.all([
      alice.waitFor(
        (frame) => frame.type === 'event' && frame.entry.event.type === 'relation_added',
        15_000,
        aliceMark,
      ),
      bob.waitFor(
        (frame) => frame.type === 'event' && frame.entry.event.type === 'relation_added',
        15_000,
        bobMark,
      ),
    ]);
    expect(aliceEvent).toEqual(bobEvent);

    const rows = await handle.db
      .select()
      .from(acceptedObjects)
      .where(sql`${acceptedObjects.id} in (${older.objectId}, ${newer.objectId})`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const olderRow = byId.get(older.objectId);
    expect(olderRow?.supersededById).toBe(newer.objectId);
    expect((olderRow?.payload as { status?: string } | undefined)?.status).toBe('superseded');
    expect(byId.get(newer.objectId)?.supersededById).toBeNull();

    const [relation] = await handle.db
      .select()
      .from(objectRelations)
      .where(eq(objectRelations.kind, 'supersedes'));
    expect(relation).toMatchObject({
      roomId: room.roomId,
      fromObjectId: newer.objectId,
      toObjectId: older.objectId,
      note: 'monday replaces friday',
      createdBy: room.people.alice,
    });
    expect(server.ledger.coreState().objects[older.objectId]?.supersededById).toBe(newer.objectId);

    const retry = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: newer.objectId,
      retiredObjectId: older.objectId,
      clientSupersessionId: 'replace-friday-with-monday',
      note: 'monday replaces friday',
    });
    expect(retry).toMatchObject({
      type: 'ack',
      roomSeq: ack.type === 'ack' ? ack.roomSeq : null,
      eventId: ack.type === 'ack' ? ack.eventId : null,
    });
    const durableRelations = await handle.db
      .select({ count: count() })
      .from(coreEvents)
      .where(eq(coreEvents.type, 'relation_added'));
    expect(Number(durableRelations[0]?.count)).toBe(1);

    const restarted = await startTestServer(handle);
    const retryingAlice = await TestClient.connect(restarted.url, room.people.alice as string);
    try {
      const afterRestart = await retryingAlice.command({
        name: 'supersede_object',
        roomId: room.roomId,
        replacementObjectId: newer.objectId,
        retiredObjectId: older.objectId,
        clientSupersessionId: 'replace-friday-with-monday',
        note: 'monday replaces friday',
      });
      expect(afterRestart).toMatchObject({
        type: 'ack',
        roomSeq: ack.type === 'ack' ? ack.roomSeq : null,
        eventId: ack.type === 'ack' ? ack.eventId : null,
      });
    } finally {
      await retryingAlice.close();
      await restarted.close();
    }

    const mismatchedRetry = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: newer.objectId,
      retiredObjectId: older.objectId,
      clientSupersessionId: 'replace-friday-with-monday',
      note: 'different durable meaning',
    });
    expect(mismatchedRetry).toMatchObject({ type: 'nack', code: 'conflict' });

    expect(serializeState(reduce(await server.ledger.replayCoreEvents()))).toBe(
      server.ledger.serialize(),
    );
  });

  /**
   * Mutation: remove the active-object allowlist before building the relation.
   * A withdrawn decision can then become the room's current replacement even
   * though it is absent from every live-state surface.
   */
  it('refuses a withdrawn replacement without consuming a ledger position', async () => {
    const alice = await connect(room.people.alice as string);
    const retired = await acceptedDecision(alice, 'ship on friday');
    const withdrawn = await acceptedDecision(alice, 'ship on monday');
    await alice.command({
      name: 'correct',
      roomId: room.roomId,
      objectId: withdrawn.objectId,
      action: 'retract',
      patch: {},
      toType: null,
      provenance: { messageIds: [], proposalId: null, interpretationId: null },
      note: 'withdrawn',
    });
    const before = await ledgerCount();

    const result = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: withdrawn.objectId,
      retiredObjectId: retired.objectId,
      clientSupersessionId: 'withdrawn-cannot-replace',
      note: null,
    });
    expect(result).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(before);
    expect(server.ledger.coreState().objects[retired.objectId]?.supersededById).toBeNull();
  });

  /**
   * Mutation: remove the `replacement.supersededById` active-source check. An
   * object already retired by a newer decision can then retire a third object,
   * creating two contradictory current-state chains from a non-live source.
   */
  it('refuses an already-superseded replacement without consuming a position', async () => {
    const alice = await connect(room.people.alice as string);
    const target = await acceptedDecision(alice, 'ship on friday');
    const staleReplacement = await acceptedDecision(alice, 'ship on monday');
    const currentReplacement = await acceptedDecision(alice, 'ship on tuesday');
    await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: currentReplacement.objectId,
      retiredObjectId: staleReplacement.objectId,
      clientSupersessionId: 'make-tuesday-current',
      note: null,
    });
    const before = await ledgerCount();

    const result = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: staleReplacement.objectId,
      retiredObjectId: target.objectId,
      clientSupersessionId: 'stale-cannot-replace',
      note: null,
    });
    expect(result).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(before);
    expect(server.ledger.coreState().objects[target.objectId]?.supersededById).toBeNull();
  });

  /**
   * Mutation: remove the `retired.retractedAt` active-target check. A command
   * can then attach live supersession state to an object the room withdrew.
   */
  it('refuses a retracted target without consuming a ledger position', async () => {
    const alice = await connect(room.people.alice as string);
    const withdrawnTarget = await acceptedDecision(alice, 'ship on friday');
    const replacement = await acceptedDecision(alice, 'ship on monday');
    await alice.command({
      name: 'correct',
      roomId: room.roomId,
      objectId: withdrawnTarget.objectId,
      action: 'retract',
      patch: {},
      toType: null,
      provenance: { messageIds: [], proposalId: null, interpretationId: null },
      note: null,
    });
    const before = await ledgerCount();

    const result = await alice.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: replacement.objectId,
      retiredObjectId: withdrawnTarget.objectId,
      clientSupersessionId: 'withdrawn-target',
      note: null,
    });
    expect(result).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(before);
    expect(server.ledger.coreState().objects[withdrawnTarget.objectId]?.supersededById).toBeNull();
  });

  /**
   * Mutation: authorize competing replacements outside the append lock or let
   * a refused relation persist with issues. Two servers then both acknowledge,
   * or the loser consumes a durable event despite changing no state.
   */
  it('serializes competing replacements to one clean durable winner', async () => {
    const alice = await connect(room.people.alice as string);
    const retired = await acceptedDecision(alice, 'ship on friday');
    const monday = await acceptedDecision(alice, 'ship on monday');
    const tuesday = await acceptedDecision(alice, 'ship on tuesday');
    const second = await startTestServer(handle);
    const bob = await TestClient.connect(second.url, room.people.bob as string);
    try {
      const results = await Promise.all([
        alice.fire({
          name: 'supersede_object',
          roomId: room.roomId,
          replacementObjectId: monday.objectId,
          retiredObjectId: retired.objectId,
          clientSupersessionId: 'race-monday',
          note: null,
        }),
        bob.fire({
          name: 'supersede_object',
          roomId: room.roomId,
          replacementObjectId: tuesday.objectId,
          retiredObjectId: retired.objectId,
          clientSupersessionId: 'race-tuesday',
          note: null,
        }),
      ]);
      expect(results.map((result) => result.type).sort()).toEqual(['ack', 'nack']);

      await server.ledger.sync();
      await second.ledger.sync();
      const relations = await handle.db
        .select()
        .from(objectRelations)
        .where(eq(objectRelations.kind, 'supersedes'));
      expect(relations).toHaveLength(1);
      const winner = relations[0]?.fromObjectId;
      expect([monday.objectId, tuesday.objectId]).toContain(winner);
      expect(server.ledger.coreState().objects[retired.objectId]?.supersededById).toBe(winner);
      expect(second.ledger.serialize()).toBe(server.ledger.serialize());
      expect(serializeState(reduce(await server.ledger.replayCoreEvents()))).toBe(
        server.ledger.serialize(),
      );
    } finally {
      await bob.close();
      await second.close();
    }
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

  /**
   * The sentence that bounded the two-oracle seam, as a test (#22 gauntlet r6,
   * minor 5).
   *
   * `apps/server/src/ledger.ts` and `0007_kind_discriminated_room.sql` both said
   * the log oracle and the fold oracle differ only for a minting event "which
   * only a direct SQL caller can put there, since this function refuses to append
   * one". They do not: `append` aborts on `rejected`/`malformed`, a business
   * refusal is `applied_with_issue`, and `applied_with_issue` **is appended** —
   * which the test above has demonstrated all along without anybody connecting it
   * to the containment claim.
   *
   * So this asserts the connection directly, which is the thing the comment was
   * asserting in prose: the ordinary command path, over a real socket, puts a
   * minting row in `core_events` that `coreState()` does not install. Both
   * comments now say that; this is what makes them stay true.
   *
   * There is still no cross-room misroute here — the r6 critic looked and found
   * none, and the second `object_accepted` names the same room as the first. What
   * changes is who can reach the seam.
   */
  it('appends a minting event the fold does not install, through the ordinary path', async () => {
    const alice = await connect(room.people.alice as string);
    const { proposalId, objectId } = await acceptedDecision(alice, 'ship on friday');

    const again = await alice.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    expect(again.type).toBe('ack');

    // Two `object_accepted` rows in the durable log, from one client, with no
    // direct SQL anywhere.
    // `orderBy` is load-bearing, not tidiness: without it Postgres may return
    // these two rows in either order and the identity assertions below become a
    // coin flip. (Found by this round's self-adversarial pass, against the
    // json-reporter run the mutant runner uses — the plain run had been green
    // three times.)
    const minting = await handle.db
      .select({ payload: coreEvents.payload, roomId: coreEvents.roomId })
      .from(coreEvents)
      .where(eq(coreEvents.type, 'object_accepted'))
      .orderBy(coreEvents.seq);
    expect(minting).toHaveLength(2);
    // Both name this room, which is the half that still holds: the CHECK pins
    // `room_id` to `object.roomId`, so the log oracle can only ever answer this
    // room for either of them.
    expect(minting.map((r) => r.roomId)).toEqual([room.roomId, room.roomId]);

    // And the second object is not in the fold. That is the seam: the log has a
    // minting row for it, `coreState()` does not.
    const minted = minting.map((r) => (r.payload as { object: { id: string } }).object.id);
    expect(minted).toHaveLength(2);
    expect(minted[0]).toBe(objectId);
    expect(minted[1]).not.toBe(objectId);
    const state = server.ledger.coreState();
    expect(state.objects[minted[0] as string]).toBeDefined();
    expect(state.objects[minted[1] as string]).toBeUndefined();
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

    const asked = await citedMessage(alice, 'when do we ship?');
    const question = await alice.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'open_question',
        payload: { question: 'when do we ship?', status: 'open' },
        confidence: 0.9,
        provenance: [asked],
        quote: 'when do we ship?',
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

  /** CATCHES: posting a bound answer as chat while leaving its question open. */
  it('commits the typed answer, accepted decision and answers relation as one ordered meaning', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = await connect(room.people.bob as string);
    const questionId = await acceptedQuestion(alice, 'which release date?');
    await alice.subscribe(room.roomId);
    await bob.subscribe(room.roomId);
    const before = await server.ledger.head(room.roomId);

    const answerCommand = {
      name: 'answer_message',
      roomId: room.roomId,
      questionId,
      body: 'Ship on Friday.',
      clientMessageId: 'bound-answer-1',
      attachments: [],
    } satisfies Command;
    const ack = await alice.command(answerCommand);
    expect(ack).toMatchObject({ type: 'ack', roomSeq: before + 3 });
    await bob.waitFor((frame) => frame.type === 'event' && frame.entry.roomSeq === before + 3);
    const batch = (await server.ledger.since(room.roomId, before)).slice(0, 3);
    expect(batch.map((entry) => entry.event.type)).toEqual([
      'message_posted',
      'object_accepted',
      'relation_added',
    ]);
    expect(batch.map((entry) => entry.roomSeq)).toEqual([before + 1, before + 2, before + 3]);
    const posted = batch[0]?.event as { messageId: string };
    const accepted = batch[1]?.event as {
      object: { id: string; provenance: { messageIds: string[] } };
    };
    expect(accepted.object.provenance.messageIds).toEqual([posted.messageId]);

    const [question] = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, questionId));
    if (!question) throw new Error('the question projection is missing');
    expect((question.payload as { status: string }).status).toBe('answered');
    const [answer] = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, accepted.object.id));
    if (!answer) throw new Error('the answer projection is missing');
    expect(answer.acceptedBy).toBe(room.people.alice);
    expect((answer.payload as { statement: string }).statement).toBe('Ship on Friday.');
    expect(serializeState(reduce(await server.ledger.replayCoreEvents()))).toBe(
      server.ledger.serialize(),
    );

    const count = await ledgerCount();
    /** CATCHES: a fresh process re-executing or refusing an answer whose ack was lost. */
    const restarted = await startTestServer(handle);
    const retryingAlice = await TestClient.connect(restarted.url, room.people.alice as string);
    try {
      const retry = await retryingAlice.command(answerCommand);
      expect(retry).toMatchObject({
        type: 'ack',
        roomSeq: before + 3,
        eventId: batch[2]?.event.id,
      });
      expect(await ledgerCount()).toBe(count);
    } finally {
      await retryingAlice.close();
      await restarted.close();
    }

    /** CATCHES: treating a retry key as authority for a different answer payload. */
    const mismatch = await alice.command({
      ...answerCommand,
      body: 'Ship on Monday.',
    });
    expect(mismatch).toMatchObject({ type: 'nack', code: 'conflict' });
    expect(await ledgerCount()).toBe(count);

    const second = await alice.command({
      ...answerCommand,
      body: 'Ship on Monday.',
      clientMessageId: 'bound-answer-2',
    });
    expect(second).toMatchObject({ type: 'nack', code: 'invalid' });
    expect(await ledgerCount()).toBe(count);
  });

  /** CATCHES: two processes committing the same retry key before either sees the other's receipt. */
  it('serializes concurrent identical bound answers to one durable batch', async () => {
    const alice = await connect(room.people.alice as string);
    const questionId = await acceptedQuestion(alice, 'which deployment window?');
    const peer = await startTestServer(handle);
    const peerAlice = await TestClient.connect(peer.url, room.people.alice as string);
    const before = await ledgerCount();
    const command = {
      name: 'answer_message',
      roomId: room.roomId,
      questionId,
      body: 'Use the Friday window.',
      clientMessageId: 'concurrent-bound-answer',
      attachments: [],
    } satisfies Command;
    try {
      const [left, right] = await Promise.all([alice.command(command), peerAlice.command(command)]);
      expect(left).toMatchObject({ type: 'ack' });
      expect(right).toMatchObject({
        type: 'ack',
        roomSeq: left.type === 'ack' ? left.roomSeq : undefined,
        eventId: left.type === 'ack' ? left.eventId : undefined,
      });
      expect(await ledgerCount()).toBe(before + 3);
      const rows = await server.ledger.since(room.roomId, 0);
      expect(rows.slice(-3).map((entry) => entry.event.type)).toEqual([
        'message_posted',
        'object_accepted',
        'relation_added',
      ]);
    } finally {
      await peerAlice.close();
      await peer.close();
    }
  });

  /** CATCHES: rechecking an expired upload grant before consulting a committed command receipt. */
  it('recovers an attached answer after its fresh-write capability expires', async () => {
    const alice = await connect(room.people.alice as string);
    const questionId = await acceptedQuestion(alice, 'which artifact is final?');
    let capabilityValid = true;
    const withAttachments = await startTestServer(handle, {
      attachmentCapabilities: { verify: () => capabilityValid },
    });
    const attachedAlice = await TestClient.connect(
      withAttachments.url,
      room.people.alice as string,
    );
    const command = {
      name: 'answer_message',
      roomId: room.roomId,
      questionId,
      body: 'The signed release archive is final.',
      clientMessageId: 'attached-bound-answer',
      attachments: [
        {
          key: `${room.roomId}/release.tar.zst`,
          name: 'release.tar.zst',
          contentType: 'application/zstd',
          size: 17,
          capability: 'fresh-only-grant',
        },
      ],
    } satisfies Command;
    try {
      const first = await attachedAlice.command(command);
      expect(first).toMatchObject({ type: 'ack' });
      const countAfterFirst = await ledgerCount();
      capabilityValid = false;
      const retry = await attachedAlice.command(command);
      expect(retry).toMatchObject({
        type: 'ack',
        roomSeq: first.type === 'ack' ? first.roomSeq : undefined,
        eventId: first.type === 'ack' ? first.eventId : undefined,
      });
      expect(await ledgerCount()).toBe(countAfterFirst);
    } finally {
      await attachedAlice.close();
      await withAttachments.close();
    }
  });

  /**
   * A human proposer is the session, not a parameter (#22 r8 self-review).
   *
   * The round's own adversarial pass — *what is this guard's input made of, and
   * who wrote it?* — asked it of `acceptance.ts`'s #4 rule and got the wrong
   * answer. That rule reads `proposal.proposer.userId` to decide whether a
   * commitment is `self` or `third_party`, and therefore whether it waits for the
   * named owner to confirm: **nobody gets committed by someone else's sentence.**
   * Its input was a field the sentence's author wrote.
   *
   * So Alice stages a commitment owned by Bob and claims to *be* Bob. On r7 the
   * proposal was stored with `proposer.userId = bob`, `staged === attributedTo`,
   * the reading classified as `self`, and the confirmation the rule exists to
   * demand was never asked for — Alice having committed Bob with Bob's name on
   * both ends of the sentence. The trusted `actor` columns were always Alice's;
   * this is the other identity in the row, the one nothing was deriving.
   *
   * **r9 asks the same question of the other branch.** r8 fixed the *human*
   * spelling and passed a *model* proposer through as written, on the grounds
   * that `record_proposal` is the seam #21's pipeline will call. It is not — it
   * is on the participant socket, and a member writing `proposer: {kind:'model',
   * …}` by hand produced a durable row that read as a machine's reading. So this
   * now drives both spellings of the same forgery over one socket and asserts
   * that neither reaches the ledger, and that `staged_by_*` names the person who
   * typed it either way.
   *
   * Both keys are sent through a cast, because `ProposalDraft` no longer has a
   * `proposer` field at all — which is the fix, and is why the cast is the
   * faithful thing to write here rather than a hole in the test: a real socket
   * sends JSON, an unknown key is stripped by zod, and this is the only way to
   * put on the wire what a real attacker would put on the wire.
   */
  it('files a human proposal under the session, not under the name the client sent', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = room.people.bob as string;
    const messageId = await citedMessage(alice, 'bob will write the migration');

    const forge = async (proposer: unknown) =>
      alice.command({
        name: 'record_proposal',
        roomId: room.roomId,
        proposal: {
          type: 'commitment',
          payload: { statement: 'write the migration', owner: bob, due: null, status: 'open' },
          confidence: 0.9,
          proposer,
          provenance: [messageId],
          quote: 'bob will write the migration',
          interpretationId: null,
        },
      } as unknown as Command);

    // The forgery r8 found: Alice's socket, Bob's name on the staging.
    const recorded = await forge({ kind: 'human', userId: bob });
    expect(recorded.type).toBe('ack');

    const proposal = (
      await lastEvent<{ proposal: { id: string; proposer: { kind: string; userId: string } } }>(
        room.roomId,
      )
    ).proposal;
    // The ledger row, which is what a replay reads and what acceptance folds.
    expect(proposal.proposer).toEqual({ kind: 'human', userId: room.people.alice });

    // And the consequence, which is the reason it matters: the commitment names
    // somebody other than its stager, so it is third-party and waits for Bob.
    const [stored] = await handle.db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(stored?.proposerUserId).toBe(room.people.alice);
    expect(stored?.stagedByKind).toBe('human');
    expect(stored?.stagedById).toBe(room.people.alice);

    // The forgery r9 found: the same sentence, dressed as a machine's reading.
    const dressed = await forge({ kind: 'model', model: 'claude-opus-4.6' });
    expect(dressed.type).toBe('ack');
    const second = (
      await lastEvent<{ proposal: { id: string; proposer: { kind: string; userId: string } } }>(
        room.roomId,
      )
    ).proposal;
    expect(second.proposer).toEqual({ kind: 'human', userId: room.people.alice });

    const [dressedRow] = await handle.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, second.id));
    expect(dressedRow?.proposerKind).toBe('human');
    expect(dressedRow?.proposerModel).toBeNull();
    expect(dressedRow?.proposerUserId).toBe(room.people.alice);
    expect(dressedRow?.stagedByKind).toBe('human');
    expect(dressedRow?.stagedById).toBe(room.people.alice);
    expect(dressedRow?.quote).toBe('bob will write the migration');
  });

  /**
   * The other half of D1, and the half that closes the *class* rather than
   * today's door.
   *
   * Removing `proposer` from the draft means a socket cannot spell the forgery
   * any more — but it is one seam, and #21's pipeline will need a seam that
   * *can* stage a model reading. So the durable rule has to hold against a model
   * proposal that reached the ledger some other way, and this drives exactly
   * that: `ledger.append` (the production append, the real reducer, the real
   * trusted-window derivation) records a model-attributed commitment naming Bob,
   * under **Alice's** human actor. Then Alice accepts it over her socket, which
   * is the ordinary `accept_proposal` command every member has.
   *
   * On r8 this was two acks and a durable commitment against Bob. The refusal
   * has to be a *refusal* — no object, no row, an aborted transaction — not an
   * `applied_with_issue` that lands the object and files a complaint.
   */
  it('refuses a human accepting a machine-attributed reading they staged themselves', async () => {
    const alice = await connect(room.people.alice as string);
    const bob = room.people.bob as string;
    const messageId = await citedMessage(alice, 'anything at all, in alice’s own words');

    const proposalId = randomUUID();
    await server.ledger.append({
      roomId: room.roomId,
      // The staging actor: a person. The proposal it carries says a model read
      // it. Those are the two facts the rule is about, and until r9 only the
      // second one was recorded anywhere a reader could see.
      actor: { kind: 'human', userId: room.people.alice as string },
      build: ({ id, at }) =>
        ({
          id,
          at,
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId: room.roomId,
            type: 'commitment',
            payload: {
              statement: 'bob takes full responsibility and will pay personally',
              owner: bob,
              due: null,
              status: 'open',
            },
            confidence: 1,
            proposer: { kind: 'model', model: 'claude-opus-4.6' },
            provenance: [messageId],
            // A sentence that appears in no cited message. Nothing on the human
            // acceptance path ever matched it against anything, which is why the
            // dressing was worth putting on.
            quote: 'yes, I take full responsibility and will pay for it personally',
            interpretationId: null,
            status: 'proposed',
            createdAt: at,
          },
        }) as never,
      // The real projection, in the same transaction as the append — the same
      // callback `appendAndProject` hands over. Without it this would append a
      // ledger row and assert about a `proposals` table nobody wrote.
      project: (context) => projectRoomEvent(context),
    });

    // The read model can now name the person, which is the fact the refusal and
    // every other remedy needs.
    const [staged] = await handle.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(staged?.proposerKind).toBe('model');
    expect(staged?.stagedByKind).toBe('human');
    expect(staged?.stagedById).toBe(room.people.alice);

    const refused = await alice.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    /**
     * An `ack` carrying an issue, not a `nack` — and that is the architecture's
     * answer for every authority gate, not a weakening of this one. `ledger.ts`:
     * "`append` aborts on `rejected` and `malformed` only. A **business** refusal
     * is `applied_with_issue`, and `applied_with_issue` is appended — that is the
     * whole point of it." The attempt is history; what it did not do is mint
     * anything. `acceptance_binding` and the receipt gates all answer this way.
     *
     * So the assertion that matters is the pair: the reason is on the wire, and
     * `accepted_objects` is empty. On r8 this was `ack` with `issues: []` and a
     * durable commitment against Bob.
     */
    expect(refused.type).toBe('ack');
    expect(refused).toMatchObject({
      issues: [expect.stringContaining('nobody validates their own attribution to a model')],
    });

    // No object, and the proposal is still open for somebody else to judge.
    const objects = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.roomId, room.roomId));
    expect(objects).toEqual([]);
    const [after] = await handle.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(after?.status).toBe('proposed');

    // …and somebody else in the room can, which is the design position this
    // narrows rather than abandons: a person who reads a machine's reading and
    // accepts it *is* the receipt, as long as they are not the person who wrote
    // the reading.
    const bobClient = await connect(bob);
    const accepted = await bobClient.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
      objectiveId: null,
    });
    expect(accepted.type).toBe('ack');
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
      reason: { kind: 'commitment_open', statement: 'you own this commitment', due: null },
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
  /**
   * The receipt's inputs are immutable, so a later mutation of `messages` cannot
   * rewrite a fold that already happened (#22 gauntlet r3 delta, blocking 2).
   *
   * The finding, verbatim:
   *
   * > Both paths share `trustFor`/`provenanceMessageIds`, but the bodies come
   * > from `messages` whose `authorId` is `onDelete: 'set null'` […] Delete a
   * > human author and a model `object_accepted` that folded cleanly under a real
   * > `authorId` replays with `''`, fails the receipt, and is absent from
   * > replayed state. Same derivation code, different substrate.
   *
   * A **claim** is the sharpest instance, because `attributed_person_not_author`
   * is the one receipt problem whose verdict is a function of `authorId` and
   * whose severity is `reject`: a claim whose claimant wrote none of the cited
   * messages is a wrong receipt, and the whole acceptance is refused. Alice
   * claims something in her own words, a model reads it, the room accepts it —
   * and then Alice's account is deleted, which is an ordinary thing for a product
   * to allow.
   *
   * Under r3 the replay re-reads `messages`, finds `author_id` NULL, maps it to
   * `''`, and refuses the acceptance that a live fold had allowed: the object is
   * simply missing from replayed state and `replayed !== live`. Under r4 the
   * window the fold saw is on the row, so the deletion changes nothing about
   * history — which is what an append-only ledger is supposed to mean.
   *
   * Catches: re-deriving the trusted window from `messages` on any fold path
   * (`catchUp`, `replayCoreEvents`), and not writing `trusted_messages` at
   * append.
   */
  /* ------------------------------------------------------------------------
   * WAS THE ONE RED TEST ON `merge/foundation`, AND IT WAS A PRODUCT
   * CONTRADICTION RATHER THAN A BROKEN TEST. Closed by #86 / `drizzle/0011`.
   * The history stays because the fix is only legible against it.
   *
   * The merge put two lanes' definitions of THE RECEIPT WINDOW in one tree, and
   * they could not both be satisfied:
   *
   *   · `fix/realtime-r11` — `atrium_receipt_window()` in
   *     `0006_derived_receipt_snapshot.sql` snapshots the window at append into
   *     an immutable column, and selects EXACTLY the cited messages
   *     (`m.id IN (payload->object->provenance->messageIds)`). That is the r3
   *     delta's blocking fix: a window re-derived from `messages` on every fold
   *     is a deterministic function of mutable inputs, so deleting an author
   *     rewrote history.
   *
   *   · `fix/core-engine-r12` — `laterRevision()` in `escalation.ts` refuses any
   *     window that ends at the citations: "whether a later message takes it
   *     back was never established". That is the r5 fix for a proposal citing
   *     only "we will deploy Friday" while "Correction: we will not" sat
   *     unread one row later.
   *
   * Neither rule exists on `main`, and each lane is internally consistent —
   * `window_ends_at_the_citations` appears only on the core branch,
   * cited-only `atrium_receipt_window` only on the realtime branch. Together
   * the SQL cannot produce a window the TypeScript will certify, so EVERY
   * non-human acceptance is refused `refer` and the model path is dead.
   *
   * THE FIX, and which side moved. `drizzle/0011` redefines the function to
   * snapshot the cited messages PLUS the room's next messages after the newest
   * citation — keeping the realtime lane's immutability (still a snapshot, still
   * taken at append, still derived from the row and from nothing a caller says)
   * and satisfying the core lane's evidence requirement. The TypeScript did not
   * move: `window_ends_at_the_citations` is a real refusal with a real argument,
   * and narrowing it would have traded a dead path for a wrong one.
   *
   * The bound had to agree with a TypeScript constant a static migration cannot
   * read, which is what made this a decision rather than a merge resolution.
   * Generating the migration from the constant was rejected — migrations are the
   * one artifact here that must be readable and immutable after the fact. The
   * migration carries a literal, `policy.ts` carries
   * `RECEIPT_POLICY.maxLaterMessagesCarried`, and
   * `packages/db/test/schema.test.ts` fails the build when they diverge. The
   * literal is one MORE than `maxLaterMessagesScanned`, so a window the room
   * outgrew is visibly over the checker's read bound rather than quietly
   * truncated; `laterRevision` refuses by name if that relation is ever broken.
   *
   * The extra message this fixture posts after the cited one is what the rule
   * asks for and is now load-bearing in both directions: the acceptance below
   * needs it to land at all, and the window assertion further down reads it back
   * out of the snapshot.
   * --------------------------------------------------------------------- */
  it('replays an accepted claim identically after its author is deleted', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);

    const quote = 'the deploy pipeline is green';
    await alice.command(send(room.roomId, quote));
    const cited = (await lastEvent<{ messageId: string }>(room.roomId)).messageId;
    /* ONE MESSAGE AFTER THE CITED ONE, BECAUSE #21's RECEIPT CHECK NOW ASKS FOR
       ONE. The core lane tightened `receipt_not_certifiable`: a window that ends
       at the newest cited message "read no evidence about what came after the
       quoted sentence — whether a later message takes it back was never
       established". This fixture posted exactly up to the citation, so on the
       merged tree the model acceptance below was refused and the case failed
       with an empty room rather than with the thing it is about.

       It is a fixture change, not a weakening: the case is that a fold and a
       replay agree after the author's row is deleted, and it needs an
       acceptance that LANDS to have anything to compare. The extra message is
       ordinary room traffic that does not mention the claim, which is the
       cheapest shape that satisfies the rule — and it is Alice's too, so the
       deletion below still removes the author of every message in the window. */
    await alice.command(send(room.roomId, 'and the changelog is out'));
    const afterwards = (await lastEvent<{ messageId: string }>(room.roomId)).messageId;

    /**
     * Staged by a **model**, through the ledger's own append — as of r9, the only
     * way there is.
     *
     * Until r9 this went over the socket with `proposer: {kind:'model', …}` in the
     * draft, because the command layer took the proposer from the caller. That is
     * D1, and the command layer no longer offers the field: a socket stages human
     * proposals and nothing else. A model reading now enters the way #21's
     * pipeline will enter it, under a model actor, which is also what makes the
     * acceptance below legal — `actorMatchesProposer` binds a model actor to its
     * own model id, so a model may not accept a person's staged reading.
     *
     * Note what did **not** change: this is still the production append, still the
     * real reducer, still the real trusted-window derivation. The staging moved
     * one seam over; nothing about what this test measures did.
     */
    const proposalId = randomUUID();
    await server.ledger.append({
      roomId: room.roomId,
      actor: { kind: 'model', model: 'test-model' },
      build: ({ id, at }) =>
        ({
          id,
          at,
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId: room.roomId,
            type: 'claim',
            payload: {
              statement: quote,
              claimant: room.people.alice as string,
              verification: 'unverified',
            },
            confidence: 0.7,
            proposer: { kind: 'model', model: 'test-model' },
            provenance: [cited],
            quote,
            interpretationId: null,
            status: 'proposed',
            createdAt: at,
          },
        }) as never,
    });

    /**
     * Accepted by a **model**, through the ledger's own append.
     *
     * Not a shortcut, and worth saying why rather than leaving it to be
     * questioned. #21's receipt gate runs for non-human acceptances only — a
     * person accepting a reading has read it, and their judgement is the receipt
     * — so a human-accepted object never touches the trusted window and cannot
     * demonstrate anything about it. No *command* carries a model actor today,
     * which r3's receipt admitted as its deviation 4: "the non-human path is
     * currently exercised by construction rather than by a test — worth a
     * critic's eye." This is that test. `ledger.append` is the production append,
     * with the actor the interpretation worker will supply.
     */
    const stored = server.ledger.coreState().proposals[proposalId];
    if (!stored) throw new Error('the proposal did not reach core state');
    const objectId = randomUUID();
    await server.ledger.append({
      roomId: room.roomId,
      actor: { kind: 'model', model: 'test-model' },
      build: ({ id, at }) =>
        ({
          id,
          at,
          type: 'object_accepted',
          object: {
            id: objectId,
            roomId: room.roomId,
            type: stored.proposal.type,
            payload: stored.proposal.payload,
            objectiveId: null,
            provenance: {
              messageIds: stored.proposal.provenance,
              proposalId,
              interpretationId: null,
            },
            createdAt: at,
            updatedAt: at,
          },
        }) as never,
    });

    const live = server.ledger.serialize();
    const before = JSON.parse(live) as { objects: Record<string, unknown> };
    // Not vacuous: the model acceptance really did land, so its absence after the
    // deletion would be a change rather than a room that never had one.
    expect(Object.keys(before.objects)).toEqual([objectId]);

    // The snapshot the append recorded, read from the ledger row rather than
    // inferred — "we wrote a column" is the claim being made.
    //
    // TWO messages since #86: the cited one and what the room said after it. The
    // second is not padding and its presence is the fix — `laterRevision` refuses
    // a window that ends at the citations, so a window of one is precisely the
    // deadlock that made this test red on the merged tree. Written out rather
    // than sliced from a longer array, so the mutant that reverts
    // `atrium_receipt_window` to 0006's cited-only SELECT
    // (`receipt_window_ends_at_the_citations`) fails here as well as in
    // `ledger-constraints.test.ts`.
    const expectedWindow = [
      { id: cited, authorId: room.people.alice as string, body: quote },
      { id: afterwards, authorId: room.people.alice as string, body: 'and the changelog is out' },
    ];
    const [row] = await handle.db
      .select({ trusted: coreEvents.trustedMessages })
      .from(coreEvents)
      .where(eq(coreEvents.type, 'object_accepted'));
    expect(row?.trusted).toEqual(expectedWindow);

    // The substrate moves. `messages.author_id` is ON DELETE SET NULL, so this is
    // the ordinary consequence of an ordinary product feature — not a corruption,
    // not an operator error, and nothing a migration could have anticipated.
    await handle.db.execute(sql`DELETE FROM users WHERE id = ${room.people.alice as string}`);
    const [message] = await handle.db
      .select({ authorId: messages.authorId })
      .from(messages)
      .where(eq(messages.id, cited));
    expect(message?.authorId).toBeNull();

    // The snapshot did not move with it — the whole window, tail included. The
    // tail is what #86 widened and it is snapshotted by the same mechanism, so it
    // has to be as immutable as the cited half: a later message whose author is
    // deleted keeps the name it had when the receipt was taken.
    const [stillThere] = await handle.db
      .select({ trusted: coreEvents.trustedMessages })
      .from(coreEvents)
      .where(eq(coreEvents.type, 'object_accepted'));
    expect(stillThere?.trusted).toEqual(expectedWindow);

    // Under r3 this is where it breaks: the replay re-reads `messages`, finds
    // `author_id` NULL, maps it to `''`, raises `attributed_person_not_author`
    // with severity `reject`, and the object is simply missing from replayed
    // state.
    const events = await server.ledger.replayCoreEvents();
    expect(serializeState(reduce(events))).toBe(live);
  });

  it('folds the ledger from scratch into byte-identical state', async () => {
    const alice = await connect(room.people.alice as string);
    await alice.subscribe(room.roomId);

    // Exercise every event type the reducer folds, plus the two it does not.
    const quote = 'we should ship friday';
    await alice.command(send(room.roomId, quote));
    // The message every model reading below cites. It has to be a real row: the
    // acceptance projects `object_sources`, whose composite `(room_id,
    // message_id)` foreign key refuses a citation of a message from another room
    // or of no message at all.
    const cited = (await lastEvent<{ messageId: string }>(room.roomId)).messageId;
    const draft = citedDraft(cited, quote);

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
        ...draft,
        type: 'open_question',
        payload: { question: 'when?', status: 'open' },
      }),
    );
    const decisionId = await accept(
      await recordProposal({
        ...draft,
        type: 'decision',
        payload: { statement: 'friday', decidedBy: null, status: 'active' },
      }),
    );
    const rejected = await recordProposal({
      ...draft,
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
