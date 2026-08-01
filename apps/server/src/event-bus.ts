import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
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
 * ## A doorbell nobody answers (#22 gauntlet r2 delta, blocking 1)
 *
 * Round 2 rang the bell from the application, and consumed it exactly once at
 * startup: no periodic reconciliation, no listener-loss callback, nothing after
 * a resubscribe. The delta gauntlet's finding was that `NOTIFY` is at-most-once
 * and is lost both on listener disconnect and on transaction rollback, so a
 * missed notification meant instance A never broadcast instance B's durable
 * rows — and A's clients had no gap to notice and therefore no reason to ask.
 * The doorbell had quietly become the only delivery path.
 *
 * Two changes, and between them the doorbell is demoted to what it should always
 * have been:
 *
 *  1. **It rings from inside the database.** `pg_notify` is emitted by
 *     `atrium_append_core_event` rather than by this process, so no writer can
 *     insert a row silently — including a writer that is not this application.
 *     `announce` is gone from this file for that reason: a method here would be
 *     a second way to ring, free to disagree with the row.
 *  2. **Losing it costs latency, not delivery.** `reconciler.ts` folds and fans
 *     out on a timer regardless, and `onListen` below fires on every
 *     (re)subscription — postgres-js re-establishes `LISTEN` after a dropped
 *     connection and calls it again — so a resubscribe is immediately followed
 *     by a reconciliation of everything missed while deaf.
 *
 * The rule stated once: **nothing in this file may ever be the only path by
 * which a fact arrives.** It is now enforced by the reconciler rather than
 * asserted in a comment, and by a test that severs the listener mid-run.
 */

/** The channel a committed ledger position is announced on. */
export const LEDGER_CHANNEL = 'atrium_ledger';
/** The channel presence and typing — never durable — are relayed on. */
export const EPHEMERAL_CHANNEL = 'atrium_ephemeral';

/**
 * "Something landed at this position." The rows come from the ledger.
 *
 * `origin` is the instance that appended, so it can ignore the echo of its own
 * commit. It is `null` when the row was written by something that did not name
 * itself — a script, a migration, a second application. Null matches no
 * instance, so *everybody* folds it, which is the direction to be wrong in.
 */
export interface LedgerAnnouncement {
  origin: string | null;
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

export interface BusHandlers {
  onLedger: (note: LedgerAnnouncement) => void;
  onEphemeral: (note: EphemeralAnnouncement) => void;
  /**
   * The listener connection has just (re)subscribed.
   *
   * Fired on the first `LISTEN` and on every re-established one after a dropped
   * connection. Anything that happened while this process was deaf produced a
   * notification nobody received, so the only correct response is to go and look
   * — which is what the reconciler does. Without this callback a listener that
   * silently reconnected would resume hearing *new* commits and never learn
   * about the ones it slept through.
   */
  onListen?: () => void;
}

export interface EventBus {
  /** This process's identity, so it can ignore the echo of its own commits. */
  readonly instanceId: string;
  /** Relay one ephemeral frame. Fire-and-forget: failure is logged, not thrown. */
  relay: <T>(roomId: string, frame: T) => void;
  start: (handlers: BusHandlers) => Promise<void>;
  close: () => Promise<void>;
}

export function createEventBus({ sql: client, logger, instanceId }: EventBusOptions): EventBus {
  const id = instanceId ?? randomUUID();
  const unlisteners: Array<() => Promise<void>> = [];
  let closed = false;

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

    start: async ({ onLedger, onEphemeral, onListen }) => {
      // postgres-js calls `onlisten` for the initial subscription *and* again
      // every time it re-establishes the LISTEN after the connection drops. That
      // second case is the whole point: it is the only in-band signal that this
      // process was deaf for a while, and everything it missed is sitting in the
      // ledger waiting to be read.
      const announceListening = (channel: string) => () => {
        if (closed) return;
        logger.info('event bus listening', { instanceId: id, channel });
        onListen?.();
      };

      const ledger = await client.listen(
        LEDGER_CHANNEL,
        (raw) => {
          const note = parse<LedgerAnnouncement>(raw, LEDGER_CHANNEL);
          // `note.origin !== id` and not `note.origin && …`: a null origin is a
          // writer that did not name itself, and this instance must fold it.
          if (note && note.origin !== id) onLedger(note);
        },
        announceListening(LEDGER_CHANNEL),
      );
      unlisteners.push(() => ledger.unlisten());

      const ephemeral = await client.listen(
        EPHEMERAL_CHANNEL,
        (raw) => {
          const note = parse<EphemeralAnnouncement>(raw, EPHEMERAL_CHANNEL);
          if (note && note.origin !== id) onEphemeral(note);
        },
        announceListening(EPHEMERAL_CHANNEL),
      );
      unlisteners.push(() => ephemeral.unlisten());
    },

    close: async () => {
      closed = true;
      for (const unlisten of unlisteners.splice(0)) {
        await unlisten().catch(() => undefined);
      }
    },
  };
}
