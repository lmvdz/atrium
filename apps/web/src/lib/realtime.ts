import { z } from 'zod';
import { loadRuntimeConfig } from './runtime-config';
import { resolveWsUrl } from './ws-url';

/**
 * The realtime client (#12/#14/#22).
 *
 * Three rules, and the whole file is them:
 *
 * 1. **`room_seq` is the only cursor.** Every room tracks `lastSeq`, the
 *    per-room sequence number of the last event applied. It is what a reconnect
 *    sends back as `since(room, lastSeq)`, and what tells a live event whether
 *    it is the next one or the far side of a gap.
 *
 * 2. **Catch up on reconnect, and on any gap.** A socket that dies mid-burst is
 *    ordinary; so is a delivery that never arrives. Both look identical from
 *    here — an event whose `roomSeq` is more than one past the cursor — and
 *    both are answered the same way: ask for the gap and apply it in order.
 *    Nothing is ever applied out of order, and nothing is applied twice.
 *
 *    That sentence is absolute and it is load-bearing, so note what has to hold
 *    for it: `applyEntry` decides both from `lastSeq` alone, and `lastSeq` comes
 *    out of the durable journal on the first read of a room. A stored record
 *    whose positions did not climb would hand it a cursor that disagrees with
 *    the events already in the timeline, and the sentence would be false without
 *    `applyEntry` doing anything wrong — which is exactly what r7's gauntlet
 *    found. `StoredRoom` is where that is now enforced; see its note.
 *
 *    Catch-up is a **loop**, not a call. The condition to keep going is
 *    `lastSeq < head` — never "was that page full?", and never the server's
 *    word for it alone. #22's r1 gauntlet found the server computing `more`
 *    from page fullness, which reports "caught up" during concurrent writes;
 *    a client that trusted one frame stopped there and lost the tail silently.
 *    The server's arithmetic is fixed too, but this client no longer depends on
 *    it: it asks again while its own cursor is behind the head it was told,
 *    whatever `more` says.
 *
 * 3. **Optimistic about your own message row, and nothing else.** A message you
 *    just typed appears immediately, marked `pending`, matched back to the
 *    server's event by `clientMessageId`. Every*thing* semantic — a proposal
 *    accepted, a decision corrected, a question answered — waits for the
 *    server. That asymmetry is the trust model, not a performance trade: the
 *    one thing you may render before the room agrees is the fact that you said
 *    something, because you are the authority on that and on nothing else
 *    (init.md §5, #12).
 *
 * The socket is injectable so all of this is testable without a browser or a
 * network; `apps/web/test/realtime.test.ts` drives it with a fake.
 */

/* ── the wire, as this client needs to see it ───────────────────────────── */

/**
 * Every wire shape below is a **schema**, and the types are read off it
 * (#22 gauntlet r6, major 1).
 *
 * These were hand-written `interface`s until r7, and the socket did
 * `JSON.parse(String(event.data)) as ServerFrame`. A cast is a promise the
 * compiler believes and nothing checks, and the r6 gauntlet showed what that
 * costs on this particular path: `applyEntry` **commits to the durable journal
 * and advances `lastSeq`**, so a frame this client accepts is a frame this
 * client will still believe after a reload — and a `roomSeq` it accepts once is
 * a position the real event can never occupy again (`if (entry.roomSeq <=
 * room.lastSeq) return`).
 *
 * The server-side hole that let a forged frame reach here is closed in
 * `apps/server/src/event-bus.ts`; this half is the client refusing to write
 * something it cannot read, which is a rule worth having on its own. It is the
 * same rule the ledger applies to `core_events` rows — parse, do not cast —
 * arriving at the last place in the system that was still casting.
 *
 * What is deliberately **not** tightened: the event body. `event` is
 * `{id, at, type}` plus whatever that kind carries, and this client renders
 * messages and counts positions rather than folding events, so demanding a full
 * per-kind schema here would create exactly the outage #46 is about — one row
 * the client cannot parse taking the whole room's catch-up down. The envelope is
 * checked; the body is passed through.
 */
const Envelope = z.object({
  roomId: z.string().min(1),
  roomSeq: z.number().int().positive(),
  seq: z.number().int().positive(),
  /**
   * `actor` is **beside** the event, not inside it. #21 took the actor out of the
   * event payload entirely — the schema has no place to put one and refuses an
   * input that carries one — because a payload is whatever the writer says it is
   * and every trust gate in the reducer reads the actor. The ledger stores it as
   * columns on the row and the wire carries it as a sibling of `event`. Nothing
   * in this client may read `entry.event.actor`; there is no such field.
   */
  actor: z.object({
    kind: z.string().min(1),
    userId: z.string().optional(),
    model: z.string().optional(),
  }),
  /**
   * The body is passed through — with one exception, and the exception is what
   * makes the sentence above true.
   *
   * `z.looseObject` keeps unknown keys, so `event.actor` survived the parse while
   * the comment said "there is no such field" (found by a foreign-lineage review
   * of r7's own first draft). The server refuses an actor in a payload at three
   * levels — `RoomEvent`'s guard, `CoreEvent.parse`, and the
   * `core_events_payload_has_no_actor` CHECK — so a body carrying one did not
   * come from the ledger, whatever else is true of it. Refusing it here is the
   * same rule at the last reader, and it costs nothing a real event needs.
   */
  event: z
    .looseObject({
      id: z.string().min(1),
      at: z.string().min(1),
      type: z.string().min(1),
    })
    .refine((body) => !('actor' in body), {
      message: 'a ledger payload carries no actor; the actor is beside the event',
    }),
  /**
   * Why the server refused this row, or `[]` when it applied (#22 r10, D4).
   *
   * **Defaulted rather than required**, for two readers that cannot be changed
   * in lockstep with the server: a journal record persisted by an older build,
   * which `StoredRoom` parses with this same schema and would otherwise discard
   * whole — throwing away a room's resume cache on the deploy that added a
   * field — and a server that has not been upgraded yet. Absent means "nothing
   * said it was refused", which is what an older ledger row means.
   *
   * The default is safe in the direction that matters: it cannot invent a
   * refusal, only fail to report one, and failing to report one is exactly the
   * behaviour of every build before this field existed.
   */
  issues: z.array(z.string()).default([]),
});

/** One ledger row, as the wire carries it. */
export type RoomEventEnvelope = z.infer<typeof Envelope>;

export const ServerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    connectionId: z.string(),
    userId: z.string(),
    heartbeatIntervalMs: z.number(),
  }),
  z.object({ type: z.literal('pong'), at: z.string() }),
  z.object({
    type: z.literal('subscribed'),
    roomId: z.string().min(1),
    head: z.number().int().min(0),
    seenSeq: z.number().int().min(0),
  }),
  z.object({ type: z.literal('unsubscribed'), roomId: z.string().min(1) }),
  z.object({ type: z.literal('event'), entry: Envelope }),
  /**
   * "This room is at `head`" — unsolicited, from the server's reconciler.
   *
   * A gap signal that does not depend on any frame having arrived. The client
   * treats it as it treats every other statement about the head: compare it with
   * its own cursor, and ask for the gap if it is behind.
   */
  z.object({
    type: z.literal('head'),
    roomId: z.string().min(1),
    head: z.number().int().min(0),
  }),
  /**
   * Every entry names the room the page names.
   *
   * The loop in `handleFrame` does its arithmetic against `view(frame.roomId)`
   * while `applyEntry` files each entry under `entry.roomId`, so a page whose
   * entries name a different room would move one room's journal on another room's
   * cursor. On the server both come from one query and cannot disagree; here they
   * are two fields of a parsed message, which is exactly the asymmetry r7 closed
   * on the bus (`EphemeralNote` refuses an envelope and a frame that name
   * different rooms) and had not closed on the socket. Second lineage, r7's own
   * review.
   */
  z
    .object({
      type: z.literal('catchup'),
      roomId: z.string().min(1),
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      head: z.number().int().min(0),
      more: z.boolean(),
      entries: z.array(Envelope),
    })
    .refine((frame) => frame.entries.every((entry) => entry.roomId === frame.roomId), {
      message: 'a catch-up page carries an entry for a different room',
    }),
  z.object({
    type: z.literal('ack'),
    commandId: z.string(),
    roomId: z.string(),
    /** `null` when nothing was appended — presence, typing, the read cursor. */
    seq: z.number().int().nullable(),
    roomSeq: z.number().int().nullable(),
    eventId: z.string().nullable(),
    issues: z.array(z.string()),
  }),
  z.object({
    type: z.literal('nack'),
    commandId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('presence'),
    roomId: z.string().min(1),
    userId: z.string(),
    state: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('typing'),
    roomId: z.string().min(1),
    userId: z.string(),
    typing: z.boolean(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('projection_changed'),
    roomId: z.string().min(1),
    at: z.string(),
  }),
  z.object({
    type: z.literal('seen'),
    roomId: z.string().min(1),
    userId: z.string(),
    seenSeq: z.number().int().min(0),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** The minimum of `WebSocket` this client uses. A browser socket satisfies it. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/* ── client state ───────────────────────────────────────────────────────── */

interface PendingAttachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  /** Retained only so an uncommitted send can replay the exact authorized frame. */
  capability: string;
}

interface PendingMessageBase {
  clientMessageId: string;
  body: string;
  at: string;
  status: 'pending' | 'failed';
  error?: string;
  attachments: PendingAttachment[];
  /**
   * Whether sending the identical frame again is a sensible thing to offer.
   *
   * True for a busy ledger (the server's `retry` nack) and for a socket that
   * dropped before answering; false for a refusal that will refuse again.
   * `clientMessageId` is an idempotency key, so a retry that turns out to have
   * been unnecessary collapses into the message that already landed.
   */
  retryable?: boolean;
}

export type PendingMessage = PendingMessageBase &
  (
    | {
        commandName: 'send_message';
        replyToId: string | null;
        mentionUserIds: string[];
      }
    | {
        commandName: 'answer_message';
        questionId: string;
      }
  );

/**
 * The room's applied history and its cursor, stored as **one thing**.
 *
 * ## Why this is not a watermark store (#22 gauntlet r2 delta, major 1)
 *
 * Round 2 had a `WatermarkStore` with `read`/`write`, and `applyEntry` did this:
 * push the event onto an in-memory array, then write the cursor. Two steps, and
 * the gauntlet found the window between them —
 *
 * > the client watermark is not crash-safe: it advances after mutating an
 * > in-memory list, so a crash between the write and the persistence resumes
 * > past an unheld event.
 *
 * — which is exactly right, and it is worse than it sounds, because the two
 * halves had *different lifetimes*. The events lived in memory and the cursor
 * could live in `localStorage`, so a reload resumed from a durable cursor into
 * an empty timeline: a room that believes it is up to date and holds nothing.
 * r2 knew about that and answered it in a doc comment telling callers to "pair a
 * durable store with a durable event cache, or not at all" — an instruction,
 * where the type could have made the pairing impossible to get wrong.
 *
 * So the interface takes both together. `commit` is handed the event **and** the
 * cursor that event implies, and an implementation that persists is required to
 * make them durable in one operation — one `setItem` of one JSON value, one
 * IndexedDB transaction, one row. There is then no interval during which the
 * cursor names an event the store does not hold, because there is no moment at
 * which only one of them has been written.
 *
 * The client's in-memory view is seeded from `load`, so the cursor a room
 * resumes at is always a cursor whose event is in the array beside it.
 * `apps/web/test/realtime.test.ts` crashes a client mid-page — the journal
 * throws partway through a five-entry catch-up — and asserts the resumed
 * client's `lastSeq` names an event it actually holds.
 */
export interface RoomJournal {
  /** Everything durably applied for this room, and the cursor that goes with it. */
  load: (roomId: string) => { events: RoomEventEnvelope[]; lastSeq: number };
  /**
   * Record one applied entry and the cursor it implies, **atomically**.
   *
   * `lastSeq` is always `entry.roomSeq`; it is a separate parameter rather than
   * derived so the contract is legible at the call site and an implementation
   * writing a compact record does not have to re-derive the client's own
   * arithmetic. An implementation may not persist one without the other.
   */
  commit: (roomId: string, entry: RoomEventEnvelope, lastSeq: number) => void;
  /**
   * Throw this room's record away and start again from nothing.
   *
   * Added in r7 for one caller and one reason: the client resuming from a record
   * the **server** contradicts. Shape validation cannot tell a real record from a
   * well-formed forgery — `localStorage` is same-origin and carries no
   * provenance — so the check that can be made is arithmetic rather than
   * structural: a cursor past the room's head is a cursor for history the room
   * does not have, whoever wrote it. The answer is to stop believing the record,
   * which costs one catch-up and is the same trade `reads a torn record as no
   * history at all` already makes.
   *
   * Not a general "delete": there is no caller that wants to forget a room it is
   * still resuming from, and there must not be one.
   */
  reset: (roomId: string) => void;
}

/**
 * The default: lives exactly as long as the client does.
 *
 * Crash-safe by construction rather than by care — a process that dies takes the
 * events and the cursor with it, so there is no state left to be inconsistent.
 * It is still written through the same two-in-one interface, because a default
 * whose shape differs from the durable one is a default that hides the durable
 * one's bugs.
 */
export function memoryJournal(): RoomJournal {
  const rooms = new Map<string, { events: RoomEventEnvelope[]; lastSeq: number }>();
  const room = (roomId: string) => {
    let existing = rooms.get(roomId);
    if (!existing) {
      existing = { events: [], lastSeq: 0 };
      rooms.set(roomId, existing);
    }
    return existing;
  };
  return {
    load: (roomId) => {
      const current = room(roomId);
      return { events: [...current.events], lastSeq: current.lastSeq };
    },
    commit: (roomId, entry, lastSeq) => {
      const current = room(roomId);
      current.events.push(entry);
      current.lastSeq = Math.max(current.lastSeq, lastSeq);
    },
    reset: (roomId) => {
      rooms.delete(roomId);
    },
  };
}

/**
 * How many events one room keeps in `localStorage`.
 *
 * Chosen against the store rather than against a room: browsers give an origin
 * on the order of 5 MB *in total*, and a message event serializes to a few
 * hundred bytes, so a few hundred events per room leaves room for several rooms
 * and everything else the origin keeps. It is an option because the right number
 * is a property of the deployment, not of this file.
 */
export const DEFAULT_JOURNAL_MAX_EVENTS = 500;

export interface LocalStorageJournalOptions {
  /** Events retained per room. Older ones are evicted; see the note on the type. */
  maxEvents?: number;
  /**
   * Called when this journal stops being durable for a room, with the reason.
   *
   * Not a silent degradation: a client whose journal has fallen back to memory
   * still works and still recovers, but it re-fetches the whole room on the next
   * reload, and an operator looking at why should be able to find out.
   *
   * **Omitting it does not make degradation silent.** With no callback the
   * default below writes one `console.warn` per room — because r4's version
   * reported nothing at all unless a caller opted in, and "the journal quietly
   * stopped being durable" is the failure this whole option exists to surface
   * (r4 delta, major). Pass `() => {}` to mean it, which is a decision somebody
   * had to write down.
   *
   * A callback that throws is caught: the journal's contract is that `commit`
   * does not throw, and a contract that a caller's logging can break is not a
   * contract.
   */
  onDegraded?: (roomId: string, reason: string) => void;
}

/**
 * What `onDegraded` does when nobody supplied one.
 *
 * `console.warn` rather than `console.error`: nothing is broken and nothing is
 * lost — the room still works, it will simply be re-read from the server on the
 * next load. But it happens once per room and it is the only evidence that the
 * client's resume cache is gone, so it is not nothing either.
 */
function warnDegraded(roomId: string, reason: string): void {
  console.warn(`[atrium] room ${roomId}: journal degraded to memory — ${reason}`);
}

/**
 * One room's durable record, as the schema it is read back with.
 *
 * The write side is `{events, lastSeq}` and the read side used to trust that on
 * the strength of two `typeof` checks and a cast. See the note at the read for
 * why this is the strict one of the two parses in this file.
 *
 * ## The record has to be a *history*, not merely well-typed (r7, defect 2)
 *
 * r7 put the envelope schema here and left the record's own structure to one
 * comparison at the read: `lastSeq === events.at(-1).roomSeq`. That is a check
 * on the last element and says nothing about the ones before it, so
 * `{events: [{roomSeq: 9, …}, {roomSeq: 2, …}], lastSeq: 2}` was accepted — the
 * last event is 2, the cursor is 2, the record agrees with itself. The 9 is then
 * already in the timeline while the cursor sits at 2, `applyEntry` dedups on
 * `roomSeq <= lastSeq`, and the *real* event at 9 arrives in catch-up and is
 * applied a second time. The room renders `[9,2,3,4,5,6,7,8,9]` in a client
 * whose first paragraph says nothing is ever applied out of order and nothing is
 * applied twice.
 *
 * Those two sentences are absolute, this schema is where they are cashed, so
 * both halves of "is this a history" are checked here rather than at the caller:
 *
 *  * `room_seq` **strictly increases**. It is minted per room by the table, so
 *    it climbs and never repeats; equal adjacent positions is the same forgery
 *    with the duplicate already in the record. Strictly increasing rather than
 *    contiguous, because eviction drops from the front and the client is allowed
 *    to hold a window — `[2,3]` is an ordinary trimmed record, `[3,2]` is not a
 *    record at all.
 *  * the cursor names the **last event held**. Unchanged in meaning from r7 and
 *    moved in here, because it is the same question: an empty record carries
 *    cursor 0, and a non-empty one carries its final position.
 *
 * What this does *not* claim is what the head check already says it does not:
 * the store carries no provenance, so a forgery that satisfies both of these is
 * still writable by anything on the origin, and a plausible one at or below the
 * room's head still displaces real events. The bound this closes is narrower and
 * exact — a record that reaches the timeline cannot make it render a position
 * twice, or out of order, which is what the two sentences promise.
 */
const StoredRoom = z
  .object({
    events: z.array(Envelope),
    lastSeq: z.number().int().min(0),
  })
  .superRefine((record, ctx) => {
    for (let i = 1; i < record.events.length; i += 1) {
      const previous = record.events[i - 1];
      const current = record.events[i];
      if (previous !== undefined && current !== undefined && current.roomSeq <= previous.roomSeq) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', i, 'roomSeq'],
          message: `room_seq must increase: ${previous.roomSeq} is followed by ${current.roomSeq}`,
        });
        return;
      }
    }
    const held = record.events.at(-1)?.roomSeq ?? 0;
    if (record.lastSeq !== held) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastSeq'],
        message: `the cursor must name the last event held: ${record.lastSeq} against ${held}`,
      });
    }
  });

/**
 * A `localStorage`-backed journal.
 *
 * One key per room holding `{events, lastSeq}` as one JSON value, so the durable
 * write is a single `setItem` — which is the whole reason this is a journal and
 * not a watermark. `localStorage` offers no transaction across two keys, so two
 * keys would reintroduce the window this interface exists to close; one key is
 * how you get atomicity out of a store that does not offer any.
 *
 * A record that does not parse, or whose cursor disagrees with its events, is
 * read as no history at all. That is deliberate: a torn write is the one case
 * where resuming is *worse* than replaying, and a room is cheap to reload.
 *
 * ## Bounded, and it never throws (#22 gauntlet r3 delta, major 2)
 *
 * > `localStorageJournal` is unbounded with no `QuotaExceededError` handling — a
 * > long room throws on every `applyEntry` after quota and stalls durable apply.
 *
 * Exactly right, and the second clause is the damaging one. `applyEntry` commits
 * *before* moving the in-memory view, so a throw from here leaves the client's
 * cursor where it was — which is the crash-safety property, and which turns into
 * a permanent stall when the throw is not transient. A full quota is not
 * transient: every subsequent event takes the same path and fails the same way,
 * and the room stops advancing at all. An unbounded store guarantees reaching
 * that state on any room that runs long enough.
 *
 * Two changes, and the second one is the contract:
 *
 * 1. **A bound.** The newest `maxEvents` are kept and older ones are evicted from
 *    the front. This is a *resume cache*, not an archive: the cursor still names
 *    the last event held, so the invariant this whole interface exists for is
 *    untouched, and a room whose scrollback was evicted re-reads it from the
 *    server like any other room the client does not have. What it must never do
 *    is grow until the store refuses it.
 * 2. **`commit` does not throw.** A write that cannot be made durable evicts
 *    harder and retries; if even a single entry will not fit, the room degrades
 *    to the in-memory journal, seeded with what it holds, and `onDegraded` says
 *    so. The client then behaves exactly like one configured with `memoryJournal`
 *    — it recovers everything from the server on the next load — instead of
 *    freezing. Throwing would preserve durability at the cost of the room, which
 *    is the wrong trade for a cache.
 *
 * The `RoomJournal` contract still permits a throw, and `applyEntry` still
 * handles one correctly; this implementation simply has no failure for which
 * stopping is better than degrading.
 *
 * ## "Never throws" is now true, and degradation is never silent (r4 delta)
 *
 * Round 4 claimed both and held neither:
 *
 * > the journal's `commit` can throw — `getItem` is outside the storage `try`,
 * > and an `onDegraded` callback may throw — and degrades silently when no
 * > callback is supplied.
 *
 * Three ways out, all closed. `getItem` is inside a `try` of its own: browsers
 * that refuse storage do it on *access* in some builds and on *use* in others,
 * and a read that throws is a store this room cannot use — so it degrades rather
 * than reporting "no history", which would look like a fresh room and re-fetch
 * silently. `JSON.parse` was already guarded. `onDegraded` is invoked inside a
 * `try`, because a caller's logging must not be able to break the one property
 * this type advertises. And with no callback at all the default writes a warning
 * (`warnDegraded`), so "nobody was told" is not reachable by omission — it takes
 * an explicit `() => {}`.
 *
 * `apps/web/test/realtime.test.ts` drives each of the three through a `Storage`
 * stub that throws where the real one would, and asserts `commit` returns.
 *
 * ## The fourth way out, which round 5 did not find (r5 delta, major 3)
 *
 * > `storage()` returns `null` when access itself throws (private mode), and
 * > `commit` falls back to memory without `report`/`warnDegraded`. The three
 * > closed throws are real; "never degrades in silence" is not yet true.
 *
 * Correct, and it is the same shape as the three: a `catch` that returns a
 * *value* instead of reporting a *fact*. `storage()` swallowed the private-mode
 * throw into `null`, and `null` is indistinguishable from "this environment has
 * no `localStorage`" — so every caller downstream had a fallback to reach for and
 * nothing to say. The room worked and re-fetched itself on every load for ever,
 * which is exactly the silence the round before had ruled out for the other
 * three doors.
 *
 * `storage()` returns the reason with the answer now, and both `null` cases —
 * refused on access, and absent altogether — go through the same `degrade`, so
 * they are reported once per room like everything else. Server-side rendering is
 * the honest cost: a `localStorageJournal` constructed where there is no
 * `localStorage` will warn once per room rather than pretending it is durable.
 * That is the report being right, not a regression.
 *
 * Which makes the list of ways this journal can stop being durable exactly four,
 * and every one of them says so: refused on access, refused on read, refused on
 * write (quota, after eviction), and absent. `onDegraded` throwing is the fifth
 * door and it is closed differently — swallowed, because the fallback for a
 * broken reporter would be the reporter.
 */
export function localStorageJournal(
  namespace: string,
  options: LocalStorageJournalOptions = {},
): RoomJournal {
  const key = (roomId: string) => `atrium:journal:${namespace}:${roomId}`;
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_JOURNAL_MAX_EVENTS);
  const fallback = memoryJournal();
  // Not `options.onDegraded?.(…)` at the call site: `?.` on an absent callback is
  // exactly the silent degradation the finding named.
  const report = options.onDegraded ?? warnDegraded;
  /** Rooms this journal has stopped being durable for. */
  const degraded = new Set<string>();
  /**
   * The store, or the reason there is not one.
   *
   * A `Storage | null` was the fourth silent path (r5 delta, major 3): `commit`
   * read the `null`, fell back to memory, and told nobody — so a private-mode
   * browser, where access itself throws, was the one degradation the round that
   * closed the other three left open. The reason travels with the answer now,
   * because a caller holding only `null` has nothing to report.
   *
   * Both `null` cases are degradation and both are reported. "No `localStorage`
   * in this environment" is not a lesser failure than a refused one: a caller
   * that asked for a durable journal and is not getting one should be told once
   * per room, whichever way the store is missing.
   */
  const storage = (): { store: Storage } | { store: null; reason: string } => {
    try {
      if (typeof localStorage === 'undefined') {
        return { store: null, reason: 'localStorage is not available in this environment' };
      }
      return { store: localStorage };
    } catch (error) {
      // Private-mode and blocked-cookie browsers throw on *access*, not on use.
      return { store: null, reason: describeStorageError(error) };
    }
  };
  /** Keep the newest `maxEvents`. The cursor names the last of them either way. */
  const trim = (events: RoomEventEnvelope[]): RoomEventEnvelope[] =>
    events.length <= maxEvents ? events : events.slice(events.length - maxEvents);

  /**
   * Hand this room over to memory, keeping everything already held.
   *
   * Seeded rather than emptied: `load` must keep returning a cursor whose event
   * it holds, and dropping the history while keeping the cursor is the exact
   * inconsistency `RoomJournal` was built to make unrepresentable.
   *
   * Declared before its callers on purpose: `readDurable` degrades too, and a
   * reader should not have to check whether a `const` arrow is initialised by the
   * time the other one runs.
   */
  const degrade = (
    roomId: string,
    held: { events: RoomEventEnvelope[]; lastSeq: number },
    reason: string,
  ): void => {
    if (degraded.has(roomId)) return;
    degraded.add(roomId);
    for (const event of held.events) fallback.commit(roomId, event, event.roomSeq);
    try {
      report(roomId, reason);
    } catch {
      // A caller's logging is not allowed to break `commit`'s "never throws".
      // Swallowed rather than re-reported: the fallback for a broken reporter
      // would be the reporter.
    }
  };

  const readDurable = (roomId: string): { events: RoomEventEnvelope[]; lastSeq: number } => {
    const access = storage();
    if (!access.store) {
      // Not `{events: [], lastSeq: 0}`: "no history" is a legitimate answer that
      // means "fresh room", and returning it for a store that does not exist is
      // the same silent lie a store that refuses to be read used to tell.
      degrade(roomId, fallback.load(roomId), access.reason);
      return fallback.load(roomId);
    }
    const store = access.store;
    let raw: string | null;
    try {
      raw = store.getItem(key(roomId));
    } catch (error) {
      // A store that refuses to be *read* is a store this room cannot use.
      // Degrading rather than returning "no history" matters: "no history" is a
      // legitimate answer that means "fresh room", and reporting it here would
      // make an unusable store look like an empty one for ever — silently
      // re-fetching the whole room on every load and never saying why.
      degrade(roomId, fallback.load(roomId), describeStorageError(error));
      return fallback.load(roomId);
    }
    if (raw === null) return { events: [], lastSeq: 0 };
    try {
      // Parsed against the same envelope schema the socket uses, not cast
      // (#22 gauntlet r6, major 1). `localStorage` is durable state this client
      // reads back and believes: a poisoned record is a `lastSeq` this client
      // resumes from, so every real event at or below it is skipped for good.
      // The store is shared with everything else on the origin and survives
      // reloads, which makes it the *most* attacker-durable input here, not the
      // least — and it was the one still going through `as RoomEventEnvelope[]`.
      //
      // A record that does not parse is treated exactly like a torn one: no
      // history, cursor 0, refetch. That is already the safe answer here — the
      // room is re-read from the ledger — and it is why this can be strict
      // without risking the outage #46 is about.
      // `StoredRoom` now carries both structural invariants — `room_seq`
      // strictly increasing, and the cursor naming the last event held. r7 had
      // the second of those as a comparison here and did not have the first at
      // all, which is r7 defect 2: a record can agree with its own cursor and
      // still not be a history. See the schema for the exploit it admitted.
      const stored = StoredRoom.safeParse(JSON.parse(raw));
      if (!stored.success) return { events: [], lastSeq: 0 };
      const { events, lastSeq } = stored.data;
      // The one invariant the schema cannot state, because it needs the key:
      // these have to be *this room's* events. The key says which room; the
      // envelopes carry their own `roomId` and `view()` renders `held.events` as
      // this room's timeline without ever re-reading it. Asking the same
      // question of the same store — what is this made of, and who wrote it —
      // the answer is "same-origin JSON anyone can author", and an entry filed
      // under room A carrying room B's `roomId` is cross-room content injection
      // for the cost of one `setItem`. Same answer as every other way this
      // record can fail to be a history: no history, cursor 0, refetch.
      if (events.some((entry) => entry.roomId !== roomId)) return { events: [], lastSeq: 0 };
      return { events, lastSeq };
    } catch {
      return { events: [], lastSeq: 0 };
    }
  };

  const readRoom = (roomId: string): { events: RoomEventEnvelope[]; lastSeq: number } => {
    if (degraded.has(roomId)) return fallback.load(roomId);
    // `readDurable` is the single place that decides whether a store exists and
    // says so. Asking `storage()` here as well was how the answer and the report
    // came apart: this branch returned the fallback and `readDurable`'s reporting
    // never ran.
    return readDurable(roomId);
  };

  return {
    load: readRoom,
    commit: (roomId, entry, lastSeq) => {
      const access = storage();
      if (!access.store) {
        // Degrade *then* commit, in that order: `degrade` seeds the fallback with
        // what was held before this entry, so committing first would file it
        // twice. Reported once per room, like every other way out of durability.
        degrade(roomId, fallback.load(roomId), access.reason);
        fallback.commit(roomId, entry, lastSeq);
        return;
      }
      const store = access.store;
      if (degraded.has(roomId)) {
        fallback.commit(roomId, entry, lastSeq);
        return;
      }
      const current = readDurable(roomId);
      // `readDurable` degrades the room if the store refuses to be read, and the
      // entry must land where the room now lives. Without this the `setItem`
      // below would fail its way down to a `degrade` that is already a no-op, and
      // the event would be dropped — the one outcome a journal may not have.
      if (degraded.has(roomId)) {
        fallback.commit(roomId, entry, lastSeq);
        return;
      }
      current.events.push(entry);
      let kept = trim(current.events);
      for (;;) {
        try {
          store.setItem(key(roomId), JSON.stringify({ events: kept, lastSeq }));
          return;
        } catch (error) {
          // Halve and retry: the quota is about bytes and this is the cheapest
          // way to find a size that fits without measuring the store. One entry
          // that will not fit is a store that cannot hold this room at all.
          if (kept.length > 1) {
            kept = kept.slice(Math.ceil(kept.length / 2));
            continue;
          }
          // `current.events` already carries `entry`, so the seed is the whole
          // history including this commit — no second write, and no duplicate.
          degrade(roomId, { events: current.events, lastSeq }, describeStorageError(error));
          return;
        }
      }
    },
    /**
     * Forget this room, on disk and not only in this object (r7, defect 3).
     *
     * The caller reaches here having decided the stored record is not this
     * room's history — today that is the head check in `subscribed` — so the
     * only thing `reset` owes it is that the record stops being resumed. r7
     * caught a throwing `removeItem` and degraded, which made the promise true
     * for the live instance and false for the store: the poisoned key survived,
     * and the next page load built a fresh journal with an empty `degraded` set,
     * read the forgery again, fired the same check again, and degraded again.
     * "Resumes from nothing" is a claim about resuming, which is what happens
     * after a reload, so a degradation cannot be the whole of it.
     *
     * Two doors, tried in order. `removeItem` is the right one and is what
     * ordinarily runs. If it throws, `setItem` of the empty record is the same
     * outcome by another route: `{events: [], lastSeq: 0}` is precisely what a
     * missing key reads back as, so overwriting is erasing as far as every
     * reader is concerned, and it leaves nothing behind to resume.
     *
     * If both throw the store is not writable at all, and the honest statement
     * is narrower than the one r7 made: this instance resumes from nothing, the
     * record stays on disk, and every later load re-reads it and re-runs the
     * check that sent us here. That costs one discard and one catch-up per load
     * — noisy, bounded, and not a corruption — and it is reported once per room
     * like every other way out of durability.
     */
    reset: (roomId) => {
      fallback.reset(roomId);
      const access = storage();
      if (!access.store) return;
      try {
        access.store.removeItem(key(roomId));
        return;
      } catch {
        // Fall through: a store that refuses to delete may still accept a write,
        // and an empty record is indistinguishable from a deleted one on read.
      }
      try {
        access.store.setItem(key(roomId), JSON.stringify({ events: [], lastSeq: 0 }));
      } catch (error) {
        degrade(roomId, { events: [], lastSeq: 0 }, describeStorageError(error));
      }
    },
  };
}

/**
 * A storage failure in words, without assuming `DOMException` exists.
 *
 * "…refused the write" until r6, which was true of one of the three throws it
 * describes: this is also what a refused *read* and a refused *access* are
 * reported as. A message that names the wrong operation sends the next person
 * looking at the wrong half of the journal.
 */
function describeStorageError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'localStorage is full — this room is now kept in memory and will be re-read from the server on the next load';
  }
  const message = error instanceof Error ? error.message : String(error);
  return `localStorage is unusable (${message}) — this room is now kept in memory`;
}

export interface RoomView {
  roomId: string;
  /** The per-room cursor. Everything about recovery hangs off this number. */
  lastSeq: number;
  /** The room's newest sequence as of the last server word on it. */
  head: number;
  /** This user's read cursor — the "since you left" divider. */
  seenSeq: number;
  /**
   * Applied events, in `room_seq` order. Never out of order, never repeated.
   *
   * True of everything `applyEntry` puts here, and — since r8 — of the resumed
   * prefix too, which is where r7's gauntlet found it false: a stored record was
   * checked against its own cursor and not against itself, so a forged one could
   * seed this array out of order and get a real position rendered twice.
   * `StoredRoom` refuses that record now. What is still *not* claimed is that
   * every entry here is authentic: a forgery under the room's head is
   * well-ordered and indistinguishable from history on this side of the socket.
   */
  events: RoomEventEnvelope[];
  /** Own messages not yet confirmed. The only optimistic thing here. */
  pending: PendingMessage[];
  /** Who is present, as last broadcast. Never persisted; never replayed. */
  presence: Record<string, string>;
  typing: string[];
  subscribed: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeClientOptions {
  /**
   * The authenticated viewer, used only for optimistic reconciliation and
   * filtering their own seen cursor. The server derives identity from the
   * Better Auth cookie on the WebSocket upgrade; this value is not sent as
   * authentication.
   */
  userId: string;
  /** Override the resolved URL. Normally omitted; see `ws-url.ts`. */
  url?: string;
  socketFactory?: SocketFactory;
  /** `false` disables reconnection entirely (tests, and one-shot tools). */
  reconnect?: false | { initialDelayMs?: number; maxDelayMs?: number; factor?: number };
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  onError?: (message: string) => void;
  /**
   * Where this room's applied events and its cursor are kept — together. In
   * memory unless you say otherwise; see `RoomJournal` for why the two are one
   * interface and not two.
   */
  journal?: RoomJournal;
  /**
   * How many entries to ask for per catch-up page.
   *
   * Defaulted rather than fixed because the *tests* need it: with the server's
   * 1000-entry default, a 12- or 40-event fixture never crosses a page boundary,
   * so multi-page catch-up went unexercised by anything but a fake socket
   * (#22 gauntlet r2 delta, major 2). The integration suite sets it to a handful
   * and the loop is then a real loop over real pages.
   */
  catchUpPageSize?: number;
  /**
   * How many catch-up rounds may make no progress before the client stops
   * asking. A loop with no floor is a loop that can spin against a server whose
   * `head` names a position it will not send — so it gives up, loudly, instead
   * of hammering. Reaching this is a bug somewhere; silence about it would be a
   * second one.
   */
  maxStalledCatchups?: number;
}

export interface RealtimeClient {
  connect: () => Promise<void>;
  close: () => void;
  status: () => ConnectionStatus;
  /** Join a room: subscribe, then close any gap since `lastSeq`. */
  join: (roomId: string) => void;
  leave: (roomId: string) => void;
  room: (roomId: string) => RoomView;
  rooms: () => string[];
  lastSeq: (roomId: string) => number;
  /** Post a message. Returns the `clientMessageId` its optimistic row is keyed on. */
  sendMessage: (
    roomId: string,
    body: string,
    options?: {
      replyToId?: string | null;
      attachments?: Array<{
        key: string;
        name: string;
        contentType: string;
        size: number;
        capability: string;
      }>;
      mentionUserIds?: string[];
    },
  ) => string;
  /** Retry one failed optimistic row with its original idempotency key and exact metadata. */
  retryMessage: (roomId: string, clientMessageId: string) => boolean;
  answerMessage: (
    roomId: string,
    questionId: string,
    body: string,
    attachments?: Array<{
      key: string;
      name: string;
      contentType: string;
      size: number;
      capability: string;
    }>,
  ) => string;
  acceptProposal: (roomId: string, proposalId: string, objectiveId?: string | null) => string;
  rejectProposal: (roomId: string, proposalId: string, reason?: string | null) => string;
  correctObject: (
    roomId: string,
    objectId: string,
    action: 'retype' | 'amend' | 'reattribute' | 'reject' | 'reopen',
    options?: {
      patch?: Record<string, unknown>;
      toType?: 'decision' | 'commitment' | 'open_question' | 'claim' | 'objective' | null;
      note?: string | null;
    },
  ) => string;
  answerBind: (roomId: string, questionId: string, answerObjectId: string) => string;
  supersedeObject: (
    roomId: string,
    replacementObjectId: string,
    retiredObjectId: string,
    options?: { clientSupersessionId?: string; note?: string | null },
  ) => { commandId: string; clientSupersessionId: string };
  resolveAttention: (
    roomId: string,
    attentionId: string,
    status?: 'resolved' | 'dismissed',
  ) => string;
  advanceSeen: (roomId: string, roomSeq?: number) => void;
  setPresence: (roomId: string, state: 'online' | 'away' | 'offline') => void;
  setTyping: (roomId: string, typing: boolean) => void;
  /** Subscribe to any change. Returns an unsubscribe function. */
  onChange: (
    listener: (roomId: string, view: RoomView, reason: 'state' | 'projection') => void,
  ) => () => void;
  onStatus: (listener: (status: ConnectionStatus) => void) => () => void;
}

const DEFAULT_RECONNECT = { initialDelayMs: 300, maxDelayMs: 10_000, factor: 2 };
const DEFAULT_MAX_STALLED_CATCHUPS = 8;

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as never));
  const factory: SocketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const backoff =
    options.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...options.reconnect };

  const journal = options.journal ?? memoryJournal();
  const catchUpPageSize = options.catchUpPageSize;
  const maxStalledCatchups = options.maxStalledCatchups ?? DEFAULT_MAX_STALLED_CATCHUPS;

  const rooms = new Map<string, RoomView>();
  const changeListeners = new Set<
    (roomId: string, view: RoomView, reason: 'state' | 'projection') => void
  >();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  /** commandId → the pending own-message it optimistically rendered. */
  const inFlight = new Map<string, { roomId: string; clientMessageId: string }>();
  /** Consecutive catch-up rounds that asked for a gap and got no closer to it. */
  const stalled = new Map<string, number>();

  let socket: SocketLike | null = null;
  let status: ConnectionStatus = 'idle';
  let attempts = 0;
  let retryHandle: unknown = null;
  let closedByUs = false;
  let nextCommandId = 0;

  function view(roomId: string): RoomView {
    let existing = rooms.get(roomId);
    if (!existing) {
      // Events and cursor together, from one read. They cannot disagree: a
      // journal that persists is required to write them in one operation, and
      // one that finds them inconsistent reports no history at all.
      const held = journal.load(roomId);
      existing = {
        roomId,
        lastSeq: held.lastSeq,
        head: held.lastSeq,
        seenSeq: 0,
        // The same filter `applyEntry` applies live, applied to what was
        // resumed: the journal holds every row it walked past — that is what
        // makes its cursor meaningful — and the room holds only the rows that
        // took effect. A record written by an older build has no `issues` on any
        // entry and so resumes exactly as it always did.
        events: held.events.filter((entry) => entry.issues.length === 0),
        pending: [],
        presence: {},
        typing: [],
        subscribed: false,
      };
      rooms.set(roomId, existing);
    }
    return existing;
  }

  function changed(roomId: string, reason: 'state' | 'projection' = 'state'): void {
    const current = view(roomId);
    for (const listener of changeListeners) listener(roomId, current, reason);
  }

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
  }

  function fail(message: string): void {
    options.onError?.(message);
  }

  const OPEN = 1;

  function send(frame: unknown): boolean {
    if (socket?.readyState !== OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function nextId(): string {
    nextCommandId += 1;
    return `c${nextCommandId}`;
  }

  function command(command: Record<string, unknown>): string {
    const commandId = nextId();
    send({ type: 'command', commandId, command });
    return commandId;
  }

  async function resolveUrl(): Promise<string> {
    if (options.url) return options.url;
    const config = await loadRuntimeConfig();
    return resolveWsUrl(config);
  }

  function applyEntry(entry: RoomEventEnvelope): void {
    const room = view(entry.roomId);
    // Already applied. At-least-once delivery plus catch-up means a client sees
    // the same event twice routinely; applying it twice would double every
    // message in the burst that a reconnect straddles.
    if (entry.roomSeq <= room.lastSeq) return;
    if (entry.roomSeq > room.lastSeq + 1) {
      // A hole. Do not apply out of order — ask for the gap and let the
      // catch-up put everything in, in sequence.
      requestSince(entry.roomId);
      return;
    }
    // Durable first, in one operation, and only then in memory.
    //
    // The order is the fix for r2-delta major 1. r2 mutated the in-memory array
    // and then wrote the cursor, so a crash in between left a cursor naming an
    // event nothing held. Committing the event and the cursor together, before
    // the in-memory view moves, means the two states a crash can leave are
    // "neither" and "both" — and a throw from the journal leaves the client's
    // own cursor where it was, so the entry is simply re-delivered by the next
    // catch-up rather than skipped.
    journal.commit(entry.roomId, entry, entry.roomSeq);
    // ── A refused row is not an event that happened ──────────────────────────
    //
    // #22 r10, D4. The server appends a row whose business checks failed
    // (`applied_with_issue`), because it *did* take a position in the log — but
    // it changed nothing, and until r10 it arrived here indistinguishable from a
    // row that changed everything. "Victim will work through the holidays",
    // refused on the server, landed in this array on every socket in the room
    // and survived a reload.
    //
    // Journalled but not shown, and both halves are load-bearing:
    //
    //  - **Journalled**, because `room_seq` is a gap-free sequence and the
    //    journal's own record requires its cursor to name the last entry it
    //    holds. Skipping the write would either strand the cursor ahead of the
    //    history — making the whole record unparseable on the next load — or
    //    leave a hole this same function would read as loss and re-request
    //    forever.
    //  - **Not shown**, because `room.events` is what the room *is*. A sentence
    //    the server refused is not part of it, and rendering it with a badge
    //    would still put somebody else's obligation in front of the person it
    //    names.
    //
    // The actor already learns why, from the `issues` on their own `ack`.
    if (entry.issues.length === 0) room.events.push(entry);
    room.lastSeq = entry.roomSeq;
    room.head = Math.max(room.head, entry.roomSeq);
    // Called for a refused row too: the optimistic echo it would have confirmed
    // has to be retired either way, or a send that the server refused sits in
    // the timeline forever with nothing to clear it.
    reconcilePending(room, entry);
    changed(entry.roomId);
  }

  /**
   * Retire the optimistic row this event confirms.
   *
   * Matched on `clientMessageId` *and* on the event being this user's own,
   * because the key is client-chosen: two clients could pick the same one, and
   * dropping someone else's echo would delete a message from the timeline.
   */
  function reconcilePending(room: RoomView, entry: RoomEventEnvelope): void {
    if (entry.event.type !== 'message_posted') return;
    const clientMessageId = entry.event.clientMessageId;
    if (typeof clientMessageId !== 'string') return;
    if (entry.actor.userId !== options.userId) return;
    room.pending = room.pending.filter((item) => item.clientMessageId !== clientMessageId);
  }

  function requestSince(roomId: string): void {
    const frame: Record<string, unknown> = { type: 'since', roomId, roomSeq: view(roomId).lastSeq };
    if (catchUpPageSize !== undefined) frame.limit = catchUpPageSize;
    send(frame);
  }

  /**
   * Tell the server what this client actually holds.
   *
   * The server repeats its `head` frame to this socket until it hears this, and
   * that is deliberate (#22 gauntlet r3 delta, blocking 1): round 3 stopped
   * sending the head once it had *attempted* delivery, so a socket that dropped
   * an event frame in a room that then went quiet had its cursor and its stale
   * head agree, and never asked. The one thing that can distinguish "sent" from
   * "held" is the holder saying so.
   *
   * Sent from two places, and both are needed. On every `head` frame, so the
   * server learns the truth even when the catch-up that follows fails or stalls;
   * and again when a catch-up loop finishes caught up, so the steady state is
   * silent rather than one frame per interval forever.
   */
  function acknowledgeHead(roomId: string): void {
    send({ type: 'ack_head', roomId, roomSeq: view(roomId).lastSeq });
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'subscribed': {
        const room = view(frame.roomId);
        room.subscribed = true;
        /**
         * A cursor past the room's head is a cursor for history the room does
         * not have — so the journal it came from is not this room's, and the
         * only safe thing to do with it is stop believing it
         * (#22 gauntlet r7 self-review, both foreign lineages).
         *
         * Parsing the journal makes it *well-formed*; it cannot make it
         * *authentic*. `localStorage` is same-origin, carries no provenance, and
         * a forgery that satisfies every field type is trivial to write:
         * `{events: [{roomSeq: 50, …}], lastSeq: 50}` resumes room A at 50 and
         * silently skips every real position at or below it, which is the r6
         * exploit's durable consequence reached from the other end. Schema
         * validation was r7's answer and is not an answer to this.
         *
         * Arithmetic is, because `frame.head` is a number the forger did not
         * *write*: it comes from the server, in the reply to this socket's own
         * `subscribe`. Note the exact strength of that, because r7's phrasing
         * read stronger than it is — it is **not** a number an attacker cannot
         * influence or predict. Same-origin JS can open its own socket, read the
         * room's true head, and plant a forgery exactly at it; the bounded case
         * below is trivially satisfiable, not merely possible. What "did not
         * write" buys is only this: the client is comparing its stored cursor
         * against a fact it fetched instead of against itself, and nothing has
         * been applied to this room on this socket yet, so a `lastSeq` above the
         * head cannot be an honest race — it is a claim about events the room
         * has never had. The room is dropped back to nothing and re-read, which
         * costs one catch-up.
         *
         * This does not make the journal trustworthy and is not offered as
         * making it so: a forgery *at or below* the true head still displaces
         * real events, and nothing on this side of the socket can tell. What it
         * closes is the unbounded case — the one where a single forged record
         * takes a room out permanently rather than corrupting a prefix of it.
         * Since r8 the prefix it can corrupt is at least well-ordered
         * (`StoredRoom`), so a forgery cannot make the timeline render the same
         * position twice; it can still put a plausible lie in front of you.
         */
        if (room.lastSeq > frame.head) {
          fail(
            `room "${frame.roomId}" resumed at ${room.lastSeq} but the server says its head is ${frame.head}; the stored journal is not this room's history and has been discarded`,
          );
          journal.reset(frame.roomId);
          room.events = [];
          room.lastSeq = 0;
          room.pending = [];
        }
        room.head = frame.head;
        room.seenSeq = frame.seenSeq;
        changed(frame.roomId);
        // Always ask, even on a first join: `lastSeq` is 0 then, so this is
        // both "load the room" and "close the gap" with one code path.
        requestSince(frame.roomId);
        return;
      }
      case 'unsubscribed': {
        const room = view(frame.roomId);
        room.subscribed = false;
        changed(frame.roomId);
        return;
      }
      case 'event':
        applyEntry(frame.entry);
        return;
      case 'head': {
        // The server's reconciler saying where the room actually is, with no
        // frame required to have arrived. Same arithmetic as everywhere else:
        // behind the head means ask for the gap.
        const room = view(frame.roomId);
        room.head = Math.max(room.head, frame.head);
        if (room.lastSeq < room.head) requestSince(frame.roomId);
        // Answered whether or not there was a gap. "I am at 37, you said 40" is
        // as useful to the server as "I have 40": both retire nothing until the
        // cursor reaches the head, and an unanswered frame is the server's cue
        // to say it again.
        acknowledgeHead(frame.roomId);
        changed(frame.roomId);
        return;
      }
      case 'catchup': {
        const room = view(frame.roomId);
        const before = room.lastSeq;
        // `max`, not assignment: a live event may already have carried this
        // room past the head this page was read against, and a cursor that
        // moved backwards would make the loop below ask for a gap that has
        // already been filled.
        room.head = Math.max(room.head, frame.head);
        for (const entry of frame.entries) applyEntry(entry);

        // The loop condition is this client's own arithmetic: am I at the head
        // I was told about? `more` is taken as a hint on top, not as the
        // authority — r1's blocking finding was precisely a server saying
        // `more: false` while `to < head`, and a client that believed it.
        if (room.lastSeq < room.head || frame.more) {
          const progressed = room.lastSeq > before;
          const rounds = progressed ? 0 : (stalled.get(frame.roomId) ?? 0) + 1;
          stalled.set(frame.roomId, rounds);
          if (rounds >= maxStalledCatchups) {
            // The server keeps naming a head it will not send. Stop asking and
            // say so: an unbounded loop here would be a client hammering a room
            // it can never finish, in silence.
            fail(
              `catch-up for room "${frame.roomId}" stalled at ${room.lastSeq} of ${room.head} after ${rounds} rounds with no progress`,
            );
          } else {
            requestSince(frame.roomId);
          }
        } else {
          stalled.delete(frame.roomId);
          // Caught up, and the server is told so. Without this the server would
          // keep repeating `head` every reconciliation pass for a client that
          // has everything — correct, and noisy forever.
          acknowledgeHead(frame.roomId);
        }
        changed(frame.roomId);
        return;
      }
      case 'ack': {
        inFlight.delete(frame.commandId);
        if (frame.issues.length > 0) {
          fail(`the server accepted the command with issues: ${frame.issues.join('; ')}`);
        }
        return;
      }
      case 'nack': {
        const pending = inFlight.get(frame.commandId);
        inFlight.delete(frame.commandId);
        if (pending) {
          const room = view(pending.roomId);
          const item = room.pending.find((p) => p.clientMessageId === pending.clientMessageId);
          if (item) {
            // Kept, not deleted. A message that vanished on failure is a
            // message the person has to retype from memory.
            item.status = 'failed';
            item.error = frame.message;
            // `retry` means the ledger was busy and nothing was written — the
            // one code for which sending the identical frame again is the right
            // answer rather than a way to make things worse.
            item.retryable = frame.code === 'retry';
          }
          changed(pending.roomId);
        }
        fail(`${frame.code}: ${frame.message}`);
        return;
      }
      case 'presence': {
        const room = view(frame.roomId);
        room.presence = { ...room.presence, [frame.userId]: frame.state };
        changed(frame.roomId);
        return;
      }
      case 'typing': {
        const room = view(frame.roomId);
        const others = room.typing.filter((id) => id !== frame.userId);
        room.typing = frame.typing ? [...others, frame.userId] : others;
        changed(frame.roomId);
        return;
      }
      case 'projection_changed':
        // No semantic state is accepted from the frame. It is only a prompt to
        // re-read the authenticated route's persisted projection.
        changed(frame.roomId, 'projection');
        return;
      case 'seen': {
        if (frame.userId !== options.userId) return;
        const room = view(frame.roomId);
        room.seenSeq = frame.seenSeq;
        changed(frame.roomId);
        return;
      }
      case 'error':
        fail(frame.message);
        return;
      default:
        return;
    }
  }

  /**
   * Everything the dead socket was the only evidence for (r1 polish).
   *
   * Presence and typing are statements about *now*, made by a server this
   * client can no longer hear: keeping them across a drop leaves a room full of
   * people who are online because nobody was around to say they left, and a
   * typing indicator that never stops. Both are re-established by the server
   * after the resubscribe, so clearing them costs a flicker and buys a UI that
   * is never confidently wrong.
   *
   * `inFlight` is the same argument about commands. The ack that would have
   * retired each entry was on that socket, so every one of them is now
   * unanswerable — and left in the map they would leak one entry per dropped
   * send, forever, and silently swallow a `nack` if a command id were ever
   * reused. The optimistic rows they point at are kept and marked retryable:
   * the send may or may not have landed, `clientMessageId` makes finding out
   * safe, and a message that vanished on a network blip is a message somebody
   * has to retype.
   *
   * `lastSeq` and the events are *not* touched. Those are the durable half, and
   * they are exactly what the catch-up loop resumes from.
   */
  function dropVolatileState(): void {
    for (const [commandId, pending] of inFlight) {
      const room = view(pending.roomId);
      const item = room.pending.find((p) => p.clientMessageId === pending.clientMessageId);
      if (item && item.status === 'pending') {
        item.status = 'failed';
        item.error = 'the connection dropped before the server answered';
        item.retryable = true;
      }
      inFlight.delete(commandId);
    }
    for (const room of rooms.values()) {
      room.subscribed = false;
      room.presence = {};
      room.typing = [];
      stalled.delete(room.roomId);
      changed(room.roomId);
    }
  }

  function attach(next: SocketLike): void {
    socket = next;
    next.onopen = () => {
      attempts = 0;
      setStatus('open');
      // Re-join everything. The server has no memory of this socket's
      // subscriptions, and `subscribed` triggers the catch-up.
      for (const roomId of rooms.keys()) {
        view(roomId).subscribed = false;
        send({ type: 'subscribe', roomId });
      }
    };
    next.onmessage = (event) => {
      let json: unknown;
      try {
        json = JSON.parse(String(event.data));
      } catch {
        fail('received a frame that is not valid JSON');
        return;
      }
      // Parsed, not cast (#22 gauntlet r6, major 1). `handleFrame` reaches
      // `applyEntry`, which writes the durable journal and moves `lastSeq`; a
      // frame that gets that far on the strength of a cast is a frame that can
      // make this client permanently skip a real event. Reported and dropped,
      // rather than thrown: the socket is still fine, and one unreadable frame
      // is not a reason to stop reading the next one.
      const parsed = ServerFrame.safeParse(json);
      if (!parsed.success) {
        fail(`received a frame this client cannot read: ${parsed.error.message}`);
        return;
      }
      handleFrame(parsed.data);
    };
    next.onerror = () => {
      fail('websocket error');
    };
    next.onclose = () => {
      socket = null;
      dropVolatileState();
      if (closedByUs || !backoff) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      const delay = Math.min(
        backoff.maxDelayMs,
        backoff.initialDelayMs * backoff.factor ** attempts,
      );
      attempts += 1;
      // Full jitter. Every client in a room reconnects at the same instant when
      // the server restarts; an unjittered backoff turns that into a thundering
      // herd on a process that has just started.
      const jittered = Math.round(delay * (0.5 + Math.random() * 0.5));
      retryHandle = schedule(() => {
        void connect();
      }, jittered);
    };
  }

  async function connect(): Promise<void> {
    if (socket) return;
    closedByUs = false;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    let url: string;
    try {
      url = await resolveUrl();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      setStatus('closed');
      return;
    }
    attach(factory(url));
  }

  return {
    connect,
    close: () => {
      closedByUs = true;
      if (retryHandle !== null) unschedule(retryHandle);
      retryHandle = null;
      socket?.close(1000, 'client closing');
      socket = null;
      // A deliberate close drops the same volatile state as an accidental one:
      // "who is here" is no more knowable when we hung up than when the wire
      // did. Some sockets deliver `onclose` for a local close and some do not,
      // and this must not depend on which.
      dropVolatileState();
      setStatus('closed');
    },
    status: () => status,
    join: (roomId) => {
      view(roomId);
      send({ type: 'subscribe', roomId });
    },
    leave: (roomId) => {
      send({ type: 'unsubscribe', roomId });
      rooms.delete(roomId);
    },
    room: (roomId) => view(roomId),
    rooms: () => [...rooms.keys()],
    lastSeq: (roomId) => view(roomId).lastSeq,
    sendMessage: (roomId, body, messageOptions = {}) => {
      const room = view(roomId);
      const clientMessageId = `${options.userId}:${now()}:${(nextCommandId + 1).toString(36)}`;
      const attachments = (messageOptions.attachments ?? []).map((attachment) => ({
        ...attachment,
      }));
      room.pending.push({
        clientMessageId,
        body,
        at: new Date(now()).toISOString(),
        status: 'pending',
        commandName: 'send_message',
        replyToId: messageOptions.replyToId ?? null,
        attachments,
        mentionUserIds: [...(messageOptions.mentionUserIds ?? [])],
      });
      const commandId = command({
        name: 'send_message',
        roomId,
        body,
        clientMessageId,
        replyToId: messageOptions.replyToId ?? null,
        attachments,
        mentionUserIds: messageOptions.mentionUserIds ?? [],
      });
      inFlight.set(commandId, { roomId, clientMessageId });
      changed(roomId);
      return clientMessageId;
    },
    retryMessage: (roomId, clientMessageId) => {
      const room = view(roomId);
      const pending = room.pending.find((item) => item.clientMessageId === clientMessageId);
      if (
        pending === undefined ||
        pending.status !== 'failed' ||
        pending.retryable !== true ||
        status !== 'open' ||
        room.subscribed !== true
      ) {
        return false;
      }
      const commandId =
        pending.commandName === 'send_message'
          ? command({
              name: 'send_message',
              roomId,
              body: pending.body,
              clientMessageId: pending.clientMessageId,
              replyToId: pending.replyToId,
              attachments: pending.attachments,
              mentionUserIds: pending.mentionUserIds,
            })
          : command({
              name: 'answer_message',
              roomId,
              questionId: pending.questionId,
              body: pending.body,
              clientMessageId: pending.clientMessageId,
              attachments: pending.attachments,
            });
      pending.status = 'pending';
      delete pending.error;
      delete pending.retryable;
      inFlight.set(commandId, { roomId, clientMessageId });
      changed(roomId);
      return true;
    },
    answerMessage: (roomId, questionId, body, attachments = []) => {
      const room = view(roomId);
      const clientMessageId = `${options.userId}:${now()}:${(nextCommandId + 1).toString(36)}`;
      const attachmentSnapshot = attachments.map((attachment) => ({ ...attachment }));
      room.pending.push({
        clientMessageId,
        body,
        at: new Date(now()).toISOString(),
        status: 'pending',
        commandName: 'answer_message',
        questionId,
        attachments: attachmentSnapshot,
      });
      const commandId = command({
        name: 'answer_message',
        roomId,
        questionId,
        body,
        clientMessageId,
        attachments: attachmentSnapshot,
      });
      inFlight.set(commandId, { roomId, clientMessageId });
      changed(roomId);
      return clientMessageId;
    },
    acceptProposal: (roomId, proposalId, objectiveId = null) =>
      command({ name: 'accept_proposal', roomId, proposalId, objectiveId }),
    rejectProposal: (roomId, proposalId, reason = null) =>
      command({ name: 'reject_proposal', roomId, proposalId, reason }),
    correctObject: (roomId, objectId, action, correction = {}) =>
      command({
        name: 'correct',
        roomId,
        objectId,
        action,
        patch: correction.patch ?? {},
        toType: correction.toType ?? null,
        provenance: { messageIds: [], proposalId: null, interpretationId: null },
        note: correction.note ?? null,
      }),
    answerBind: (roomId, questionId, answerObjectId) =>
      command({ name: 'answer_bind', roomId, questionId, answerObjectId, note: null }),
    supersedeObject: (roomId, replacementObjectId, retiredObjectId, supersession = {}) => {
      const clientSupersessionId =
        supersession.clientSupersessionId ??
        `${options.userId}:${now()}:${(nextCommandId + 1).toString(36)}`;
      const commandId = command({
        name: 'supersede_object',
        roomId,
        replacementObjectId,
        retiredObjectId,
        clientSupersessionId,
        note: supersession.note ?? null,
      });
      return { commandId, clientSupersessionId };
    },
    resolveAttention: (roomId, attentionId, status = 'resolved') =>
      command({ name: 'resolve_attention', roomId, attentionId, status }),
    advanceSeen: (roomId, roomSeq) => {
      const target = roomSeq ?? view(roomId).lastSeq;
      // Explicit, per room, never a global mark-all-read (#12/#14).
      command({ name: 'advance_seen', roomId, roomSeq: target });
    },
    setPresence: (roomId, state) => {
      command({ name: 'set_presence', roomId, state });
    },
    setTyping: (roomId, typing) => {
      command({ name: 'set_typing', roomId, typing });
    },
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
