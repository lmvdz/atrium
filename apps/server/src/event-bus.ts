import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Logger } from './logger.js';
import {
  type EphemeralFrame,
  EphemeralNote,
  type LedgerNote,
  LedgerNote as LedgerNoteSchema,
} from './protocol.js';

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
 *  1. **It rings from inside the database.** `pg_notify` is emitted by the
 *     `core_events_doorbell` trigger rather than by this process, so no writer
 *     can insert a row silently — including a writer that is not this
 *     application. `announce` is gone from this file for that reason: a method
 *     here would be a second way to ring, free to disagree with the row.
 *
 *     It rang from inside `atrium_append_core_event` until r7, and that made
 *     this sentence false for exactly the writer it names: the r6 gauntlet got a
 *     row into `core_events` through a function that was not that one, and it
 *     landed silently. A trigger on the table has no such gap — see
 *     `packages/db/drizzle/0008_invariants_on_the_table.sql`.
 *  2. **Losing it costs latency, not delivery.** `reconciler.ts` folds and fans
 *     out on a timer regardless, and `onListen` below fires on every
 *     (re)subscription — postgres-js re-establishes `LISTEN` after a dropped
 *     connection and calls it again — so a resubscribe is immediately followed
 *     by a reconciliation of everything missed while deaf.
 *
 * The rule stated once: **nothing in this file may ever be the only path by
 * which a fact arrives.** It is now enforced by the reconciler rather than
 * asserted in a comment, and by a test that severs the listener mid-run.
 *
 * ## Neither channel is trusted input (#22 gauntlet r6, major 1)
 *
 * Round 6's blocking finding was not about delivery at all. `NOTIFY` requires
 * **no privilege** in Postgres: anything that can connect can put a string on
 * either channel. Until r7 this file answered that with two casts —
 * `JSON.parse(raw) as T` — and `ws-server.ts` handed the result to
 * `hub.broadcast` with no validation of any kind. The gauntlet executed it:
 *
 * ```sql
 * NOTIFY atrium_ephemeral, '{"origin":"attacker","roomId":"<room>","frame":{
 *   "type":"event","entry":{"roomSeq":1,"seq":1,…}}}';
 * ```
 *
 * A subscribed client received a forged **`event`** frame — a durable ledger
 * entry — while `core_events` was empty, committed it to its own journal, and
 * advanced `lastSeq` past a position the real ledger had not reached. The real
 * event at that position is then skipped forever. Durable client/ledger
 * divergence, and `core_events` was never touched.
 *
 * Two things changed, and the second is the one that closes the class:
 *
 *  1. **Both channels parse rather than cast.** `LedgerNote` and `EphemeralNote`
 *     in `protocol.ts` are the schemas; a string that does not match is logged
 *     and dropped exactly like unparseable JSON, because a notification is not
 *     a request and there is nobody to answer.
 *  2. **The ephemeral channel has a closed alphabet.** `EphemeralFrame` is
 *     `presence | typing` and nothing else, with a compile-time assertion that no
 *     durable frame can ever join it. There is no longer a spelling of "event"
 *     that this channel accepts, so the exploit above is not a validation failure
 *     to be caught — it is a sentence that cannot be said.
 *
 * The rule those two enforce, stated once: **a durable entry reaches a client by
 * exactly one route — this server read it out of `core_events` under an
 * authenticated session.** Not from a notification, not from a peer, not from a
 * cache. See `protocol.ts` for where that rule is written down.
 */

/** The channel a committed ledger position is announced on. */
export const LEDGER_CHANNEL = 'atrium_ledger';
/** The channel presence and typing — never durable — are relayed on. */
export const EPHEMERAL_CHANNEL = 'atrium_ephemeral';

/** @see LedgerNote in `protocol.ts` — the schema this channel is parsed with. */
export type LedgerAnnouncement = LedgerNote;

/** A frame that is not history, and so has no ledger to be read back from. */
export interface EphemeralAnnouncement {
  origin: string;
  roomId: string;
  frame: EphemeralFrame;
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
  /**
   * Relay one ephemeral frame. Fire-and-forget: failure is logged, not thrown.
   *
   * Typed `EphemeralFrame`, not `<T>`. The generic was how a durable frame could
   * be handed to this channel without anything objecting, and the receiving half
   * would have accepted it (r6 major 1).
   */
  relay: (roomId: string, frame: EphemeralFrame) => void;
  start: (handlers: BusHandlers) => Promise<void>;
  close: () => Promise<void>;
}

export function createEventBus({ sql: client, logger, instanceId }: EventBusOptions): EventBus {
  const id = instanceId ?? randomUUID();
  const unlisteners: Array<() => Promise<void>> = [];
  let closed = false;

  /**
   * Parse one notification against the channel's schema, or drop it.
   *
   * Not a cast. `NOTIFY` needs no privilege, so `raw` is attacker-reachable on
   * both channels and the only difference between "someone else's bug" and "an
   * exploit" is what the receiver does with a string it did not validate. A
   * notification is not a request: there is nobody to answer and nothing to
   * retry, so a refusal is a log line and a dropped frame.
   *
   * `raw.slice(0, 200)` because a rejected notification is by definition a string
   * this process does not understand, and logging all of it is how a log becomes
   * the place an attacker writes.
   */
  function parse<T>(
    raw: string,
    channel: string,
    schema: {
      safeParse: (
        v: unknown,
      ) => { success: true; data: T } | { success: false; error: { message: string } };
    },
  ): T | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn('unparseable notification', { channel, raw: raw.slice(0, 200) });
      return null;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      logger.warn('notification refused by the channel schema', {
        channel,
        raw: raw.slice(0, 200),
        reason: result.error.message,
      });
      return null;
    }
    return result.data;
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
          const note = parse(raw, LEDGER_CHANNEL, LedgerNoteSchema);
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
          const note = parse(raw, EPHEMERAL_CHANNEL, EphemeralNote);
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
