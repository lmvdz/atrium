import { randomUUID } from 'node:crypto';
import type { CovenantReadStatus } from '@atrium/core';
import {
  acceptedObjects,
  covenantAnchors,
  type DatabaseHandle,
  listCovenantAnchorObjectIds,
  loadCovenantAnchor,
} from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ChatMsg } from '../../apps/web/app/prototype/types.js';
import { ConversationDoc } from '../../apps/web/app/prototype/yjs-conversation.js';
import { certifyObjectSpan, REPLICA_ABSENT_POSITION } from '../../apps/web/lib/certify-anchor.js';
import { webCovenantReadAuthority } from '../../apps/web/lib/covenant-read.js';
import { readerForLiveDoc } from '../../apps/web/lib/covenant-reader.js';
import { liveCovenantDoc } from '../../apps/web/lib/live-covenant-doc.js';
import { roomCovenantReads } from '../../apps/web/lib/room-covenant-reads.js';
import { RoomDriftSweep } from '../../apps/web/lib/room-drift-sweep.js';
import { dbYdocStreamSource, RoomReplicaManager } from '../../apps/web/lib/room-replica-manager.js';
import {
  clearServerReplicas,
  type ServerRoomReplica,
  serverReplicaFor,
  type WriterIdentity,
} from '../../apps/web/lib/server-room-replica.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * E7 (#199, P6F-5) — THE DRIFT-ON-UPDATE SCHEDULER, DETECT, ON A REAL POSTGRES.
 *
 * The auto-stale heart: a human `✓` goes `~` the instant an agent-peer edits the
 * certified content — decided SERVER-SIDE on the E3 replica, by a coarse
 * invalidate + a SPAN-SCOPED digest re-resolution, and surfaced to the glyphs by
 * the read path's overlay of the sweep's `staleObjectIds` (DETECT's deliverable).
 *
 * ## THESE TESTS EXERCISE THE PRODUCTION SHAPE (E7, #199 Fix 5)
 *
 * What production runs is what is verified here: the read path is
 * {@link roomCovenantReads} (NOT the non-prod `serverCovenantReadAuthority`), the
 * sweep drives a {@link webCovenantReadAuthority} (the SAME authority the process
 * singleton binds, with its `liveFreshness` port), and the sweep lifecycle is the
 * {@link RoomReplicaManager}'s `sweepFactory` (start + seed on acquire, stop on evict).
 * Reads are asserted through the `{ objectId → status }` map `roomCovenantReads`
 * returns — the exact map the surface's glyph resolver consumes.
 *
 *   1. an edit IN a certified span → `✓`→`~` within one render tick;
 *   2. an edit OUT of range → the `✓` STAYS (digest identical);
 *   3. no false-stale STORM (an out-of-range edit doesn't stale a sibling span);
 *   4. the stale transition is a MACHINE `~` — never a `✓`; the machine writes
 *      no anchor; the draft is frozen so no consumer can flip it to `✓`;
 *   5. green TWICE at concurrency (two peers editing);
 *   6. the sweep racing a human certify of the SAME object — the certify mints,
 *      the sweep never clobbers it and never re-`✓`s;
 *   7. Fix 1 — the async ledger refresh is EPOCHED: a stale/older refresh completing
 *      after a newer one never wipes a newer certified set or a live `~` draft;
 *   8. Fix 2 + r3 — a freshly-certified anchor seeded via `noteCertified` is under the
 *      sweep's synchronous coverage, so its FIRST in-span edit is caught — even when a
 *      STALE pre-seed ledger refresh (observed [] pre-mint) completes LAST: monotone-by-
 *      assertion reconciliation keeps the seed sticky, so the edit is caught WITHIN THE TICK;
 *   9. Fix 3 — the overlay is FAIL-CLOSED until the sweep has spoken: a certified span
 *      with no settled sweep verdict reads `~`, not `ok`; demote-only (never mints `ok`);
 *  10. Fix 4 — the PRODUCTION teardown fail-close: evict → provider→null → the read
 *      path's fresh per-request resolve yields `~` (no `markSweepLive` gate — removed);
 *  11. revert-to-original-digest returns to `✓` — PINNING the #180 DIGEST MODEL
 *      (a covenant-MEANING call reserved for Lars, pending sticky-`~` ratification).
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

const FIXED_NOW = '2026-08-17T00:00:00.000Z';

function msg(id: string, text: string, kind: ChatMsg['kind'] = 'human'): ChatMsg {
  return { id, time: '10:00', kind, who: 'you', text };
}

/** Append one Yjs update through the E2 authenticated door — a durable stream row. */
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

const delta = (convo: ConversationDoc, priorSv: Uint8Array): Uint8Array =>
  Y.encodeStateAsUpdate(convo.doc, priorSv);

/**
 * A peer catches up the replica's current state, edits it, and applies the delta
 * back into the replica as an AUTHENTICATED write (attributed to `writer`). This is
 * the agent-peer edit that DETECT must catch: it fires the replica doc's `update`
 * event, which is what the sweep subscribes to. (In production the same event fires
 * from the live Electric / ws feed — a NAMED infra gap, exactly as E3's.)
 */
function peerEdit(
  replica: ServerRoomReplica,
  writer: WriterIdentity,
  edit: (peer: ConversationDoc) => void,
): void {
  const peer = new ConversationDoc();
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(replica.doc));
  const sv = Y.encodeStateVector(replica.doc);
  edit(peer);
  replica.applyAuthenticatedUpdate(delta(peer, sv), writer);
}

interface Wired {
  roomId: string;
  ada: string;
  hexi: string; // an agent peer
  manager: RoomReplicaManager;
  replica: ServerRoomReplica;
  /** Object ids certified so far — the sweep re-resolves exactly these. */
  certified: string[];
  /** The sweeps the manager's production `sweepFactory` created, keyed by room. */
  sweeps: Map<string, RoomDriftSweep>;
}

/**
 * Seed a room with two rich-text messages (m1, m2), then stand up the PRODUCTION
 * wiring: a {@link RoomReplicaManager} whose `sweepFactory` builds exactly what
 * `room-replica-singleton` builds in production — a {@link RoomDriftSweep} over a
 * {@link webCovenantReadAuthority} whose certified set is the AUTHORITATIVE ledger.
 * `acquire` starts + seeds the sweep. Returns the wiring; the caller certifies and edits.
 */
async function wire(): Promise<Wired> {
  const room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
  const ada = room.people.ada as string;
  const hexi = room.people.hexi as string;

  // m1 and m2 as two durable rows, each a rich-text body.
  const doc = new ConversationDoc();
  doc.append(msg('m1', 'alpha beta gamma'));
  await appendThroughDoor(handle, room.roomId, ada, Y.encodeStateAsUpdate(doc.doc));
  const sv1 = Y.encodeStateVector(doc.doc);
  doc.append(msg('m2', 'delta epsilon zeta'));
  await appendThroughDoor(handle, room.roomId, ada, delta(doc, sv1));

  const sweeps = new Map<string, RoomDriftSweep>();
  const manager = new RoomReplicaManager({
    source: dbYdocStreamSource(handle.db),
    // The PRODUCTION sweep factory (mirrors room-replica-singleton): the sweep drives a
    // web authority (with a `liveFreshness` port), and its certified set is the
    // AUTHORITATIVE `covenant_anchors`, never a caller allowlist.
    sweepFactory: (roomId, replica) => {
      const live = liveCovenantDoc(roomId);
      const reader = readerForLiveDoc(live.provider, undefined, live.options);
      const authority = webCovenantReadAuthority({
        loadAnchor: (objectId) => loadCovenantAnchor(handle.db, { roomId, objectId }),
        reader,
        expectedRoomId: roomId,
      });
      const sweep = new RoomDriftSweep({
        doc: replica.doc,
        authority,
        loadCertifiedObjectIds: () => listCovenantAnchorObjectIds(handle.db, { roomId }),
        now: () => FIXED_NOW,
      });
      sweeps.set(roomId, sweep);
      return sweep;
    },
  });
  const replica = await manager.acquire(room.roomId);
  if (replica === null) throw new Error('the replica must catch up from the durable stream');

  return { roomId: room.roomId, ada, hexi, manager, replica, certified: [], sweeps };
}

/** The manager-owned production sweep for the room. */
function mgrSweep(w: Wired): RoomDriftSweep {
  const s = w.sweeps.get(w.roomId);
  if (s === undefined) throw new Error('the production sweepFactory must have built a sweep');
  return s;
}

/** Await the room's live sweep going quiet (every re-resolve + ledger refresh settled). */
function settle(w: Wired): Promise<void> {
  return mgrSweep(w).settled();
}

/** Run one sweep now (as `acquire`/an update would) and await it settle — seed verdicts. */
async function seedAndSettle(w: Wired): Promise<void> {
  mgrSweep(w).sweepNow();
  await settle(w);
}

/**
 * Poll a predicate until true (or time out). Used in the r3 racing test to await ONE
 * sweep-driven re-resolve settling while a DIFFERENT ledger refresh is deliberately left
 * PARKED — `settled()` cannot be used there because it would await the parked refresh too.
 * A timeout means the awaited state never arrived (the bug), so it fails the test loudly.
 */
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: predicate never became true');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Resolve the room's glyphs through the PRODUCTION read path ({@link roomCovenantReads}),
 * wired to THIS manager's acquire + sweep overlays — exactly what the surface consumes.
 */
function reads(w: Wired, ids: string[]): Promise<Record<string, CovenantReadStatus>> {
  return roomCovenantReads(handle.db, w.roomId, ids, {
    acquire: (id) => w.manager.acquire(id),
    staleObjectIds: (id) => w.manager.staleObjectIdsFor(id),
    sweptObjectIds: (id) => w.manager.sweptObjectIdsFor(id),
  });
}

/**
 * Certify a human `✓` over `messageId`'s [start,end) span. Tracks the object in the
 * caller-side list `w.certified` UNLESS `trackInCallerList: false` — the omitted-id
 * test (Fix 1) certifies WITHOUT tracking, to prove the sweep still finds it from the
 * AUTHORITATIVE ledger, not from a hand-maintained caller list.
 */
async function certifySpan(
  w: Wired,
  objectId: string,
  messageId: string,
  start: number,
  end: number,
  opts?: { trackInCallerList?: boolean },
): Promise<void> {
  // Idempotent: a RE-certify (acceptance #6) reuses the same objectId, so the object
  // row already exists — only the covenant anchor is re-minted below.
  await handle.db
    .insert(acceptedObjects)
    .values({
      id: objectId,
      roomId: w.roomId,
      type: 'decision',
      payload: { statement: 'ship it', decidedBy: null, status: 'active' },
    })
    .onConflictDoNothing();
  const live = liveCovenantDoc(w.roomId);
  const path = w.replica.conversation.bodyPath(messageId) as number[];
  const reader = readerForLiveDoc(live.provider, { path, start, end }, live.options);
  const head = await w.manager.streamHead(w.roomId);
  const outcome = await certifyObjectSpan({
    database: handle.db,
    session: { userId: w.ada, principalKind: 'human' },
    authorizedRoomId: w.roomId,
    objectId,
    reader,
    streamFreshness: {
      requiredPosition: head,
      consumedPosition: () =>
        serverReplicaFor(w.roomId)?.consumedStreamPosition() ?? REPLICA_ABSENT_POSITION,
    },
  });
  if (!outcome.ok) throw new Error(`certify refused (${outcome.reason})`);
  if (opts?.trackInCallerList !== false) w.certified.push(objectId);
}

/** Every anchor row over a (room, object) — to prove the machine wrote none. */
function anchorsFor(roomId: string, objectId: string) {
  return handle.db
    .select()
    .from(covenantAnchors)
    .where(and(eq(covenantAnchors.roomId, roomId), eq(covenantAnchors.objectId, objectId)));
}

/** Tear the room's live sweep + replica down (production eviction path). */
function teardown(w: Wired): void {
  w.manager.evictAll();
}

describe('acceptance #1 — an edit IN a certified span → ✓→~ within one render tick', () => {
  it('the in-span digest move flips a resolved ✓ to ~ in the read map; the transition is a machine ~ draft', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // certify 'alpha'
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok'); // the human's ✓ resolves through the read path

    // An agent peer edits INSIDE the certified span. The update fires synchronously,
    // so the sweep's invalidate has already run by the time this returns.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );

    // WITHIN THE TICK: the read path's fresh re-resolve sees the moved digest → `~`
    // (drift), with no await on the sweep.
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // Once the async sweep settles: the push-based DETECT deliverable (staleObjectIds)
    // also carries o1, and the read map is still `~`.
    await settle(w);
    expect(mgrSweep(w).staleObjectIds().has(o1)).toBe(true);
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // The stale transition is recorded as a MACHINE `~` draft — kind is `'~'`, never `✓`.
    const draft = mgrSweep(w).staleDraftFor(o1);
    expect(draft?.kind).toBe('~');
    expect(draft?.objectId).toBe(o1);
    teardown(w);
  });
});

describe('acceptance #2 — an edit OUT of range → the ✓ STAYS (digest identical)', () => {
  it('an edit past the span boundary (same body) re-resolves back to ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // certify 'alpha'
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok');

    // Edit m1 at index 12 — inside 'gamma', OUT of the [0,5) certified span.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(12, 'ZZZ'),
    );
    await settle(w);

    // The certified [0,5) window re-renders byte-identically ⇒ the human's ✓ STAYS.
    expect((await reads(w, [o1]))[o1]).toBe('ok');
    expect(mgrSweep(w).staleDraftFor(o1)).toBeUndefined(); // no machine ~ draft
    teardown(w);
  });

  it('an edit to a DIFFERENT message leaves the certified span ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m2')?.insert(0, 'CHANGED '),
    );
    await settle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok');
    teardown(w);
  });
});

describe('acceptance #3 — span precision: no false-stale STORM', () => {
  it('an in-span edit to one object drifts ONLY it; a sibling certified span stays ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    const o2 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // 'alpha'
    await certifySpan(w, o2, 'm2', 0, 5); // 'delta'
    await seedAndSettle(w);
    let m = await reads(w, [o1, o2]);
    expect(m[o1]).toBe('ok');
    expect(m[o2]).toBe('ok');

    // Edit m1 in-span. The sweep coarsely invalidates BOTH o1 and o2, but only o1's
    // digest moved — o2 re-resolves back to `ok`. That is span precision (no storm).
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(1, 'QQ'),
    );
    await settle(w);
    m = await reads(w, [o1, o2]);
    expect(m[o1]).toBe('drift'); // ~
    expect(m[o2]).toBe('ok'); // ✓ — NOT stormed
    expect(mgrSweep(w).staleDraftFor(o1)?.kind).toBe('~');
    expect(mgrSweep(w).staleDraftFor(o2)).toBeUndefined();
    teardown(w);
  });
});

describe('acceptance #4 — the machine drafts ~ ONLY, never ✓; no re-✓ path', () => {
  it('the machine writes NO covenant anchor; the draft is frozen `~`', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    const before = await anchorsFor(w.roomId, o1);
    expect(before.length).toBe(1);
    expect(before[0]?.certifierKind).toBe('human');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await settle(w);
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // The machine touched the LEDGER not at all — same one row, still human-certified.
    const after = await anchorsFor(w.roomId, o1);
    expect(after.length).toBe(1);
    expect(after[0]?.certifierKind).toBe('human');
    expect(after[0]?.certifierId).toBe(w.ada);
    for (const draft of mgrSweep(w).staleDrafts().values()) expect(draft.kind).toBe('~');

    // The exposed draft is FROZEN at runtime, not only `readonly` at compile time: a
    // cast/JS consumer cannot flip its kind to '✓'.
    const draft = mgrSweep(w).staleDraftFor(o1);
    expect(draft).toBeDefined();
    expect(Object.isFrozen(draft)).toBe(true);
    expect(() => {
      (draft as unknown as { kind: string }).kind = '✓';
    }).toThrow();
    expect(mgrSweep(w).staleDraftFor(o1)?.kind).toBe('~');
    teardown(w);
  });

  it('FLIP: while the content stays drifted, no sweep / re-resolve / race yields a ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await settle(w);
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // Hammer the sweep concurrently — the content is still drifted, so EVERY resolve
    // must land on `~`. A single `ok` here would be a machine re-certification.
    for (let round = 0; round < 5; round++) {
      const races = Array.from({ length: 8 }, () => {
        mgrSweep(w).sweepNow();
        return settle(w);
      });
      await Promise.all(races);
      expect((await reads(w, [o1]))[o1]).toBe('drift');
    }
    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    teardown(w);
  });
});

describe('acceptance #5 — green TWICE at concurrency (two peers editing)', () => {
  it('two peers each drift their own span; both verdicts are correct, run twice', async () => {
    for (let run = 0; run < 2; run++) {
      await resetDatabase(handle);
      clearServerReplicas();
      const w = await wire();
      const o1 = randomUUID();
      const o2 = randomUUID();
      await certifySpan(w, o1, 'm1', 0, 5);
      await certifySpan(w, o2, 'm2', 0, 5);
      await seedAndSettle(w);
      let m = await reads(w, [o1, o2]);
      expect(m[o1]).toBe('ok');
      expect(m[o2]).toBe('ok');

      // Two peers edit, each INSIDE a different certified span, back to back — two
      // updates racing through the one sweep. Both spans must end `~`.
      peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
        peer.body('m1')?.insert(1, 'A'),
      );
      peerEdit(w.replica, { userId: w.ada, principalKind: 'human' }, (peer) =>
        peer.body('m2')?.insert(1, 'B'),
      );
      await settle(w);
      m = await reads(w, [o1, o2]);
      expect(m[o1]).toBe('drift');
      expect(m[o2]).toBe('drift');
      expect(mgrSweep(w).staleDraftFor(o1)?.kind).toBe('~');
      expect(mgrSweep(w).staleDraftFor(o2)?.kind).toBe('~');
      teardown(w);
    }
  });
});

describe('acceptance #6 — the sweep racing a human certify of the SAME object', () => {
  it('the certify of the swept object mints cleanly; the sweep never clobbers it and never re-✓s', async () => {
    // Same-object race: the sweep HAMMERS while the human certifies the VERY object it is
    // sweeping. The human ✓ must land; the machine must neither clobber it nor mint a ✓.
    const w = await wire();
    const o1 = randomUUID();

    const hammer = (async () => {
      for (let round = 0; round < 12; round++) {
        mgrSweep(w).sweepNow();
        await settle(w);
      }
    })();
    await Promise.all([hammer, certifySpan(w, o1, 'm1', 0, 5)]);

    // A final sweep resolves against the now-committed anchor.
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok'); // the human's ✓ stands
    expect(mgrSweep(w).staleDraftFor(o1)).toBeUndefined(); // no machine ~ over a fresh ✓

    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    expect(rows[0]?.certifierId).toBe(w.ada);
    teardown(w);
  });
});

describe('acceptance #7 — Fix 1: the async ledger refresh is EPOCHED (stale result never rolls back)', () => {
  it('a stale/older refresh completing AFTER a newer one never wipes a live ~ draft or the certified set', async () => {
    // The race: two sweeps kick two `loadCertifiedObjectIds` reads; the OLDER (smaller/
    // empty) result resolves LAST. Without the epoch guard it would overwrite the newer
    // certified set and PRUNE the drafts the newer snapshot added — the next sweep would
    // then invalidate nothing and a real drift would go undetected (a false ✓).
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    // Drift o1 in-span so its correct verdict is `~`.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );

    // A STANDALONE production-authority sweep with a controllable ledger loader, so the
    // completion ORDER of the two refreshes is deterministic (the sweep class + the web
    // authority are exactly production's; only the ledger read's timing is controlled —
    // which is precisely the race). Not subscribed to updates: driven by manual sweepNow.
    const live = liveCovenantDoc(w.roomId);
    const reader = readerForLiveDoc(live.provider, undefined, live.options);
    const authority = webCovenantReadAuthority({
      loadAnchor: (objectId) => loadCovenantAnchor(handle.db, { roomId: w.roomId, objectId }),
      reader,
      expectedRoomId: w.roomId,
    });
    const loadResolvers: Array<(ids: string[]) => void> = [];
    const sweep = new RoomDriftSweep({
      doc: w.replica.doc,
      authority,
      loadCertifiedObjectIds: () =>
        new Promise<string[]>((res) => {
          loadResolvers.push(res);
        }),
      now: () => FIXED_NOW,
    });

    // Kick TWO sweeps: epoch 1 (first) and epoch 2 (second). Neither ledger read has
    // resolved yet — both are parked in loadResolvers.
    sweep.sweepNow(); // epoch 1
    sweep.sweepNow(); // epoch 2
    expect(loadResolvers.length).toBe(2);
    const [resolveEpoch1, resolveEpoch2] = loadResolvers;
    if (resolveEpoch1 === undefined || resolveEpoch2 === undefined) {
      throw new Error('both ledger refreshes must be parked');
    }

    // Complete the NEWER refresh (epoch 2) FIRST with the correct set {o1}: it sweeps o1
    // → resolve → `~` draft, and adopts {o1} at epoch 2.
    resolveEpoch2([o1]);
    // Then complete the OLDER refresh (epoch 1) with a STALE EMPTY set: the epoch guard
    // must DROP its adoption + pruning, so o1's `~` draft and the certified set survive.
    resolveEpoch1([]);
    await sweep.settled();

    expect(sweep.staleObjectIds().has(o1)).toBe(true); // the ~ draft SURVIVED the stale refresh
    expect(sweep.staleDraftFor(o1)?.kind).toBe('~');

    // And a further sweep still invalidates + re-resolves o1 (proof the set wasn't emptied).
    loadResolvers.length = 0;
    sweep.sweepNow(); // epoch 3
    const resolveEpoch3 = loadResolvers[0];
    if (resolveEpoch3 === undefined) throw new Error('the epoch-3 refresh must be parked');
    resolveEpoch3([o1]);
    await sweep.settled();
    expect(sweep.staleObjectIds().has(o1)).toBe(true);
    teardown(w);
  });
});

describe('acceptance #8 — Fix 2 + r3: a freshly-certified anchor is swept on its first edit, even racing a stale pre-seed refresh', () => {
  it('RACING pre-seed refresh: a stale [] refresh completing LAST cannot wipe the noteCertified seed; the first in-span edit is caught WITHIN THE TICK', async () => {
    // THE r3 RACE (class-closing): a `loadCertifiedObjectIds` refresh KICKED before the
    // anchor was minted (it observes []) completes AFTER a `noteCertified` seed. The old
    // latest-COMPLETED-wins reconciliation wholesale-replaced the certified set, so the stale
    // [] pruned the seed — and the fresh anchor's FIRST in-span edit then missed within-tick
    // detection (the sync pass no longer covered it; only a later async refresh rediscovered
    // it). The fix makes reconciliation MONOTONE by ASSERTION epoch: a refresh ISSUED before a
    // seed can never prune it, so the seed survives and the edit is caught within the tick.
    //
    // Driven with a controllable ledger loader so the completion ORDER is deterministic — the
    // sweep class + web authority are EXACTLY production's; only the ledger read's timing is
    // controlled (which is precisely the race). Subscribed to updates (start), so the in-span
    // edit fires the real synchronous sweep pass.
    const w = await wire();
    const o1 = randomUUID();

    const live = liveCovenantDoc(w.roomId);
    const reader = readerForLiveDoc(live.provider, undefined, live.options);
    const authority = webCovenantReadAuthority({
      loadAnchor: (objectId) => loadCovenantAnchor(handle.db, { roomId: w.roomId, objectId }),
      reader,
      expectedRoomId: w.roomId,
    });
    const loadResolvers: Array<(ids: string[]) => void> = [];
    const sweep = new RoomDriftSweep({
      doc: w.replica.doc,
      authority,
      loadCertifiedObjectIds: () =>
        new Promise<string[]>((res) => {
          loadResolvers.push(res);
        }),
      now: () => FIXED_NOW,
    });
    sweep.start();

    // (1) KICK a pre-seed refresh (epoch 1). It observes [] (pre-mint) and is PARKED — it
    // will complete LAST, after the seed.
    sweep.sweepNow();
    expect(loadResolvers.length).toBe(1);
    const resolvePreSeed = loadResolvers[0];
    if (resolvePreSeed === undefined) throw new Error('the pre-seed refresh must be parked');

    // (2) CERTIFY o1 (anchor now in the ledger) and SEED it into the live sweep — exactly
    // what the certify action's `noteCertifiedFor` does on a successful mint.
    await certifySpan(w, o1, 'm1', 0, 5);
    sweep.noteCertified(o1);
    // Let the seed's re-resolve settle to swept-clean WITHOUT awaiting the parked pre-seed
    // refresh (`settled()` would await it and never return).
    await until(() => sweep.sweptObjectIds().has(o1));
    expect(sweep.sweptObjectIds().has(o1)).toBe(true); // seed is under coverage, swept-clean

    // (3) COMPLETE the stale [] refresh LAST. Issued BEFORE the seed, so monotone-by-assertion
    // reconciliation must NOT prune the seed: the certified set and swept-clean survive.
    resolvePreSeed([]);
    await new Promise((r) => setTimeout(r, 0)); // flush the refresh's .then microtasks
    expect(sweep.sweptObjectIds().has(o1)).toBe(true); // the stale [] did NOT wipe the seed

    // (4) FIRST in-span edit → fires the synchronous sweep pass. Because o1 SURVIVED in the
    // certified snapshot, the sync pass invalidates o1 and clears its swept-clean WITHIN THE
    // TICK (synchronously, no await), and drives a re-resolve that drafts `~` — without the
    // async ledger refresh having to rediscover o1. Park the edit's own refresh to PROVE the
    // `~` comes from the edit's synchronous sweep, not from the async rediscovery.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    expect(sweep.sweptObjectIds().has(o1)).toBe(false); // sync coverage touched it in-tick

    // WITHIN THE TICK: the edit's own re-resolve drafts `~` while the async refresh stays
    // PARKED — staleObjectIds carries o1 without any ledger refresh having rediscovered it.
    await until(() => sweep.staleObjectIds().has(o1));
    expect(sweep.staleObjectIds().has(o1)).toBe(true);
    expect(sweep.staleDraftFor(o1)?.kind).toBe('~');

    // Through the REAL read path (with this sweep's overlays), o1 reads `~`.
    const m = await roomCovenantReads(handle.db, w.roomId, [o1], {
      acquire: (id) => w.manager.acquire(id),
      staleObjectIds: () => sweep.staleObjectIds(),
      sweptObjectIds: () => sweep.sweptObjectIds(),
    });
    expect(m[o1]).toBe('drift');

    // Drain any parked refresh so no promise dangles, then tear down.
    for (const r of loadResolvers) r([o1]);
    await sweep.settled();
    sweep.stop();
    teardown(w);
  });

  it('Fix 1 companion — the swept set is AUTHORITATIVE: an anchor omitted from any caller list is still swept', async () => {
    const w = await wire();
    const oOmitted = randomUUID();
    // Certify WITHOUT tracking in the caller-side list — the sweep derives its set from
    // the AUTHORITATIVE `covenant_anchors`, so an omitted id is still swept.
    await certifySpan(w, oOmitted, 'm1', 0, 5, { trackInCallerList: false });
    expect(w.certified).not.toContain(oOmitted);
    await seedAndSettle(w);
    expect((await reads(w, [oOmitted]))[oOmitted]).toBe('ok');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await settle(w);
    expect((await reads(w, [oOmitted]))[oOmitted]).toBe('drift');
    expect(mgrSweep(w).staleObjectIds().has(oOmitted)).toBe(true);
    teardown(w);
  });
});

describe('acceptance #9 — Fix 3: the overlay is FAIL-CLOSED until the sweep has spoken', () => {
  it('a certified span with NO settled sweep verdict reads ~, not ok; then ok once swept-clean', async () => {
    const w = await wire();
    const o1 = randomUUID();
    // Certify AFTER acquire and DO NOT sweep: the live sweep has NO settled verdict for o1.
    await certifySpan(w, o1, 'm1', 0, 5);

    // The fresh per-request resolve would conclude `ok` (the span is byte-identical), but
    // the overlay WITHHOLDS it — o1 is neither `~` nor swept-clean, so it reads `~`.
    expect(mgrSweep(w).sweptObjectIds().has(o1)).toBe(false);
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // Once the sweep has POSITIVELY swept o1 clean, the overlay serves the `ok`.
    await seedAndSettle(w);
    expect(mgrSweep(w).sweptObjectIds().has(o1)).toBe(true);
    expect((await reads(w, [o1]))[o1]).toBe('ok');
    teardown(w);
  });

  it('DEMOTE-ONLY: the overlay never mints an ok — a sweep ~ wins over a fresh-resolve ok is impossible to invert', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok');

    // Drift it: both the fresh resolve AND the sweep say `~`. The overlay cannot turn that
    // back into `ok` — there is no path from a `~` (either source) to an `ok` in the map.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await settle(w);
    expect((await reads(w, [o1]))[o1]).toBe('drift');

    // Directly assert the demote-only property against the read path: inject a swept-clean
    // set that (wrongly) claims o1 is clean while the live content is drifted. The fresh
    // resolve is `~`, and the overlay must NOT promote it to `ok`.
    const m = await roomCovenantReads(handle.db, w.roomId, [o1], {
      acquire: (id) => w.manager.acquire(id),
      staleObjectIds: () => new Set<string>(), // pretend the sweep has no ~ draft
      sweptObjectIds: () => new Set<string>([o1]), // pretend o1 is swept-clean
    });
    expect(m[o1]).toBe('drift'); // still `~` — the overlay only ever demotes, never mints
    teardown(w);
  });
});

describe('acceptance #10 — Fix 4: the PRODUCTION teardown fail-close', () => {
  it('after evict (provider→null), the read path fresh-resolves to ~ — no markSweepLive gate', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok'); // trusted while the replica + sweep are live

    // Production teardown: evict the room. `dispose` stops the sweep (invalidate-all) and
    // UNREGISTERS the replica, so `serverReplicaFor` → null.
    w.manager.evict(w.roomId);
    expect(serverReplicaFor(w.roomId)).toBeNull();
    // The overlays no longer exist for the room.
    expect(w.manager.staleObjectIdsFor(w.roomId)).toBeUndefined();
    expect(w.manager.sweptObjectIdsFor(w.roomId)).toBeUndefined();

    // A read whose lazy-start cannot re-establish the replica (stream unreachable ⇒
    // acquire returns null) fresh-resolves against a `null` provider ⇒ `~`. This is the
    // proven teardown fail-close: invalidate-all + provider→null + fresh-resolve-per-request.
    const afterEvict = await roomCovenantReads(handle.db, w.roomId, [o1], {
      acquire: async () => null, // stream unreachable — no re-establish
      staleObjectIds: (id) => w.manager.staleObjectIdsFor(id),
      sweptObjectIds: (id) => w.manager.sweptObjectIdsFor(id),
    });
    expect(afterEvict[o1]).toBe('drift');
    teardown(w);
  });
});

describe('acceptance #11 — revert-to-original-digest returns to ✓ (the #180 DIGEST MODEL)', () => {
  it('an exact revert of the edited content clears the ~ and resolves ✓ again', async () => {
    /* COVENANT-MEANING NOTE (do NOT change without Lars): this asserts the CURRENT
       #180 DIGEST MODEL — a `✓` is bound to the rendered DIGEST of the certified span,
       so content that drifts to `~` and is then reverted BYTE-IDENTICALLY re-resolves
       to `ok` and the machine `~` clears. Whether an exact revert should instead leave
       a STICKY `~` (a covenant-MEANING decision — "this span was touched, re-affirm it")
       is reserved for Lars's ratification; until then the digest model stands, and this
       test PINS it so a future sticky-~ change is a deliberate, visible edit here. */
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // certify 'alpha' [0,5)
    await seedAndSettle(w);
    expect((await reads(w, [o1]))[o1]).toBe('ok');

    // Edit IN-span → drift → ~.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await settle(w);
    expect((await reads(w, [o1]))[o1]).toBe('drift');
    expect(mgrSweep(w).staleDraftFor(o1)?.kind).toBe('~');

    // REVERT exactly: delete the inserted 'X' at index 2, restoring 'alpha' byte-for-byte.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.delete(2, 1),
    );
    await settle(w);

    // The rendered digest returns to the certified bytes ⇒ the human's ✓ resolves again
    // and the machine ~ is cleared (the digest model — pending sticky-~ ratification).
    expect((await reads(w, [o1]))[o1]).toBe('ok');
    expect(mgrSweep(w).staleDraftFor(o1)).toBeUndefined();

    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    teardown(w);
  });
});
