import { randomUUID } from 'node:crypto';
import { renderedDigestOf } from '@atrium/core';
import { acceptedObjects, type DatabaseHandle } from '@atrium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ChatMsg } from '../../apps/web/app/prototype/types.js';
import {
  ConversationDoc,
  conversationContentRoot,
} from '../../apps/web/app/prototype/yjs-conversation.js';
import { certifyObjectSpan } from '../../apps/web/lib/certify-anchor.js';
import { CovenantDocReaderProd, readerForLiveDoc } from '../../apps/web/lib/covenant-reader.js';
import { liveCovenantDoc } from '../../apps/web/lib/live-covenant-doc.js';
import { dbYdocStreamSource, RoomReplicaManager } from '../../apps/web/lib/room-replica-manager.js';
import {
  clearServerReplicas,
  type ServerRoomReplica,
  serverReplicaFor,
} from '../../apps/web/lib/server-room-replica.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * E3 (#203) — THE SERVER REPLICA, END-TO-END ON A REAL POSTGRES STREAM.
 *
 * The acceptance test the in-memory proofs stand in for: updates written through
 * the E2 authenticated door (`atrium_append_ydoc_update`, migration 0054) become
 * durable `ydoc_updates` rows carrying a persisted writer stamp, and a replica
 * rebuilt from those rows — a COLD RESTART, a fresh process, an empty ledger —
 * recovers the ORIGINAL authorship from the DATA, refuses to mint while it lags the
 * stream head, and converges identically to a second independent process.
 *
 * Three claims, each the ticket's:
 *   1. Kill + restart ⇒ the replica catches up from the durable rows and
 *      `authenticatedAuthorOf` returns the ORIGINAL writers (the stamps replayed),
 *      never fail-closed-unknown.
 *   2. A certify while the replica LAGS the stream head is REFUSED (the freshness
 *      gate), not a stale anchor — and once caught up, it mints.
 *   3. Two web processes converge independently from the same stream and resolve
 *      IDENTICAL glyphs (same content, same authorship, same rendered digest).
 * ═════════════════════════════════════════════════════════════════════════ */

const handle = openDatabase();

beforeEach(async () => {
  await resetDatabase(handle);
  clearServerReplicas();
});
afterAll(async () => {
  clearServerReplicas();
  await handle.close();
});

function msg(id: string, text: string, kind: ChatMsg['kind'] = 'human'): ChatMsg {
  return { id, time: '10:00', kind, who: 'you', text };
}

/** Append one Yjs update through the E2 door, attributed to `actorId` — a durable row. */
async function appendThroughDoor(
  h: DatabaseHandle,
  roomId: string,
  actorId: string,
  op: Uint8Array,
): Promise<void> {
  await h.db.execute(
    sql`SELECT atrium_append_ydoc_update(${roomId}::uuid, ${actorId}::uuid, ${Buffer.from(op)}::bytea) AS id`,
  );
}

/** The incremental update a fresh append produces on top of a prior state vector. */
function delta(convo: ConversationDoc, priorSv: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(convo.doc, priorSv);
}

/** The rendered digest of a message's [start,end) body span, as the covenant signs it. */
function spanDigest(
  replica: ServerRoomReplica,
  messageId: string,
  start: number,
  end: number,
): string | null {
  const path = replica.conversation.bodyPath(messageId);
  if (path === null) return null;
  const reader = new CovenantDocReaderProd(
    replica.doc,
    { path, start, end },
    { resolveRoot: conversationContentRoot },
  );
  const capture = reader.captureSelection();
  return capture ? renderedDigestOf(capture.fragment) : null;
}

describe('authorship survives a cold restart via the durable stream (acceptance #1)', () => {
  it('a replica rebuilt from the rows returns the ORIGINAL human/agent writers, not unknown', async () => {
    const room = await seedRoom(handle, ['ada', 'bob', 'hexi'], { agents: ['hexi'] });

    // Ada writes m1; Bob catches up and writes m2; Hexi (an agent) writes a1. Each
    // update is appended through the authenticated door, so each durable row carries
    // its writer stamp (ada→human, bob→human, hexi→agent) — from the session, in DATA.
    const ada = new ConversationDoc();
    ada.append(msg('m1', 'ship the migration'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );

    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(ada.doc));
    const svAfterAda = Y.encodeStateVector(bob.doc);
    bob.append(msg('m2', 'reviewed and approved'));
    await appendThroughDoor(handle, room.roomId, room.people.bob as string, delta(bob, svAfterAda));

    const hexi = new ConversationDoc();
    Y.applyUpdate(hexi.doc, Y.encodeStateAsUpdate(bob.doc));
    const svAfterBob = Y.encodeStateVector(hexi.doc);
    hexi.append(msg('a1', 'the drafted reading', 'agent'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.hexi as string,
      delta(hexi, svAfterBob),
    );

    // COLD RESTART: a brand-new manager (a fresh process) with an empty in-process
    // ledger catches the replica up from the durable rows alone.
    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const replica = await manager.acquire(room.roomId);
    if (replica === null) throw new Error('the replica must catch up from the durable stream');

    // Content converged…
    expect(replica.conversation.body('m1')?.toString()).toBe('ship the migration');
    expect(replica.conversation.body('m2')?.toString()).toBe('reviewed and approved');
    expect(replica.conversation.body('a1')?.toString()).toBe('the drafted reading');
    // …and authorship is the ORIGINAL writers, recovered from the persisted stamps.
    expect(replica.authenticatedAuthorOf('m1')).toEqual({
      userId: room.people.ada,
      principalKind: 'human',
    });
    expect(replica.authenticatedAuthorOf('m2')).toEqual({
      userId: room.people.bob,
      principalKind: 'human',
    });
    expect(replica.authenticatedAuthorOf('a1')).toEqual({
      userId: room.people.hexi,
      principalKind: 'agent',
    });
    expect(replica.consumedStreamPosition()).toBe(3);
    manager.evictAll();
  });

  it('a byte-replay row by another member never re-attributes on catch-up (E2 dedupe + first-writer-wins)', async () => {
    const room = await seedRoom(handle, ['ada', 'mallory']);
    const ada = new ConversationDoc();
    ada.append(msg('m1', 'the honest reading'));
    const op = Y.encodeStateAsUpdate(ada.doc);
    await appendThroughDoor(handle, room.roomId, room.people.ada as string, op);
    // Mallory replays Ada's EXACT bytes through her own session — the door dedupes on
    // op_digest and returns the original row, never a second, still stamped Ada.
    await appendThroughDoor(handle, room.roomId, room.people.mallory as string, op);

    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const replica = await manager.acquire(room.roomId);
    expect(replica?.authenticatedAuthorOf('m1')).toEqual({
      userId: room.people.ada,
      principalKind: 'human',
    });
    expect(replica?.consumedStreamPosition()).toBe(1); // one durable row, not two
    manager.evictAll();
  });
});

describe('the freshness gate refuses a lagging replica, then mints once caught up (acceptance #2)', () => {
  it('a certify while the replica LAGS the head is refused; a caught-up replica mints', async () => {
    const room = await seedRoom(handle, ['ada']);
    const o1 = randomUUID();
    const o2 = randomUUID();
    for (const id of [o1, o2]) {
      await handle.db.insert(acceptedObjects).values({
        id,
        roomId: room.roomId,
        type: 'decision',
        payload: { statement: 'ship it', decidedBy: null, status: 'active' },
      });
    }

    const ada = new ConversationDoc();
    ada.append(msg('m1', 'alpha beta gamma'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );

    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const replica = await manager.acquire(room.roomId);
    if (replica === null) throw new Error('replica must catch up');
    const head1 = await manager.streamHead(room.roomId);
    expect(replica.consumedStreamPosition()).toBe(head1);

    // A CAUGHT-UP replica mints a real anchor over m1's 'alpha'.
    const live = liveCovenantDoc(room.roomId);
    const path = replica.conversation.bodyPath('m1') as number[];
    const reader = readerForLiveDoc(live.provider, { path, start: 0, end: 5 }, live.options);
    const minted = await certifyObjectSpan({
      database: handle.db,
      session: { userId: room.people.ada as string, principalKind: 'human' },
      authorizedRoomId: room.roomId,
      objectId: o1,
      reader,
      streamFreshness: {
        requiredPosition: head1,
        consumedPosition: () =>
          serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
      },
    });
    expect(minted.ok).toBe(true);

    // A NEW durable row is appended — the head advances, but the warm replica has NOT
    // consumed it (live subscribe is E4/Electric infra). It now LAGS the stream head.
    const ada2 = new ConversationDoc();
    Y.applyUpdate(ada2.doc, Y.encodeStateAsUpdate(replica.doc));
    const svBefore = Y.encodeStateVector(ada2.doc);
    ada2.append(msg('m2', 'delta epsilon'));
    await appendThroughDoor(handle, room.roomId, room.people.ada as string, delta(ada2, svBefore));
    const head2 = await manager.streamHead(room.roomId);
    expect(head2).toBe(head1 + 1);
    expect(replica.consumedStreamPosition()).toBe(head1); // still behind

    // A certify against the lagging replica is REFUSED — not a stale anchor.
    const lagging = await certifyObjectSpan({
      database: handle.db,
      session: { userId: room.people.ada as string, principalKind: 'human' },
      authorizedRoomId: room.roomId,
      objectId: o2,
      reader,
      streamFreshness: {
        requiredPosition: head2,
        consumedPosition: () =>
          serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
      },
    });
    expect(lagging).toEqual({ ok: false, reason: 'replica_lagging' });

    // Catch up (a fresh catch-up reaches head2), and the same certify now mints.
    manager.evict(room.roomId);
    const caughtUp = await manager.acquire(room.roomId);
    if (caughtUp === null) throw new Error('re-acquire must catch up to head2');
    expect(caughtUp.consumedStreamPosition()).toBe(head2);
    const live2 = liveCovenantDoc(room.roomId);
    const path2 = caughtUp.conversation.bodyPath('m2') as number[];
    const reader2 = readerForLiveDoc(
      live2.provider,
      { path: path2, start: 0, end: 5 },
      live2.options,
    );
    const mintedAfter = await certifyObjectSpan({
      database: handle.db,
      session: { userId: room.people.ada as string, principalKind: 'human' },
      authorizedRoomId: room.roomId,
      objectId: o2,
      reader: reader2,
      streamFreshness: {
        requiredPosition: head2,
        consumedPosition: () =>
          serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
      },
    });
    expect(mintedAfter.ok).toBe(true);
    manager.evictAll();
  });
});

describe('two web processes converge independently and resolve identical glyphs (acceptance #3)', () => {
  it('two managers on separate connections catch up to identical content, authorship and digest', async () => {
    const room = await seedRoom(handle, ['ada', 'bob']);
    const ada = new ConversationDoc();
    ada.append(msg('m1', 'the shared reading'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );
    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(ada.doc));
    const sv = Y.encodeStateVector(bob.doc);
    bob.append(msg('m2', 'the second reading'));
    await appendThroughDoor(handle, room.roomId, room.people.bob as string, delta(bob, sv));

    // Two independent processes: separate connection pools, separate managers,
    // separate in-process ledgers. Each catches up from the SAME durable stream.
    const handleB = openDatabase(5);
    try {
      const mgrA = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
      const mgrB = new RoomReplicaManager({ source: dbYdocStreamSource(handleB.db) });
      const rA = await mgrA.acquire(room.roomId);
      const rB = await mgrB.acquire(room.roomId);
      if (rA === null || rB === null) throw new Error('both replicas must catch up');

      // Identical content…
      expect(rA.conversation.body('m1')?.toString()).toBe(rB.conversation.body('m1')?.toString());
      expect(rA.conversation.body('m2')?.toString()).toBe(rB.conversation.body('m2')?.toString());
      // …identical authorship, each recovered independently from the stamps…
      expect(rA.authenticatedAuthorOf('m1')).toEqual(rB.authenticatedAuthorOf('m1'));
      expect(rA.authenticatedAuthorOf('m2')).toEqual(rB.authenticatedAuthorOf('m2'));
      expect(rA.authenticatedAuthorOf('m1')).toEqual({
        userId: room.people.ada,
        principalKind: 'human',
      });
      // …and an identical rendered digest for the same span — the same glyph resolves.
      const dA = spanDigest(rA, 'm1', 0, 3);
      const dB = spanDigest(rB, 'm1', 0, 3);
      expect(dA).not.toBeNull();
      expect(dA).toBe(dB);
      mgrA.evictAll();
      mgrB.evictAll();
    } finally {
      await handleB.close();
    }
  });
});
