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
import { commandReceipts, coreEvents, type Database } from '@atrium/db';
import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Logger } from './logger.js';
import { declaredRoomId, isCoreEvent, RoomEvent } from './room-events.js';

/**
 * The receipt-window column, read back through a schema rather than trusted
 * (#46, r7 addendum 2).
 *
 * `trusted_messages` is a durable `jsonb` column, and the write path constrains
 * only its *shape* via a CHECK — the same asymmetry #46 is about, one column
 * over. A row whose window does not match `ProvenanceMessage[]` cannot be folded
 * safely (for a model `object_accepted` the window is exactly what the receipt
 * is checked against), so a column that fails this is treated as a malformed row
 * on read, consistent with what a malformed `payload` gets, rather than folded
 * under a window nobody can vouch for.
 */
const TrustedWindow = z
  .array(z.object({ id: z.string(), authorId: z.string(), body: z.string() }))
  .nullable();

/** The first ~500 chars of a zod failure, as `path: message; …`. Bounded so a log line stays a log line. */
function describeParseFailure(error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
}

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
 * role; an identified actor's membership is read `FOR SHARE` (a human's since
 * 0004, an agent's too since 0017, which also refuses a row whose `actor_kind`
 * disagrees with that identity's own `principal_kind`); the reducer's two
 * rejection reasons — both properties of position — are enforced in canonical
 * `(at, id)` order under `COLLATE "C"`; and the notification is emitted, so no
 * path can insert without ringing the bell. This file still does all of it too,
 * because a boundary that only the outer layer checks and a boundary that only
 * the inner layer checks are both one layer short.
 *
 * **Since r7 those rules live on the table, not in the function**
 * (`drizzle/0008_invariants_on_the_table.sql`). The r6 gauntlet reached
 * `core_events` through a function that was not `atrium_append_core_event` — the
 * call-stack guard matched an unqualified name any schema can claim — so a rule
 * inside the function bound only callers of the function. Membership, the
 * subject-room resolution, the ordering gate, `room_seq` and the receipt window
 * are the `core_events_invariants` BEFORE INSERT trigger; the doorbell is the
 * `core_events_doorbell` AFTER INSERT trigger. The function keeps the lock and
 * the door. Everything above is still true of the *database*; none of it is
 * still true of the *function*, and the difference is the whole of r6's major 3.
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
 * `core_events_invariants` trigger calls it to obtain what the row stores (it was
 * the append function until r7 — see above), and the append returns what was
 * stored so `append` can refuse the transaction if the two ever differ. The
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

/**
 * One *readable* row of the ledger, as everything downstream sees it.
 *
 * The `kind` discriminant exists because of #46: a row whose payload no longer
 * parses as a `RoomEvent` cannot become one of these — there is no honest
 * `event` to put in it — and the read path must not throw when it meets one. So
 * `LedgerEntry` is a union, and a row that cannot be read comes back as a
 * `MalformedLedgerEntry` marker instead. This is the folded arm.
 */
export interface FoldedLedgerEntry {
  /** Discriminant. A row that parsed and can carry a real event. */
  kind: 'event';
  /** Global position — the total order the core's cursor lives in. */
  seq: number;
  /** Per-room position — the `since(room, room_seq)` cursor. */
  roomSeq: number;
  roomId: string;
  event: RoomEvent;
  /** The trusted actor, read back from the row's own columns. Never the payload. */
  actor: Actor;
  /**
   * Why the reducer refused this row, or empty when it applied cleanly — the
   * `applied_with_issue` reasons, travelling *with* the row (#22 r10, D4).
   *
   * ## The defect this closes
   *
   * A business refusal is delivered to the actor's own socket in its `ack` and
   * to nobody else, while the row itself — refused, changing nothing — is
   * appended and fanned out to every subscriber as an ordinary `event` frame,
   * and replayed to cold readers by `since`. So r9's refusal of "Victim will
   * work through the holidays" was visible to the attacker and invisible to the
   * room: every other socket got the full payload with no marker, the client
   * put it in `room.events`, and it survived a reload in the durable journal.
   * The refusal reached one person; the sentence reached everyone.
   *
   * ## Why the frame is marked rather than withheld
   *
   * Not broadcasting the row is the other option and it is not available.
   * `room_seq` is advertised gap-free and is the client's cursor — it is what
   * `since` walks and what the gap detector reads — so a row that is skipped
   * live and present in catch-up desynchronises the two, and a row skipped in
   * both leaves a hole the client correctly reads as loss and re-requests
   * forever. The row happened; what it did not do is take effect. So it travels
   * with the reason it took no effect, and the client drops it from the room's
   * materialised history while still advancing past it.
   *
   * ## One producer
   *
   * Every path that hands out a `LedgerEntry` fills this from `issuesFor`, which
   * reads `CoreState.issues` — the fold's own record. Live delivery, the
   * reconciler's fan-out and the `since` page therefore answer from the same
   * oracle rather than from three, which is what makes "the catch-up path says
   * what the live path said" a fact about the code rather than a hope.
   */
  issues: readonly string[];
}

/**
 * A row that could not be read back as a `RoomEvent` — the #46 marker.
 *
 * ## Why this exists rather than a throw
 *
 * The write path validates the CHECKs and nothing else, so SQL runs no zod: a
 * `message_posted` with `body: ""` (a `z.string().min(1)` violation) lands
 * durably through a bad migration, a manual fix, or any future non-participant
 * writer. Until #46 the read path called `RoomEvent.parse`, which **throws** on
 * such a row — and because `hydrate` folds the whole ledger before serving and
 * `since` walks it on every reconnect, one unreadable row took the room down on
 * every subsequent hydration, forever, for every client, with no path back
 * except editing the log by hand.
 *
 * The decision (recorded on #46) is **skip-and-report**: the row is never folded
 * — a payload that cannot parse was never consumable, so excluding it is the
 * correct fold, not a corruption of it — and it travels out as this marker so an
 * operator sees which row and why, and so a client's `room_seq` cursor can
 * advance *past* it (the position is real; only the payload is not) rather than
 * reading a hole it re-requests forever.
 *
 * It carries no `event`, no `actor` and no `issues`: there is nothing trustworthy
 * to fold, and fabricating a placeholder event would be exactly the laundering
 * this marker exists to refuse.
 */
export interface MalformedLedgerEntry {
  /** Discriminant. A row that exists but cannot be read as an event. */
  kind: 'malformed';
  /** Global position — real; the row is durable, only its payload is not. */
  seq: number;
  /** Per-room position — real, and what lets a client advance its cursor past it. */
  roomSeq: number;
  roomId: string;
  /** The parse-failure detail: which field failed and why. Never a fabricated event. */
  reason: string;
}

/**
 * One row of the ledger, readable or not. Downstream code that folds or renders
 * an event must narrow on `kind` first — `isFoldedEntry` / `isMalformedEntry`
 * below — which is the whole point of making the marker a peer of the folded
 * entry rather than a laundered variant of it.
 */
export type LedgerEntry = FoldedLedgerEntry | MalformedLedgerEntry;

/** Narrow a `LedgerEntry` to the folded arm — the one that carries an event. */
export function isFoldedEntry(entry: LedgerEntry): entry is FoldedLedgerEntry {
  return entry.kind === 'event';
}

/** Narrow a `LedgerEntry` to the #46 malformed marker. */
export function isMalformedEntry(entry: LedgerEntry): entry is MalformedLedgerEntry {
  return entry.kind === 'malformed';
}

export interface AppendResult extends FoldedLedgerEntry {
  /** The reducer's verdict, or `null` for a ledger-only event. */
  outcome: EventOutcome | null;
}

export interface AppendBatchResult {
  entries: AppendResult[];
  /** True when a durable command receipt recovered these existing rows. */
  replayed: boolean;
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
   * As of r3 the database refuses an unauthorized human actor on its own — in the
   * append function then, in the `core_events_invariants` trigger since r7 — so
   * this is the outer half of two. It stays because it produces the error the
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

/** Several causally inseparable rows committed and projected under one lock. */
export interface AppendBatchRequest {
  roomId: string;
  actor: Actor;
  authorize?: (tx: Tx) => Promise<void>;
  /** Fresh-attempt authority checks, deliberately skipped for a durable replay. */
  prepare?: (tx: Tx) => Promise<void>;
  idempotency?: {
    commandName: string;
    key: string;
    /** Lowercase SHA-256 computed by the server from the semantic command. */
    fingerprint: string;
    expectedEventTypes: readonly RoomEvent['type'][];
  };
  /** Refuse the whole causal unit if any reducer step reports a business issue. */
  requireClean?: boolean;
  builds: readonly ((assigned: { id: string; at: string }) => RoomEvent)[];
  project?: (context: ProjectionContext<RoomEvent>) => Promise<void>;
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
  /**
   * How many distinct malformed rows this process has met and reported (#46).
   *
   * The operator-facing metric behind the WARN log: non-zero means the ledger
   * holds a row no reader can fold, which stayed survivable rather than taking
   * the room down. Deduped by `seq`, so it counts rows, not encounters.
   */
  malformedCount: () => number;
  append: <T extends RoomEvent>(request: AppendRequest<T>) => Promise<AppendResult>;
  appendBatch: (request: AppendBatchRequest) => Promise<AppendBatchResult>;
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

/**
 * Turn the row's two actor columns back into the union core folds, or `null` for
 * an `actor_kind` the enum does not have (#46, HIGH 3).
 *
 * The read path uses this rather than {@link actorFromColumns} because a drifted
 * or corrupt `actor_kind` is the same class of hazard as a payload that no longer
 * parses — one column over — and used to `throw` here, re-crashing every
 * `hydrate`/`since`/`replay` on a row whose *payload* was perfectly valid. A
 * `null` return lets `parseRow` turn it into the same malformed marker instead of
 * taking the room down. Guessing is refused, not the read: folding the row under
 * an actor nobody chose would silently reopen every trust gate the reducer reads
 * the actor for.
 */
export function safeActorFromColumns(kind: string, id: string | null): Actor | null {
  switch (kind) {
    case 'human':
      return { kind: 'human', userId: id ?? '' };
    // Same column shape as `human`, deliberately: `actor_id` holds the user id
    // for both, so replay reconstructs an agent by the same id the live append
    // wrote. What separates them on the way back out is the discriminant, which
    // is exactly what `isHuman` reads — a replay that flattened the two would
    // re-fold an agent's history as a person's and quietly reopen every gate.
    case 'agent':
      return { kind: 'agent', userId: id ?? '' };
    case 'model':
      return { kind: 'model', model: id ?? '' };
    case 'system':
      return { kind: 'system' };
    default:
      return null;
  }
}

/**
 * Turn the row's two actor columns back into the union core folds.
 *
 * The strict form, kept for the write side and any caller that has already
 * established the `actor_kind` is one the enum has. The read path uses
 * {@link safeActorFromColumns} instead — see #46, HIGH 3.
 */
export function actorFromColumns(kind: string, id: string | null): Actor {
  const actor = safeActorFromColumns(kind, id);
  if (actor === null) {
    // A kind the enum does not have means the ledger disagrees with this code.
    throw new Error(`core_events.actor_kind holds an unknown value "${kind}"`);
  }
  return actor;
}

/** The two columns, from the union. `null` for the system actor, and only it. */
export function actorToColumns(actor: Actor): { kind: Actor['kind']; id: string | null } {
  switch (actor.kind) {
    case 'human':
      return { kind: 'human', id: actor.userId };
    case 'agent':
      return { kind: 'agent', id: actor.userId };
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

/** One shared empty list, so a clean row costs no allocation on the fan-out path. */
const EMPTY_ISSUES: readonly string[] = Object.freeze([]);

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
  /** `state.issues`, keyed by event id — see `issuesFor`. */
  const issuesByEvent = new Map<string, string[]>();
  /** How much of `state.issues` is already in the map. */
  let indexedIssues = 0;

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
    // #46 (BLOCKER 2): the canonical-order column, selected for EVERY row so the
    // ordering watermark can advance past a malformed row too. A malformed row's
    // payload may not parse, but the row is still physically present in the
    // `(occurred_at, id)` order the append gate enforces — and a future-dated bad
    // row that did not move `lastAtMs` would make the next append's minted `at`
    // fall behind it and be refused. `occurred_at` is pinned to `payload.at` by a
    // CHECK, so it is the same instant the fold would have read, available even
    // when the payload is not.
    occurredAt: coreEvents.occurredAt,
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
    /**
     * The row's `occurred_at`, as stored (#46, BLOCKER 2). Present for every row,
     * readable or not — it is a lifted column, not the payload — so `catchUp` can
     * advance the ordering watermark past a malformed row.
     */
    occurredAt: string;
  }

  function parseRow(row: {
    seq: number | string;
    roomSeq: number | string;
    roomId: string;
    payload: unknown;
    actorKind: string;
    actorId: string | null;
    trustedMessages: ProvenanceMessage[] | null;
    occurredAt: string;
  }): LedgerRow {
    const seq = Number(row.seq);
    const roomSeq = Number(row.roomSeq);
    const occurredAt = String(row.occurredAt);
    const malformed = (reason: string): LedgerRow => ({
      entry: { kind: 'malformed', seq, roomSeq, roomId: row.roomId, reason },
      trustedMessages: null,
      occurredAt,
    });
    // #46: a payload that does not parse used to `throw` here, which took the
    // whole room down on every hydration forever. It is now reported, not fatal:
    // the row comes back as a `malformed` marker instead of a folded event. It is
    // never fed to the reducer (a row that cannot parse was never consumable), so
    // excluding it is the correct fold — see `catchUp`.
    const parsed = RoomEvent.safeParse(row.payload);
    if (!parsed.success) {
      return malformed(`payload: ${describeParseFailure(parsed.error)}`);
    }
    // #46, HIGH 3: the actor columns are read defensively too. A drifted or
    // corrupt `actor_kind` on an otherwise-valid payload used to `throw` from
    // `actorFromColumns` one line below — re-crashing hydrate/since/replay, #46
    // one column over. It now yields the same malformed marker.
    const actor = safeActorFromColumns(row.actorKind, row.actorId);
    if (actor === null) {
      return malformed(`actor: core_events.actor_kind holds an unknown value "${row.actorKind}"`);
    }
    // r7 addendum 2 + grok's trusted_messages nuance: the receipt window is a
    // durable column the write path constrains only in shape. Read it through the
    // schema too — but a window that does not parse only makes the whole row
    // malformed when the window is *load-bearing for this event kind*.
    //
    // The reducer consults the window for exactly one kind: `object_accepted`
    // (`reduce.ts`'s `applyObjectAccepted` is its only reader). For that kind a
    // bad window means the acceptance cannot be certified against the messages it
    // cites, so the fold is not trustworthy and the row is malformed — the
    // marker is correct. For every other kind the window is never read, so
    // discarding an otherwise-valid payload's fold over it would be throwing away
    // a good event for a column that changes nothing. Those fold, with the bad
    // window dropped and reported separately.
    const window = TrustedWindow.safeParse(row.trustedMessages);
    if (!window.success) {
      if (parsed.data.type === 'object_accepted') {
        return malformed(`trusted_messages: ${describeParseFailure(window.error)}`);
      }
      reportDroppedWindow(seq, roomSeq, row.roomId, describeParseFailure(window.error));
      return {
        entry: {
          kind: 'event',
          seq,
          roomSeq,
          roomId: row.roomId,
          event: parsed.data,
          actor,
          issues: EMPTY_ISSUES,
        },
        trustedMessages: null,
        occurredAt,
      };
    }
    return {
      entry: {
        kind: 'event',
        seq,
        roomSeq,
        roomId: row.roomId,
        event: parsed.data,
        actor,
        // Filled by `withIssues` on the way out, never here: `catchUp` parses a
        // page *before* it folds it, so a verdict read at parse time is the
        // verdict of the previous state and would report every freshly folded
        // refusal as clean.
        issues: EMPTY_ISSUES,
      },
      trustedMessages: window.data,
      occurredAt,
    };
  }

  /**
   * Malformed rows seen so far this process, deduped by `seq` (#46).
   *
   * The metric an operator watches, and the dedup that keeps the WARN log from
   * repeating on every `since`/`sync` that walks the same bad row: `catchUp`
   * advances `lastSeq` past a malformed row exactly as past a folded one, so it
   * reports each at most once — and `foldThrough`, which every read path calls
   * before answering, funnels every first encounter through `catchUp`.
   */
  const reportedMalformed = new Set<number>();

  /** Log-and-count a malformed row, once per distinct `seq`. */
  function reportMalformed(entry: MalformedLedgerEntry): void {
    if (reportedMalformed.has(entry.seq)) return;
    reportedMalformed.add(entry.seq);
    logger.warn('ledger row does not parse — skipped and reported, not folded (#46)', {
      seq: entry.seq,
      roomSeq: entry.roomSeq,
      roomId: entry.roomId,
      reason: entry.reason,
    });
  }

  /**
   * Rows whose `trusted_messages` window did not parse but whose event was folded
   * anyway, because the window is not load-bearing for that kind (#46). Deduped
   * by `seq` so a walk over the same row does not repeat the WARN.
   */
  const reportedDroppedWindow = new Set<number>();

  /** Log a dropped (non-load-bearing) receipt window, once per distinct `seq`. */
  function reportDroppedWindow(seq: number, roomSeq: number, roomId: string, reason: string): void {
    if (reportedDroppedWindow.has(seq)) return;
    reportedDroppedWindow.add(seq);
    logger.warn(
      'ledger row has an unreadable trusted_messages window on a kind that does not consult it — folded without the window (#46)',
      { seq, roomSeq, roomId, reason },
    );
  }

  /** The one place a folded `LedgerEntry` acquires its verdict. */
  function withIssues(entry: FoldedLedgerEntry): FoldedLedgerEntry {
    return { ...entry, issues: issuesFor(entry.event.id) };
  }

  /**
   * Why the fold refused this event, or `EMPTY_ISSUES` — read off `CoreState`,
   * which is the fold's own record of it.
   *
   * ## Why the fold and not a column
   *
   * The alternative was a durable `issues` column set by the append procedure,
   * and it is worse in the way that matters here: the reasons would then be a
   * *parameter* somebody supplies, so a direct caller of the granted append
   * function could mark a real event refused or hide a real refusal. That is the
   * exact shape of the r4-delta blocking finding about the receipt window
   * (`trustToRecord`, below). `state.issues` cannot be supplied — it is produced
   * by folding the row, and folding the row is what makes it durable and what
   * every replay does again.
   *
   * ## Why the index is safe to answer from
   *
   * `hydrate` folds the whole ledger before the socket opens, and `catchUp`
   * folds strictly forward from `lastSeq`, so this state has consumed every row
   * up to `lastSeq` — and the read paths below make sure they have folded past
   * the page they are about to answer with before they call this. An event that
   * applied cleanly is absent from `state.issues`, which is why the callers'
   * fold-first discipline is load-bearing: "no issues recorded" and "not folded
   * yet" would otherwise be the same answer, and that answer would be a
   * fail-open.
   */
  function issuesFor(eventId: string): readonly string[] {
    reindexIssues();
    return issuesByEvent.get(eventId) ?? EMPTY_ISSUES;
  }

  /**
   * Fold `state.issues` into a by-event index, incrementally.
   *
   * `state.issues` is append-only and every state this module adopts is a
   * continuation of the last one, so everything before `indexedIssues` is
   * already in the map. Rebuilt from a prefix rather than from scratch because
   * `since` is on the read path and the list is unbounded.
   */
  function reindexIssues(): void {
    for (let index = indexedIssues; index < state.issues.length; index += 1) {
      const issue = state.issues[index];
      if (!issue) continue;
      const held = issuesByEvent.get(issue.eventId);
      if (held) held.push(issue.reason);
      else issuesByEvent.set(issue.eventId, [issue.reason]);
    }
    indexedIssues = state.issues.length;
  }

  /**
   * Fold everything committed up to `through`, so `issuesFor` can answer about
   * it. Throws rather than guessing: an entry this instance has not folded has
   * no verdict, and reporting "no issues" for it is the fail-open this whole
   * field exists to close.
   */
  async function foldThrough(through: number): Promise<void> {
    if (through <= lastSeq) return;
    await runExclusive(() => catchUp(db));
    if (through > lastSeq) {
      throw new CommandError(
        'conflict',
        `the ledger has rows up to seq ${through} that this instance has not folded (at ${lastSeq}) — refusing to serve them without saying whether they applied`,
      );
    }
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
   * against, and the `core_events_invariants` trigger calls it again to obtain
   * what the row stores. Neither value is chosen by a caller, and `append`
   * compares the two before it lets the transaction commit — see the note there.
   *
   * The second caller was `atrium_append_core_event` until r7; it is the trigger
   * now, which is what makes the derivation cover a writer that never went
   * through the function (`drizzle/0008_invariants_on_the_table.sql`).
   *
   * Run inside the append transaction, after the ledger lock: `messages` is only
   * ever written by a projection inside an append, so under the lock the answer
   * cannot move between the two calls.
   *
   * `atrium_receipt_window` is `SECURITY INVOKER` while the append function is
   * `SECURITY DEFINER`, so in a deployment with a dedicated unprivileged app role
   * this call runs as that role and the boundary's runs as the table owner. That
   * survives r7 unchanged even though the second caller moved into a trigger: a
   * trigger fired by a statement inside a `SECURITY DEFINER` function runs under
   * that function's effective user, so it is still the owner deriving the stored
   * value. What *is* new is the fail-closed direction — a writer that reaches
   * `core_events` outside the function derives the window as itself, and a role
   * without `SELECT` on `messages` cannot complete the insert at all. Least
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
      // #46 (MEDIUM 5): event ids that parsed as a `RoomEvent` but were refused
      // by `CoreEvent.parse` on fold, mapped to the reason. These are converted
      // to markers below rather than fanned out as clean events.
      const coreMalformed = new Map<string, string>();
      const core = [];
      for (const row of parsed) {
        // #46: a malformed row is never folded. It was never a consumable event,
        // so excluding it is the correct fold, not a skip that changes one.
        if (row.entry.kind === 'malformed') continue;
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
        // replay reproduces. Since r3 the `rejected` half is refused in SQL — the
        // canonical-order gate and `core_events_id_key` are exactly
        // `out_of_order` and `duplicate` — so reaching *that* branch means
        // something wrote around the boundary. It stays fatal, on purpose (#46
        // keeps the rejected half as it was).
        for (const outcome of result.outcomes) {
          if (outcome.outcome === 'rejected') {
            throw new Error(
              `ledger integrity: event "${outcome.event.id}" in core_events was rejected on fold (${outcome.reason}: ${outcome.detail}) — the ledger contains an event that was never canonically consumable`,
            );
          }
          if (outcome.outcome === 'malformed') {
            // #46 deleted the throw that used to be here. A row this deep is one
            // whose payload passed `RoomEvent` yet `CoreEvent.parse` refused —
            // the two schemas disagreeing, which `parseRow`'s safe-skip does not
            // catch because the row *did* parse as a `RoomEvent`. It is still a
            // row no replay can fold, so it is reported and — MEDIUM 5 — the
            // matching entry is converted to a marker below rather than reaching
            // `folded`/fan-out as a clean event. (In practice unreachable: the
            // core kinds in `RoomEventVariants` are @atrium/core's own schemas, so
            // a payload that parses as one parses as the other.)
            const badId = (outcome.event as { id?: unknown }).id;
            if (typeof badId === 'string') coreMalformed.set(badId, outcome.detail);
            logger.warn(
              'ledger row parsed as a RoomEvent but not as a CoreEvent — reported, not folded (#46)',
              { detail: outcome.detail, lastSeq },
            );
          }
        }
      }
      for (const { entry, occurredAt } of parsed) {
        lastSeq = Math.max(lastSeq, entry.seq);
        // #46 (BLOCKER 2): advance the ordering watermark for EVERY physical row,
        // malformed included. `occurred_at` is pinned to `payload.at` by a CHECK
        // and read from a lifted column, so it is available even when the payload
        // is not — and a future-dated malformed row that left `lastAtMs` behind it
        // would make the next append's minted `at` be refused by the append gate,
        // trading "process down" for "ledger nobody can write to".
        const atMs = Date.parse(occurredAt);
        if (Number.isFinite(atMs)) lastAtMs = Math.max(lastAtMs, atMs);
        if (entry.kind === 'malformed') {
          // Reported (once per seq) and carried out so the fan-out can advance a
          // client's cursor past it without a hole, and an operator sees it.
          reportMalformed(entry);
          folded.push(entry);
          continue;
        }
        // #46 (MEDIUM 5): a row the reducer refused as malformed on fold is not a
        // clean event — convert it to a marker before it reaches `folded`/fan-out,
        // so cold-read and live fan-out agree that this position is unreadable.
        const coreReason = coreMalformed.get(entry.event.id);
        if (coreReason !== undefined) {
          const marker: MalformedLedgerEntry = {
            kind: 'malformed',
            seq: entry.seq,
            roomSeq: entry.roomSeq,
            roomId: entry.roomId,
            reason: `core: ${coreReason}`,
          };
          reportMalformed(marker);
          folded.push(marker);
          continue;
        }
        // After the fold above, so a row refused on the way in carries the
        // reason it was refused out to the fan-out (#22 r10, D4).
        folded.push(withIssues(entry));
      }
      if (rows.length < PAGE) break;
    }
    return folded;
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
   * whose minting event actually installed. The boundary asks the **log**: every
   * `proposal_recorded` row that exists, folded or not. Those differ for exactly
   * one shape — a minting row the fold does not install.
   *
   * ## The containment argument that used to be here was false (#22 gauntlet r6,
   * minor 5)
   *
   * It said that shape is one "which only a direct SQL caller can put there,
   * since this function refuses to append one". `append` aborts on `rejected` and
   * `malformed` only. A **business** refusal is `applied_with_issue`, and
   * `applied_with_issue` is appended — that is the whole point of it. Accepting
   * the same proposal twice through the ordinary command path produces two
   * `object_accepted` rows, and the second object is absent from `coreState()`;
   * `integration/server/commands.test.ts` has said so all along, which is what
   * makes the sentence above a thing nobody checked rather than a thing nobody
   * could have.
   *
   * The two reasons the reducer actually rejects for are `out_of_order` and
   * `duplicate` (`RejectionReason` in @atrium/core — there is no authority-gate
   * rejection, and naming one was the second error in the same sentence). Both are
   * excluded from `core_events` by SQL: the canonical-order gate and
   * `core_events_id_key`. So the set the old sentence described was empty, and the
   * set that is actually reachable is reachable by an ordinary client.
   *
   * ## What still holds, which is the part that matters
   *
   * For that shape the boundary places the correction in the room the unfolded
   * minting event was recorded in, and the fold places it in **no** room at all
   * (`null`, and an `unknown object` issue). That is a column-versus-fold
   * difference and it is *not* the cross-room misroute the finding is about: the
   * fold never answers a *different* room, because the only candidate rooms are
   * the ones `core_events_payload_room_matches` has already pinned to the column,
   * and two candidates in two rooms are refused outright. Live still equals
   * replay — both fold the same row to the same issue. The r6 critic went looking
   * for a case where the two oracles answer different rooms and reported finding
   * none. What r7 changes is the honesty of the bound, not the bound.
   *
   * Closing it entirely would mean folding inside the boundary, which means
   * running the reducer in SQL. The boundary is the ledger's oracle; it is not
   * and cannot be the fold's.
   *
   * The refusals are not the same set either, and the difference is the direction
   * you would expect: this function has two (unknown subject, subject in another
   * room) and the boundary has three — it also refuses a subject minted in more
   * than one room. That third one is not a log this function "can never produce"
   * either, and the reason it does not is worth naming because it is not in this
   * file: `commands.ts` mints every subject id with `randomUUID()`, so a client
   * cannot name an existing subject into a second room.
   */
  function resolveRoomId(
    event: RoomEvent,
    authorizedRoomId: string,
    sourceState: CoreState = state,
  ): string {
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
      fromState = sourceState.proposals[event.proposalId]?.proposal.roomId;
      subject = `proposal "${event.proposalId}"`;
    } else if (event.type === 'object_corrected') {
      fromState = sourceState.objects[event.objectId]?.object.roomId;
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

  async function appendBatch(request: AppendBatchRequest): Promise<AppendBatchResult> {
    if (request.builds.length === 0) {
      throw new CommandError('invalid', 'an atomic append batch must contain at least one event');
    }
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
          const actorColumns = actorToColumns(request.actor);
          if (request.idempotency) {
            if (actorColumns.id === null) {
              throw new CommandError('invalid', 'a system command cannot claim a retry key');
            }
            const [receipt] = await tx
              .select()
              .from(commandReceipts)
              .where(
                and(
                  eq(commandReceipts.roomId, request.roomId),
                  eq(commandReceipts.actorKind, actorColumns.kind),
                  eq(commandReceipts.actorId, actorColumns.id),
                  eq(commandReceipts.commandName, request.idempotency.commandName),
                  eq(commandReceipts.idempotencyKey, request.idempotency.key),
                ),
              )
              .limit(1);
            if (receipt) {
              if (receipt.payloadFingerprint !== request.idempotency.fingerprint) {
                throw new CommandError(
                  'conflict',
                  'that retry key already names a different command payload',
                );
              }
              const rows = await tx
                .select(ROW)
                .from(coreEvents)
                .where(
                  and(
                    eq(coreEvents.roomId, request.roomId),
                    gte(coreEvents.roomSeq, receipt.firstRoomSeq),
                    lte(coreEvents.roomSeq, receipt.lastRoomSeq),
                  ),
                )
                .orderBy(asc(coreEvents.roomSeq));
              const recovered = rows
                .map((row) => parseEntry(row))
                .map((entry) => {
                  // #46: a receipt that resolves to a malformed row cannot be
                  // verified against its expected event types. This is the
                  // command's own idempotent-replay path, not a read path a room
                  // depends on to hydrate, so refusing the retry (rather than
                  // skipping) is correct — the caller re-mints at the head.
                  if (entry.kind === 'malformed') {
                    throw new CommandError(
                      'conflict',
                      `the durable command receipt resolves to a malformed row (seq ${entry.seq}) that cannot be verified`,
                    );
                  }
                  return entry;
                });
              const actualTypes = recovered.map((entry) => entry.event.type);
              if (
                recovered.length !== receipt.eventCount ||
                actualTypes.length !== request.idempotency.expectedEventTypes.length ||
                actualTypes.some(
                  (type, index) => type !== request.idempotency?.expectedEventTypes[index],
                )
              ) {
                throw new CommandError(
                  'conflict',
                  'the durable command receipt does not resolve to its exact ledger batch',
                );
              }
              return {
                results: recovered.map((entry) => ({
                  ...withIssues(entry),
                  // The durable entry and its fold issues are exact. The
                  // transient reducer object was never stored and no batch
                  // caller consumes it.
                  outcome: null,
                })),
                staged: { state, seq: lastSeq, at: lastAtMs },
                replayed: true,
              };
            }
          }

          await request.prepare?.(tx);
          let stagedState = state;
          let stagedAtMs = lastAtMs;
          let stagedSeq = lastSeq;
          const results: AppendResult[] = [];

          for (const build of request.builds) {
            const atMs = Math.max(Date.now(), stagedAtMs + 1);
            const at = new Date(atMs).toISOString();
            const id = randomUUID();
            const built = build({ id, at });
            if (built.id !== id || built.at !== at) {
              throw new CommandError(
                'invalid',
                'a command may not choose its own ledger position — build() must use the assigned id and at',
              );
            }
            // #46 append-time guard (defense-in-depth): refuse a payload that
            // does not satisfy `RoomEvent` at the write boundary, so a bug in a
            // command handler cannot mint the very row the read path now has to
            // survive. It does NOT replace the read behaviour — rows predating
            // this guard, or written by any future/raw path around it, still
            // exist, which is the whole point of #46 — it just stops *this*
            // server from being the writer that creates one.
            const guard = RoomEvent.safeParse(built);
            if (!guard.success) {
              throw new CommandError(
                'invalid',
                `refusing to append a payload that does not satisfy RoomEvent: ${describeParseFailure(guard.error)}`,
              );
            }
            // #46 (MEDIUM 4): everything downstream uses the *parsed* event, not
            // the raw `build()` output. What gets folded, inserted into `payload`,
            // projected and returned in the `AppendResult` is `guard.data`, so a
            // cold read (which parses the `payload` column back through the same
            // schema) and this live fan-out cannot disagree — no `event as
            // RoomEvent` laundering that persists an object the read path would
            // narrow differently.
            const event: RoomEvent = guard.data;
            const roomId = resolveRoomId(event, request.roomId, stagedState);
            const actor = request.actor;

            const before = stagedState;
            let after = stagedState;
            let outcome: EventOutcome | null = null;
            /**
             * The window this event folded under.
             *
             * Not on its way anywhere: the `core_events_invariants` trigger derives
             * its own from the same `atrium_receipt_window` and assigns it onto the
             * row on the way in. This is kept only so the
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
              const applied = appendEvent(before, event, trusted);
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
              if (request.requireClean && applied.outcome === 'applied_with_issue') {
                throw new CommandError(
                  'invalid',
                  `atomic command refused: ${applied.issues.map((issue) => issue.reason).join('; ')}`,
                );
              }
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
              throw new CommandError(
                'conflict',
                'the ledger append procedure returned no position',
              );
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

            results.push({
              kind: 'event',
              seq,
              roomSeq,
              roomId,
              event,
              actor,
              outcome,
              issues: EMPTY_ISSUES,
            });
            stagedState = after;
            stagedSeq = seq;
            stagedAtMs = atMs;
          }
          if (request.idempotency) {
            const first = results[0];
            const last = results.at(-1);
            if (!first || !last || actorColumns.id === null) {
              throw new CommandError('conflict', 'the atomic command produced no receipt interval');
            }
            const actualTypes = results.map((result) => result.event.type);
            if (
              actualTypes.length !== request.idempotency.expectedEventTypes.length ||
              actualTypes.some(
                (type, index) => type !== request.idempotency?.expectedEventTypes[index],
              )
            ) {
              throw new CommandError(
                'conflict',
                'the atomic command built an unexpected event batch',
              );
            }
            await tx.insert(commandReceipts).values({
              roomId: request.roomId,
              actorKind: actorColumns.kind,
              actorId: actorColumns.id,
              commandName: request.idempotency.commandName,
              idempotencyKey: request.idempotency.key,
              payloadFingerprint: request.idempotency.fingerprint,
              firstRoomSeq: first.roomSeq,
              lastRoomSeq: last.roomSeq,
              eventCount: results.length,
            });
          }
          return {
            results,
            staged: { state: stagedState, seq: stagedSeq, at: stagedAtMs },
            replayed: false,
          };
        })
        .catch((error: unknown) => {
          throw asCommandError(error);
        });

      const { results, staged, replayed } = committed;
      // Adopted only now: an in-memory state that ran ahead of a rolled-back
      // transaction would reject the retry of the very command that failed.
      state = staged.state;
      lastSeq = Math.max(lastSeq, staged.seq);
      lastAtMs = Math.max(lastAtMs, staged.at);
      // Through `issuesFor` like every other path, and only after the state has
      // been adopted. Reading `outcome.issues` here instead would be a second
      // derivation of the same fact — the one that lets a live frame and a
      // `since` page disagree about whether a row applied.
      return {
        entries: results.map((result) => ({ ...result, issues: issuesFor(result.event.id) })),
        replayed,
      };
    });
  }

  async function append<T extends RoomEvent>(request: AppendRequest<T>): Promise<AppendResult> {
    const { entries } = await appendBatch({
      roomId: request.roomId,
      actor: request.actor,
      authorize: request.authorize,
      builds: [request.build],
      project: request.project as AppendBatchRequest['project'],
    });
    const [result] = entries;
    if (!result) throw new CommandError('conflict', 'the ledger append returned no event');
    return result;
  }

  return {
    hydrate: async () => {
      const folded = await runExclusive(() => catchUp(db));
      const malformed = folded.filter(isMalformedEntry).length;
      logger.info('ledger hydrated', {
        events: folded.length - malformed,
        malformed,
        lastSeq,
      });
    },
    coreState: () => state,
    serialize: () => serializeState(state),
    lastSeq: () => lastSeq,
    malformedCount: () => reportedMalformed.size,
    append,
    appendBatch,
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
      const entries = rows.map(parseEntry);
      // Fold first, then answer. A page can contain rows another instance
      // committed a moment ago; asking `issuesFor` about one this process has
      // not folded would answer "clean" for a row that was refused. This is also
      // what reports a malformed row (#46): `foldThrough` runs `catchUp`, which
      // logs and counts each malformed row once as it advances past it.
      await foldThrough(entries.at(-1)?.seq ?? 0);
      // #46: a malformed row is named in the answer (the marker rides through),
      // never thrown — `since(room, 0, 50)` resolves for a room with an
      // unreadable row instead of rejecting every reconnect forever.
      return entries.map((entry) => (entry.kind === 'malformed' ? entry : withIssues(entry)));
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
      const page = await db.transaction(
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
      // Outside the snapshot on purpose: the fold has to run *after* the page is
      // read, so it covers every row in it. A refused row must reach a cold
      // reader marked exactly as it reached a live one (#22 r10, D4) — this is
      // the catch-up half of that, and it is the same `issuesFor`.
      await foldThrough(page.entries.at(-1)?.seq ?? 0);
      // #46: `to`/`head` are computed over *all* rows including malformed ones,
      // so a client's cursor advances past a bad row; the marker rides out in
      // `entries` so the row is named rather than a silent hole. `withIssues`
      // only touches folded entries.
      return {
        ...page,
        entries: page.entries.map((entry) =>
          entry.kind === 'malformed' ? entry : withIssues(entry),
        ),
      };
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
          // #46: a malformed row is not foldable on replay any more than live —
          // excluding it keeps live ≡ replay, since `catchUp` excludes it too.
          if (entry.kind === 'malformed') {
            reportMalformed(entry);
            continue;
          }
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
