import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

async function fixture() {
  const a = await seedRoom(handle, ['alice']);
  const b = await seedRoom(handle, ['bob']);
  const messageId = randomUUID();
  const attachmentId = randomUUID();
  const proposalId = randomUUID();
  const objectId = randomUUID();
  const alice = a.people.alice as string;
  await handle.db.execute(sql`
    INSERT INTO messages (id, room_id, author_id, body)
    VALUES (${messageId}, ${a.roomId}, ${alice}, '@h @a @p @o')
  `);
  await handle.db.execute(sql`
    INSERT INTO attachments (id, room_id, key, name, content_type, size, claimed_by_message_id)
    VALUES (${attachmentId}, ${a.roomId}, ${`${a.roomId}/${attachmentId}`}, 'a.txt', 'text/plain', 1, ${messageId})
  `);
  await handle.db.execute(sql`
    INSERT INTO proposals
      (id, room_id, type, payload, confidence, proposer_kind, proposer_user_id,
       staged_by_kind, staged_by_id, status)
    VALUES
      (${proposalId}, ${a.roomId}, 'decision', ${JSON.stringify({ statement: 'p' })}::jsonb,
       1, 'human', ${alice}, 'human', ${alice}, 'proposed')
  `);
  await handle.db.execute(sql`
    INSERT INTO accepted_objects
      (id, room_id, type, payload, revision)
    VALUES (${objectId}, ${a.roomId}, 'decision', ${JSON.stringify({ statement: 'o' })}::jsonb, 0)
  `);
  return { a, b, alice, messageId, attachmentId, proposalId, objectId };
}

async function insertReference(input: {
  roomId: string;
  messageId: string;
  ordinal: number;
  kind: 'human' | 'attachment' | 'proposal' | 'object';
  targetId: string;
  start: number;
  end: number;
  surface: string;
}) {
  await handle.db.execute(sql`
    INSERT INTO message_references
      (room_id, message_id, ordinal, kind, target_id, start, "end", surface)
    VALUES
      (${input.roomId}, ${input.messageId}, ${input.ordinal}, ${input.kind},
       ${input.targetId}, ${input.start}, ${input.end}, ${input.surface})
  `);
}

describe('typed reference database conformance', () => {
  /** Mutation: remove one CASE branch or compare the caller room to itself. */
  it('accepts every allowlisted same-room target kind', async () => {
    const f = await fixture();
    await insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 0, kind: 'human', targetId: f.alice, start: 0, end: 2, surface: '@h' });
    await insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 1, kind: 'attachment', targetId: f.attachmentId, start: 3, end: 5, surface: '@a' });
    await insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 2, kind: 'proposal', targetId: f.proposalId, start: 6, end: 8, surface: '@p' });
    await insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 3, kind: 'object', targetId: f.objectId, start: 9, end: 11, surface: '@o' });
    const rows = await handle.db.execute(sql`SELECT kind FROM message_references ORDER BY ordinal`);
    expect(rows.map((row) => row.kind)).toEqual(['human', 'attachment', 'proposal', 'object']);
  });

  /** Mutation: validate target existence without anchoring its stored room. */
  it('rejects a cross-room target for every allowlisted kind', async () => {
    const f = await fixture();
    const other = await fixture();
    const targets = [
      ['human', other.alice],
      ['attachment', other.attachmentId],
      ['proposal', other.proposalId],
      ['object', other.objectId],
    ] as const;
    for (const [kind, targetId] of targets) {
      // postgres-js wraps the server text; rejection itself is the fact under
      // test, and the following count proves no prior attempt landed.
      await expect(insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 0, kind, targetId, start: 0, end: 2, surface: '@h' })).rejects.toThrow();
    }
    const rows = await handle.db.execute(sql`SELECT count(*)::integer AS n FROM message_references`);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  /** Mutation: trust caller spans/surfaces or count Unicode code points as JS offsets. */
  it('rejects forged surfaces and validates UTF-16 spans', async () => {
    const f = await fixture();
    await expect(insertReference({ roomId: f.a.roomId, messageId: f.messageId, ordinal: 0, kind: 'human', targetId: f.alice, start: 0, end: 2, surface: '@x' })).rejects.toThrow(/surface/);
    const unicodeMessage = randomUUID();
    await handle.db.execute(sql`INSERT INTO messages (id, room_id, author_id, body) VALUES (${unicodeMessage}, ${f.a.roomId}, ${f.alice}, ${'😀 @h'})`);
    await insertReference({ roomId: f.a.roomId, messageId: unicodeMessage, ordinal: 0, kind: 'human', targetId: f.alice, start: 3, end: 5, surface: '@h' });
  });
});
