import 'server-only';
import { listCovenantAnchorObjectIds, loadCovenantAnchor, upsertCovenantStatus } from '@atrium/db';
import { identityGuardedSpanResolver, webCovenantReadAuthority } from './covenant-read';
import { readerForLiveDoc } from './covenant-reader';
import { db } from './db';
import { liveCovenantDoc } from './live-covenant-doc';
import { RoomDriftSweep } from './room-drift-sweep';
import { dbYdocStreamSource, RoomReplicaManager } from './room-replica-manager';
import { serverReplicaFor } from './server-room-replica';

/**
 * THE PROCESS'S ONE room-replica manager (E3, #203). Lazy-starts a room's server-
 * authoritative replica from the durable `ydoc_updates` stream on first need,
 * registers it so `liveCovenantDoc` / `serverReplicaFor` resolve it, catches a warm
 * replica up to the head on every acquire, and idle-evicts it fail-closed.
 *
 * ONE per process — the web process's replica IS its authority (NO RPC). Both the
 * CERTIFY path (`covenant-actions.ts`) and the READ path (`room-covenant-reads.ts`)
 * must acquire through the SAME manager, so the read path's lazy-start and the
 * certify path's freshness gate see one shared registry rather than fighting over
 * `serverReplicaFor`. Held on `globalThis` (a `Symbol.for` key) so Next's hot reload
 * does not orphan a live replica behind a fresh manager.
 */
export function roomReplicaManager(): RoomReplicaManager {
  const key = Symbol.for('atrium.web.room-replica-manager');
  const holder = globalThis as unknown as { [key]?: RoomReplicaManager };
  holder[key] ??= new RoomReplicaManager({
    source: dbYdocStreamSource(db()),
    // E7, #199 Fix 2 — WIRE DETECT LIVE. Each acquired replica gets a drift sweep over
    // its authoritative `Y.Doc`, driving a fail-closed read authority whose `invalidate`
    // fires on every content update. The swept set is the AUTHORITATIVE `covenant_anchors`
    // (Fix 1), never a caller allowlist. The manager starts it on acquire (seeding one
    // `sweepNow`) and stops it — re-fail-closing the authority — on evict (Fix 3).
    sweepFactory: (roomId, replica) => {
      const live = liveCovenantDoc(roomId);
      const reader = readerForLiveDoc(live.provider, undefined, live.options);
      const authority = webCovenantReadAuthority({
        loadAnchor: (objectId) => loadCovenantAnchor(db(), { roomId, objectId }),
        reader,
        expectedRoomId: roomId,
        // F1 (#220 / T6): the sweep's re-verdict serves `✓` ONLY when the displayed body
        // (`body(objectId)`, by `mid`) is the exact `Y.XmlText` the anchor signed — so a
        // `mid` remap between edits drives the sweep to project `drift` (`~`), reaching
        // both browsers over `covenant_status`. Same current-replica source as the reader.
        spanResolver: identityGuardedSpanResolver(
          reader,
          () => serverReplicaFor(roomId)?.conversation ?? null,
        ),
      });
      return new RoomDriftSweep({
        doc: replica.doc,
        authority,
        // AUTHORITATIVE certified set from the ledger, not a caller list (Fix 1).
        loadCertifiedObjectIds: () => listCovenantAnchorObjectIds(db(), { roomId }),
        // PROJECT every recompute to the durable read-only covenant_status table (E6,
        // #206), as the OWNER/server path — a client can never author a verdict
        // (migration 0056 REVOKEs client writes). Fire-and-forget and fail-safe: a
        // persistence error must not break DETECT, so the promise is caught and
        // swallowed (the in-process draft ledger + read-path overlay stay the
        // load-bearing `~`; this table is the durable mirror clients sync).
        onVerdict: (objectId, status, generation) => {
          void upsertCovenantStatus(db(), { roomId, objectId, status, generation }).catch(
            (error) => {
              // Projection write failed (transient DB error, evicted room). The verdict
              // still stands in-process; the next recompute re-upserts it. DO NOT swallow
              // silently: a failed `drift` upsert that is never retried can strand the row
              // at a stale `ok` (the #217 cardinal sin), so log it distinctly — the
              // generation guard makes the eventual re-upsert safe, but the failure must
              // be visible, not invisible.
              console.error(
                `[covenant-status] projection upsert failed room=${roomId} object=${objectId} ` +
                  `status=${status} generation=${generation}:`,
                error,
              );
            },
          );
        },
      });
    },
  });
  return holder[key] as RoomReplicaManager;
}
