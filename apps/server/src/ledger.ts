import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  type CoreEvent,
  type CoreState,
  type EventOutcome,
  emptyState,
  foldEvents,
  serializeState,
} from '@atrium/core';
import { coreEvents, type Database } from '@atrium/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { EventBus } from './event-bus.js';
import type { Logger } from './logger.js';
import { declaredRoomId, isCoreEvent, RoomEvent } from './room-events.js';

/**
 * The durable ledger, and the single writer in front of it.
 *
 * ## The invariant this module exists to hold (issue #22)
 *
 * > "the durable ledger must contain ONLY events accepted in canonical order —
 * > room_seq is assigned transactionally at append, so an out-of-order event is
 * > rejected at the command layer and never persisted. The reducer watermark is
 * > a defense-in-depth guard, not a data path; if refused events could reach the
 * > log, full replay (which re-sorts) would accept what live ingestion refused
 * > and the two states would diverge."
 *
 * `append` is the only way a row reaches `core_events`, and inside one
 * transaction it: takes the ledger's advisory lock, folds any rows another
 * writer committed since we last looked, mints the event's position, runs it
 * through `appendEvent`, and inserts. A `rejected` outcome throws, the
 * transaction rolls back, and there is no row, no sequence number and no gap.
 *
 * ## Why the lock is global rather than per room
 *
 * Because core state is. #19 r3 settled that the reducer gates on a **global**
 * cursor — `issues`, `corrections` and `consumedEventIds` are global ordered
 * lists, so a per-room gate cannot make a live fold and a replay byte-equal —
 * and #22 resolved the consequence by giving the ledger a global `seq` rather
 * than sharding core state per room. A per-room lock would let two rooms
 * interleave those global lists one way live and another way on replay, which
 * is exactly the divergence the design is built to exclude.
 *
 * The cost is real and bounded: appends serialize across the whole instance.
 * init.md prescribes one application server, a room is a handful of events a
 * minute, and the lock is held for one INSERT plus its projections. If that
 * ever stops being true, the fix is to shard *core state* per room — not to
 * weaken the lock while the state stays global.
 *
 * ## Why the lock is in Postgres and not just in this process
 *
 * The in-process mutex (`runExclusive`) is what keeps the in-memory `CoreState`
 * consistent. It says nothing to a second process — a migration runner, a
 * second server during a rolling deploy, a script. `pg_advisory_xact_lock`
 * does, and `catchUp` is what lets this process notice that someone else wrote
 * while it held nothing: it folds the gap before minting a position, so a
 * second writer degrades to "slower", never to "divergent". `UNIQUE(room_id,
 * room_seq)` is the last line under both.
 *
 * ## Why the lock is no longer merely cooperative (r1, major 1)
 *
 * Both critics said the same thing about round 1: everything above is a
 * convention between well-behaved callers. Any writer with the same database
 * role could `INSERT INTO core_events` directly and skip canonical minting, the
 * reducer, and gap-free assignment.
 *
 * So it is no longer possible. `drizzle/0003_append_enforcement.sql` adds
 * `atrium_append_core_event(...)` — which takes the lock, mints `room_seq`
 * under it and inserts — and a `BEFORE INSERT` trigger that refuses any insert
 * whose plpgsql call stack does not run through that function *and* whose
 * transaction does not actually hold the lock. `append` below calls the
 * procedure like every other caller must; there is no privileged path, and the
 * integration suite proves it by trying a direct insert as a superuser and
 * being refused.
 *
 * ## `seq` may gap. `room_seq` may not.
 *
 * `seq` is a `bigserial` and a sequence does not roll back: a transaction that
 * takes `seq = n` and then aborts — a rejected event, a failed projection, a
 * membership that vanished mid-append — burns `n` forever. That is fine, and it
 * is deliberately not claimed otherwise: `seq` is a total *order*, not a
 * census, and nothing counts it. `room_seq` is minted `max + 1` under the lock
 * inside the same transaction, so an aborted append gives its number straight
 * back and the per-room sequence stays contiguous. Only the per-room one is
 * advertised as gap-free, and only it is what `since(room, room_seq)` walks.
 */

/**
 * `0x41545232` — "ATR2", for Atrium issue #22. Any constant works; a
 * distinctive one keeps an accidental collision with another library's advisory
 * lock (pg-boss takes its own) from looking like a deadlock in our own code.
 */
export const LEDGER_ADVISORY_LOCK_KEY = 0x4154_5232;

/**
 * How long an append will wait for the ledger lock before giving up.
 *
 * Without this a writer blocks forever behind a stuck one, and "forever" on a
 * socket handler means a connection that never answers. With it, contention
 * surfaces as SQLSTATE `55P03` and becomes a *retryable* nack — a specific
 * thing a client may sensibly do again — rather than a generic failure the
 * caller has to guess about (r1 polish).
 */
export const LEDGER_LOCK_TIMEOUT_MS = 10_000;

/** The transaction handle drizzle hands a `db.transaction` callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type CommandErrorCode =
  /** The reducer refused the event: it lost the ordering race, or is a repeat. */
  | 'rejected'
  /** The caller is not a member of the room they addressed. */
  | 'not_a_member'
  /** The command is well-formed but asks for something that cannot be done. */
  | 'invalid'
  /** A uniqueness or foreign-key constraint said no. */
  | 'conflict'
  /**
   * Nothing was wrong with the command; the database was busy. Sending the very
   * same frame again is the correct response, which is the whole reason this is
   * not `invalid`: a client cannot tell "you may retry this" from "this will
   * never work" if both arrive under one code, so it either gives up on a
   * transient failure or hammers a permanent one.
   */
  | 'retry';

/**
 * SQLSTATEs that mean "busy", not "wrong".
 *
 *  - `55P03` lock_not_available — our own `lock_timeout` fired on the ledger
 *    lock.
 *  - `57014` query_canceled — a `statement_timeout`, or an operator cancelling
 *    the backend. The r1 finding names this one specifically.
 *  - `40001` serialization_failure / `40P01` deadlock_detected — Postgres chose
 *    this transaction as the victim. Retrying is exactly what it expects.
 */
const RETRYABLE_SQLSTATES = new Set(['55P03', '57014', '40001', '40P01']);

/** Walk the driver's cause chain for a SQLSTATE. Drizzle wraps the real error. */
function sqlState(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}

/**
 * Re-throw a database error as the command error it actually is.
 *
 * Only the busy ones are reclassified. Everything else keeps its identity —
 * turning every failure into "retry" would be the same mistake in the other
 * direction, and a client retrying a constraint violation forever is worse than
 * one that gave up too early.
 */
function asCommandError(error: unknown): unknown {
  if (error instanceof CommandError) return error;
  const state = sqlState(error);
  if (state !== null && RETRYABLE_SQLSTATES.has(state)) {
    return new CommandError(
      'retry',
      `the ledger was busy (SQLSTATE ${state}); nothing was written — send this command again`,
    );
  }
  return error;
}

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** One row of the ledger, as everything downstream sees it. */
export interface LedgerEntry {
  /** Global position — the total order the core's cursor lives in. */
  seq: number;
  /** Per-room position — the `since(room, room_seq)` cursor. */
  roomSeq: number;
  roomId: string;
  event: RoomEvent;
}

export interface AppendResult extends LedgerEntry {
  /** The reducer's verdict, or `null` for a ledger-only event. */
  outcome: EventOutcome | null;
}

/** What `append` needs from a command handler. */
export interface AppendRequest<T extends RoomEvent = RoomEvent> {
  /** The room the caller was authorized for. Checked against the event's own. */
  roomId: string;
  /**
   * Re-check the caller's right to write this room, **inside the append
   * transaction** (r1, major 4).
   *
   * Round 1 checked membership before opening the transaction, which is a
   * textbook time-of-check/time-of-use gap: a membership revoked in between was
   * still good enough to append with, and the event that resulted is durable
   * history written by someone who was no longer in the room. Called with the
   * transaction handle, after the ledger lock is taken and before anything is
   * minted; it must throw to refuse, and the throw takes the whole append with
   * it.
   */
  authorize?: (tx: Tx) => Promise<void>;
  /** Build the event once the ledger has assigned it an id and a timestamp. */
  build: (assigned: { id: string; at: string }) => T;
  /**
   * Write this event's projections — accepted_objects, messages, relations —
   * in the same transaction as the ledger row. A projection that fails takes
   * the event down with it, because a ledger row whose projection is missing is
   * a state the next reader disagrees with.
   */
  project?: (context: ProjectionContext<T>) => Promise<void>;
}

export interface ProjectionContext<T extends RoomEvent = RoomEvent> {
  tx: Tx;
  event: T;
  roomId: string;
  seq: number;
  roomSeq: number;
  /** Core state before the event — for "did this actually change anything?". */
  before: CoreState;
  /** Core state after it. Projections are read from here, never recomputed. */
  after: CoreState;
  outcome: EventOutcome | null;
}

export interface LedgerOptions {
  db: Database;
  logger: Logger;
  /**
   * Announce commits so other instances can fan them out. Optional: a ledger
   * with no bus is a single-instance ledger, which is still correct — it just
   * has nobody to tell.
   */
  bus?: Pick<EventBus, 'announce'>;
}

/** A `since` page, with the head it was read against. */
export interface CatchUpPage {
  entries: LedgerEntry[];
  /** The room's newest `room_seq` **as of the same snapshot** as `entries`. */
  head: number;
  /** The position this page reached: the last entry's, or `from` if empty. */
  to: number;
  /**
   * Whether history continues past `to`.
   *
   * `to < head`, and nothing else. Round 1 computed it from page fullness
   * (`entries.length === limit && …`) and that was the blocking finding: a
   * partial page during concurrent writes reports "caught up" while the head
   * has already moved, and the client has no reason to ask again. Because both
   * numbers come from one snapshot, this is exact rather than nearly always
   * right.
   */
  more: boolean;
}

export interface Ledger {
  /** Fold everything already durable. Call once, before serving. */
  hydrate: () => Promise<void>;
  /** The live core state: a fold of the ledger's core-typed subsequence. */
  coreState: () => CoreState;
  /** That state, canonically serialized — the live half of live ≡ replay. */
  serialize: () => string;
  /** Global position of the last row this process has folded. */
  lastSeq: () => number;
  append: <T extends RoomEvent>(request: AppendRequest<T>) => Promise<AppendResult>;
  /**
   * Fold everything another instance committed since this one last looked, and
   * hand back what was newly folded so the caller can fan it out locally. The
   * cross-instance half of delivery; see `event-bus.ts`.
   */
  sync: () => Promise<LedgerEntry[]>;
  /** The gap after `roomSeq`, in order. The `since(room, seq)` catch-up. */
  since: (roomId: string, roomSeq: number, limit?: number) => Promise<LedgerEntry[]>;
  /** The same page, plus the head it was read against — one snapshot, no race. */
  catchUpPage: (roomId: string, roomSeq: number, limit?: number) => Promise<CatchUpPage>;
  /** The room's newest `room_seq`, or 0 for a room with no history. */
  head: (roomId: string) => Promise<number>;
  /** Every core event in the ledger, in `seq` order — the replay half. */
  replayCoreEvents: () => Promise<CoreEvent[]>;
}

const PAGE = 500;

export function createLedger({ db, logger, bus }: LedgerOptions): Ledger {
  let state: CoreState = emptyState();
  let lastSeq = 0;
  /**
   * The `at` of the newest event this process has folded, in epoch ms.
   *
   * The canonical order is `(at, id)` and `appendEvent` demands *strictly*
   * after. Two appends inside one millisecond would otherwise tie on `at` and
   * fall through to a random uuid tie-break — which loses half the time, and
   * would turn a burst (exactly what the acceptance test posts) into a stream
   * of rejections. So the clock only ever moves forward here: `max(now,
   * last + 1ms)`. It stays within a hair of wall time under any real load and
   * is monotonic under all of it.
   */
  let lastAtMs = 0;
  /** In-process serialization; see the module note on the two locks. */
  let tail: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    // Keep the chain alive whatever this call does, but never let an
    // unhandled rejection escape from the chain itself.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function parseRow(row: {
    seq: number | string;
    roomSeq: number | string;
    roomId: string;
    payload: unknown;
  }): LedgerEntry {
    // A payload that does not parse means the ledger disagrees with the code
    // reading it. There is no safe way to skip it: skipping changes the fold.
    const event = RoomEvent.parse(row.payload);
    return { seq: Number(row.seq), roomSeq: Number(row.roomSeq), roomId: row.roomId, event };
  }

  /**
   * Fold every row after `lastSeq` into the live state. Safe to adopt
   * immediately even when the surrounding transaction later rolls back: those
   * rows were committed by whoever wrote them, and folding them cannot be
   * undone by our own failure.
   */
  async function catchUp(runner: Pick<Database, 'select'>): Promise<LedgerEntry[]> {
    const folded: LedgerEntry[] = [];
    for (;;) {
      const rows = await runner
        .select({
          seq: coreEvents.seq,
          roomSeq: coreEvents.roomSeq,
          roomId: coreEvents.roomId,
          payload: coreEvents.payload,
        })
        .from(coreEvents)
        .where(gt(coreEvents.seq, lastSeq))
        .orderBy(asc(coreEvents.seq))
        .limit(PAGE);
      if (rows.length === 0) break;

      const entries = rows.map(parseRow);
      const core = entries.map((entry) => entry.event).filter(isCoreEvent);
      if (core.length > 0) {
        const result = foldEvents(core, state);
        state = result.state;
        // A rejection here is the invariant in the module header, violated: the
        // ledger held an event that canonical order refuses. It is not
        // recoverable by retrying, and carrying on would serve a state that no
        // replay reproduces.
        for (const outcome of result.outcomes) {
          if (outcome.outcome === 'rejected') {
            throw new Error(
              `ledger integrity: event "${outcome.event.id}" in core_events was rejected on fold (${outcome.reason}: ${outcome.detail}) — the ledger contains an event that was never canonically consumable`,
            );
          }
        }
      }
      for (const entry of entries) {
        lastSeq = Math.max(lastSeq, entry.seq);
        lastAtMs = Math.max(lastAtMs, Date.parse(entry.event.at));
        folded.push(entry);
      }
      if (rows.length < PAGE) break;
    }
    return folded;
  }

  function nextTimestamp(): string {
    const ms = Math.max(Date.now(), lastAtMs + 1);
    lastAtMs = ms;
    return new Date(ms).toISOString();
  }

  /**
   * The room an event belongs to, checked against the room the caller was
   * authorized for.
   *
   * `proposal_rejected` and `object_corrected` name a thing rather than a room,
   * so their room comes from state. Everything else declares one, and a
   * declaration that disagrees with the authorized room is refused: without
   * this, a member of room A could accept an object into room B by putting B's
   * id inside the payload, having passed a membership check for A.
   */
  function resolveRoomId(event: RoomEvent, authorizedRoomId: string): string {
    const declared = declaredRoomId(event);
    if (declared !== null && declared !== authorizedRoomId) {
      throw new CommandError(
        'invalid',
        `event names room "${declared}" but the command was authorized for room "${authorizedRoomId}"`,
      );
    }
    if (declared !== null) return declared;

    // Only the two room-less kinds reach here; `declaredRoomId` is exhaustive
    // over the rest, so anything else is a union that grew without this
    // switch noticing.
    let fromState: string | undefined;
    let subject: string;
    if (event.type === 'proposal_rejected') {
      fromState = state.proposals[event.proposalId]?.proposal.roomId;
      subject = `proposal "${event.proposalId}"`;
    } else if (event.type === 'object_corrected') {
      fromState = state.objects[event.objectId]?.object.roomId;
      subject = `object "${event.objectId}"`;
    } else {
      throw new CommandError('invalid', `event type "${event.type}" declares no room`);
    }
    if (fromState === undefined) {
      throw new CommandError('invalid', `unknown ${subject}`);
    }
    if (fromState !== authorizedRoomId) {
      throw new CommandError(
        'invalid',
        `target belongs to room "${fromState}" but the command was authorized for room "${authorizedRoomId}"`,
      );
    }
    return fromState;
  }

  async function append<T extends RoomEvent>(request: AppendRequest<T>): Promise<AppendResult> {
    return runExclusive(async () => {
      // A busy database is not a bad command. Reclassified here, where the
      // driver error still exists: by the time it reaches the socket layer it
      // is a wrapped `Error` with no SQLSTATE left to read.
      const committed = await db
        .transaction(async (tx) => {
          // Bound the wait for the lock. `SET LOCAL` so it lasts exactly this
          // transaction and never leaks into whatever the pool hands out next.
          await tx.execute(
            sql`SET LOCAL lock_timeout = ${sql.raw(String(LEDGER_LOCK_TIMEOUT_MS))}`,
          );
          // Serialize with any other writer before reading a sequence number:
          // taking it after the read would let two transactions compute the same
          // `room_seq` and leave the UNIQUE index to arbitrate, which costs a
          // rolled-back command for no reason.
          // The cast is not decoration: postgres-js sends parameters untyped, and
          // `pg_advisory_xact_lock` is overloaded on (bigint) and (int, int).
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_ADVISORY_LOCK_KEY}::bigint)`);

          // Authorization, inside the transaction that writes (r1, major 4). It
          // goes after the lock so it cannot be starved by a queue of appends,
          // and before the fold so a refusal costs nothing.
          await request.authorize?.(tx);

          await catchUp(tx);

          const at = nextTimestamp();
          const id = randomUUID();
          const event = request.build({ id, at });
          if (event.id !== id || event.at !== at) {
            throw new CommandError(
              'invalid',
              'a command may not choose its own ledger position — build() must use the assigned id and at',
            );
          }
          const roomId = resolveRoomId(event, request.roomId);

          const before = state;
          let after = state;
          let outcome: EventOutcome | null = null;
          if (isCoreEvent(event)) {
            const applied = appendEvent(state, event);
            if (applied.outcome === 'rejected') {
              // The whole point. Throwing here aborts the transaction, so the
              // INSERT below never happens and the refused event leaves nothing.
              throw new CommandError(
                'rejected',
                `${applied.reason}: ${applied.detail} — re-mint the command at the current position and retry`,
              );
            }
            outcome = applied;
            after = applied.state;
          }

          // Through the procedure, like every other writer — there is no
          // privileged path and no direct INSERT anywhere in this codebase. The
          // procedure mints `room_seq` under the lock it re-takes, and the
          // trigger behind it refuses anything that did not come this way. See
          // `drizzle/0003_append_enforcement.sql`.
          //
          // The whole event goes into `payload`, envelope included: replay is a
          // parse of that column, not a re-assembly from the lifted ones. The
          // lifted `actor` and `occurred_at` are checked against it by constraint,
          // so the two can never describe different orders.
          const appended = (await tx.execute(sql`
          SELECT "seq", "room_seq" FROM atrium_append_core_event(
            ${roomId}::uuid,
            ${event.id}::text,
            ${event.type}::event_type,
            ${JSON.stringify(event.actor)}::jsonb,
            ${JSON.stringify(event)}::jsonb,
            ${event.at}::timestamptz
          )
        `)) as unknown as Array<{ seq: string | number; room_seq: string | number }>;
          const minted = appended[0];
          const seq = Number(minted?.seq);
          const roomSeq = Number(minted?.room_seq);
          if (!Number.isFinite(seq) || !Number.isFinite(roomSeq)) {
            throw new CommandError('conflict', 'the ledger append procedure returned no position');
          }

          await request.project?.({ tx, event, roomId, seq, roomSeq, before, after, outcome });

          // Inside the transaction on purpose: Postgres queues notifications and
          // delivers them at commit, so no peer can be told about a row that then
          // rolls back, and none can read the ledger before the row is visible.
          await bus?.announce(tx, { roomId, seq, roomSeq });

          return {
            result: { seq, roomSeq, roomId, event: event as RoomEvent, outcome },
            staged: { state: after, seq, at: Date.parse(event.at) },
          };
        })
        .catch((error: unknown) => {
          throw asCommandError(error);
        });

      const { result, staged } = committed;
      // Adopted only now: an in-memory state that ran ahead of a rolled-back
      // transaction would reject the retry of the very command that failed.
      state = staged.state;
      lastSeq = Math.max(lastSeq, staged.seq);
      lastAtMs = Math.max(lastAtMs, staged.at);
      return result;
    });
  }

  return {
    hydrate: async () => {
      const folded = await runExclusive(() => catchUp(db));
      logger.info('ledger hydrated', { events: folded.length, lastSeq });
    },
    coreState: () => state,
    serialize: () => serializeState(state),
    lastSeq: () => lastSeq,
    append,
    /**
     * Fold whatever a peer instance committed, and report it.
     *
     * Through `runExclusive`, so it can never interleave with an append that is
     * mid-flight: an append adopts its own row's state and `lastSeq` inside the
     * same critical section it committed in, which is what keeps this from
     * folding — and re-broadcasting — a row the appending path is about to
     * announce itself. Idempotent by construction: `catchUp` reads strictly
     * past `lastSeq`, so calling it for a notification that was already covered
     * by an earlier one returns nothing at all.
     */
    sync: () => runExclusive(() => catchUp(db)),
    since: async (roomId, roomSeq, limit = 1000) => {
      if (!Number.isInteger(roomSeq) || roomSeq < 0) {
        throw new CommandError('invalid', 'since cursor must be a non-negative integer');
      }
      const rows = await db
        .select({
          seq: coreEvents.seq,
          roomSeq: coreEvents.roomSeq,
          roomId: coreEvents.roomId,
          payload: coreEvents.payload,
        })
        .from(coreEvents)
        .where(and(eq(coreEvents.roomId, roomId), gt(coreEvents.roomSeq, roomSeq)))
        .orderBy(asc(coreEvents.roomSeq))
        .limit(limit);
      return rows.map(parseRow);
    },
    /**
     * The page and the head, read in **one transaction**.
     *
     * Two separate reads is how the r1 hole stayed open even after `more` was
     * computed correctly: rows committed between the page and the head make the
     * two describe different moments, and any claim relating them ("you are at
     * `to`, the room is at `head`") is then a claim about a state that never
     * existed. A read-only transaction gives both numbers one snapshot, so
     * `to < head` is exactly true rather than nearly always true — and a client
     * that loops until `to === head` terminates for the right reason.
     *
     * That `head` may have moved on by the time the frame reaches the client is
     * fine and unavoidable: it will be told about that by a live broadcast, or
     * by the next turn of its own catch-up loop.
     */
    catchUpPage: async (roomId, roomSeq, limit = 1000) => {
      if (!Number.isInteger(roomSeq) || roomSeq < 0) {
        throw new CommandError('invalid', 'since cursor must be a non-negative integer');
      }
      return db.transaction(
        async (tx) => {
          const rows = await tx
            .select({
              seq: coreEvents.seq,
              roomSeq: coreEvents.roomSeq,
              roomId: coreEvents.roomId,
              payload: coreEvents.payload,
            })
            .from(coreEvents)
            .where(and(eq(coreEvents.roomId, roomId), gt(coreEvents.roomSeq, roomSeq)))
            .orderBy(asc(coreEvents.roomSeq))
            .limit(limit);
          const [headRow] = await tx
            .select({ head: sql<string>`coalesce(max(${coreEvents.roomSeq}), 0)` })
            .from(coreEvents)
            .where(eq(coreEvents.roomId, roomId));

          const entries = rows.map(parseRow);
          const head = Number(headRow?.head ?? 0);
          const to = entries.at(-1)?.roomSeq ?? roomSeq;
          return { entries, head, to, more: to < head };
        },
        // REPEATABLE READ, so the two statements see one snapshot rather than
        // two consecutive ones. READ COMMITTED would take a fresh snapshot per
        // statement, which is the race this method exists to close.
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
    head: async (roomId) => {
      const [row] = await db
        .select({ head: sql<string>`coalesce(max(${coreEvents.roomSeq}), 0)` })
        .from(coreEvents)
        .where(eq(coreEvents.roomId, roomId));
      return Number(row?.head ?? 0);
    },
    replayCoreEvents: async () => {
      const events: CoreEvent[] = [];
      let cursor = 0;
      for (;;) {
        const rows = await db
          .select({
            seq: coreEvents.seq,
            roomSeq: coreEvents.roomSeq,
            roomId: coreEvents.roomId,
            payload: coreEvents.payload,
          })
          .from(coreEvents)
          .where(gt(coreEvents.seq, cursor))
          .orderBy(asc(coreEvents.seq))
          .limit(PAGE);
        if (rows.length === 0) break;
        for (const row of rows) {
          const entry = parseRow(row);
          cursor = Math.max(cursor, entry.seq);
          if (isCoreEvent(entry.event)) events.push(entry.event);
        }
        if (rows.length < PAGE) break;
      }
      return events;
    },
  };
}
