import { randomUUID } from 'node:crypto';
import {
  acceptedObjects,
  covenantAnchors,
  type DatabaseHandle,
  listCovenantAnchorObjectIds,
} from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { serverCovenantReadAuthority } from '../../apps/server/src/covenant-read.js';
import type { ChatMsg } from '../../apps/web/app/prototype/types.js';
import { ConversationDoc } from '../../apps/web/app/prototype/yjs-conversation.js';
import { certifyObjectSpan, REPLICA_ABSENT_POSITION } from '../../apps/web/lib/certify-anchor.js';
import { readerSpanResolver } from '../../apps/web/lib/covenant-read.js';
import { readerForLiveDoc } from '../../apps/web/lib/covenant-reader.js';
import { liveCovenantDoc } from '../../apps/web/lib/live-covenant-doc.js';
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
 * invalidate + a SPAN-SCOPED digest re-resolution. This exercises the sweep
 * against a real durable stream + replica + the `covenant_anchors` ledger:
 *
 *   1. an edit IN a certified span → `✓`→`~` within one render tick;
 *   2. an edit OUT of range → the `✓` STAYS (digest identical);
 *   3. no false-stale STORM (an out-of-range edit doesn't stale a sibling span);
 *   4. the stale transition is a MACHINE `~` — never a `✓`; the machine writes
 *      no anchor; no sweep/re-resolve/race turns a `~` into a `✓`;
 *   5. green TWICE at concurrency (two peers editing);
 *   6. the sweep racing a human certify of the SAME object — the certify mints,
 *      the sweep never clobbers it and never re-`✓`s;
 *   7. trust tied to an ACTUALLY-LIVE sweep (Fix 3): a live-swept authority serves
 *      a cached `ok` as `✓`; an UNSWEPT one serves it `~`; invalidate-on-update
 *      (not a boolean) is what a swept read reflects;
 *   8. the swept set is AUTHORITATIVE (Fix 1): an anchor omitted from a caller list
 *      is STILL swept (found from `covenant_anchors`), so no undetected false `✓`;
 *   9. a STOPPED/evicted sweep fails closed (Fix 3): read-after-stop never serves a
 *      trusted `✓` (markSweepLive(false) + invalidate-all);
 *  10. revert-to-original-digest returns to `✓` — PINNING the #180 DIGEST MODEL
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
  authority: ReturnType<typeof serverCovenantReadAuthority>;
  sweep: RoomDriftSweep;
}

/**
 * Seed a room with two rich-text messages (m1, m2), catch a replica up from the
 * durable stream, and build a DRIFT-SWEPT server read authority + a RoomDriftSweep
 * over the replica doc. Returns the wiring; the caller certifies spans and edits.
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

  const manager = new RoomReplicaManager({ source: dbYdocStreamSource(handle.db) });
  const replica = await manager.acquire(room.roomId);
  if (replica === null) throw new Error('the replica must catch up from the durable stream');

  const live = liveCovenantDoc(room.roomId);
  const sweepReader = readerForLiveDoc(live.provider, undefined, live.options);
  const authority = serverCovenantReadAuthority({
    db: handle.db,
    roomId: room.roomId,
    resolveSpan: readerSpanResolver(sweepReader),
    // No `driftSwept` boolean any more (E7 #199 Fix 3): the guard clears ONLY because
    // the sweep below calls `authority.markSweepLive(true)` on `start()`. Trust follows
    // the sweep's real lifecycle, so a stopped sweep re-fail-closes this authority.
  });
  const certified: string[] = [];
  const sweep = new RoomDriftSweep({
    doc: replica.doc,
    authority,
    // AUTHORITATIVE certified set from the ledger (E7 #199 Fix 1), NOT a caller list —
    // an anchor a caller forgot to enumerate would otherwise never be swept (a false ✓).
    loadCertifiedObjectIds: () => listCovenantAnchorObjectIds(handle.db, { roomId: room.roomId }),
    now: () => FIXED_NOW,
  });
  sweep.start();

  return { roomId: room.roomId, ada, hexi, manager, replica, certified, authority, sweep };
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

describe('acceptance #1 — an edit IN a certified span → ✓→~ within one render tick', () => {
  it('the in-span digest move flips a resolved ✓ to ~; the transition is a machine ~ draft', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // certify 'alpha'

    // A first sweep settles the standing ✓ (out-of-range of nothing yet) to `ok`.
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok'); // the human's ✓ resolves

    // An agent peer edits INSIDE the certified span. The update fires synchronously,
    // so the sweep's invalidate has already run by the time this returns.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );

    // WITHIN THE TICK: the synchronous invalidate already demoted the ✓ to `~`
    // (no await needed) — the read authority returns `unresolved` for the dropped entry.
    expect(w.authority.read(o1).covenantStatus).not.toBe('ok');

    // Once the async re-resolve settles: the span-scoped digest moved ⇒ definitive `~`.
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('drift');

    // The stale transition is recorded as a MACHINE `~` draft — kind is `'~'`, never `✓`.
    const draft = w.sweep.staleDraftFor(o1);
    expect(draft).toBeDefined();
    expect(draft?.kind).toBe('~');
    expect(draft?.objectId).toBe(o1);
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #2 — an edit OUT of range → the ✓ STAYS (digest identical)', () => {
  it('an edit past the span boundary (same body) re-resolves back to ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // certify 'alpha'
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    // Edit m1 at index 12 — inside 'gamma', OUT of the [0,5) certified span.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(12, 'ZZZ'),
    );
    await w.sweep.settled();

    // The certified [0,5) window re-renders byte-identically ⇒ the human's ✓ STAYS.
    expect(w.authority.read(o1).covenantStatus).toBe('ok');
    expect(w.sweep.staleDraftFor(o1)).toBeUndefined(); // no machine ~ draft
    w.sweep.stop();
    w.manager.evictAll();
  });

  it('an edit to a DIFFERENT message leaves the certified span ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m2')?.insert(0, 'CHANGED '),
    );
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #3 — span precision: no false-stale STORM', () => {
  it('an in-span edit to one object drifts ONLY it; a sibling certified span stays ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    const o2 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5); // 'alpha'
    await certifySpan(w, o2, 'm2', 0, 5); // 'delta'
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');
    expect(w.authority.read(o2).covenantStatus).toBe('ok');

    // Edit m1 in-span. The sweep coarsely invalidates BOTH o1 and o2, but only o1's
    // digest moved — o2 re-resolves back to `ok`. That is span precision, and the
    // proof there is no storm.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(1, 'QQ'),
    );
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('drift'); // ~
    expect(w.authority.read(o2).covenantStatus).toBe('ok'); // ✓ — NOT stormed
    expect(w.sweep.staleDraftFor(o1)?.kind).toBe('~');
    expect(w.sweep.staleDraftFor(o2)).toBeUndefined();
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #4 — the machine drafts ~ ONLY, never ✓; no re-✓ path', () => {
  it('the machine writes NO covenant anchor, and the standing anchor stays human-certified', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    const before = await anchorsFor(w.roomId, o1);
    expect(before.length).toBe(1);
    expect(before[0]?.certifierKind).toBe('human');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('drift');

    // The machine touched the LEDGER not at all — same one row, still human-certified.
    const after = await anchorsFor(w.roomId, o1);
    expect(after.length).toBe(1);
    expect(after[0]?.certifierKind).toBe('human');
    expect(after[0]?.certifierId).toBe(w.ada);
    // Every machine draft that exists is a `~` — there is no ✓ variant to record.
    for (const draft of w.sweep.staleDrafts().values()) expect(draft.kind).toBe('~');

    // Fix 4 — the exposed draft is FROZEN at runtime, not only `readonly` at compile
    // time: a cast/JS consumer cannot flip its kind to '✓'. `Object.freeze` makes the
    // write a no-op (throws in strict mode; vitest ESM runs strict), so kind stays '~'.
    const draft = w.sweep.staleDraftFor(o1);
    expect(draft).toBeDefined();
    expect(Object.isFrozen(draft)).toBe(true);
    expect(() => {
      (draft as unknown as { kind: string }).kind = '✓';
    }).toThrow();
    expect(w.sweep.staleDraftFor(o1)?.kind).toBe('~');
    w.sweep.stop();
    w.manager.evictAll();
  });

  it('FLIP: while the content stays drifted, no sweep / re-resolve / race yields a ✓', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('drift');

    // Hammer the sweep concurrently — the content is still drifted, so EVERY resolve
    // must land on `~`. A single `ok` here would be a machine re-certification.
    for (let round = 0; round < 5; round++) {
      const races = Array.from({ length: 8 }, () => {
        w.sweep.sweepNow();
        return w.sweep.settled();
      });
      await Promise.all(races);
      expect(w.authority.read(o1).covenantStatus).toBe('drift');
    }
    // The anchor never became machine-certified.
    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    w.sweep.stop();
    w.manager.evictAll();
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
      w.sweep.sweepNow();
      await w.sweep.settled();
      expect(w.authority.read(o1).covenantStatus).toBe('ok');
      expect(w.authority.read(o2).covenantStatus).toBe('ok');

      // Two peers edit, each INSIDE a different certified span, back to back — two
      // updates racing through the one sweep. Both spans must end `~`.
      peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
        peer.body('m1')?.insert(1, 'A'),
      );
      peerEdit(w.replica, { userId: w.ada, principalKind: 'human' }, (peer) =>
        peer.body('m2')?.insert(1, 'B'),
      );
      await w.sweep.settled();
      expect(w.authority.read(o1).covenantStatus).toBe('drift');
      expect(w.authority.read(o2).covenantStatus).toBe('drift');
      expect(w.sweep.staleDraftFor(o1)?.kind).toBe('~');
      expect(w.sweep.staleDraftFor(o2)?.kind).toBe('~');
      w.sweep.stop();
      w.manager.evictAll();
    }
  });
});

describe('acceptance #6 — the sweep racing a human certify of the SAME object', () => {
  it('the certify of the swept object mints cleanly; the sweep never clobbers it and never re-✓s', async () => {
    // Same-object race (Fix 6): the sweep HAMMERS while the human certifies the VERY
    // object it is sweeping (its first certify — certifyObjectSpan refuses a second over
    // an already-certified object). The human ✓ must land, and the machine must neither
    // clobber it nor mint a ✓ of its own — no matter how the two interleave.
    const w = await wire();
    const o1 = randomUUID();

    // Hammer the sweep concurrently with the certify — a sweep pass may observe o1 mid-
    // certify (before its anchor exists) or just after; either way it may only read.
    const hammer = (async () => {
      for (let round = 0; round < 12; round++) {
        w.sweep.sweepNow();
        await w.sweep.settled();
      }
    })();
    await Promise.all([hammer, certifySpan(w, o1, 'm1', 0, 5)]);

    // A final sweep resolves against the now-committed anchor.
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok'); // the human's ✓ stands
    expect(w.sweep.staleDraftFor(o1)).toBeUndefined(); // no machine ~ over a fresh ✓

    // Exactly ONE row for o1, human-certified — the machine minted nothing.
    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    expect(rows[0]?.certifierId).toBe(w.ada);
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #7 — trust is tied to an ACTUALLY-LIVE sweep, not a caller boolean (Fix 3)', () => {
  it('a LIVE-swept authority serves a cached ✓; an UNSWEPT one serves the same ok as ~', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    // The sweep is LIVE (start() called markSweepLive(true)), so a cached ✓ is trusted —
    // NOT because a caller passed driftSwept, but because a sweep is genuinely running.
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    // The SAME ledger + the SAME live doc, but NO sweep started on it: fail-closed. A
    // server-cached `ok` it cannot freshness-prove is served `~`, never a stale ✓.
    const live = liveCovenantDoc(w.roomId);
    const unsweptReader = readerForLiveDoc(live.provider, undefined, live.options);
    const unswept = serverCovenantReadAuthority({
      db: handle.db,
      roomId: w.roomId,
      resolveSpan: readerSpanResolver(unsweptReader),
    });
    const resolved = await unswept.resolve(o1);
    expect(resolved.covenantStatus).toBe('ok'); // genuinely resolves ok…
    expect(unswept.read(o1).covenantStatus).not.toBe('ok'); // …but read() demotes to ~ (no live sweep)
    w.sweep.stop();
    w.manager.evictAll();
  });

  it('invalidate-on-update, not a standing boolean, is what a swept read reflects', async () => {
    // NOT-THEATER for Fix 3: the guard is real machinery, not a `driftSwept:true` flag.
    // A live sweep serves ✓; an in-span edit fires the sweep's synchronous invalidate;
    // the very next read is `~` WITHIN THE TICK — the invalidate did the work, not a boolean.
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    // No await: the update handler ran the synchronous invalidate already.
    expect(w.authority.read(o1).covenantStatus).not.toBe('ok');
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #8 — the swept set is AUTHORITATIVE (an anchor omitted from a caller list is STILL swept)', () => {
  it('Fix 1: an object certified but NEVER added to the caller list drifts anyway (found from the ledger)', async () => {
    const w = await wire();
    const oOmitted = randomUUID();
    // Certify WITHOUT tracking in the caller-side list — the old caller-passed
    // `certifiedObjectIds()` would never enumerate it, so its drift would go UNDETECTED
    // (a false ✓). The sweep now derives its set from the AUTHORITATIVE `covenant_anchors`.
    await certifySpan(w, oOmitted, 'm1', 0, 5, { trackInCallerList: false });
    expect(w.certified).not.toContain(oOmitted); // proven absent from any caller list

    w.sweep.sweepNow();
    await w.sweep.settled();
    // The ledger loader found it → it resolves to the human's standing ✓.
    expect(w.authority.read(oOmitted).covenantStatus).toBe('ok');

    // Drift it in-span. The sweep — driven by the ledger, not the caller list — catches it.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await w.sweep.settled();
    expect(w.authority.read(oOmitted).covenantStatus).toBe('drift'); // ~ — NOT an undetected false ✓
    expect(w.sweep.staleDraftFor(oOmitted)?.kind).toBe('~');
    expect(w.sweep.staleObjectIds().has(oOmitted)).toBe(true);
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #9 — a STOPPED sweep fails closed (Fix 3): read-after-stop never serves a trusted ✓', () => {
  it('after stop(), a previously-✓ object reads ~ — the authority is re-fail-closed + invalidated', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok'); // trusted while the sweep is live

    // Teardown. stop() must both re-arm the fail-closed guard (markSweepLive(false)) AND
    // invalidate every cached object — so no stopped sweep leaves a trusting authority.
    w.sweep.stop();
    expect(w.authority.read(o1).covenantStatus).not.toBe('ok'); // proved fail-open, now closed

    // Even a fresh resolve after stop cannot be TRUSTED by read(): the guard is re-armed,
    // so read() demotes the freshly-cached ok to ~ (no live sweep to prove it fresh).
    const r = await w.authority.resolve(o1);
    expect(r.covenantStatus).toBe('ok'); // it genuinely still resolves ok…
    expect(w.authority.read(o1).covenantStatus).not.toBe('ok'); // …but read() serves ~ (stopped)
    w.manager.evictAll();
  });

  it('eviction through the manager stops the sweep and re-fail-closes it', async () => {
    // The production teardown path: RoomReplicaManager.evict → dispose → sweep.stop().
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    w.sweep.stop(); // (the manager owns the sweep in production; here the sweep is wired by hand)
    w.manager.evict(w.roomId);
    expect(w.authority.read(o1).covenantStatus).not.toBe('ok');
    w.manager.evictAll();
  });
});

describe('acceptance #10 — revert-to-original-digest returns to ✓ (the #180 DIGEST MODEL)', () => {
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
    w.sweep.sweepNow();
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    // Edit IN-span → drift → ~.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    await w.sweep.settled();
    expect(w.authority.read(o1).covenantStatus).toBe('drift');
    expect(w.sweep.staleDraftFor(o1)?.kind).toBe('~');

    // REVERT exactly: delete the inserted 'X' at index 2, restoring 'alpha' byte-for-byte.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.delete(2, 1),
    );
    await w.sweep.settled();

    // The rendered digest returns to the certified bytes ⇒ the human's ✓ resolves again
    // and the machine ~ is cleared (the digest model — pending sticky-~ ratification).
    expect(w.authority.read(o1).covenantStatus).toBe('ok');
    expect(w.sweep.staleDraftFor(o1)).toBeUndefined();

    // The machine minted nothing: still exactly one human anchor row.
    const rows = await anchorsFor(w.roomId, o1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.certifierKind).toBe('human');
    w.sweep.stop();
    w.manager.evictAll();
  });
});
