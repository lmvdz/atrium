import 'server-only';
import { type Database, ydocUpdates } from '@atrium/db';
import { asc, eq, sql } from 'drizzle-orm';
import {
  registerServerReplica,
  ServerRoomReplica,
  serverReplicaFor,
  unregisterServerReplica,
  type WriterIdentity,
} from './server-room-replica';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ROOM-REPLICA LIFECYCLE (E3, #203) — lazy-start, idle-evict, re-register.
 *
 * `ServerRoomReplica` is the authority; this is who OWNS one per room and decides
 * when it exists. It dissolves the two lifecycle gaps the replica's header used to
 * name:
 *
 *   - LAZY-START. A replica is expensive (a caught-up `Y.Doc`), so one is built on
 *     FIRST NEED — the certify path or the read path asks {@link RoomReplicaManager.acquire}
 *     for a room and gets a replica caught up from the durable stream, registered so
 *     `liveCovenantDoc(roomId)` / `serverReplicaFor(roomId)` resolve it.
 *   - IDLE-EVICT, FAIL-CLOSED. A replica unused past {@link RoomReplicaManagerOptions.idleMs}
 *     is dropped ({@link RoomReplicaManager.sweepIdle}) — destroyed and UNREGISTERED, so
 *     `serverReplicaFor` returns `null` and the reader yields `~`. Eviction never
 *     leaves a stale/guessed `✓` behind: a torn-down replica is a `null` provider, not
 *     a warm one serving old bytes.
 *
 * ## NO RPC — the web process's replica IS its authority (topology gap #4)
 *
 * The catch-up SOURCE is the room's durable `ydoc_updates` rows (E1 #201 / E2 #202),
 * read directly — a snapshot of the room's stream in append order, exactly the rows
 * the Electric shape carries. The web process folds them into its OWN replica and
 * reads its OWN authority; nothing reaches across to a ws-server process. Two web
 * processes each catch up independently from the SAME durable stream and converge to
 * identical content — no shared replica, no broker, no RPC.
 *
 * ## Authorship survives a cold restart — via DATA (gap #3, load-bearing)
 *
 * Each row carries E2's persisted `writer_user_id`/`writer_kind` stamp. {@link
 * ServerRoomReplica.catchUp} replays that stamp into the ledger, range-exact, as it
 * folds the row — so a replica rebuilt AFTER A RESTART attributes content to the
 * ORIGINAL writers, from the rows, never from process memory that is gone. A `system`
 * row (no authenticated author) folds content without authorship — fail-closed to
 * unknown, exactly as an un-replayed catch-up always did.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * One durable-stream row as the manager consumes it: the opaque Yjs `op` bytes plus
 * E2's persisted authorship stamp (migration 0054). `writerUserId` is `null` iff
 * `writerKind === 'system'` (the DB's own consistency check), which the manager maps
 * to an UNATTRIBUTED catch-up.
 */
export interface PersistedYdocUpdate {
  readonly op: Uint8Array;
  readonly writerUserId: string | null;
  readonly writerKind: 'human' | 'agent' | 'system';
}

/**
 * The durable-stream catch-up source — the port `RoomReplicaManager` reads a room's
 * history and head through. In production this is Electric's shape over `ydoc_updates`;
 * {@link dbYdocStreamSource} is the direct-Postgres binding used in-sandbox and in the
 * compose-backed acceptance test, where no Electric service can stand up.
 */
export interface YdocStreamSource {
  /**
   * Every `ydoc_updates` row for the room, IN STREAM (append) ORDER — the catch-up
   * snapshot. Order is the total order `(appended_at, id)`; a stable order is what
   * makes two independently-catching-up replicas converge and makes the stream
   * position below meaningful.
   */
  snapshot(roomId: string): Promise<readonly PersistedYdocUpdate[]>;
  /**
   * The current stream HEAD position for the room — the count of durable rows. The
   * freshness gate compares a replica's consumed position ({@link
   * ServerRoomReplica.consumedStreamPosition}) against this: a replica that trails
   * the head has not caught up, and a certify against it is refused (fail-closed).
   */
  head(roomId: string): Promise<number>;
}

/**
 * The authenticated writer a persisted row attributes to, or `null` for a `system`
 * row (no authenticated author ⇒ unattributed catch-up, fail-closed to unknown). The
 * kind is the row's persisted `writer_kind` — E2 looked it up from the actor's
 * immutable `users.principal_kind`, so an agent that claimed human is stamped `agent`
 * here too. A malformed row (a named user with a `system` kind, or an authored kind
 * with no user — both refused by the DB's consistency check) is treated as
 * unattributed rather than trusted.
 */
export function writerFromRow(row: PersistedYdocUpdate): WriterIdentity | null {
  if (row.writerKind === 'system') return null;
  if (row.writerUserId === null) return null; // inconsistent stamp ⇒ fail-closed
  return { userId: row.writerUserId, principalKind: row.writerKind };
}

/** A direct-Postgres {@link YdocStreamSource} over the room's `ydoc_updates` rows. */
export function dbYdocStreamSource(db: Pick<Database, 'select'>): YdocStreamSource {
  return {
    async snapshot(roomId: string): Promise<readonly PersistedYdocUpdate[]> {
      const rows = await db
        .select({
          op: ydocUpdates.op,
          writerUserId: ydocUpdates.writerUserId,
          writerKind: ydocUpdates.writerKind,
        })
        .from(ydocUpdates)
        .where(eq(ydocUpdates.room, roomId))
        // The total stream order: append time, id breaking any same-instant tie.
        .orderBy(asc(ydocUpdates.appendedAt), asc(ydocUpdates.id));
      return rows.map((r) => ({
        // Postgres `bytea` arrives as a Node Buffer; Yjs needs a plain Uint8Array.
        op: Uint8Array.from(r.op as Uint8Array),
        writerUserId: r.writerUserId,
        writerKind: r.writerKind,
      }));
    },
    async head(roomId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(ydocUpdates)
        .where(eq(ydocUpdates.room, roomId));
      return Number(row?.count ?? 0);
    },
  };
}

export interface RoomReplicaManagerOptions {
  /** The durable-stream catch-up source (Electric shape in prod, {@link dbYdocStreamSource} here). */
  readonly source: YdocStreamSource;
  /**
   * Evict a replica unused for at least this long ({@link RoomReplicaManager.sweepIdle}).
   * Defaults to five minutes. A replica is cheap to rebuild (a fresh catch-up), so idle
   * memory is not worth holding; correctness does not depend on the value — a wrongly
   * evicted replica lazy-starts again on the next `acquire`.
   */
  readonly idleMs?: number;
  /** Clock seam, for deterministic idle-eviction tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Entry {
  readonly replica: ServerRoomReplica;
  lastUsedAt: number;
}

/**
 * Owns one {@link ServerRoomReplica} per room: lazy-starts it from the durable stream,
 * keeps it registered for the certify/read paths, and idle-evicts it fail-closed.
 */
export class RoomReplicaManager {
  private readonly entries = new Map<string, Entry>();
  private readonly source: YdocStreamSource;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: RoomReplicaManagerOptions) {
    this.source = options.source;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * The room's replica, caught up to the current durable-stream head. A warm replica
   * this manager already holds is REUSED (same object) and CAUGHT UP to the head
   * before it is returned; otherwise one is lazy-started from the stream. Registers
   * it so `liveCovenantDoc` / `serverReplicaFor` resolve it, and marks it used
   * (resetting the idle timer).
   *
   * WHY A WARM REPLICA RE-CATCHES-UP ON EVERY ACQUIRE (E3, #203 blocker). Without a
   * live Electric subscription (the eventual E-infra shape), a warm replica does not
   * see rows appended since it warmed — so a reused replica would trail the head
   * forever and the freshness gate would refuse `replica_lagging` permanently
   * (certify → append → certify again → never mints). Re-folding the durable snapshot
   * on acquire fixes that: {@link ServerRoomReplica.catchUp} dedupes by each row's
   * stream ordinal, so already-consumed rows are no-ops and only genuinely-new rows
   * advance the replica. It converges to head from the SAME durable stream — no RPC.
   *
   * FAIL-CLOSED, twice:
   *   - If the catch-up SOURCE throws (the stream is unreachable), a COLD acquire
   *     registers nothing and returns `null`; a WARM one keeps the replica it already
   *     had (the freshness gate still refuses if that replica trails the head), rather
   *     than tearing down a working replica over a transient read failure.
   *   - A POISON ROW (garbage bytes PUT through the E2 door: `parseUpdateMeta` /
   *     `applyUpdate` throws) is caught PER ROW and skipped — it never crashes acquire
   *     and never 500s certify for the whole room. A skipped row is not counted, so the
   *     replica stays below the head and certify cleanly refuses `replica_lagging`.
   */
  async acquire(roomId: string): Promise<ServerRoomReplica | null> {
    const held = this.entries.get(roomId);
    const warm =
      held !== undefined &&
      serverReplicaFor(roomId) === held.replica &&
      !held.replica.conversation.isDestroyed();

    let rows: readonly PersistedYdocUpdate[];
    try {
      rows = await this.source.snapshot(roomId);
    } catch {
      // Stream unreachable. A warm replica is kept as-is (gate guards staleness); a
      // cold acquire (nothing usable held) registers nothing and fails closed.
      if (warm && held !== undefined) {
        held.lastUsedAt = this.now();
        return held.replica;
      }
      if (held !== undefined) this.dispose(roomId, held);
      return null;
    }

    let replica: ServerRoomReplica;
    if (warm && held !== undefined) {
      replica = held.replica; // reuse the SAME object; catch it up below
      held.lastUsedAt = this.now();
    } else {
      if (held !== undefined) this.dispose(roomId, held); // stale entry ⇒ rebuild
      replica = new ServerRoomReplica();
      registerServerReplica(roomId, replica);
      this.entries.set(roomId, { replica, lastUsedAt: this.now() });
    }

    // Replay each row in stream order, folding content AND its persisted authorship
    // stamp (range-exact) — so authorship survives a cold restart via data. The row's
    // INDEX is its stream ordinal: dedupe key (a re-consumed row is a no-op) and the
    // ledger's overlap tiebreak. A poison row is caught and skipped (fail-closed).
    for (let position = 0; position < rows.length; position += 1) {
      const row = rows[position] as PersistedYdocUpdate;
      try {
        replica.catchUp(row.op, writerFromRow(row), position);
      } catch {
        // Garbage bytes for this row: quarantine it. It stays unconsumed, so the
        // replica trails the head and certify refuses cleanly rather than 500ing.
      }
    }
    return replica;
  }

  /** The current durable-stream head position for the room (for the freshness gate). */
  streamHead(roomId: string): Promise<number> {
    return this.source.head(roomId);
  }

  /**
   * Evict the room's replica NOW — destroy it and unregister it, so `serverReplicaFor`
   * returns `null` (fail-closed). A no-op if this manager holds none for the room. Only
   * touches the registry when the registered replica is still the one we own, so an
   * eviction never yanks a replica another owner registered in the meantime.
   */
  evict(roomId: string): void {
    const held = this.entries.get(roomId);
    if (held === undefined) return;
    this.dispose(roomId, held);
  }

  /**
   * Evict every replica idle for at least {@link RoomReplicaManagerOptions.idleMs}.
   * Intended to run on a timer; correctness does not depend on it firing (an evicted
   * replica lazy-starts again), only memory does.
   */
  sweepIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [roomId, entry] of [...this.entries]) {
      if (entry.lastUsedAt <= cutoff) this.dispose(roomId, entry);
    }
  }

  /** Drop every replica this manager owns — test isolation and process shutdown. */
  evictAll(): void {
    for (const [roomId, entry] of [...this.entries]) this.dispose(roomId, entry);
  }

  private dispose(roomId: string, entry: Entry): void {
    this.entries.delete(roomId);
    // Only unregister if we are still the registered authority — never yank someone
    // else's replica. Destroy ours regardless so its doc is freed.
    if (serverReplicaFor(roomId) === entry.replica) unregisterServerReplica(roomId);
    entry.replica.destroy();
  }
}
