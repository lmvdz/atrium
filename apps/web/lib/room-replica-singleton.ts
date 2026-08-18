import 'server-only';
import { db } from './db';
import { dbYdocStreamSource, RoomReplicaManager } from './room-replica-manager';

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
  holder[key] ??= new RoomReplicaManager({ source: dbYdocStreamSource(db()) });
  return holder[key] as RoomReplicaManager;
}
