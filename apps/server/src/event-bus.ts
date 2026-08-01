import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Tx } from './ledger.js';
import type { Logger } from './logger.js';

/**
 * Cross-instance fan-out, on Postgres `LISTEN`/`NOTIFY`.
 *
 * ## Why this exists (#22 gauntlet r1, the blocking finding)
 *
 * Round 1's hub was in-process, and the argument for that was "a subscriber
 * that misses a broadcast reconnects and asks `since(room, room_seq)`". Codex
 * took the argument apart in one sentence: **delivery is process-local while
 * the recovery claim is durable.** A client connected to instance 1 is never
 * told that instance 2 committed anything — no live frame, no gap to notice, no
 * reason to ask. It sits at its cursor while the room moves on, indefinitely,
 * and no amount of correctness inside `since()` helps a client that never calls
 * it.
 *
 * So commits are announced, and every instance listens. A notification is a
 * *doorbell*, not a payload: it carries the position that landed and who landed
 * it, and the receiving instance reads the rows out of the ledger itself. That
 * matters three times over — the 8000-byte NOTIFY limit an event body would
 * eventually exceed; the fact that the receiver has to fold those rows into its
 * own `CoreState` anyway, which means reading them; and because a payload
 * relayed through a side channel is a second copy of history, free to disagree
 * with the first.
 *
 * ## Why not Redis
 *
 * init.md forbids it — "Postgres for everything, including the job queue".
 * `LISTEN`/`NOTIFY` costs one connection per instance and no new dependency.
 *
 * ## What a notification does not promise
 *
 * Delivery is best-effort. A listener that is disconnected when the NOTIFY
 * fires never sees it. That is survivable *here and nowhere else*: the ledger
 * is still the durable record, an instance re-reads from its own `lastSeq` when
 * it next syncs, and a client's catch-up loop closes the rest. Nothing in this
 * file may ever become the only path by which a fact arrives.
 */

/** The channel a committed ledger position is announced on. */
export const LEDGER_CHANNEL = 'atrium_ledger';
/** The channel presence and typing — never durable — are relayed on. */
export const EPHEMERAL_CHANNEL = 'atrium_ephemeral';

/** "Something landed at this position." The rows come from the ledger. */
export interface LedgerAnnouncement {
  /** The instance that appended. Its own subscribers already have the frame. */
  origin: string;
  roomId: string;
  seq: number;
  roomSeq: number;
}

/** A frame that is not history, and so has no ledger to be read back from. */
export interface EphemeralAnnouncement<T = unknown> {
  origin: string;
  roomId: string;
  frame: T;
}

export interface EventBusOptions {
  /** The raw postgres-js client. Drizzle cannot express `LISTEN`. */
  sql: postgres.Sql;
  logger: Logger;
  /** Overridable so a test can run two "instances" against one database. */
  instanceId?: string;
}

export interface EventBus {
  /** This process's identity, so it can ignore the echo of its own commits. */
  readonly instanceId: string;
  /**
   * Announce a commit **from inside the append transaction**. Postgres holds
   * notifications until commit and drops them on rollback, so an announcement
   * can neither precede nor outlive the row it is about. Announcing after the
   * transaction returned would open a window in which a peer reads the ledger
   * before the row is visible and concludes there is nothing there.
   */
  announce: (tx: Tx, note: Omit<LedgerAnnouncement, 'origin'>) => Promise<void>;
  /** Relay one ephemeral frame. Fire-and-forget: failure is logged, not thrown. */
  relay: <T>(roomId: string, frame: T) => void;
  start: (handlers: {
    onLedger: (note: LedgerAnnouncement) => void;
    onEphemeral: (note: EphemeralAnnouncement) => void;
  }) => Promise<void>;
  close: () => Promise<void>;
}

export function createEventBus({ sql: client, logger, instanceId }: EventBusOptions): EventBus {
  const id = instanceId ?? randomUUID();
  const unlisteners: Array<() => Promise<void>> = [];

  function parse<T>(raw: string, channel: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A malformed notification is someone else's bug on a channel we do not
      // own exclusively. Log it and carry on; the ledger is still the truth.
      logger.warn('unparseable notification', { channel, raw: raw.slice(0, 200) });
      return null;
    }
  }

  return {
    instanceId: id,

    announce: async (tx, note) => {
      const payload = JSON.stringify({ origin: id, ...note } satisfies LedgerAnnouncement);
      // `pg_notify(channel, payload)` rather than `NOTIFY channel, 'payload'`:
      // the function form takes both as bound parameters, where the statement
      // form needs the channel as an identifier and the payload as a literal —
      // which is string concatenation into SQL, in the one place that receives
      // a room id off the wire.
      await tx.execute(sql`SELECT pg_notify(${LEDGER_CHANNEL}, ${payload})`);
    },

    relay: (roomId, frame) => {
      const payload = JSON.stringify({ origin: id, roomId, frame });
      // Not awaited: an ephemeral frame that arrives late is worthless, and a
      // presence update must never hold up the socket that produced it.
      void client.notify(EPHEMERAL_CHANNEL, payload).catch((error: unknown) => {
        logger.warn('ephemeral relay failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },

    start: async ({ onLedger, onEphemeral }) => {
      const ledger = await client.listen(LEDGER_CHANNEL, (raw) => {
        const note = parse<LedgerAnnouncement>(raw, LEDGER_CHANNEL);
        if (note && note.origin !== id) onLedger(note);
      });
      unlisteners.push(() => ledger.unlisten());

      const ephemeral = await client.listen(EPHEMERAL_CHANNEL, (raw) => {
        const note = parse<EphemeralAnnouncement>(raw, EPHEMERAL_CHANNEL);
        if (note && note.origin !== id) onEphemeral(note);
      });
      unlisteners.push(() => ephemeral.unlisten());

      logger.info('event bus listening', {
        instanceId: id,
        channels: [LEDGER_CHANNEL, EPHEMERAL_CHANNEL],
      });
    },

    close: async () => {
      for (const unlisten of unlisteners.splice(0)) {
        await unlisten().catch(() => undefined);
      }
    },
  };
}
