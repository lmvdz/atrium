import 'server-only';
import type { CovenantReadStatus } from '@atrium/core';
import { type Database, loadCovenantAnchor } from '@atrium/db';
import { identityGuardedSpanResolver, webCovenantReadAuthority } from './covenant-read';
import { readerForLiveDoc } from './covenant-reader';
import { liveCovenantDoc } from './live-covenant-doc';
import { roomReplicaManager } from './room-replica-singleton';
import { serverReplicaFor } from './server-room-replica';

/**
 * RESOLVE A ROOM'S OBJECT `✓`/`~` GLYPHS — the server side of the display-glyph
 * wiring (#198, P6F-4). This is where the certified-content check that SL-6 routed
 * every reader through (`anchorCertifies` → the read authority) is actually DRIVEN:
 * it builds the ONE fail-closed {@link webCovenantReadAuthority} for the room and
 * resolves each object's covenant status against the live document, returning a plain
 * `{ objectId → status }` map the client surfaces read through
 * {@link import('./covenant-read').precomputedGlyphResolver}.
 *
 * ## Why this runs on the SERVER, not in the surface
 *
 * The display surfaces (`LiveRoomSession`, `ReplaySession`) are client components,
 * but the document the covenant resolves against is NOT the browser's copy. P6F-2
 * (#196) made the room's authoritative `Y.Doc` a SERVER-side replica precisely
 * because "a CRDT cannot securely authenticate WHO authored content" — a peer can
 * drift its own local doc, so resolving `✓` against client bytes would reintroduce
 * the exact authorship-blindness P6F-2 closed. The authority therefore resolves
 * against the server-authoritative replica (`liveCovenantDoc`) HERE, and only the
 * definitive verdicts cross to the client. The reader/anchor handles (a live `Y.Doc`
 * and DB access) are not serializable across the RSC boundary anyway; the STATUS is.
 *
 * The three ports are the real ones:
 *   - `loadAnchor` — the room-scoped `covenant_anchors` read ({@link loadCovenantAnchor}).
 *   - `reader`     — {@link readerForLiveDoc} over the room's current server replica,
 *                    watching the `conversation-content` share (`liveCovenantDoc.options`).
 *   - `expectedRoomId` — the room binding, so a foreign-room anchor fails closed.
 *
 * LAZY-STARTS THE REPLICA (E3, #203). The read path — not only certify — acquires
 * the room's server replica before resolving, so authorship SURVIVES A RESTART all
 * the way to the glyphs: after a cold restart nothing is registered, and if only the
 * certify path acquired, every object would read `~` until someone certified. The
 * acquire catches the replica up from the durable stream (idempotently — a warm one
 * is reused), so the reader resolves against caught-up content. Eviction stays
 * FAIL-CLOSED: an acquire that returns `null` (stream unreachable) leaves the
 * provider polling `null`, and the reader yields `~`. Injectable (`acquire`) so a
 * unit test can drive the fail-closed branches without a durable stream; production
 * defaults to the process's one {@link roomReplicaManager}.
 *
 * FAIL-CLOSED throughout: no replica registered (torn down / never joined / a lazy-
 * start that could not reach the stream) ⇒ the provider polls `null` ⇒ the reader
 * resolves nothing ⇒ `drift` (`~`); no anchor ⇒ `drift` (`~`); a drifted span ⇒
 * `drift` (`~`). Only a live span byte-identical to its anchor resolves `ok` (`✓`).
 * Each call `resolve()`s fresh, so a subsequent server render (the live route's
 * `router.refresh()` on drift/projection change) re-resolves the current verdict —
 * the staleness bound without a client doc.
 */
export async function roomCovenantReads(
  db: Pick<Database, 'select'>,
  roomId: string,
  objectIds: readonly string[],
  options?: {
    /**
     * Lazy-start the room's replica before resolving. Defaults to the process's one
     * {@link roomReplicaManager}'s `acquire`; a test injects a fake to drive the
     * fail-closed branches (or a manager over its own durable stream) without the
     * production singleton's real-Postgres source.
     */
    readonly acquire?: (roomId: string) => Promise<unknown>;
    /**
     * The object ids the room's LIVE drift sweep currently reads as `~` (E7, #199
     * Fix 2). Defaults to the process singleton's `staleObjectIdsFor`; a test injects
     * a fake. Consuming it is what makes the live sweep's push-based DETECT reach the
     * glyphs, not only the pull-based re-resolve below — a span the sweep marks `~` is
     * FORCED `~` here (fail-closed: it can only ever demote an `ok`, never mint one).
     */
    readonly staleObjectIds?: (roomId: string) => ReadonlySet<string> | undefined;
    /**
     * The certified objects the room's live sweep has confirmed SWEPT-CLEAN (E7, #199
     * Fix 3). Defaults to the process singleton's `sweptObjectIdsFor`; a test injects a
     * fake. This is what makes the overlay FAIL-CLOSED until the sweep has spoken: a fresh
     * `resolve()` that concludes `ok` is served `ok` ONLY if the sweep has positively
     * swept the object clean; a certified object with no settled sweep verdict yet (a
     * freshly-certified anchor, or one an edit re-opened before its re-resolve settled) is
     * NOT in this set, so its `ok` is WITHHELD and it reads `~`. Demote-only: the overlay
     * never mints an `ok` the resolve did not produce — it only withholds one until swept.
     * When `undefined` (no sweep/manager) the overlay does not withhold: the fresh
     * re-resolve, itself fail-closed, is the sole verdict (matching the no-overlay case).
     */
    readonly sweptObjectIds?: (roomId: string) => ReadonlySet<string> | undefined;
  },
): Promise<Record<string, CovenantReadStatus>> {
  if (objectIds.length === 0) return {};
  // Lazy-start (or catch up) the room's replica so a read after a restart resolves
  // authorship, not `~`. Fail-closed: any failure here leaves the provider `null`.
  const acquire = options?.acquire ?? ((id: string) => roomReplicaManager().acquire(id));
  await acquire(roomId);
  // The live sweep's current `~` drafts — consumed as a fail-closed overlay below.
  // The default reads the process singleton; a test injects its own. Guarded: if no
  // sweep/manager is available (a test that stubs `acquire` but not this), fall back to
  // `undefined` (no overlay) rather than throwing — the fresh re-resolve is itself
  // fail-closed, so the overlay is additive, never load-bearing for a `~`.
  const staleObjectIds =
    options?.staleObjectIds ??
    ((id: string): ReadonlySet<string> | undefined => {
      try {
        return roomReplicaManager().staleObjectIdsFor(id);
      } catch {
        return undefined;
      }
    });
  // The live sweep's SWEPT-CLEAN set (E7, #199 Fix 3) — the overlay withholds `ok` for a
  // certified object not yet confirmed clean by the sweep (fail-closed until it speaks).
  const sweptObjectIds =
    options?.sweptObjectIds ??
    ((id: string): ReadonlySet<string> | undefined => {
      try {
        return roomReplicaManager().sweptObjectIdsFor(id);
      } catch {
        return undefined;
      }
    });
  const stale = staleObjectIds(roomId);
  const sweptClean = sweptObjectIds(roomId);
  const live = liveCovenantDoc(roomId);
  const reader = readerForLiveDoc(live.provider, undefined, live.options);
  const authority = webCovenantReadAuthority({
    loadAnchor: (objectId) => loadCovenantAnchor(db, { roomId, objectId }),
    reader,
    expectedRoomId: roomId,
    // F1 (#220 / T6): serve `✓` ONLY when the displayed body (`body(objectId)`, by
    // `mid`) is the exact `Y.XmlText` the anchor signed (frozen relative positions).
    // Re-reads the current replica per resolve; a divergence (a `mid` remap) or an
    // evicted replica fails closed to drift (`~`), never a `✓` over unsigned content.
    spanResolver: identityGuardedSpanResolver(
      reader,
      () => serverReplicaFor(roomId)?.conversation ?? null,
    ),
  });
  // De-dupe object ids so one object resolves once; the authority also dedupes
  // concurrent resolves of the same id, but the caller's list may repeat.
  const unique = [...new Set(objectIds)];
  const resolved = await Promise.all(
    unique.map(async (objectId) => {
      const { covenantStatus } = await authority.resolve(objectId);
      // OVERLAY the live sweep, fail-closed and DEMOTE-ONLY (E7, #199 Fix 2 + Fix 3):
      //   1. an object the sweep has marked `~` is `~` regardless of this fresh resolve —
      //      the sweep's push-based DETECT is authoritative for a `~` (Fix 2);
      //   2. a fresh `ok` is served ONLY if the sweep has positively swept the object
      //      clean; a certified object with no settled sweep verdict yet (a freshly-
      //      certified anchor, or one an edit re-opened before its re-resolve settled) is
      //      WITHHELD to `~` (Fix 3) — fail-closed until the sweep speaks.
      // Both directions only ever demote an `ok` to `~`; the overlay never mints an `ok`.
      // When the swept-clean signal is absent (no sweep/manager), it does not withhold —
      // the fresh re-resolve, itself fail-closed, stands alone.
      let status: CovenantReadStatus = covenantStatus;
      if (stale?.has(objectId)) {
        status = 'drift';
      } else if (covenantStatus === 'ok' && sweptClean !== undefined && !sweptClean.has(objectId)) {
        status = 'drift'; // certified but not-yet-swept-clean ⇒ withhold `ok`, fail-closed
      }
      return [objectId, status] as const;
    }),
  );
  return Object.fromEntries(resolved);
}
