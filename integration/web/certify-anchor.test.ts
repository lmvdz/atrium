import { randomUUID } from 'node:crypto';
import {
  type CovenantDocReader,
  certifyAnchor,
  type RenderedFragment,
  renderedDigestOf,
} from '@atrium/core';
import { acceptedObjects, covenantAnchors, insertCovenantAnchor, memberships } from '@atrium/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { certifyObjectSpan } from '../../apps/web/lib/certify-anchor.js';
import { CovenantDocReaderProd } from '../../apps/web/lib/covenant-reader.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/* ---------------------------------------------------------------------------
 * THE COVENANT CERTIFY PATH, ON A REAL POSTGRES — #190 (SL-3 CERTIFY-PATH).
 *
 * The gated write of a DERIVED covenant anchor, and the three HARD enforcements
 * routed from SL-1's gauntlet, each exercised as a property of the SERVER path and
 * the TABLE — the things a unit test over the pure core could not see:
 *
 *   1. The certifier is the SESSION's, never the request. A non-human session
 *      writes NO row and is refused; the table refuses a machine certifier written
 *      by raw SQL two ways (0050 CHECK, 0052 correlation trigger).
 *   2. Only `certifyAnchor(serverReader, meta)` output is persisted. The persisted
 *      digest / state vector / delete set / span boundaries are the reader's, and
 *      the API has no field to substitute a client's; a forged digest is refused at
 *      the table.
 *   3. The resolution context is SERVER-DERIVED. A stale/forged caller context is
 *      refused by core before it can be signed → no row.
 *
 * Where a guard is under test, reverting it turns the case red — the acceptance bar
 * a guard whose test still passes without it fails to meet.
 * ------------------------------------------------------------------------- */

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

interface Fixture {
  roomId: string;
  workspaceId: string;
  /** A human. */
  ada: string;
  /** A second human. */
  bob: string;
  /** An AGENT principal. */
  hexi: string;
  /** An accepted object in the room — the span's object (the FK target). */
  objectId: string;
}

/** A room, two people, an agent, and an accepted object to certify a span of. */
async function fixture(): Promise<Fixture> {
  const room = await seedRoom(handle, ['ada', 'bob', 'hexi'], { agents: ['hexi'] });
  const objectId = randomUUID();
  await handle.db.insert(acceptedObjects).values({
    id: objectId,
    roomId: room.roomId,
    type: 'decision',
    payload: { statement: 'ship it', decidedBy: null, status: 'active' },
  });
  return {
    roomId: room.roomId,
    workspaceId: room.workspaceId,
    ada: room.people.ada as string,
    bob: room.people.bob as string,
    hexi: room.people.hexi as string,
    objectId,
  };
}

const SPAN = { path: [0, 0] as number[], start: 0, end: 5 } as const;

/** A live Y.Doc whose content root holds a `Y.XmlText` body — a span to certify. */
function makeDoc(): { doc: Y.Doc; body: Y.XmlText } {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const para = new Y.XmlElement('paragraph');
  const body = new Y.XmlText();
  frag.insert(0, [para]);
  para.insert(0, [body]);
  body.insert(0, 'hello world');
  return { doc, body };
}

/** The authoritative server reader, positioned on the selection. */
function capturingReader(doc: Y.Doc): CovenantDocReaderProd {
  return new CovenantDocReaderProd(doc, { path: SPAN.path, start: SPAN.start, end: SPAN.end });
}

/** Every anchor row over a given (room, object). */
function anchorsFor(roomId: string, objectId: string) {
  return handle.db
    .select()
    .from(covenantAnchors)
    .where(and(eq(covenantAnchors.roomId, roomId), eq(covenantAnchors.objectId, objectId)));
}

/**
 * Run a write that must be REFUSED, and return the database's own words — walking
 * the `cause` chain, because drizzle's outermost message is always the same and a
 * naive matcher would pass on a syntax error in the test's own SQL. (Copied from
 * `certify-session.test.ts` for the same reason it exists there.)
 */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    const parts: string[] = [];
    let cursor: unknown = error;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('the write was accepted, and this case exists because it must not be');
}

describe('a human certify gesture writes exactly one SERVER-DERIVED anchor row', () => {
  it('writes one row whose digest / SV / DS / boundaries are the READER’s, not the request’s', async () => {
    const at = await fixture();
    const { doc } = makeDoc();
    const reader = capturingReader(doc);

    // What the SERVER reader independently derives — the only honest source of these.
    const capture = reader.captureSelection();
    const context = reader.authoritativeContext();
    if (!capture || !context) throw new Error('the reader must capture the seeded span');
    const expectedDigest = renderedDigestOf(capture.fragment);

    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader,
    });
    if (!outcome.ok) throw new Error(`the certify was refused (${outcome.reason})`);

    const rows = await anchorsFor(at.roomId, at.objectId);
    expect(rows.length).toBe(1);
    const [row] = rows;
    if (!row) throw new Error('exactly one anchor row was expected');
    // SERVER-DERIVED: every resolution-bearing field equals the reader's own output.
    expect(row.renderedDigest).toBe(expectedDigest);
    expect(row.stateVector).toBe(context.stateVector);
    expect(row.deleteSet).toBe(context.deleteSet);
    expect(row.relStart).toBe(capture.relStart);
    expect(row.relEnd).toBe(capture.relEnd);
    expect(row.revision).toBe(context.revision);
    // The certifier is the SESSION's human, kind and id.
    expect(row.certifierKind).toBe('human');
    expect(row.certifierId).toBe(at.ada);
  });

  it('a second certify over the same span is refused already_certified — still ONE row', async () => {
    const at = await fixture();
    const first = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: capturingReader(makeDoc().doc),
    });
    expect(first.ok).toBe(true);

    const second = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.bob, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: capturingReader(makeDoc().doc),
    });
    expect(second).toEqual({ ok: false, reason: 'already_certified' });
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(1);
  });
});

describe('the machine never certifies (#162/#164) — enforcement 1', () => {
  /**
   * THE GATE. A non-human session is refused BEFORE the reader is touched, and
   * nothing reaches the table.
   *
   * RED ON REVERT: delete the `session.principalKind !== 'human'` guard from
   * `certifyObjectSpan`. The agent's certify then reaches the insert; 0052's
   * correlation trigger refuses it (certifier_id names an agent) — red either way,
   * which is the point: with the guard the refusal is legible at the gate, without
   * it the only thing between a machine and the ledger is the table.
   */
  it('an agent session writes NO row and is refused not_human', async () => {
    const at = await fixture();
    const outcome = await certifyObjectSpan({
      database: handle.db,
      // The agent's own session — the honest input; a machine cannot dress itself
      // human, because the kind is the server's, not the request's.
      session: { userId: at.hexi, principalKind: 'agent' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: capturingReader(makeDoc().doc),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });

  /* THE TABLE, not the function — 0050's CHECK. Even with every app guard gone, the
     column cannot hold a machine kind. A HUMAN certifier_id is used so the 0052
     correlation trigger passes and the 0050 CHECK on `certifier_kind` is the clause
     under test in isolation. */
  it('the TABLE refuses a certifier_kind=agent written by raw insert (0050 CHECK)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.insert(covenantAnchors).values({
        roomId: at.roomId,
        objectId: at.objectId,
        revision: 1,
        relStart: 'a',
        relEnd: 'b',
        stateVector: 'sv',
        deleteSet: 'ds',
        enclosedItems: [],
        renderedDigest: 'a'.repeat(64),
        certifierKind: 'agent',
        certifierId: at.ada, // a HUMAN id, so only the certifier_kind CHECK can fire
        certifiedAt: new Date(),
      }),
    );
    expect(why).toMatch(/certifier_is_human|check/i);
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });

  /**
   * THE MINT-BYPASS 0052 CLOSES. certifier_kind='human' satisfies the 0050 CHECK,
   * but certifier_id names an AGENT — a machine dressed as the human behind a ✓.
   * The correlation trigger crosses to `users.principal_kind` and refuses it.
   *
   * RED ON REVERT: drop the `atrium_covenant_anchor_certifier_is_human` trigger
   * (0052). This insert — a valid-looking human-kind row pointing at an agent — then
   * succeeds, which is the exact dishonest attribution the trigger exists to refuse.
   */
  it('the TABLE refuses certifier_kind=human over an AGENT certifier_id (0052 trigger)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.insert(covenantAnchors).values({
        roomId: at.roomId,
        objectId: at.objectId,
        revision: 1,
        relStart: 'a',
        relEnd: 'b',
        stateVector: 'sv',
        deleteSet: 'ds',
        enclosedItems: [],
        renderedDigest: 'a'.repeat(64),
        certifierKind: 'human',
        certifierId: at.hexi, // an AGENT uuid — the mint-bypass
        certifiedAt: new Date(),
      }),
    );
    expect(why).toMatch(/machine never certifies|human/i);
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });

  /* The insert HELPER cannot smuggle a machine kind past the table either. */
  it('insertCovenantAnchor with certifierKind=agent is refused by the table', async () => {
    const at = await fixture();
    const anchor = certifyAnchor(capturingReader(makeDoc().doc), {
      objectId: at.objectId,
      roomId: at.roomId,
      certifier: { kind: 'human', userId: at.ada },
      certifiedAt: new Date().toISOString(),
    });
    if (anchor === null) throw new Error('capture failed');
    const why = await refusal(insertCovenantAnchor(handle.db, { anchor, certifierKind: 'agent' }));
    expect(why).toMatch(/certifier_is_human|check|human/i);
  });

  /* A FRESH anchor is never anonymous — 0052 refuses a null certifier_id on INSERT. */
  it('the TABLE refuses a null certifier_id on insert (0052)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.insert(covenantAnchors).values({
        roomId: at.roomId,
        objectId: at.objectId,
        revision: 1,
        relStart: 'a',
        relEnd: 'b',
        stateVector: 'sv',
        deleteSet: 'ds',
        enclosedItems: [],
        renderedDigest: 'a'.repeat(64),
        certifierKind: 'human',
        certifierId: null,
        certifiedAt: new Date(),
      }),
    );
    expect(why).toMatch(/must name its certifier|anonymous/i);
  });
});

describe('the resolution context is server-derived — enforcement 3', () => {
  /**
   * A STALE / FORGED CALLER CONTEXT IS REFUSED. The reader's captured selection
   * claims a revision that disagrees with the authoritative head — the shape a
   * caller-supplied earlier-revision context has. Core refuses to sign it, so no
   * row is written.
   *
   * RED ON REVERT: delete the `captured.revision !== authoritative.revision …`
   * refusal from core `certifyAnchor`. This then signs the head's context over a
   * stale fragment and a row lands.
   */
  it('a selection whose claimed context disagrees with HEAD writes no row', async () => {
    const at = await fixture();
    const fragment: RenderedFragment = {
      ancestors: [],
      nodes: [{ kind: 'text', text: 'x', marks: [] }],
    };
    const staleReader: CovenantDocReader = {
      authoritativeContext: () => ({ revision: 5, stateVector: 'HEAD_SV', deleteSet: 'HEAD_DS' }),
      captureSelection: () => ({
        // An EARLIER revision than the authoritative head — the disagreement.
        revision: 4,
        relStart: 'rs',
        relEnd: 're',
        stateVector: 'OLD_SV',
        deleteSet: 'OLD_DS',
        fragment,
        enclosedItems: [],
      }),
      resolveSpan: () => null,
    };
    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: staleReader,
    });
    expect(outcome).toEqual({ ok: false, reason: 'derive_failed' });
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });

  /* An unavailable doc (no capture) also fails closed — no row. */
  it('an unavailable live doc writes no row (fail-closed)', async () => {
    const at = await fixture();
    const deadReader: CovenantDocReader = {
      authoritativeContext: () => null,
      captureSelection: () => null,
      resolveSpan: () => null,
    };
    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: deadReader,
    });
    expect(outcome).toEqual({ ok: false, reason: 'derive_failed' });
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });
});

describe('the anchor is frozen once written — the immutability trigger holds (0050/0051)', () => {
  async function certifyOne(at: Fixture): Promise<void> {
    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: capturingReader(makeDoc().doc),
    });
    if (!outcome.ok) throw new Error(`certify refused (${outcome.reason})`);
  }

  /**
   * A FORGED DIGEST cannot be written OVER a standing signature. `rendered_digest`
   * is a signed field; the immutability trigger refuses any UPDATE that changes it.
   *
   * RED ON REVERT: drop the `rendered_digest` clause from
   * `atrium_covenant_anchor_immutable` (0050). This UPDATE then rewrites the digest
   * under the `✓` — the exact float-free-of-what-was-signed the freeze prevents.
   */
  it('a raw UPDATE forging rendered_digest is refused', async () => {
    const at = await fixture();
    await certifyOne(at);
    const why = await refusal(
      handle.db
        .update(covenantAnchors)
        .set({ renderedDigest: 'b'.repeat(64) })
        .where(
          and(eq(covenantAnchors.roomId, at.roomId), eq(covenantAnchors.objectId, at.objectId)),
        ),
    );
    expect(why).toMatch(/recorded once|may not be rewritten/i);
  });

  it('a raw UPDATE moving the state vector / delete set / boundaries is refused', async () => {
    const at = await fixture();
    await certifyOne(at);
    for (const set of [
      { stateVector: 'forged' },
      { deleteSet: 'forged' },
      { relStart: 'forged' },
      { relEnd: 'forged' },
      { revision: 999 },
      { certifierId: at.bob },
    ] as const) {
      const why = await refusal(
        handle.db
          .update(covenantAnchors)
          .set(set)
          .where(
            and(eq(covenantAnchors.roomId, at.roomId), eq(covenantAnchors.objectId, at.objectId)),
          ),
      );
      expect(why).toMatch(/recorded once|may not be rewritten/i);
    }
  });

  /* THE TABLE refuses a MALFORMED digest outright (0050 CHECK) — a forged non-sha256. */
  it('the TABLE refuses a malformed (non-sha256) digest at insert (0050 CHECK)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.insert(covenantAnchors).values({
        roomId: at.roomId,
        objectId: at.objectId,
        revision: 1,
        relStart: 'a',
        relEnd: 'b',
        stateVector: 'sv',
        deleteSet: 'ds',
        enclosedItems: [],
        renderedDigest: 'NOT-A-SHA256',
        certifierKind: 'human',
        certifierId: at.ada,
        certifiedAt: new Date(),
      }),
    );
    expect(why).toMatch(/digest_is_sha256|check/i);
  });
});

describe('the membership is re-derived in the write transaction (the TOCTOU close)', () => {
  /**
   * A membership revoked after the caller resolved the room refuses the certify.
   *
   * RED ON REVERT: remove the `loadRoomMembershipRow` re-check from
   * `certifyObjectSpan`. The anchor then lands, authored by somebody the room had
   * already removed.
   */
  it('a membership revoked between the caller read and the write refuses (no row)', async () => {
    const at = await fixture();
    await handle.db
      .delete(memberships)
      .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.ada)));
    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: at.ada, principalKind: 'human' },
      authorizedRoomId: at.roomId,
      objectId: at.objectId,
      reader: capturingReader(makeDoc().doc),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_in_room' });
    expect((await anchorsFor(at.roomId, at.objectId)).length).toBe(0);
  });
});
