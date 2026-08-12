import { randomUUID } from 'node:crypto';
import {
  acceptedObjects,
  attachments,
  messageReferences,
  messages,
  proposals,
} from '@atrium/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { describeError } from '../support/constraints.js';
import { openDatabase, resetDatabase, type SeededRoom, seedRoom } from '../support/harness.js';

const handle = openDatabase(5);
let roomA: SeededRoom;
let roomB: SeededRoom;

beforeEach(async () => {
  await resetDatabase(handle);
  roomA = await seedRoom(handle, ['alice'], { slug: 'reference-a' });
  roomB = await seedRoom(handle, ['bob'], { slug: 'reference-b' });
});

afterAll(async () => handle.close());

async function message(room: SeededRoom, body: string) {
  const id = randomUUID();
  await handle.db.insert(messages).values({
    id,
    roomId: room.roomId,
    authorId: Object.values(room.people)[0],
    body,
  });
  return id;
}

async function semanticTargets(room: SeededRoom) {
  const userId = Object.values(room.people)[0] as string;
  const proposalId = randomUUID();
  await handle.db.insert(proposals).values({
    id: proposalId,
    roomId: room.roomId,
    type: 'claim',
    payload: { statement: 'the proposal', claimant: userId, verification: 'unverified' },
    confidence: 1,
    proposerKind: 'human',
    proposerUserId: userId,
    stagedByKind: 'human',
    stagedById: userId,
  });
  const objectId = randomUUID();
  await handle.db.insert(acceptedObjects).values({
    id: objectId,
    roomId: room.roomId,
    type: 'claim',
    payload: { statement: 'the object', claimant: userId, verification: 'unverified' },
    proposalId,
    acceptedBy: userId,
  });
  return { proposalId, objectId };
}

async function claimedAttachment(room: SeededRoom, messageId: string) {
  const id = randomUUID();
  await handle.db.insert(attachments).values({
    id,
    roomId: room.roomId,
    key: `${room.roomId}/${id}`,
    name: 'file',
    contentType: 'text/plain',
    size: 4,
    claimedByMessageId: messageId,
  });
  return id;
}

async function refusedWith(fragment: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(describeError(error)).toContain(fragment);
    return;
  }
  throw new Error(`expected Postgres to refuse the write with ${fragment}`);
}

describe('durable typed reference conformance', () => {
  /* CATCHES: implementing only the human branch, accepting code-point offsets
     instead of browser UTF-16 offsets, or losing authored order by target id. */
  it('accepts every allowlisted target kind with exact UTF-16 authored spans', async () => {
    const body = '😀 @alice @file @proposal @object';
    const messageId = await message(roomA, body);
    const attachmentId = await claimedAttachment(roomA, messageId);
    const { proposalId, objectId } = await semanticTargets(roomA);
    await handle.db.insert(messageReferences).values([
      {
        roomId: roomA.roomId,
        messageId,
        ordinal: 0,
        kind: 'human',
        targetId: roomA.people.alice as string,
        start: 3,
        end: 9,
        surface: '@alice',
      },
      {
        roomId: roomA.roomId,
        messageId,
        ordinal: 1,
        kind: 'attachment',
        targetId: attachmentId,
        start: 10,
        end: 15,
        surface: '@file',
      },
      {
        roomId: roomA.roomId,
        messageId,
        ordinal: 2,
        kind: 'proposal',
        targetId: proposalId,
        start: 16,
        end: 25,
        surface: '@proposal',
      },
      {
        roomId: roomA.roomId,
        messageId,
        ordinal: 3,
        kind: 'object',
        targetId: objectId,
        start: 26,
        end: 33,
        surface: '@object',
      },
    ]);

    expect(
      await handle.db
        .select({ ordinal: messageReferences.ordinal, kind: messageReferences.kind })
        .from(messageReferences)
        .where(eq(messageReferences.messageId, messageId))
        .orderBy(messageReferences.ordinal),
    ).toEqual([
      { ordinal: 0, kind: 'human' },
      { ordinal: 1, kind: 'attachment' },
      { ordinal: 2, kind: 'proposal' },
      { ordinal: 3, kind: 'object' },
    ]);
  });

  /* CATCHES: validating a surface with Postgres code-point positions, accepting
     a slice through one half of a surrogate pair, or trusting caller surface. */
  it('enforces UTF-16 surface equality, including astral characters', async () => {
    const messageId = await message(roomA, '😀 @alice');
    const base = {
      roomId: roomA.roomId,
      messageId,
      ordinal: 0,
      kind: 'human' as const,
      targetId: roomA.people.alice as string,
    };
    await refusedWith('message reference surface does not match authored body', () =>
      handle.db.insert(messageReferences).values({ ...base, start: 2, end: 8, surface: '@alice' }),
    );
    await refusedWith('message reference surface does not match authored body', () =>
      handle.db.insert(messageReferences).values({ ...base, start: 0, end: 1, surface: '😀' }),
    );
  });

  /* CATCHES: checking each span alone but never checking it against already
     stored spans, allowing two targets to claim the same authored characters. */
  it('refuses overlapping spans', async () => {
    const messageId = await message(roomA, '@alice');
    await handle.db.insert(messageReferences).values({
      roomId: roomA.roomId,
      messageId,
      ordinal: 0,
      kind: 'human',
      targetId: roomA.people.alice as string,
      start: 0,
      end: 6,
      surface: '@alice',
    });
    await refusedWith('message reference spans overlap', () =>
      handle.db.insert(messageReferences).values({
        roomId: roomA.roomId,
        messageId,
        ordinal: 1,
        kind: 'human',
        targetId: roomA.people.alice as string,
        start: 1,
        end: 6,
        surface: 'alice',
      }),
    );
  });

  /* CATCHES: looking up targets globally, or trusting the caller's room beside
     a valid id. Every kind is anchored to its stored room and attachment claim. */
  it('refuses cross-room and unavailable targets for every kind', async () => {
    const ownMessage = await message(roomA, '@target');
    const foreignMessage = await message(roomB, '@target');
    const foreignAttachment = await claimedAttachment(roomB, foreignMessage);
    const foreignSemantic = await semanticTargets(roomB);
    const foreign: Record<'human' | 'attachment' | 'proposal' | 'object', string> = {
      human: roomB.people.bob as string,
      attachment: foreignAttachment,
      proposal: foreignSemantic.proposalId,
      object: foreignSemantic.objectId,
    };

    for (const kind of ['human', 'attachment', 'proposal', 'object'] as const) {
      for (const targetId of [foreign[kind], randomUUID()]) {
        await refusedWith('message reference target unavailable', () =>
          handle.db.insert(messageReferences).values({
            roomId: roomA.roomId,
            messageId: ownMessage,
            ordinal: 0,
            kind,
            targetId,
            start: 0,
            end: 7,
            surface: '@target',
          }),
        );
      }
    }
    expect(
      await handle.db
        .select({ id: messageReferences.id })
        .from(messageReferences)
        .where(eq(messageReferences.messageId, ownMessage)),
    ).toEqual([]);
  });

  /* CATCHES: extending the enum without extending the trigger, or disabling the
     trigger so the declared allowlist remains documentation rather than a gate. */
  it('keeps the database enum and enabled trigger exhaustively aligned', async () => {
    const [row] = await handle.db.execute<{
      kinds: string[];
      definition: string;
      enabled: string;
    }>(sql`
      SELECT
        enum_range(NULL::message_reference_kind)::text[] AS kinds,
        pg_get_functiondef('validate_message_reference_target()'::regprocedure) AS definition,
        t.tgenabled::text AS enabled
      FROM pg_trigger t
      WHERE t.tgrelid='message_references'::regclass
        AND t.tgname='message_references_validate_target'
        AND NOT t.tgisinternal
    `);
    // The two participant kinds a reference can name (a person and an agent,
    // #100) plus the three item kinds — the exact DB enum, kept in lockstep with
    // the trigger's CASE. Adding a kind to the enum without teaching the trigger
    // fails the loop below.
    expect(row?.kinds).toEqual(['human', 'agent', 'attachment', 'proposal', 'object']);
    expect(row?.enabled).toBe('O');
    for (const kind of row?.kinds ?? []) {
      expect(row?.definition).toContain(`WHEN '${kind}'`);
    }
    expect(row?.definition).toContain('ELSE');
  });

  /*
   * An agent is a mention target (#100). These pin the trigger's participant
   * branches to the target's OWN principal_kind, so neither identity kind can be
   * named as the other now that both hold memberships.
   *
   * CATCHES: anchoring an `agent` reference to bare membership (which would let a
   * human be named as an agent, or the reverse), or forgetting the agent branch
   * entirely (ELSE → 'unsupported message reference kind').
   */
  describe('a reference names a person or an agent, never one as the other', () => {
    let room: SeededRoom;
    beforeEach(async () => {
      // aria is provisioned as an agent principal; ben is a person. Both are
      // members of the same room.
      room = await seedRoom(handle, ['aria', 'ben'], { slug: 'reference-agent', agents: ['aria'] });
    });

    async function reference(
      messageId: string,
      kind: 'human' | 'agent',
      targetId: string,
      surface: string,
    ) {
      await handle.db.insert(messageReferences).values({
        roomId: room.roomId,
        messageId,
        ordinal: 0,
        kind,
        targetId,
        start: 0,
        end: surface.length,
        surface,
      });
    }

    it('accepts an agent reference to an agent member', async () => {
      const messageId = await message(room, '@aria please look');
      await reference(messageId, 'agent', room.people.aria as string, '@aria');
      expect(
        await handle.db
          .select({ kind: messageReferences.kind })
          .from(messageReferences)
          .where(eq(messageReferences.messageId, messageId)),
      ).toEqual([{ kind: 'agent' }]);
    });

    it('accepts a human reference to a human member', async () => {
      const messageId = await message(room, '@ben please look');
      await reference(messageId, 'human', room.people.ben as string, '@ben');
      expect(
        await handle.db
          .select({ kind: messageReferences.kind })
          .from(messageReferences)
          .where(eq(messageReferences.messageId, messageId)),
      ).toEqual([{ kind: 'human' }]);
    });

    it('refuses a human reference that names an agent member', async () => {
      const messageId = await message(room, '@aria please look');
      await refusedWith('message reference target unavailable', () =>
        reference(messageId, 'human', room.people.aria as string, '@aria'),
      );
    });

    it('refuses an agent reference that names a human member', async () => {
      const messageId = await message(room, '@ben please look');
      await refusedWith('message reference target unavailable', () =>
        reference(messageId, 'agent', room.people.ben as string, '@ben'),
      );
    });

    /* The cross-room matrix above (line ~201) covers the four older kinds; the
       agent branch is new and needs its own cross-room proof, because its room
       predicate lives in a separate SELECT. An agent that is a member of ANOTHER
       room must not be nameable from this one — the trigger's agent branch joins
       on `m.room_id = NEW.room_id`, so the foreign agent is not a member HERE.

       CATCHES: removing `m.room_id = NEW.room_id` from the agent branch — the
       foreign agent then matches on principal_kind alone and the reference is
       wrongly accepted, which this refusal expectation would no longer see. */
    it('refuses an agent reference to an agent who is a member of another room', async () => {
      const elsewhere = await seedRoom(handle, ['zara'], {
        slug: 'reference-agent-elsewhere',
        agents: ['zara'],
      });
      const messageId = await message(room, '@zara please look');
      await refusedWith('message reference target unavailable', () =>
        reference(messageId, 'agent', elsewhere.people.zara as string, '@zara'),
      );
      expect(
        await handle.db
          .select({ id: messageReferences.id })
          .from(messageReferences)
          .where(eq(messageReferences.messageId, messageId)),
      ).toEqual([]);
    });
  });
});
