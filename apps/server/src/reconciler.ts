import type { Ledger, LedgerEntry } from './ledger.js';
import type { Logger } from './logger.js';

/**
 * The delivery path that does not depend on a notification arriving.
 *
 * ## The finding this answers (#22 gauntlet r2 delta, blocking 1)
 *
 * > `LISTEN/NOTIFY` is consumed only at startup: no periodic `ledger.sync()`,
 * > no listener-loss callback, no post-resubscribe reconciliation. NOTIFY is
 * > at-most-once and is lost on listener disconnect or transaction rollback, so
 * > if instance A misses B's notification, A never broadcasts those durable rows
 * > and its clients have no gap signal to trigger `since`.
 *
 * The shape of the bug matters more than the mechanism. Round 2 was careful to
 * say that a notification is a doorbell rather than a payload — but a doorbell
 * that is rung once and never rung again is not an optimization on top of a
 * durable path, it *is* the path, and it is an at-most-once one. A subscriber on
 * the deaf instance never sees the events, never sees a gap, and therefore never
 * asks: there is no client-side recovery for a hole the client cannot detect.
 *
 * ## What this does about it
 *
 * Two loops, both cheap, both bounded, both indifferent to whether any
 * notification was ever delivered.
 *
 * 1. **Fold and fan out.** `ledger.sync()` reads strictly past this instance's
 *    `lastSeq`, folds whatever is there and returns it. Normally that is one
 *    indexed query returning zero rows. When it returns rows, they are broadcast
 *    to this instance's subscribers exactly as a doorbell-triggered sync would
 *    have broadcast them — the two share one code path, so there is no
 *    "reconciliation delivery" that could behave differently from live delivery.
 *
 * 2. **Tell each subscribed room its head.** For every room that has at least
 *    one subscriber, one `GROUP BY` gives every head in a single query, and any
 *    room whose head this instance has not yet announced gets a `head` frame.
 *    This is the belt to the first loop's braces, and it covers a different
 *    failure: a row this instance folded and broadcast, whose *frame* was lost
 *    on the way to one particular socket. `sync` cannot help there — it has
 *    already folded the row — but a client told "the room is at 40" while its
 *    own cursor says 37 asks for the gap on its own.
 *
 * Both run on the same timer, and both run immediately whenever the listener
 * (re)subscribes — see `BusHandlers.onListen`. Between them, a lost doorbell
 * costs at most one interval of latency and never a delivery.
 *
 * ## Why a timer rather than something cleverer
 *
 * Because the expensive alternatives buy nothing here. A room is a handful of
 * events a minute (init.md), the sync query is a primary-key range scan that
 * usually returns nothing, and the head query is one aggregate over an index
 * that already exists for `since`. Polling is the boring answer and the boring
 * answer is the one whose failure modes are all visible.
 */

export interface ReconcilerOptions {
  ledger: Pick<Ledger, 'sync' | 'heads'>;
  logger: Logger;
  /** How often to reconcile. */
  intervalMs: number;
  /** Rooms with at least one local subscriber — the only ones worth a head read. */
  subscribedRooms: () => readonly string[];
  /** Fan out rows this instance had not folded yet. */
  onEntries: (entries: LedgerEntry[]) => void;
  /** Tell a room's subscribers where the room actually is. */
  onHead: (roomId: string, head: number) => void;
}

export interface Reconciler {
  /** Run one pass now. Safe to call concurrently; overlapping passes coalesce. */
  reconcile: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

/**
 * How often the reconciler runs when nothing asks it to.
 *
 * Two seconds is chosen against the failure it covers rather than against a
 * throughput target: it is the worst-case extra latency for a client on an
 * instance whose doorbell was lost, and it is short enough that a person does
 * not experience it as the room being broken. Every pass is one range scan that
 * returns nothing plus one aggregate over the subscribed rooms, so the cost of
 * being wrong about this number is small in both directions.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;

export function createReconciler(options: ReconcilerOptions): Reconciler {
  const { ledger, logger, intervalMs, subscribedRooms, onEntries, onHead } = options;
  /** The head this instance has already told each room's subscribers about. */
  const announcedHeads = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The pass in flight, if any.
   *
   * Reconciliation is triggered from three places — the timer, the doorbell, and
   * a listener resubscribe — and they can coincide. Overlapping passes would be
   * harmless (`sync` is idempotent by construction) but they would queue on the
   * ledger's in-process mutex behind each other for no benefit, so a caller that
   * arrives mid-pass waits for the one already running instead of starting a
   * second.
   */
  let inFlight: Promise<void> | null = null;

  async function pass(): Promise<void> {
    const folded = await ledger.sync();
    if (folded.length > 0) {
      onEntries(folded);
      // A row this instance just folded is a row its subscribers have now been
      // sent, so its head is announced by construction.
      for (const entry of folded) {
        announcedHeads.set(entry.roomId, Math.max(announcedHeads.get(entry.roomId) ?? 0, entry.roomSeq));
      }
    }

    const rooms = subscribedRooms();
    if (rooms.length === 0) return;
    const heads = await ledger.heads(rooms);
    for (const roomId of rooms) {
      const head = heads.get(roomId) ?? 0;
      if (head === 0) continue;
      // Only when it moved. A `head` frame per room per tick would be a
      // heartbeat nobody asked for, and would train clients to ignore it.
      if ((announcedHeads.get(roomId) ?? 0) >= head) continue;
      announcedHeads.set(roomId, head);
      onHead(roomId, head);
    }
  }

  async function reconcile(): Promise<void> {
    if (inFlight) return inFlight;
    const run = pass()
      .catch((error: unknown) => {
        // Not fatal, and deliberately loud. The rows are durable, the next pass
        // will find them, and a client that noticed a gap asks for it — but a
        // *persistent* failure here means this instance has stopped delivering
        // anything a peer wrote, which is the divergence in slow motion.
        logger.error('ledger reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  }

  return {
    reconcile,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void reconcile();
      }, intervalMs);
      // The process must be allowed to exit while this is pending; a
      // reconciliation is never worth holding a shutdown open for.
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
