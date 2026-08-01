import { randomUUID } from 'node:crypto';
import {
  type Actor,
  type AuthoredEvent,
  appendEvent,
  type CoreState,
  type EventOutcome,
  emptyState,
  foldEvents,
  type ProvenanceMessage,
  serializeState,
  type TrustedContext,
  trustedContext,
} from '@atrium/core';
import { coreEvents, type Database } from '@atrium/db';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
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
 * ## The append function is the authorization boundary (r2 delta, blocking 2)
 *
 * Round 2 made the *path* structural — a `SECURITY DEFINER` function plus a
 * trigger that reads its own call stack — and the delta gauntlet found that a
 * structural path is not a boundary. The function was executable by `PUBLIC`,
 * did no membership check, ran no reducer validation and emitted no doorbell, so
 * calling it directly satisfied every guard round 2 had built and inserted a row
 * in silence.
 *
 * `drizzle/0004_trusted_actor_and_append_boundary.sql` is the answer and is the
 * authority on it: `EXECUTE` is revoked from `PUBLIC` and granted to the app
 * role; a human actor's membership is read `FOR SHARE` inside the function; the
 * reducer's two rejection reasons — both properties of position — are enforced
 * there in canonical `(at, id)` order under `COLLATE "C"`; and the notification
 * is emitted inside, so no path can insert without ringing the bell. This file
 * still does all of it too, because a boundary that only the outer layer checks
 * and a boundary that only the inner layer checks are both one layer short.
 *
 * ## The actor is a column, and replay reads it back (#21)
 *
 * `CoreEvent` has no actor field and refuses a payload carrying one. The actor
 * is stored as `actor_kind` / `actor_id` on the row, written by the transaction
 * that assigns `room_seq`, and handed back to `foldEvents` as the trusted
 * context — because replaying a payload under a different actor is replaying a
 * different event.
 *
 * ## The receipt window is remembered, not re-derived (r3 delta, blocking 2)
 *
 * Round 3 derived the second trusted column — the message window a receipt is
 * checked against — on *both* paths, from the same payload field against the same
 * table, and treated that sameness as the guarantee. The delta gauntlet found the
 * guarantee is not in the function:
 *
 * > the bodies come from `messages` whose `authorId` is `onDelete: 'set null'`
 * > […] Delete a human author and a model `object_accepted` that folded cleanly
 * > under a real `authorId` replays with `''`, fails the receipt, and is absent
 * > from replayed state. Same derivation code, different substrate.
 *
 * A deterministic function of mutable inputs is not deterministic. So the window
 * is read from `messages` **once**, by the append, and written into
 * `core_events.trusted_messages` in the same transaction; every fold after that —
 * `catchUp` on this instance, `catchUp` on a peer, `replayCoreEvents` a year
 * later — reads the column. `messages` is not consulted by any fold path at all,
 * which is what makes the guarantee hold for *any* future mutation of it rather
 * than for the one the gauntlet happened to name.
 *
 * ## …and it is DERIVED at the boundary, not handed to it (r4 delta, blocking)
 *
 * Round 4 got the column right and the door wrong: the append function took the
 * window as a parameter, checked only its shape, and stored it.
 *
 * > A direct caller of the granted append function supplies a fabricated but
 * > well-formed receipt window and every fold trusts it.
 *
 * This is the third appearance of one shape, and the general form is the lesson:
 * **trust follows derivation, not location.** The actor moved out of the payload
 * into a column and was still forgeable until the command layer derived it from
 * the session. The window moved out of a mutable table into an immutable column
 * and was still forgeable because the boundary accepted it. A trusted location
 * holding an untrusted value is a longer path to the same defect.
 *
 * There is no window parameter now. `atrium_receipt_window(room_id, actor_kind,
 * payload)` in `drizzle/0006_derived_receipt_snapshot.sql` is the only derivation
 * in the system: this module calls it to obtain what the fold runs against, the
 * append function calls it to obtain what it stores, and the append returns what
 * it stored so `append` can refuse the transaction if the two ever differ. The
 * practical test for the next argument anybody adds to that function is the one
 * the gauntlet gave: *could a direct caller supply a well-formed lie?*
 *
 * The general rule, since it outlives this column: anything a fold validates
 * against belongs in the event or on the event's row, and must be computed there
 * rather than accepted there. The corrected FK audit and the full audit of the
 * append function's remaining arguments are in the head of
 * `drizzle/0006_derived_receipt_snapshot.sql`.
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
  /** The trusted actor, read back from the row's own columns. Never the payload. */
  actor: Actor;
}

export interface AppendResult extends LedgerEntry {
  /** The reducer's verdict, or `null` for a ledger-only event. */
  outcome: EventOutcome | null;
}

/** What `append` needs from a command handler. */
export interface AppendRequest<T extends RoomEvent = RoomEvent> {
  /** The room the caller was authorized for. Checked against the event's own. */
  roomId: string;
  /** The trusted actor, derived from the authenticated session. Never a payload. */
  actor: Actor;
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
   *
   * As of r3 the append function refuses an unauthorized human actor on its own,
   * so this is the outer half of two. It stays because it produces the error the
   * client can act on, and because the two halves answer for different callers:
   * this one for the command layer, that one for everybody else.
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
  /** The trusted actor this row was appended under — the projections' "who". */
  actor: Actor;
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
   * This process's identity, stamped onto every doorbell so an instance can
   * ignore the echo of its own commits. Optional: with none, the notification
   * carries a null origin, which no instance matches — so every instance folds,
   * which is the safe direction to be wrong in.
   */
  instanceId?: string;
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
   * hand back what was newly folded so the caller can fan it out locally.
   *
   * This is the **durable** delivery path, and after the r2 delta gauntlet it is
   * the primary one: the doorbell only decides *when* it runs, never whether the
   * rows arrive. See `reconciler.ts`.
   */
  sync: () => Promise<LedgerEntry[]>;
  /** The gap after `roomSeq`, in order. The `since(room, seq)` catch-up. */
  since: (roomId: string, roomSeq: number, limit?: number) => Promise<LedgerEntry[]>;
  /** The same page, plus the head it was read against — one snapshot, no race. */
  catchUpPage: (roomId: string, roomSeq: number, limit?: number) => Promise<CatchUpPage>;
  /** The room's newest `room_seq`, or 0 for a room with no history. */
  head: (roomId: string) => Promise<number>;
  /** The head of every room named, in one query. The reconciler's read. */
  heads: (roomIds: readonly string[]) => Promise<Map<string, number>>;
  /**
   * Every core event in the ledger, in `seq` order, **with its trusted context**
   * — the replay half of live ≡ replay. Rows, not bare payloads: #21's `reduce`
   * takes `AuthoredEvent[]`, and a replay that invented the actors would be
   * replaying different events.
   */
  replayCoreEvents: () => Promise<AuthoredEvent[]>;
}

const PAGE = 500;

/** Turn the row's two actor columns back into the union core folds. */
export function actorFromColumns(kind: string, id: string | null): Actor {
  switch (kind) {
    case 'human':
      return { kind: 'human', userId: id ?? '' };
    case 'model':
      return { kind: 'model', model: id ?? '' };
    case 'system':
      return { kind: 'system' };
    default:
      // A kind the enum does not have means the ledger disagrees with this
      // code. Guessing would fold the row under an actor nobody chose.
      throw new Error(`core_events.actor_kind holds an unknown value "${kind}"`);
  }
}

/** The two columns, from the union. `null` for the system actor, and only it. */
export function actorToColumns(actor: Actor): { kind: Actor['kind']; id: string | null } {
  switch (actor.kind) {
    case 'human':
      return { kind: 'human', id: actor.userId };
    case 'model':
      return { kind: 'model', id: actor.model };
    case 'system':
      return { kind: 'system', id: null };
    default: {
      const exhaustive: never = actor;
      throw new Error(`unknown actor ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function createLedger({ db, logger, instanceId }: LedgerOptions): Ledger {
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

  const ROW = {
    seq: coreEvents.seq,
    roomSeq: coreEvents.roomSeq,
    roomId: coreEvents.roomId,
    payload: coreEvents.payload,
    actorKind: coreEvents.actorKind,
    actorId: coreEvents.actorId,
    trustedMessages: coreEvents.trustedMessages,
  } as const;

  /**
   * A row as this module reads it: the entry everything downstream sees, plus
   * the receipt window it folded under.
   *
   * The window is deliberately **not** on `LedgerEntry`. That type is what the
   * wire is built from, and a snapshot of message bodies riding on every fan-out
   * frame would be a payload nobody asked for — the client already has the
   * messages, through the projection, and the window exists for the reducer.
   */
  interface LedgerRow {
    entry: LedgerEntry;
    /** `null` when no window was supplied; `[]` when one was and it was empty. */
    trustedMessages: ProvenanceMessage[] | null;
  }

  function parseRow(row: {
    seq: number | string;
    roomSeq: number | string;
    roomId: string;
    payload: unknown;
    actorKind: string;
    actorId: string | null;
    trustedMessages: ProvenanceMessage[] | null;
  }): LedgerRow {
    // A payload that does not parse means the ledger disagrees with the code
    // reading it. There is no safe way to skip it: skipping changes the fold.
    const event = RoomEvent.parse(row.payload);
    return {
      entry: {
        seq: Number(row.seq),
        roomSeq: Number(row.roomSeq),
        roomId: row.roomId,
        event,
        actor: actorFromColumns(row.actorKind, row.actorId),
      },
      trustedMessages: row.trustedMessages,
    };
  }

  function parseEntry(row: Parameters<typeof parseRow>[0]): LedgerEntry {
    return parseRow(row).entry;
  }

  /**
   * The receipt window a row folds under, **derived by the database** from the
   * row itself.
   *
   * Round 3 derived it in TypeScript on both the append and the replay path and
   * called that sameness the guarantee; the r3 delta showed the substrate moved
   * underneath it. Round 4 snapshotted it into a column and let the append
   * function take it as a *parameter*, checked only for shape — and the r4 delta
   * found the same defect one move further along:
   *
   * > A direct caller of the granted append function supplies a fabricated but
   * > well-formed receipt window and every fold trusts it.
   *
   * So there is no window in TypeScript at all now, and nothing here reads
   * `messages`. `atrium_receipt_window(room_id, actor_kind, payload)` is the only
   * derivation there is: this function calls it to obtain what the fold runs
   * against, and `atrium_append_core_event` calls it again to obtain what it
   * stores. Neither value is chosen by a caller, and `append` compares the two
   * before it lets the transaction commit — see the note there.
   *
   * Run inside the append transaction, after the ledger lock: `messages` is only
   * ever written by a projection inside an append, so under the lock the answer
   * cannot move between the two calls.
   *
   * `atrium_receipt_window` is `SECURITY INVOKER` while the append function is
   * `SECURITY DEFINER`, so in a deployment with a dedicated unprivileged app role
   * this call runs as that role and the boundary's runs as the table owner. Least
   * privilege was preferred over making the two identical, and what that costs is
   * *checked* rather than assumed — see the comparison in `append`. Making the
   * derivation `SECURITY DEFINER` would close the class instead of checking it, at
   * the price of a read primitive over every room's message bodies granted to the
   * app role; that role already holds `SELECT` on `messages` in every deployment
   * this repo ships, so the two answers are closer than the choice looks.
   */
  async function trustToRecord(
    runner: Pick<Database, 'execute'>,
    event: RoomEvent,
    actor: Actor,
    roomId: string,
  ): Promise<TrustedContext> {
    const columns = actorToColumns(actor);
    const rows = (await runner.execute(sql`
      SELECT atrium_receipt_window(
        ${roomId}::uuid,
        ${columns.kind}::actor_kind,
        ${JSON.stringify(event)}::jsonb
      ) AS window
    `)) as unknown as Array<{ window: ProvenanceMessage[] | null }>;
    const window = rows[0]?.window ?? null;
    return window === null
      ? trustedContext({ actor })
      : trustedContext({ actor, messages: window });
  }

  /**
   * Two windows, compared as values.
   *
   * `jsonb` normalises key order, so the round trip cannot be compared by
   * `JSON.stringify` on the raw objects. `null` and `[]` stay distinct because
   * #21's reducer reports them as different refusals.
   */
  function sameWindow(
    a: readonly ProvenanceMessage[] | null | undefined,
    b: readonly ProvenanceMessage[] | null | undefined,
  ): boolean {
    // Length-prefixed rather than delimited. A message body may contain any
    // character at all, so any separator is a separator a body can forge — and a
    // comparison fooled by its own encoding is the exact class of bug this
    // function exists to catch.
    const part = (value: string) => `${value.length}:${value}`;
    const canonical = (window: readonly ProvenanceMessage[] | null | undefined) =>
      window === null || window === undefined
        ? null
        : window.map((m) => `${part(m.id)}${part(m.authorId)}${part(m.body)}`).join('');
    return canonical(a) === canonical(b);
  }

  /**
   * The trusted context a stored row folds under: its own columns, and nothing
   * else. No query, no clock, no `messages`.
   *
   * `null` and `[]` are kept apart on purpose. #21's reducer refuses a non-human
   * acceptance whose window is absent *or* empty, and reports the two
   * differently — "no window was supplied, so the receipt could not be checked"
   * against "the window is empty". Collapsing them here would make a replay
   * report a different reason than the live append did, which is a smaller
   * version of the same divergence.
   */
  function trustFromRow(actor: Actor, snapshot: ProvenanceMessage[] | null): TrustedContext {
    return snapshot === null
      ? trustedContext({ actor })
      : trustedContext({ actor, messages: snapshot });
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
        .select(ROW)
        .from(coreEvents)
        .where(gt(coreEvents.seq, lastSeq))
        .orderBy(asc(coreEvents.seq))
        .limit(PAGE);
      if (rows.length === 0) break;

      const parsed = rows.map(parseRow);
      const entries = parsed.map((row) => row.entry);
      const core = [];
      for (const row of parsed) {
        if (!isCoreEvent(row.entry.event)) continue;
        // From the row's own columns. No read of `messages` on any fold path —
        // see the module note on r3-delta blocking 2.
        core.push({
          ...trustFromRow(row.entry.actor, row.trustedMessages),
          event: row.entry.event,
        });
      }
      if (core.length > 0) {
        const result = foldEvents(core, state);
        state = result.state;
        // A rejection here is the invariant in the module header, violated: the
        // ledger held an event that canonical order refuses. It is not
        // recoverable by retrying, and carrying on would serve a state that no
        // replay reproduces. Since r3 the append function refuses those rows in
        // SQL, so reaching this line means something wrote around the boundary.
        for (const outcome of result.outcomes) {
          if (outcome.outcome === 'rejected') {
            throw new Error(
              `ledger integrity: event "${outcome.event.id}" in core_events was rejected on fold (${outcome.reason}: ${outcome.detail}) — the ledger contains an event that was never canonically consumable`,
            );
          }
          if (outcome.outcome === 'malformed') {
            throw new Error(
              `ledger integrity: a row in core_events does not parse as a CoreEvent (${outcome.detail}) — the ledger contains a payload no replay can fold`,
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
   * `proposal_rejected`, `proposal_superseded` and `object_corrected` name a
   * thing rather than a room, so their room comes from state. Everything else
   * declares one, and a declaration that disagrees with the authorized room is
   * refused: without this, a member of room A could accept an object into room B
   * by putting B's id inside the payload, having passed a membership check for A.
   *
   * **This is the command path only, and it is no longer the only place the
   * question is asked** (#22 gauntlet r5 delta, major 2). Until 0007 a direct
   * caller of the granted append function could file a `proposal_rejected` into
   * any room at all — the CHECK's `coalesce` fell through to the column, so
   * `room_id = room_id` held for anything. `atrium_append_core_event` now resolves
   * the named proposal or object back to the room its own ledger row landed in,
   * and refuses a disagreement.
   *
   * ## The two are close and they are not the same oracle, which is the part
   * worth writing down
   *
   * This function asks the **fold**: `state.proposals[id]` holds only subjects
   * whose minting event actually applied. The boundary asks the **log**: every
   * `proposal_recorded` row that exists, applied or not. Those differ for exactly
   * one shape — a minting event the reducer refused (an authority gate, a
   * duplicate) — which only a direct SQL caller can put there, since this function
   * refuses to append one.
   *
   * For that shape the boundary places the correction in the room the refused
   * minting event was recorded in, and the fold places it in **no** room at all
   * (`null`, and an `unknown object` issue). That is a column-versus-fold
   * difference and it is *not* the cross-room misroute the finding is about: the
   * fold never answers a *different* room, because the only candidate rooms are
   * the ones `core_events_payload_room_matches` has already pinned to the column,
   * and two candidates in two rooms are refused outright. Live still equals
   * replay — both fold the same row to the same issue.
   *
   * Closing it entirely would mean folding inside the boundary, which means
   * running the reducer in SQL. The boundary is the ledger's oracle; it is not
   * and cannot be the fold's.
   *
   * The refusals are not the same set either, and the difference is the direction
   * you would expect: this function has two (unknown subject, subject in another
   * room) and the boundary has three — it also refuses a subject minted in more
   * than one room, which is a log this function can never produce and a direct
   * caller can.
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

    // Only the three room-less kinds reach here; `declaredRoomId` is exhaustive
    // over the rest, so anything else is a union that grew without this
    // switch noticing.
    let fromState: string | undefined;
    let subject: string;
    if (event.type === 'proposal_rejected' || event.type === 'proposal_superseded') {
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
          const actor = request.actor;

          const before = state;
          let after = state;
          let outcome: EventOutcome | null = null;
          /**
           * The window this event folded under.
           *
           * Not on its way anywhere: the append function derives its own from the
           * same `atrium_receipt_window` and writes that. This is kept only so the
           * two can be compared once the append returns what it stored, which is
           * what makes "one derivation" a checked fact rather than a claim about
           * the code. `undefined` for a ledger-only kind that was never folded.
           */
          let foldedWindow: readonly ProvenanceMessage[] | undefined;
          let folded = false;
          if (isCoreEvent(event)) {
            // Derived by the database, from the row this transaction is about to
            // insert. Nothing here reads `messages`, and nothing here chooses the
            // window — see the note on `trustToRecord` and r4-delta blocking.
            const trusted = await trustToRecord(tx, event, actor, roomId);
            foldedWindow = trusted.messages;
            folded = true;
            const applied = appendEvent(state, event, trusted);
            if (applied.outcome === 'rejected' || applied.outcome === 'malformed') {
              // The whole point. Throwing here aborts the transaction, so the
              // INSERT below never happens and the refused event leaves nothing.
              throw new CommandError(
                applied.outcome === 'rejected' ? 'rejected' : 'invalid',
                applied.outcome === 'rejected'
                  ? `${applied.reason}: ${applied.detail} — re-mint the command at the current position and retry`
                  : applied.detail,
              );
            }
            outcome = applied;
            after = applied.state;
          }

          // Through the procedure, like every other writer — there is no
          // privileged path and no direct INSERT anywhere in this codebase. The
          // procedure authorizes the actor, refuses anything out of canonical
          // order, mints `room_seq` under the lock it re-takes, inserts, and
          // rings the doorbell; the trigger behind it refuses anything that did
          // not come this way. See `drizzle/0004_trusted_actor_and_append_boundary.sql`.
          //
          // The whole event goes into `payload`, envelope included: replay is a
          // parse of that column, not a re-assembly from the lifted ones. The
          // actor is NOT in the payload — a constraint refuses one that is — and
          // rides in its own two columns instead.
          //
          // There is **no receipt-window argument**. Round 4's signature had one
          // and the r4-delta gauntlet's blocking finding is what it cost: the
          // boundary validated its shape and stored it verbatim, so a direct
          // caller supplied a well-formed lie and every later fold believed it.
          // The window is derived inside, from `p_payload` and `p_room_id` — the
          // same values this statement inserts — and returned so the fold above
          // can be checked against it.
          const columns = actorToColumns(actor);
          const appended = (await tx.execute(sql`
          SELECT "seq", "room_seq", "trusted_messages" FROM atrium_append_core_event(
            ${roomId}::uuid,
            ${event.id}::text,
            ${event.type}::event_type,
            ${columns.kind}::actor_kind,
            ${columns.id}::text,
            ${JSON.stringify(event)}::jsonb,
            ${event.at}::timestamptz,
            ${instanceId ?? null}::text
          )
        `)) as unknown as Array<{
            seq: string | number;
            room_seq: string | number;
            trusted_messages: ProvenanceMessage[] | null;
          }>;
          const minted = appended[0];
          const seq = Number(minted?.seq);
          const roomSeq = Number(minted?.room_seq);
          if (!Number.isFinite(seq) || !Number.isFinite(roomSeq)) {
            throw new CommandError('conflict', 'the ledger append procedure returned no position');
          }
          /**
           * The row folded under exactly the window the row now holds.
           *
           * ## What this proves, exactly — and what it does not (r5 delta, major 1)
           *
           * Round 5's receipt called this "what makes one derivation a checked
           * fact", which reads as though it validated the window. It does not, and
           * the finding is right about why:
           *
           * > it is identity between two calls to the same SQL under one
           * > transaction, so both can agree while both are wrong, and a direct
           * > SQL caller never runs it at all.
           *
           * Granted in full. `atrium_receipt_window` is the only derivation there
           * is; if the derivation is wrong, both calls are wrong together and this
           * comparison is silent. It is not a check on the *content* of the
           * window. What the content is checked by is a different instrument
           * entirely — the integration tests that assert room-scoping, `messages.seq`
           * ordering, and NULL-vs-`[]` against a real database.
           *
           * Two things it does prove, both worth the round trip:
           *
           *  1. **Live ≡ replay for this row.** The right-hand side is now a
           *     `RETURNING` of the stored column (0007), not the value the function
           *     meant to store. A replay reads that same column. So this compares
           *     the window the live fold ran against with the bytes every future
           *     replay will run against — which is the property this whole column
           *     exists for, and the only one of the three the reducer's own
           *     determinism does not already give.
           *  2. **The `SECURITY INVOKER` / `SECURITY DEFINER` split costs nothing
           *     here.** The two calls run as two roles by design (see
           *     `trustToRecord`). If that divergence ever produced two answers —
           *     row-level security, a search-path difference, a revoked `SELECT` on
           *     `messages` — this is what notices, rather than a room whose
           *     acceptances quietly stop folding.
           *
           * It aborts rather than logs, because either failure means the durable
           * row would replay into a different state than it applied: the
           * transaction rolls back and the event leaves nothing behind.
           *
           * It runs on the server's path only. A direct SQL caller holding
           * `EXECUTE` never executes this line — which is exactly why every
           * guarantee that has to hold against such a caller lives in the SQL
           * boundary and not here.
           */
          if (folded && !sameWindow(foldedWindow, minted?.trusted_messages ?? null)) {
            throw new CommandError(
              'conflict',
              'the receipt window this event folded under is not the one the ledger recorded — refusing the append rather than storing a row that replays differently than it applied',
            );
          }

          await request.project?.({
            tx,
            event,
            actor,
            roomId,
            seq,
            roomSeq,
            before,
            after,
            outcome,
          });

          return {
            result: { seq, roomSeq, roomId, event: event as RoomEvent, actor, outcome },
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
     * by an earlier one returns nothing at all. That idempotence is what makes
     * it safe to call on a timer as well as on a doorbell.
     */
    sync: () => runExclusive(() => catchUp(db)),
    since: async (roomId, roomSeq, limit = 1000) => {
      if (!Number.isInteger(roomSeq) || roomSeq < 0) {
        throw new CommandError('invalid', 'since cursor must be a non-negative integer');
      }
      const rows = await db
        .select(ROW)
        .from(coreEvents)
        .where(and(eq(coreEvents.roomId, roomId), gt(coreEvents.roomSeq, roomSeq)))
        .orderBy(asc(coreEvents.roomSeq))
        .limit(limit);
      return rows.map(parseEntry);
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
     * fine and unavoidable: it will be told about that by a live broadcast, by
     * the reconciler's periodic head frame, or by the next turn of its own
     * catch-up loop.
     */
    catchUpPage: async (roomId, roomSeq, limit = 1000) => {
      if (!Number.isInteger(roomSeq) || roomSeq < 0) {
        throw new CommandError('invalid', 'since cursor must be a non-negative integer');
      }
      return db.transaction(
        async (tx) => {
          const rows = await tx
            .select(ROW)
            .from(coreEvents)
            .where(and(eq(coreEvents.roomId, roomId), gt(coreEvents.roomSeq, roomSeq)))
            .orderBy(asc(coreEvents.roomSeq))
            .limit(limit);
          const [headRow] = await tx
            .select({ head: sql<string>`coalesce(max(${coreEvents.roomSeq}), 0)` })
            .from(coreEvents)
            .where(eq(coreEvents.roomId, roomId));

          const entries = rows.map(parseEntry);
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
    /**
     * Every named room's head, in one query.
     *
     * The reconciler runs this on a timer over the rooms that have subscribers,
     * so "cheap and bounded" has to be true rather than hoped for: one indexed
     * `GROUP BY` over `(room_id, room_seq)` for the whole set, not one round
     * trip per room. A room with no events is absent from the result and the
     * caller reads it as 0.
     */
    heads: async (roomIds) => {
      const unique = [...new Set(roomIds)];
      if (unique.length === 0) return new Map();
      const rows = await db
        .select({ roomId: coreEvents.roomId, head: sql<string>`max(${coreEvents.roomSeq})` })
        .from(coreEvents)
        .where(inArray(coreEvents.roomId, unique))
        .groupBy(coreEvents.roomId);
      return new Map(rows.map((row) => [row.roomId, Number(row.head)]));
    },
    replayCoreEvents: async () => {
      const rows: AuthoredEvent[] = [];
      let cursor = 0;
      for (;;) {
        const page = await db
          .select(ROW)
          .from(coreEvents)
          .where(gt(coreEvents.seq, cursor))
          .orderBy(asc(coreEvents.seq))
          .limit(PAGE);
        if (page.length === 0) break;
        for (const row of page) {
          const { entry, trustedMessages } = parseRow(row);
          cursor = Math.max(cursor, entry.seq);
          if (!isCoreEvent(entry.event)) continue;
          // The row's own snapshot, not a fresh read of `messages`. This is the
          // replay half of r3-delta blocking 2: the substrate a replay folds is
          // the substrate the append folded, whatever has happened to the
          // conversation since.
          rows.push({ ...trustFromRow(entry.actor, trustedMessages), event: entry.event });
        }
        if (page.length < PAGE) break;
      }
      return rows;
    },
  };
}
