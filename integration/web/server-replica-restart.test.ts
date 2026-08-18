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
import { roomCovenantReads } from '../../apps/web/lib/room-covenant-reads.js';
import {
  dbYdocStreamSource,
  RoomReplicaManager,
  type YdocStreamSource,
} from '../../apps/web/lib/room-replica-manager.js';
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

  it('BLOCKER-1: certify → append → certify again MINTS, with NO manual evict (the warm replica re-catches-up on acquire)', async () => {
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

    // The certify action's exact wiring, run twice against the SAME manager.
    const certify = async (objectId: string, messageId: string): Promise<boolean> => {
      const requiredPosition = await manager.streamHead(room.roomId);
      const replica = await manager.acquire(room.roomId); // lazy-start OR warm re-catch-up
      if (replica === null) throw new Error('acquire must return a replica');
      const live = liveCovenantDoc(room.roomId);
      const path = replica.conversation.bodyPath(messageId) as number[];
      const reader = readerForLiveDoc(live.provider, { path, start: 0, end: 5 }, live.options);
      const outcome = await certifyObjectSpan({
        database: handle.db,
        session: { userId: room.people.ada as string, principalKind: 'human' },
        authorizedRoomId: room.roomId,
        objectId,
        reader,
        streamFreshness: {
          requiredPosition,
          consumedPosition: () =>
            serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
        },
      });
      return outcome.ok;
    };

    // First certify mints.
    expect(await certify(o1, 'm1')).toBe(true);

    // A new row is appended AFTER the replica warmed (no live subscription sees it).
    const ada2 = new ConversationDoc();
    Y.applyUpdate(ada2.doc, Y.encodeStateAsUpdate(serverReplicaFor(room.roomId)?.doc as Y.Doc));
    const svBefore = Y.encodeStateVector(ada2.doc);
    ada2.append(msg('m2', 'delta epsilon'));
    await appendThroughDoor(handle, room.roomId, room.people.ada as string, delta(ada2, svBefore));

    // The SECOND certify — WITHOUT any manual evict — must catch the warm replica up on
    // acquire and MINT, not refuse `replica_lagging` forever. This is the blocker.
    expect(await certify(o2, 'm2')).toBe(true);
    expect(serverReplicaFor(room.roomId)?.consumedStreamPosition()).toBe(2);
    manager.evictAll();
  });

  it('BLOCKER-2: a poison row PUT through the door does not 500 certify — acquire skips it, the room refuses cleanly', async () => {
    const room = await seedRoom(handle, ['ada']);
    const o1 = randomUUID();
    await handle.db.insert(acceptedObjects).values({
      id: o1,
      roomId: room.roomId,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
    });

    const ada = new ConversationDoc();
    ada.append(msg('m1', 'alpha beta gamma'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );
    // Ada PUTs GARBAGE bytes through the authenticated door — stored verbatim (the door
    // does not parse the op; #208 tracks the non-owner boundary, not op validity).
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    );

    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    // acquire MUST NOT throw (otherwise the action 500s and certify is DOWN for the room).
    const replica = await manager.acquire(room.roomId);
    expect(replica).not.toBeNull();
    // The good row folded; the poison row was quarantined ⇒ the replica trails the head.
    expect(replica?.conversation.body('m1')?.toString()).toBe('alpha beta gamma');
    const head = await manager.streamHead(room.roomId);
    expect(head).toBe(2);
    expect(replica?.consumedStreamPosition()).toBe(1);

    // certify against the lagging (poisoned) room is a CLEAN refusal, never a 500.
    const live = liveCovenantDoc(room.roomId);
    const path = replica?.conversation.bodyPath('m1') as number[];
    const reader = readerForLiveDoc(live.provider, { path, start: 0, end: 5 }, live.options);
    const outcome = await certifyObjectSpan({
      database: handle.db,
      session: { userId: room.people.ada as string, principalKind: 'human' },
      authorizedRoomId: room.roomId,
      objectId: o1,
      reader,
      streamFreshness: {
        requiredPosition: head,
        consumedPosition: () =>
          serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
    manager.evictAll();
  });
});

describe('#203 CLASS on a REAL stream: a visibility-hole reorder folds the missing row (stable seq, not array index)', () => {
  it('a middle durable row hidden then revealed folds on re-acquire; the gate refuses until it is caught up', async () => {
    const room = await seedRoom(handle, ['ada']);

    // Three durable rows on one client — real per-room stream_seqs 1, 2, 3, minted by
    // the append function (migration 0055).
    const ada = new ConversationDoc();
    ada.append(msg('m1', 'alpha'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );
    const sv1 = Y.encodeStateVector(ada.doc);
    ada.append(msg('m2', 'beta'));
    await appendThroughDoor(handle, room.roomId, room.people.ada as string, delta(ada, sv1));
    const sv2 = Y.encodeStateVector(ada.doc);
    ada.append(msg('m3', 'gamma'));
    await appendThroughDoor(handle, room.roomId, room.people.ada as string, delta(ada, sv2));

    // The REAL durable rows, in seq order, from Postgres.
    const real = dbYdocStreamSource(handle.db);
    const all = await real.snapshot(room.roomId);
    expect(all.map((r) => r.streamSeq)).toEqual([1, 2, 3]);
    const midSeq = all[1]?.streamSeq as number; // 2 — the row the hole hides

    // A source that reads real rows but momentarily HIDES the middle seq from the
    // SNAPSHOT while the HEAD (max seq) already sees it — the visibility hole. Keyed on
    // the array index, m2 would collide with an already-folded index on reveal and be
    // deduped away; keyed on stream_seq it is a distinct row that folds cleanly.
    let reveal = false;
    const holed: YdocStreamSource = {
      async snapshot(roomId: string) {
        const rows = await real.snapshot(roomId);
        return reveal ? rows : rows.filter((r) => r.streamSeq !== midSeq);
      },
      head: (roomId: string) => real.head(roomId),
    };
    const manager = new RoomReplicaManager({ source: holed });

    const first = await manager.acquire(room.roomId);
    if (first === null) throw new Error('first acquire must catch up');
    expect(first.conversation.body('m2')).toBeNull(); // the hidden middle row
    expect(first.consumedStreamPosition()).toBe(1); // gap at seq 2 holds the prefix at 1
    expect(first.consumedStreamPosition()).toBeLessThan(await manager.streamHead(room.roomId));

    reveal = true;
    const caughtUp = await manager.acquire(room.roomId);
    expect(caughtUp).toBe(first); // same warm object, re-caught-up
    expect(caughtUp?.conversation.body('m2')?.toString()).toBe('beta'); // once-missing row folded
    expect(caughtUp?.consumedStreamPosition()).toBe(3);
    expect(caughtUp?.consumedStreamPosition()).toBe(await manager.streamHead(room.roomId));
    manager.evictAll();
  });

  it('POISON-then-FULL-STATE: a full-state row re-declaring an earlier writer keeps original authorship, and the poisoned room stays fail-closed', async () => {
    const room = await seedRoom(handle, ['ada', 'bob']);

    // Ada writes m1 (seq 1).
    const ada = new ConversationDoc();
    ada.append(msg('m1', 'the original reading'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );

    // A poison row is PUT through the door (seq 2) — garbage bytes, stored verbatim.
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    );

    // Bob catches up Ada's content, writes m2, and appends a FULL-STATE update (seq 3)
    // that re-declares Ada's m1 structs alongside his own new ones.
    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(ada.doc));
    bob.append(msg('m2', 'the reviewer reading'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.bob as string,
      Y.encodeStateAsUpdate(bob.doc), // FULL state, not a delta
    );

    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const replica = await manager.acquire(room.roomId);
    if (replica === null) throw new Error('acquire must not throw on a poison row');

    // Content: m1 and m2 both present (the full-state row carried both); authorship is
    // the ORIGINAL writers — m1 to Ada (earliest seq wins over the full-state
    // re-declaration), m2 to Bob.
    expect(replica.conversation.body('m1')?.toString()).toBe('the original reading');
    expect(replica.conversation.body('m2')?.toString()).toBe('the reviewer reading');
    expect(replica.authenticatedAuthorOf('m1')).toEqual({
      userId: room.people.ada,
      principalKind: 'human',
    });
    expect(replica.authenticatedAuthorOf('m2')).toEqual({
      userId: room.people.bob,
      principalKind: 'human',
    });

    // FAIL-CLOSED: the poison row (seq 2) never folds, so the contiguous position is
    // stuck at 1 below a head of 3 — the room can never certify while the poison sits
    // in the stream, exactly the fail-closed the ticket asks for.
    const head = await manager.streamHead(room.roomId);
    expect(head).toBe(3);
    expect(replica.consumedStreamPosition()).toBe(1);
    expect(replica.consumedStreamPosition()).toBeLessThan(head);
    manager.evictAll();
  });
});

describe('the READ path lazy-starts the replica so authorship reaches the glyphs after a restart (acceptance #4)', () => {
  it('MAJOR-4: after a cold restart, roomCovenantReads acquires the replica and resolves the certified span ✓ — not `~`', async () => {
    const room = await seedRoom(handle, ['ada']);
    const objectId = randomUUID();
    await handle.db.insert(acceptedObjects).values({
      id: objectId,
      roomId: room.roomId,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
    });

    const ada = new ConversationDoc();
    ada.append(msg('m1', 'alpha beta gamma'));
    await appendThroughDoor(
      handle,
      room.roomId,
      room.people.ada as string,
      Y.encodeStateAsUpdate(ada.doc),
    );

    // Certify m1's 'alpha' span — persists a real covenant anchor.
    const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const replica = await manager.acquire(room.roomId);
    if (replica === null) throw new Error('replica must catch up');
    const head = await manager.streamHead(room.roomId);
    const live = liveCovenantDoc(room.roomId);
    const path = replica.conversation.bodyPath('m1') as number[];
    const reader = readerForLiveDoc(live.provider, { path, start: 0, end: 5 }, live.options);
    const minted = await certifyObjectSpan({
      database: handle.db,
      session: { userId: room.people.ada as string, principalKind: 'human' },
      authorizedRoomId: room.roomId,
      objectId,
      reader,
      streamFreshness: {
        requiredPosition: head,
        consumedPosition: () =>
          serverReplicaFor(room.roomId)?.consumedStreamPosition() ?? Number.NEGATIVE_INFINITY,
      },
    });
    expect(minted.ok).toBe(true);

    // COLD RESTART: tear every replica down. The registry is now empty — if only the
    // certify path acquired, the read below would be `~`.
    manager.evictAll();
    clearServerReplicas();
    expect(serverReplicaFor(room.roomId)).toBeNull();

    // BEFORE (the bug): a read with no lazy-start resolves `~` because nothing is registered.
    const withoutLazyStart = await roomCovenantReads(handle.db, room.roomId, [objectId], {
      acquire: async () => {}, // no lazy-start ⇒ nothing registered
    });
    expect(withoutLazyStart[objectId]).toBe('drift');

    // AFTER (the fix): the read path lazy-starts the replica from the durable stream,
    // so the certified span resolves `ok` — authorship survives the restart to the glyph.
    const freshManager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
    const reads = await roomCovenantReads(handle.db, room.roomId, [objectId], {
      acquire: (rid) => freshManager.acquire(rid),
    });
    expect(reads[objectId]).toBe('ok');
    freshManager.evictAll();
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
