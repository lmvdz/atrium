import { randomUUID } from 'node:crypto';
import { acceptedObjects, covenantAnchors, type DatabaseHandle } from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ChatMsg } from '../../apps/web/app/prototype/types.js';
import { ConversationDoc } from '../../apps/web/app/prototype/yjs-conversation.js';
import { certifyObjectSpan, REPLICA_ABSENT_POSITION } from '../../apps/web/lib/certify-anchor.js';
import { readerSpanResolver } from '../../apps/web/lib/covenant-read.js';
import { readerForLiveDoc } from '../../apps/web/lib/covenant-reader.js';
import { liveCovenantDoc } from '../../apps/web/lib/live-covenant-doc.js';
import { RoomDriftSweep } from '../../apps/web/lib/room-drift-sweep.js';
import {
  dbYdocStreamSource,
  RoomReplicaManager,
} from '../../apps/web/lib/room-replica-manager.js';
import {
  clearServerReplicas,
  type ServerRoomReplica,
  serverReplicaFor,
  type WriterIdentity,
} from '../../apps/web/lib/server-room-replica.js';
import { serverCovenantReadAuthority } from '../../apps/server/src/covenant-read.js';
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
 *   6. the sweep racing a human certify — the certify mints, the sweep never
 *      clobbers it and never re-`✓`s;
 *   7. the `#182-before-server-✓` flag-clear: a swept authority serves a cached
 *      `ok` as `✓`; an UNSWEPT one still serves it `~` (fail-closed).
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
    // The sweep below IS live on this authority — clears the `#182-before-server-✓` gate.
    driftSwept: true,
  });
  const certified: string[] = [];
  const sweep = new RoomDriftSweep({
    doc: replica.doc,
    authority,
    certifiedObjectIds: () => certified,
    now: () => FIXED_NOW,
  });
  sweep.start();

  return { roomId: room.roomId, ada, hexi, manager, replica, certified, authority, sweep };
}

/** Certify a human `✓` over `messageId`'s [start,end) span, and track the object. */
async function certifySpan(
  w: Wired,
  objectId: string,
  messageId: string,
  start: number,
  end: number,
): Promise<void> {
  await handle.db.insert(acceptedObjects).values({
    id: objectId,
    roomId: w.roomId,
    type: 'decision',
    payload: { statement: 'ship it', decidedBy: null, status: 'active' },
  });
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
  w.certified.push(objectId);
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

describe('acceptance #6 — the sweep racing a human certify', () => {
  it('a certify mints while the sweep runs; the sweep never clobbers it and never re-✓s', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();

    // Race: an in-span edit to o1 (drifts it) AND a fresh human certify of o2 over m2.
    peerEdit(w.replica, { userId: w.hexi, principalKind: 'agent' }, (peer) =>
      peer.body('m1')?.insert(2, 'X'),
    );
    const o2 = randomUUID();
    const [, ,] = await Promise.all([
      w.sweep.settled(),
      certifySpan(w, o2, 'm2', 0, 5), // the human ✓ mints, concurrent with the sweep
    ]);

    w.sweep.sweepNow();
    await w.sweep.settled();
    // o1 drifted (the peer edit), o2 is the human's fresh ✓ — resolved, not clobbered.
    expect(w.authority.read(o1).covenantStatus).toBe('drift');
    expect(w.authority.read(o2).covenantStatus).toBe('ok');
    // Exactly one row per object, both human-certified — the machine minted nothing.
    expect((await anchorsFor(w.roomId, o1))[0]?.certifierKind).toBe('human');
    expect((await anchorsFor(w.roomId, o2))[0]?.certifierKind).toBe('human');
    w.sweep.stop();
    w.manager.evictAll();
  });
});

describe('acceptance #7 — the #182-before-server-✓ flag-clear is real', () => {
  it('a SWEPT authority serves a cached ✓; an UNSWEPT one serves the same ok as ~', async () => {
    const w = await wire();
    const o1 = randomUUID();
    await certifySpan(w, o1, 'm1', 0, 5);
    w.sweep.sweepNow();
    await w.sweep.settled();
    // Swept: the sweep guarantees invalidate-on-drift, so a cached ✓ is trusted.
    expect(w.authority.read(o1).covenantStatus).toBe('ok');

    // The SAME ledger + the SAME live doc, but NO sweep declared: fail-closed. A
    // server-cached `ok` it cannot freshness-prove is served `~`, never a stale ✓.
    const live = liveCovenantDoc(w.roomId);
    const unsweptReader = readerForLiveDoc(live.provider, undefined, live.options);
    const unswept = serverCovenantReadAuthority({
      db: handle.db,
      roomId: w.roomId,
      resolveSpan: readerSpanResolver(unsweptReader),
      // driftSwept omitted ⇒ failClosedWithoutFreshness stays SET (the pre-E7 default).
    });
    const resolved = await unswept.resolve(o1);
    expect(resolved.covenantStatus).toBe('ok'); // genuinely resolves ok…
    expect(unswept.read(o1).covenantStatus).not.toBe('ok'); // …but read() demotes to ~
    w.sweep.stop();
    w.manager.evictAll();
  });
});
