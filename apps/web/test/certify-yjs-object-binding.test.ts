import { ClaimPayload } from '@atrium/core';
import { acceptedObjects, covenantAnchors, type Database } from '@atrium/db';
import { describe, expect, it, vi } from 'vitest';
import { certifyObjectSpan } from '@/lib/certify-anchor';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';
import { conversationContentRoot, ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * #220 / T6 — THE ensureObject BINDING on certifyObjectSpan.
 *
 * Proves the yjs-span → covenant-object binding at the WRITE layer: when the certify
 * gate is handed `ensureObject`, the `accepted_objects` row the anchor's composite FK
 * names is UPSERTED in the SAME transaction, before the anchor, and stamped HUMAN —
 * and, cardinally, a NON-human session is refused BEFORE any object row is written, so
 * the machine never even mints the anchor's FK target.
 *
 * `loadRoomMembershipRow` is mocked (the transaction's membership re-check); everything
 * else — the humanity gate, the derive-and-sign over a real `ConversationDoc` body, and
 * the `certifyObjectSpan` transaction shape — is the shipped code. The end-to-end DB
 * path (a real Postgres row + the covenant_status projection) is the two-browser
 * acceptance's job (rubric 12).
 * ═════════════════════════════════════════════════════════════════════════ */

vi.mock('@atrium/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atrium/auth')>();
  return {
    ...actual,
    // The write-transaction membership re-check — a member, so the gate proceeds.
    loadRoomMembershipRow: vi.fn(async () => ({ roomId: 'room_t6', userId: 'u_alice' })),
  };
});

const HUMAN = { userId: 'u_alice', principalKind: 'human' as const };
const ROOM = 'room_t6';

/** A real reader over a real ConversationDoc body, positioned on a span (derives a real anchor). */
function readerForSpan(): CovenantDocReaderProd {
  const doc = new ConversationDoc();
  doc.append({ id: 'o_msg', time: '12:00', kind: 'human', who: 'Alice', text: 'Ready ship it now' });
  const bodyPath = doc.bodyPath('o_msg');
  if (bodyPath === null) throw new Error('no body');
  return new CovenantDocReaderProd(
    doc.doc,
    { path: bodyPath, start: 0, end: 5 },
    { resolveRoot: conversationContentRoot },
  );
}

interface RecordedInsert {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

/** A fake Database recording every insert, so we can assert the object + anchor writes. */
function recordingDatabase(recorded: RecordedInsert[]): Database {
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ kind: 'human' }] }) }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        recorded.push({ table, values });
        return {
          onConflictDoNothing: async () => undefined,
          returning: async () => [{ id: 'anchor_row_1' }],
        };
      },
    }),
  };
  return {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(tx),
  } as unknown as Database;
}

describe('certifyObjectSpan ensureObject: the binding writes a human-touched object, atomically', () => {
  it('a human certify UPSERTS the accepted_objects row (id = objectId, human-touched) then the anchor', async () => {
    const recorded: RecordedInsert[] = [];
    const payload = ClaimPayload.parse({
      statement: 'Ready',
      claimant: HUMAN.userId,
      verification: 'unverified',
    });
    const outcome = await certifyObjectSpan({
      database: recordingDatabase(recorded),
      session: HUMAN,
      authorizedRoomId: ROOM,
      objectId: 'o_msg',
      reader: readerForSpan(),
      ensureObject: { type: 'claim', payload },
    });

    expect(outcome.ok).toBe(true);

    // The object insert came FIRST (before the anchor), keyed by object id, human-stamped.
    const objectInsert = recorded.find((r) => r.table === acceptedObjects);
    const anchorInsert = recorded.find((r) => r.table === covenantAnchors);
    expect(objectInsert).toBeDefined();
    expect(anchorInsert).toBeDefined();
    expect(recorded.indexOf(objectInsert as RecordedInsert)).toBeLessThan(
      recorded.indexOf(anchorInsert as RecordedInsert),
    );
    expect(objectInsert?.values).toMatchObject({
      id: 'o_msg',
      roomId: ROOM,
      type: 'claim',
      acceptedBy: HUMAN.userId,
      acceptedByKind: 'human',
    });
    expect(objectInsert?.values.humanTouchedAt).toBeInstanceOf(Date);
    // The anchor row is over the same object id, certifier kind human.
    expect(anchorInsert?.values).toMatchObject({ objectId: 'o_msg', certifierKind: 'human' });
  });

  it('a NON-human session is refused before any object row is written — the machine never mints the FK target', async () => {
    const recorded: RecordedInsert[] = [];
    const outcome = await certifyObjectSpan({
      database: recordingDatabase(recorded),
      session: { userId: 'agent_x', principalKind: 'agent' },
      authorizedRoomId: ROOM,
      objectId: 'o_msg',
      reader: readerForSpan(),
      ensureObject: {
        type: 'claim',
        payload: ClaimPayload.parse({
          statement: 'Ready',
          claimant: 'agent_x',
          verification: 'unverified',
        }),
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
    // No accepted_objects row, no anchor — nothing was written for a machine.
    expect(recorded).toHaveLength(0);
  });
});
