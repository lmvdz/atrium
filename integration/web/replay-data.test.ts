import {
  acceptedObjects,
  interpretations,
  messages,
  objectSources,
  proposalSources,
  proposals,
  type NewAcceptedObjectRow,
  type NewInterpretation,
  type NewProposalRow,
} from '@atrium/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadReplayData } from '../../apps/web/lib/replay-data.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

describe('persisted replay data', () => {
  /**
   * Mutation: remove the room predicate from any replay query. The foreign
   * room's message, proposal, object, interpretation or provenance edge then
   * appears in this snapshot, and a replay presents another room's words or
   * semantic state as part of this conversation.
   *
   * Mutation: order messages by id or insertion result rather than `seq`. The
   * two deliberately reversed ids below render in the wrong chronology.
   */
  it('loads one complete room in ledger order without cross-room state', async () => {
    const own = await seedRoom(handle, ['alice'], { slug: 'demo' });
    const foreign = await seedRoom(handle, ['mallory'], { slug: 'foreign' });
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const foreignMessageId = randomUUID();

    await handle.db.insert(messages).values([
      {
        id: firstMessageId,
        roomId: own.roomId,
        authorId: own.people.alice,
        body: 'first in the room',
      },
      {
        id: secondMessageId,
        roomId: own.roomId,
        authorId: own.people.alice,
        body: 'second in the room',
        replyToId: firstMessageId,
      },
      {
        id: foreignMessageId,
        roomId: foreign.roomId,
        authorId: foreign.people.mallory,
        body: 'not part of this replay',
      },
    ]);

    const ownInterpretationId = randomUUID();
    const foreignInterpretationId = randomUUID();
    const interpretationRows: NewInterpretation[] = [
      { id: ownInterpretationId, messageId: firstMessageId, status: 'succeeded' },
      { id: foreignInterpretationId, messageId: foreignMessageId, status: 'succeeded' },
    ];
    await handle.db.insert(interpretations).values(interpretationRows);

    const ownProposalId = randomUUID();
    const foreignProposalId = randomUUID();
    const proposalRows: NewProposalRow[] = [
      {
        id: ownProposalId,
        roomId: own.roomId,
        interpretationId: ownInterpretationId,
        type: 'claim',
        payload: {
          statement: 'first in the room',
          claimant: own.people.alice as string,
          verification: 'unverified',
        },
        confidence: 0.9,
        proposerKind: 'model',
        proposerModel: 'replay/test',
        stagedByKind: 'model',
        stagedById: 'replay/test',
        quote: 'first in the room',
      },
      {
        id: foreignProposalId,
        roomId: foreign.roomId,
        interpretationId: foreignInterpretationId,
        type: 'claim',
        payload: {
          statement: 'not part of this replay',
          claimant: foreign.people.mallory as string,
          verification: 'unverified',
        },
        confidence: 0.9,
        proposerKind: 'model',
        proposerModel: 'replay/test',
        stagedByKind: 'model',
        stagedById: 'replay/test',
        quote: 'not part of this replay',
      },
    ];
    await handle.db.insert(proposals).values(proposalRows);
    await handle.db.insert(proposalSources).values([
      { roomId: own.roomId, proposalId: ownProposalId, messageId: firstMessageId },
      {
        roomId: foreign.roomId,
        proposalId: foreignProposalId,
        messageId: foreignMessageId,
      },
    ]);

    const ownObjectId = randomUUID();
    const foreignObjectId = randomUUID();
    const objectRows: NewAcceptedObjectRow[] = [
      {
        id: ownObjectId,
        roomId: own.roomId,
        type: 'claim',
        payload: {
          statement: 'first in the room',
          claimant: own.people.alice as string,
          verification: 'unverified',
        },
        proposalId: ownProposalId,
      },
      {
        id: foreignObjectId,
        roomId: foreign.roomId,
        type: 'claim',
        payload: {
          statement: 'not part of this replay',
          claimant: foreign.people.mallory as string,
          verification: 'unverified',
        },
        proposalId: foreignProposalId,
      },
    ];
    await handle.db.insert(acceptedObjects).values(objectRows);
    await handle.db.insert(objectSources).values([
      { roomId: own.roomId, objectId: ownObjectId, messageId: secondMessageId },
      { roomId: foreign.roomId, objectId: foreignObjectId, messageId: foreignMessageId },
    ]);

    const replay = await loadReplayData(handle.db, own.roomId);

    expect(replay).not.toBeNull();
    expect(replay?.messages.map((message) => message.body)).toEqual([
      'first in the room',
      'second in the room',
    ]);
    expect(replay?.interpretations.map((row) => row.id)).toEqual([ownInterpretationId]);
    expect(replay?.proposals.map((row) => row.id)).toEqual([ownProposalId]);
    expect(replay?.proposalSources).toEqual([
      { roomId: own.roomId, proposalId: ownProposalId, messageId: firstMessageId },
    ]);
    expect(replay?.objects.map((row) => row.id)).toEqual([ownObjectId]);
    expect(replay?.objectSources).toEqual([
      { roomId: own.roomId, objectId: ownObjectId, messageId: secondMessageId },
    ]);
    expect(replay?.participants.map((person) => person.name)).toEqual(['alice']);
  });

  /** Mutation: turn a missing room into an empty replay and let `/` claim it loaded. */
  it('distinguishes an absent replay room from a room with no messages', async () => {
    expect(await loadReplayData(handle.db, randomUUID())).toBeNull();
  });
});
