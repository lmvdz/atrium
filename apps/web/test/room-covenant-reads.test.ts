import { type CovenantAnchor, certifyAnchor } from '@atrium/core';
import type { Database } from '@atrium/db';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorCertifies, precomputedGlyphResolver } from '@/lib/covenant-read';
import { readerForLiveDoc } from '@/lib/covenant-reader';
import { liveCovenantDoc } from '@/lib/live-covenant-doc';
import { roomCovenantReads } from '@/lib/room-covenant-reads';
import {
  clearServerReplicas,
  registerServerReplica,
  ServerRoomReplica,
  type WriterIdentity,
} from '@/lib/server-room-replica';
import type { ChatMsg } from '../app/prototype/types';

/* ═══════════════════════════════════════════════════════════════════════════
 * P6F-4 / #198 — LIVE RESOLVER WIRING, end-to-end, NOT-THEATER.
 *
 * Flips the fail-closed `~` back to a real `✓`. On base int/phase6 the display
 * surfaces pass `glyphResolver = undefined` (ReplaySession) / omit the 5th arg
 * (liveRoomView), so `anchorCertifies` is ALWAYS false and every object renders `~`.
 * This proves the two halves this ticket wires:
 *
 *   1. SERVER — `roomCovenantReads` builds the ONE `webCovenantReadAuthority` over
 *      the room's authoritative live replica + the `covenant_anchors` read
 *      (`loadCovenantAnchor`), and resolves each object to a definitive status:
 *      a certified-unchanged span ⇒ `ok`; an in-span edit ⇒ `drift`; no anchor ⇒
 *      `drift`; a FOREIGN-ROOM anchor (right objectId, wrong room) ⇒ `drift` (never
 *      a foreign-room `✓`).
 *   2. CLIENT — `precomputedGlyphResolver` wraps that map as the sync
 *      `ObjectGlyphResolver` the surfaces thread into `replayView`/`liveRoomView`,
 *      and `anchorCertifies` (the exact seam every migrated reader computes `✓`
 *      through) returns TRUE only for an `ok`, false for everything else.
 *
 * Each assertion FAILS on base (`~` everywhere, no `precomputedGlyphResolver`).
 * The reader/replica wiring mirrors `certifyObjectSpanAction` exactly (via
 * `liveCovenantDoc`), so this is the shipped path, not a hand-made double. The DB
 * `covenant_anchors` read is the one seam the sandbox cannot stand up (no Postgres),
 * so a faithful ROW — built from a REAL server-derived anchor — is returned through
 * a minimal `select` stub; everything resolution-bearing is real.
 * ═════════════════════════════════════════════════════════════════════════ */

const ROOM = 'room_p6f4';
const ALICE: WriterIdentity = { userId: 'u_alice', principalKind: 'human' };
/**
 * These resolution tests register the replica themselves ({@link seedReplica}), so
 * they inject a NO-OP lazy-start — the acquire is exercised on its own in the
 * lazy-start block below, against the fail-closed and the resolves-authorship paths.
 */
const NO_LAZY_START = { acquire: async () => {} } as const;
const CERT_ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-17T12:00:00.000Z';
const OBJECT_ID = 'o_span';

afterEach(() => clearServerReplicas());

function msg(id: string, text: string): ChatMsg {
  return { id, time: '10:00', kind: 'human', who: 'you', text };
}

/** A caught-up replica of one room, seeded with one authored rich-text body. */
function seedReplica(text: string): ServerRoomReplica {
  const replica = new ServerRoomReplica().seedAuthored([msg('m1', text)], ALICE);
  registerServerReplica(ROOM, replica);
  return replica;
}

/** Derive a REAL anchor the way the certify gate does — server reader over the replica. */
function deriveAnchor(
  replica: ServerRoomReplica,
  span: { start: number; end: number },
): CovenantAnchor {
  const path = replica.conversation.bodyPath('m1') as number[];
  const live = liveCovenantDoc(ROOM);
  const reader = readerForLiveDoc(
    live.provider,
    { path, start: span.start, end: span.end },
    live.options,
  );
  const anchor = certifyAnchor(reader, {
    objectId: OBJECT_ID,
    roomId: ROOM,
    certifier: CERT_ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('deriveAnchor: capture failed');
  return anchor;
}

/** The `covenant_anchors` ROW a real anchor persists as (what `loadCovenantAnchor` reads back). */
function rowFrom(anchor: CovenantAnchor) {
  return {
    id: 'anchor_row_1',
    roomId: anchor.roomId,
    objectId: anchor.objectId,
    revision: anchor.revision,
    relStart: anchor.relStart,
    relEnd: anchor.relEnd,
    stateVector: anchor.stateVector,
    deleteSet: anchor.deleteSet,
    enclosedItems: anchor.enclosedItems,
    renderedDigest: anchor.renderedDigest,
    certifierKind: anchor.certifier.kind,
    certifierId: anchor.certifier.userId,
    certifiedAt: new Date(anchor.certifiedAt),
    createdAt: new Date(anchor.certifiedAt),
  };
}

/** A minimal `Pick<Database,'select'>` that returns preset rows for the anchor read. */
function stubDb(rows: unknown[]): Pick<Database, 'select'> {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Pick<Database, 'select'>;
}

describe('roomCovenantReads — the server resolves ✓/~ against the authoritative replica (#198)', () => {
  it('a certified UNCHANGED span ⇒ ok (the `✓`), and the client shim + anchorCertifies agree', async () => {
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 }); // 'ship'
    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      [OBJECT_ID],
      NO_LAZY_START,
    );

    expect(reads[OBJECT_ID]).toBe('ok');
    // The shipped client decision: precomputedGlyphResolver → anchorCertifies ⇒ `✓`.
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(true);
  });

  it('an IN-SPAN edit on the authority ⇒ drift (`~`), never a stale `✓`', async () => {
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 });
    // A peer edits the certified sub-range on the authoritative replica AFTER certify.
    replica.conversation.body('m1')?.insert(2, 'X');

    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      [OBJECT_ID],
      NO_LAZY_START,
    );
    expect(reads[OBJECT_ID]).toBe('drift');
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(false); // `~`
  });

  it('NO anchor for the object ⇒ drift (`~`)', async () => {
    seedReplica('ship the migration');
    const reads = await roomCovenantReads(stubDb([]), ROOM, [OBJECT_ID], NO_LAZY_START); // empty ledger read
    expect(reads[OBJECT_ID]).toBe('drift');
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(false);
  });

  it('a FOREIGN-ROOM anchor (right objectId, wrong room) ⇒ drift (`~`), never a foreign-room `✓`', async () => {
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 });
    // The same object id, but the persisted anchor names a DIFFERENT room. The
    // authority's `expectedRoomId = ROOM` must fail it closed rather than paint the
    // wrong room's `✓`. (The `loadCovenantAnchor` room-scoped query is the first
    // guard; `expectedRoomId` is this defence-in-depth second guard.)
    const foreign = rowFrom({ ...anchor, roomId: 'room_somewhere_else' });
    const reads = await roomCovenantReads(stubDb([foreign]), ROOM, [OBJECT_ID], NO_LAZY_START);
    expect(reads[OBJECT_ID]).toBe('drift');
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(false);
  });

  it('an UNREGISTERED room (no live replica) ⇒ drift (`~`), fail-closed', async () => {
    // No replica registered. Even with a valid-looking anchor row, the provider polls
    // null ⇒ the reader resolves nothing ⇒ drift. (Uses a static anchor row.)
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 });
    clearServerReplicas(); // tear the replica down; the row remains readable
    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      [OBJECT_ID],
      NO_LAZY_START,
    );
    expect(reads[OBJECT_ID]).toBe('drift');
  });
});

describe('E3 (#203) — the READ path LAZY-STARTS the replica (authorship survives restart to the glyphs)', () => {
  it('MAJOR-4: with nothing registered (a cold restart), roomCovenantReads acquires the replica, and the certified span resolves ✓ — not `~`', async () => {
    // A cold restart: the registry is empty. If only certify acquired, this read would
    // be `~` until someone certified. The injected acquire is the lazy-start the
    // production default performs against the durable stream — here it registers a
    // caught-up replica so authorship reaches the glyph.
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 });
    clearServerReplicas(); // NOTHING registered — the cold-restart starting point

    let acquired = 0;
    const lazyStart = {
      acquire: async (roomId: string) => {
        acquired += 1;
        expect(roomId).toBe(ROOM);
        // A real acquire catches up from the durable stream to the SAME content; here
        // we re-register the identical replica the anchor was derived from.
        registerServerReplica(ROOM, replica);
        return replica;
      },
    };

    const reads = await roomCovenantReads(stubDb([rowFrom(anchor)]), ROOM, [OBJECT_ID], lazyStart);
    expect(acquired).toBe(1); // the read path acquired, it did not assume a warm replica
    expect(reads[OBJECT_ID]).toBe('ok'); // authorship/content resolved after the restart
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(true);
  });

  it('eviction stays FAIL-CLOSED: an acquire that leaves nothing registered ⇒ every glyph drifts (`~`)', async () => {
    const replica = seedReplica('ship the migration');
    const anchor = deriveAnchor(replica, { start: 0, end: 4 });
    // The replica is idle-evicted; the lazy-start cannot reach the stream (returns
    // null and registers nothing). The reader must poll null and yield `~`.
    clearServerReplicas();
    const reads = await roomCovenantReads(stubDb([rowFrom(anchor)]), ROOM, [OBJECT_ID], {
      acquire: async () => null, // acquire failed / stream unreachable ⇒ nothing registered
    });
    expect(reads[OBJECT_ID]).toBe('drift');
    expect(anchorCertifies(precomputedGlyphResolver(reads), OBJECT_ID)).toBe(false);
  });
});

describe('precomputedGlyphResolver — the client shim the surfaces thread (#198)', () => {
  it('maps a resolved status map into the sync ObjectGlyphResolver: ok ⇒ ✓, else ~', () => {
    const resolver = precomputedGlyphResolver({ a: 'ok', b: 'drift', c: 'unresolved' });
    expect(resolver?.peek('a').covenantStatus).toBe('ok');
    expect(resolver?.peek('b').covenantStatus).toBe('drift');
    expect(resolver?.peek('c').covenantStatus).toBe('unresolved');
    // An object absent from the map fails closed to drift (`~`).
    expect(resolver?.peek('missing').covenantStatus).toBe('drift');

    // The decision the surfaces actually make (anchorCertifies): `✓` only for `ok`.
    expect(anchorCertifies(resolver, 'a')).toBe(true);
    expect(anchorCertifies(resolver, 'b')).toBe(false);
    expect(anchorCertifies(resolver, 'c')).toBe(false);
    expect(anchorCertifies(resolver, 'missing')).toBe(false);
  });

  it('no reads (undefined — a fixture / no live doc) ⇒ no resolver ⇒ every glyph `~` (the base behaviour)', () => {
    const resolver = precomputedGlyphResolver(undefined);
    expect(resolver).toBeUndefined();
    // anchorCertifies with an undefined resolver is exactly base int/phase6: always `~`.
    expect(anchorCertifies(resolver, 'a')).toBe(false);
  });
});
