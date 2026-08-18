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
  /**
   * The row's IMMUTABLE `stream_seq` (migration 0055) — a per-room, gap-free,
   * strictly-increasing bigint minted at append time. It is the STABLE ROW IDENTITY
   * the replica dedupes and gap-detects on, NEVER the row's position in this
   * snapshot array: a reordered snapshot reuses each row's own seq, so a late/
   * reordered row can never collide with an already-folded row's ordinal (#203).
   *
   * A `bigint` (the column is a Postgres `bigint`), read WITHOUT narrowing to a JS
   * `number`, so a seq above `2^53` carries and compares exactly (#203 hygiene).
   */
  readonly streamSeq: bigint;
}

/**
 * The durable-stream catch-up source — the port `RoomReplicaManager` reads a room's
 * history and head through. In production this is Electric's shape over `ydoc_updates`;
 * {@link dbYdocStreamSource} is the direct-Postgres binding used in-sandbox and in the
 * compose-backed acceptance test, where no Electric service can stand up.
 */
export interface YdocStreamSource {
  /**
   * Every `ydoc_updates` row for the room, IN STREAM ORDER — the catch-up snapshot.
   * Order is by the immutable per-room `stream_seq` (migration 0055); each row
   * carries its own `streamSeq`, so the replica's dedupe/freshness never depend on a
   * row's POSITION in this array (a reordered snapshot is harmless — the fix for the
   * #203 array-index class).
   */
  snapshot(roomId: string): Promise<readonly PersistedYdocUpdate[]>;
  /**
   * The current stream HEAD for the room — the MAXIMUM `stream_seq`, not a row count
   * (0 when the room has no rows). The freshness gate compares a replica's consumed
   * position ({@link ServerRoomReplica.consumedStreamPosition} — the highest
   * CONTIGUOUS seq folded) against this: a replica that has not folded every seq up
   * to the head with no gap has not caught up, and a certify against it is refused
   * (fail-closed). Head-as-max and consumed-as-contiguous-prefix are the pair that
   * makes a skipped-yet-reordered row surface as a lag rather than a false pass.
   *
   * A `bigint` (the column is a Postgres `bigint`), so a head above `2^31` never 500s
   * on an `::int` overflow and one above `2^53` never narrows — the whole freshness
   * comparison is `bigint`-consistent (#203 hygiene).
   */
  head(roomId: string): Promise<bigint>;
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
export function writerFromRow(
  row: Pick<PersistedYdocUpdate, 'writerUserId' | 'writerKind'>,
): WriterIdentity | null {
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
          // Read the bigint seq as TEXT and parse to `bigint` — bypassing drizzle's
          // `mode: 'number'` mapper — so a seq above `2^53` is never narrowed (#203).
          streamSeq: sql<string>`${ydocUpdates.streamSeq}::text`,
        })
        .from(ydocUpdates)
        .where(eq(ydocUpdates.room, roomId))
        // The stream order is the immutable per-room stream_seq (migration 0055);
        // the fold and the dedupe key on the row's own seq, not this array index.
        .orderBy(asc(ydocUpdates.streamSeq));
      return rows.map((r) => ({
        // Postgres `bytea` arrives as a Node Buffer; Yjs needs a plain Uint8Array.
        op: Uint8Array.from(r.op as Uint8Array),
        writerUserId: r.writerUserId,
        writerKind: r.writerKind,
        streamSeq: BigInt(r.streamSeq),
      }));
    },
    async head(roomId: string): Promise<bigint> {
      // The head is the MAXIMUM stream_seq, not a row count — the value the
      // replica's highest-contiguous-seq position is compared against (#203). 0 for
      // an empty room (coalesce), so an empty stream's gate is 0 >= 0. Cast to TEXT,
      // NOT `::int`: `::int` would 500 (`integer out of range`) once the head passes
      // `2^31`; reading the bigint as text and parsing to `bigint` compares exactly at
      // any head (#203 hygiene).
      const [row] = await db
        .select({ head: sql<string>`coalesce(max(${ydocUpdates.streamSeq}), 0)::text` })
        .from(ydocUpdates)
        .where(eq(ydocUpdates.room, roomId));
      return BigInt(row?.head ?? '0');
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
   * immutable `stream_seq`, so already-consumed rows are no-ops and only genuinely-new rows
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
    let rows: readonly PersistedYdocUpdate[];
    try {
      rows = await this.source.snapshot(roomId);
    } catch {
      // Stream unreachable. Re-read the registry AFTER the await (single-flight, see
      // below): a warm replica is kept as-is (the gate still guards staleness); a
      // cold acquire (nothing usable held) registers nothing and fails closed.
      const held = this.entries.get(roomId);
      const warm =
        held !== undefined &&
        serverReplicaFor(roomId) === held.replica &&
        !held.replica.conversation.isDestroyed();
      if (warm && held !== undefined) {
        held.lastUsedAt = this.now();
        return held.replica;
      }
      if (held !== undefined) this.dispose(roomId, held);
      return null;
    }

    // SINGLE-FLIGHT (E3, #203 hardening). Decide warm-vs-cold from the registry as
    // it stands AFTER the await, not from a snapshot taken before it. The whole
    // block below is synchronous (no `await`), so two concurrent cold acquires
    // cannot interleave here: whichever resumes first creates + registers the one
    // replica, and the other re-reads the registry and REUSES it instead of
    // registering a second — which the old (pre-await) check leaked as an orphan
    // (registered, then overwritten last-wins, never disposed).
    const held = this.entries.get(roomId);
    const warm =
      held !== undefined &&
      serverReplicaFor(roomId) === held.replica &&
      !held.replica.conversation.isDestroyed();

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
    // IMMUTABLE `stream_seq` is its stream ordinal: dedupe key (a re-consumed or
    // reordered row is a no-op / lands on its own seq) and the ledger's overlap
    // tiebreak. A poison row is caught and skipped (fail-closed).
    for (const row of rows) {
      try {
        replica.catchUp(row.op, writerFromRow(row), row.streamSeq);
      } catch {
        // Garbage bytes for this row: quarantine it. Its seq stays a gap, so the
        // replica trails the head and certify refuses cleanly rather than 500ing.
      }
    }
    return replica;
  }

  /** The current durable-stream head position for the room (for the freshness gate). */
  streamHead(roomId: string): Promise<bigint> {
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
