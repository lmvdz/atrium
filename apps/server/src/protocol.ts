import type { Actor } from '@atrium/core';
import { Id } from '@atrium/core';
import { z } from 'zod';
import { Command, type CommandInput, PresenceState } from './commands.js';
import {
  MAX_DIFF_DELTA_BYTES,
  MAX_DIFF_FILES,
  MAX_DIFF_HEADER_LEN,
  MAX_DIFF_LINE_LEN,
  MAX_DIFF_LINES,
  MAX_DIFF_PATH_LEN,
} from './execution/git.js';
import type { CommandErrorCode } from './ledger.js';
import type { RoomEvent } from './room-events.js';

/**
 * A running session's coalesced diff delta (#159). Field names mirror
 * `SessionDiffFilePayload` (`room-events.ts`) so the client derives add/del/ctx
 * from the unified-diff `+`/`-`/space prefixes exactly as it does for the durable
 * receipt diff — one dialect, not two. A single optional `hunk` (not the receipt's
 * `hunks` array) keeps a delta inside the 4KB bound; the snapshot carries the full
 * coalesced `SessionDiff`.
 */
const SessionDiffDeltaFrame = z.object({
  type: z.literal('session_diff_delta'),
  roomId: Id,
  sessionId: Id,
  progressSeq: z.number().int().nonnegative(),
  at: z.string().min(1),
  truncated: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(MAX_DIFF_PATH_LEN),
        status: z.enum(['added', 'modified', 'deleted', 'renamed']),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        hunk: z
          .object({
            header: z.string().max(MAX_DIFF_HEADER_LEN + 1),
            lines: z.array(z.string().max(MAX_DIFF_LINE_LEN + 1)).max(MAX_DIFF_LINES),
          })
          .optional(),
      }),
    )
    // The FILE bound is the number of files (#159 fix, finding 8), not the line
    // ceiling: a diff delta carries at most `MAX_DIFF_FILES` files, each of whose
    // single `hunk.lines` array is separately capped at `MAX_DIFF_LINES` above.
    // Bounding `files` by `MAX_DIFF_LINES` (2000) let an untrusted bus frame carry
    // 2000 file entries — fifty times the durable diff's own file ceiling — before
    // the 4KB byte cap or this length cap refused it.
    .max(MAX_DIFF_FILES),
});

/**
 * Does a built diff-delta frame fit the 4KB ephemeral ceiling (#159)?
 *
 * The bound is enforced HERE, in the producer, rather than in the union member —
 * a `discriminatedUnion` member must be a plain object, and the covenant type-wall
 * (`_EphemeralCarriesNothingDurable`) reads that union, so the frame stays a plain
 * object and the aggregate check is a producer obligation. Counts ACTUAL UTF-8
 * bytes (the encoding the bus serializes in), never `String.length` code units —
 * the same accounting the durable diff's aggregate ceiling uses (#145 r3, FIX 2).
 * A frame over the cap must be coalesced harder with `truncated:true`; the snapshot
 * heals the dropped lines and the receipt replaces the stream at terminal.
 */
export function diffDeltaFrameFits(frame: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8') <= MAX_DIFF_DELTA_BYTES;
}

/**
 * The wire contract (#12): commands travel client→server, events travel
 * server→client tagged `(room, room_seq)`, and the client's only cursor is
 * `room_seq`.
 *
 * Everything here is server-authoritative. There is no CRDT and no merge: a
 * client that reconnects asks `since(room, room_seq)` and is told what it
 * missed, in order. The one thing a client may render before the server agrees
 * is its own message echo, keyed on `clientMessageId` — see
 * `apps/web/src/lib/realtime.ts` for why that is the only safe optimism.
 */

export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string().min(1).optional() }),
  z.object({ type: z.literal('ping') }),
  /** Join a room's fan-out. Replies with the room head and this user's cursor. */
  z.object({ type: z.literal('subscribe'), roomId: Id }),
  z.object({ type: z.literal('unsubscribe'), roomId: Id }),
  /** Catch-up: everything after `roomSeq`, in order. */
  z.object({
    type: z.literal('since'),
    roomId: Id,
    roomSeq: z.number().int().min(0),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  /**
   * "I hold up to `roomSeq` in this room."
   *
   * The only evidence the server accepts that a `head` frame arrived (#22
   * gauntlet r3 delta, blocking 1). Round 3 retired the head frame when it had
   * *sent* one — or, worse, when it had merely broadcast the events — which is
   * the send that may have failed being taken as proof it did not. A head frame
   * is now repeated to a socket until that socket says otherwise.
   *
   * Deliberately **not** `advance_seen`. That is a person's read cursor, it is
   * durable, it is broadcast to the room, and it moves for reasons that have
   * nothing to do with delivery — a client that has every event but has not
   * looked at the room must not be told it is behind, and a client that marked a
   * room read must not thereby claim to hold events it never received.
   */
  z.object({ type: z.literal('ack_head'), roomId: Id, roomSeq: z.number().int().min(0) }),
  z.object({ type: z.literal('command'), commandId: z.string().min(1).max(128), command: Command }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
/**
 * The same frames as a caller *writes* them, before zod applies its defaults.
 *
 * A socket sends JSON with the optional halves left out and the server fills
 * them in, so this — not `ClientFrame` — is the shape anything constructing a
 * frame should be typed against. Demanding `toType: null, provenance: {…}` from
 * a caller is demanding a shape no real client ever sends, and a test harness
 * typed that way drifts from the protocol every time a field gains a default.
 */
export type ClientFrameInput = z.input<typeof ClientFrame>;
export type { CommandInput };

/**
 * One ledger entry as the wire carries it.
 *
 * `actor` is beside the event rather than inside it, which is #21's contract
 * showing through to the client: the payload has no place for an actor and the
 * reducer refuses one that tries, so the wire cannot put it back. The client
 * reads `entry.actor` where it used to read `entry.event.actor` — most visibly
 * in `reconcilePending`, which matches a person's own message echo on it.
 */
export interface WireEvent {
  roomId: string;
  /** Per-room position — the client's cursor, and what `since` takes back. */
  roomSeq: number;
  /** Global position. Diagnostics and cross-room ordering; not a client cursor. */
  seq: number;
  /** The trusted actor, from the ledger row's own columns. Never the payload. */
  actor: Actor;
  event: RoomEvent;
  /**
   * Why the reducer refused this row, or `[]` when it applied.
   *
   * **A refused row is not an event that happened**, and until #22 r10 the wire
   * could not say so: `issues` reached the actor in their own `ack` and nothing
   * else, while this frame carried the full payload to every other subscriber
   * and to every cold reader through `since`, unmarked. The frame carries the
   * verdict now — on both paths, from one derivation in the ledger — so a client
   * can advance its cursor past the row without putting the sentence in the
   * room's history. `apps/web`'s client drops it; see `applyEntry` there.
   */
  issues: string[];
}

/**
 * A durable ledger *position* that carries no event — the #46 wire tombstone.
 *
 * A row whose payload cannot be read back as a `RoomEvent` (a bad migration, a
 * manual fix, a future non-participant writer — SQL runs no zod) is still a real
 * row: it holds a `room_seq`, and `room_seq` is the client's only cursor.
 * Filtering it off the wire — which is what this server did before — leaves a
 * hole in the catch-up page, and the client's `applyEntry` accepts only
 * `lastSeq + 1`, so it re-requests the gap and stalls after the
 * max-stalled-catchups guard. The server outage #46 closed on the read path
 * became a client outage one layer down.
 *
 * The tombstone is how the position travels without an event: the client applies
 * it to advance its cursor **past** the bad row, so the valid rows after it land,
 * and it renders nothing. It fabricates no event — there is no `event`, no
 * `actor`, no `issues` — which is the covenant #46 keeps: nothing is invented to
 * paper over a row that cannot be read. It is the wire twin of the ledger's
 * `MalformedLedgerEntry`, and the client applies it exactly as it applies a
 * refused row (`applied_with_issue`): journalled so `room_seq` stays gap-free,
 * never shown because there is nothing that happened to show.
 */
export interface WireTombstone {
  roomId: string;
  /** Per-room position — real; this is the cursor the client advances past. */
  roomSeq: number;
  /** Global position. Diagnostics; not a client cursor. */
  seq: number;
  /** Discriminant: this position holds a row that could not be read as an event. */
  malformed: true;
  /** Why the row could not be read. Advisory, for an operator; never rendered. */
  reason: string;
}

/**
 * One position as a `catchup` page carries it: a readable event, or a tombstone
 * for a row that is not (#46).
 *
 * The catch-up page carries the union. On the LIVE path the two travel as separate
 * frames — a readable row as `event` (a `WireEvent`), a malformed row as `tombstone`
 * (a `WireTombstone`) — rather than one widened `event` frame. Round 2 skipped the
 * marker on the live fan-out entirely, on the theory that the reconciler's
 * `head`→`since` would close the gap; it does, but a whole reconcile interval late,
 * and not at all if that one frame is lost. Round 3 carries it live so a subscriber
 * advances the instant the row is folded. The distinct discriminant — rather than
 * teaching every reader of `event.entry.event` to narrow on `malformed` — keeps a
 * live `event` frame exactly what it always was.
 *
 * ## Rollout / old-client compatibility
 *
 * The live `tombstone` frame is new. A client from before round 3 has no `tombstone`
 * case in its `ServerFrame` union, so it rejects the frame at parse and drops it —
 * which corrupts nothing (a dropped frame advances no cursor) and recovers through
 * the same `head`→`since` path round 2 relied on, where the catch-up page has
 * carried the tombstone since round 2. So the change degrades safely: upgraded
 * clients advance immediately, older ones fall back to the reconciler. No version
 * handshake is negotiated on this socket, so a hard skew guard is not cheap here;
 * the safe degradation above is the rollout contract. Deploy server and client
 * together when you can, but a lagging client is not a correctness hazard.
 *
 * ## The tombstone is a forward-compatible-ONLY change (#46 round 4)
 *
 * Be precise about which "old client" degrades gracefully. The paragraph above
 * holds for a round-2-or-later client, whose catch-up schema already parses a
 * `WireTombstone` in the page. A **pre-#46 client** is different: its catch-up
 * schema is `entries: z.array(Envelope)` (verified on `origin/main`), which cannot
 * parse a tombstone at all — the whole `catchup` frame fails at the schema, the
 * page is dropped, and that client re-requests the identical `since` and stalls on
 * any room that contains a malformed row, until it upgrades. So the wire tombstone
 * (both the live `tombstone` frame and the catch-up tombstone entry) is a
 * FORWARD-COMPATIBLE-ONLY protocol change: new clients read it, pre-deploy clients
 * cannot, and there is no version handshake on this socket to bridge them.
 *
 * That is safe, and strictly better than pre-#46, on three counts:
 *   1. **Server-first deploy is the correct order and loses nothing.** Before #46,
 *      one malformed row makes `hydrate` throw and the whole PROCESS exits — a
 *      total outage for every client in every room. After it, the server stays up;
 *      rooms with no bad row are fully unaffected.
 *   2. **Current clients get the full benefit the moment they upgrade** — they
 *      advance past the malformed row on both the live and catch-up paths.
 *   3. **The only degradation is a pre-deploy client stalling on the one affected
 *      room** (not a crash, not data corruption, not other rooms) until it
 *      upgrades. The contract is graceful-degradation-to-stall, scoped to the room
 *      that holds the unreadable row — a working→stalled step on one room for old
 *      clients, never a working→broken regression.
 */
export type WireEntry = WireEvent | WireTombstone;

export type ServerFrame =
  | { type: 'welcome'; connectionId: string; userId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | {
      type: 'subscribed';
      roomId: string;
      head: number;
      seenSeq: number;
      /**
       * THE DURABLE PROGRESS FLOOR (#159 round-4, finding 3). One `{sessionId,
       * progressSeq}` pair per session with a live `sessions.progress` snapshot in
       * this room, read at subscribe time — the same authenticated read
       * `loadControlPlane` performs, carried on the frame that already answers
       * every (re)subscribe rather than a second round trip. The client floors its
       * `progressFloor` by these on every `subscribed` (first join AND reconnect),
       * so a stale/reordered/forged live frame in `(client's old floor, snapshot]`
       * is refused instead of shown — the gap round-3's fix left open, because
       * `recoverProgress` existed but nothing on the production path ever called
       * it. `[]` for a room with no running session's progress yet.
       */
      progress: readonly { sessionId: string; progressSeq: number }[];
    }
  | { type: 'unsubscribed'; roomId: string }
  | { type: 'event'; entry: WireEvent }
  /**
   * A malformed row on the LIVE path (#46 round 3). Its own frame rather than a
   * widened `event`, so a live `event` frame stays a readable event and the
   * subscriber advances its cursor past the bad position immediately — instead of
   * only recovering on the reconciler's next `head`→`since`. The client renders it
   * as nothing; it exists to carry the cursor forward.
   */
  | { type: 'tombstone'; entry: WireTombstone }
  /**
   * "This room is at `head`." Unsolicited, from the reconciler.
   *
   * The second half of #22 r2-delta's blocking finding 1. `sync` covers rows
   * this instance never folded; this covers rows it folded and broadcast whose
   * *frame* did not reach one particular socket. Nothing in the client has to
   * trust it beyond comparing it with its own cursor — which is the same
   * arithmetic the catch-up loop already does — and a client already at the head
   * does nothing at all.
   *
   * Repeated to a socket every reconciliation pass until that socket replies
   * `ack_head` with a cursor at or past it (r3 delta, blocking 1). A client that
   * is already caught up answers once and hears nothing more; a client whose
   * event frame was lost hears it again next pass, which is the whole recovery.
   */
  | { type: 'head'; roomId: string; head: number }
  /**
   * The gap, in one frame. `from`/`to` are inclusive-exclusive bounds so a
   * client can tell "you are caught up" (`to === head`) from "there is more"
   * without counting, and `more` says so outright when a limit truncated it.
   */
  | {
      type: 'catchup';
      roomId: string;
      from: number;
      to: number;
      head: number;
      more: boolean;
      entries: WireEntry[];
    }
  /**
   * The command succeeded. The three positional fields are `null` exactly when
   * nothing was appended — presence, typing and the read cursor — rather than
   * `0` and `""`, because `0` would have to mean both "the very first" and "not
   * applicable", and a client cannot tell those apart after the fact.
   */
  | {
      type: 'ack';
      commandId: string;
      roomId: string;
      seq: number | null;
      roomSeq: number | null;
      eventId: string | null;
      issues: string[];
      /**
       * `open_session` only: the authorized-draw outcome (#118 fix r2, HIGH-3). A
       * draw either GRANTED a session (`granted`, with the id) or was REFUSED
       * against the plan's budget (`refused`, `reason=budget`, with the slice and
       * the committed count). Both outcomes append and ack with empty `issues` — a
       * `session_opened` vs a durable `draw_refused` — so `issues` cannot tell them
       * apart. This is how a caller/adapter knows whether it actually got a session
       * rather than proceeding as if a refused draw opened one. Absent otherwise.
       */
      draw?:
        | { outcome: 'granted'; sessionId: string }
        | { outcome: 'refused'; reason: 'budget'; slice: number; authorizedDraws: number };
    }
  | { type: 'nack'; commandId: string; code: CommandErrorCode | 'malformed'; message: string }
  | { type: 'presence'; roomId: string; userId: string; state: PresenceState; at: string }
  | { type: 'typing'; roomId: string; userId: string; typing: boolean; at: string }
  /** A derived database projection changed after the last durable room event. */
  | { type: 'projection_changed'; roomId: string; at: string }
  /**
   * A running session's spend/context heartbeat (#159, decided in #152).
   * Presence-shaped and LOSSY: server-minted from the `report_session_progress`
   * command, relayed fire-and-forget, never journalled. The final values land
   * durably on the session's exit event; this is the live `~` preview between.
   */
  | {
      type: 'session_heartbeat';
      roomId: string;
      sessionId: string;
      progressSeq: number;
      spendMicros: number | null;
      contextPct: number | null;
      at: string;
    }
  /**
   * A running session's coalesced diff delta (#159, decided in #152). Ephemeral
   * and ≤4KB (the 8000-byte NOTIFY limit). The receipt's `SessionDiffPayload` is
   * the ONE durable diff; this is a live preview the snapshot heals and the
   * receipt replaces wholesale at terminal.
   */
  | {
      type: 'session_diff_delta';
      roomId: string;
      sessionId: string;
      progressSeq: number;
      at: string;
      truncated: boolean;
      files: {
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        additions: number;
        deletions: number;
        hunk?: { header: string; lines: string[] };
      }[];
    }
  | { type: 'seen'; roomId: string; userId: string; seenSeq: number }
  | { type: 'error'; message: string };

/**
 * What the ephemeral bus is allowed to carry, as a schema rather than as a
 * convention (#22 gauntlet r6, major 1).
 *
 * ## Why this is a type and not a comment
 *
 * `NOTIFY` needs no privilege in Postgres. Anything that can open a connection
 * to the database can put a string on `atrium_ephemeral`, and until r7 the
 * receiving side did `JSON.parse(raw) as T` and handed the result straight to
 * `hub.broadcast`. The r6 gauntlet executed the consequence: a subscribed client
 * received a forged `event` frame — a durable ledger entry, with a `roomSeq` —
 * while `SELECT count(*) FROM core_events` was **0**. The client's `applyEntry`
 * committed it to its own journal and advanced `lastSeq`, so the *real* event at
 * that position was thereafter permanently skipped. Durable divergence, produced
 * without touching `core_events` at all.
 *
 * The design error underneath the exploit is the one this type fixes: **an
 * ephemeral bus that can carry a durable frame is a second way for history to
 * arrive.** `event-bus.ts` says it in prose — "a payload relayed through a side
 * channel is a second copy of history, free to disagree with the first" — and
 * then typed the payload `unknown`.
 *
 * So the rule is now written down where it can be enforced: the bus carries
 * presence, typing, and a payload-free request to reread a persisted projection.
 * None is history. A frame naming any other type does not parse, and `event` in
 * particular cannot be spelled here at all.
 *
 * ## What this does not close, said plainly
 *
 * The bus authenticates nobody, and a schema cannot. A forged **presence** or
 * **typing** frame, well-formed and naming a room consistently, is still relayed
 * to that room's subscribers by anything that can reach the database. That is a
 * real residual and it is the deliberate shape of the fix rather than an
 * oversight. Forged presence or typing costs a transient wrong indicator. A
 * forged `projection_changed` can force an authorized subscriber to reread its
 * own route, but supplies none of the state that route returns. A lost projection
 * signal can delay cross-instance freshness indefinitely; unlike ledger heads,
 * this channel has no durable revision/ack loop. The Phase-2 single-instance
 * path and ordinary relay are covered; listener-loss recovery for derived
 * projections remains explicitly unclaimed. What is closed is the *durable*
 * forgery case — a notification becoming history a client believes after reload.
 *
 * Making even that impossible means authenticating the channel (a shared secret
 * in the payload, or a `SECURITY DEFINER` relay function with `EXECUTE` revoked
 * from `PUBLIC`), which is a different ticket and a real one. It is not this
 * ticket, and pretending the alphabet closed it would be the same overclaim this
 * round is about.
 *
 * ## The durable rule, stated once — and stated accurately
 *
 * **A ledger entry reaches a client only from a row this server has committed or
 * read under an authenticated session; never from a notification, a peer or a
 * cache.** There are exactly three producers of `event`/`catchup` frames, all in
 * `ws-server.ts`: the acknowledged command path, which broadcasts the entry its
 * own append transaction just committed; `fanOut`, from rows the reconciler read
 * back out of `core_events`; and the `catchup` reply, from `ledger.since`. The
 * bus is not among them and must never become one.
 *
 * An earlier draft of this paragraph said "this server read it out of
 * `core_events`", which is false of the first of those three — the command path
 * broadcasts the value it appended rather than re-reading it. That is a
 * deliberate saving and not a gap (the transaction has committed, and the row's
 * lifted columns are pinned to the payload by CHECKs), but a sentence in the file
 * that exists to hold sentences to tests has no business overstating by one
 * producer.
 */
export const EphemeralFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('presence'),
    roomId: Id,
    userId: Id,
    state: PresenceState,
    at: z.string().min(1),
  }),
  z.object({
    type: z.literal('typing'),
    roomId: Id,
    userId: Id,
    typing: z.boolean(),
    at: z.string().min(1),
  }),
  z.object({
    type: z.literal('projection_changed'),
    roomId: Id,
    at: z.string().min(1),
  }),
  /**
   * THE LIVE PROGRESS FRAMES (#159, decided in #152).
   *
   * Both join `EphemeralFrame`, which is the covenant point-3 type-wall: the
   * compile-time `_EphemeralCarriesNothingDurable` assert below stays satisfied
   * because neither is `event`/`catchup`, so live progress can NEVER arrive as a
   * journalable `event`. Both are server-minted from the authority-guarded
   * `report_session_progress` command — the bus authenticates nobody, so a forged
   * frame is presence-class residual (a transient wrong preview, erased by the next
   * snapshot read and by the receipt), never durable or certifiable. And neither
   * carries a `certified`/`verified`/epistemic field (covenant point 2): every value
   * is a `~` draft.
   */
  z.object({
    type: z.literal('session_heartbeat'),
    roomId: Id,
    sessionId: Id,
    progressSeq: z.number().int().nonnegative(),
    spendMicros: z.number().int().nonnegative().nullable(),
    contextPct: z.number().min(0).max(1).nullable(),
    at: z.string().min(1),
  }),
  SessionDiffDeltaFrame,
]);
export type EphemeralFrame = z.infer<typeof EphemeralFrame>;

/**
 * Compile-time: every ephemeral frame is a server frame, and none of them is one
 * of the two that carry history.
 *
 * The first half stops the bus and the socket drifting into two dialects of
 * "presence". The second is the durable rule above as a type error: adding
 * `'event'` or `'catchup'` to `EphemeralFrame` makes
 * `_EphemeralCarriesNothingDurable` resolve to `never` and `tsc` refuses the
 * build.
 *
 * `Extract<…>` inside a tuple, and not the obvious `EphemeralFrame['type'] extends
 * 'event' | 'catchup' ? never : true`. The obvious spelling is **inert**: with
 * `'presence' | 'typing' | 'event'` the whole union still does not extend
 * `'event' | 'catchup'`, so it resolves to `true` and the build stays green with a
 * durable frame in the union. That was the first draft of this assert, and a
 * foreign-lineage reviewer compiled a minimal reproduction to show it — an
 * assertion about a safety property that asserted nothing, inside the file whose
 * whole subject is exactly that. `Extract` asks the question the other way round
 * (is any member of this union one of those two?), and the tuple stops the
 * conditional distributing over `never`, which would make the empty case answer
 * `never` too.
 *
 * The runtime pin is `accepts exactly the two ephemeral frames` in
 * `apps/server/test/protocol.test.ts`, which reads the union's members back off
 * the schema. That test is the one that has to hold; this is belt and braces, and
 * it is written down that way round because a type-level assert is exactly the
 * kind of thing that can be silently inert.
 */
type _EphemeralIsAServerFrame = EphemeralFrame extends ServerFrame ? true : never;
type _EphemeralCarriesNothingDurable = [
  Extract<EphemeralFrame['type'], 'event' | 'catchup'>,
] extends [never]
  ? true
  : never;
const _ephemeralContract: [_EphemeralIsAServerFrame, _EphemeralCarriesNothingDurable] = [
  true,
  true,
];
void _ephemeralContract;

/**
 * One relayed frame, with the room it is for beside it.
 *
 * `roomId` is duplicated — it is in the frame too — and that is deliberate: the
 * envelope is what `hub.broadcast` fans out on, so a note whose envelope and
 * frame name different rooms would deliver a presence update for room A to room
 * B's subscribers. `event-bus.ts` refuses that rather than picking one.
 */
export const EphemeralNote = z
  .object({
    /** The instance that sent it, so it can ignore the echo of its own relay. */
    origin: z.string().min(1),
    roomId: Id,
    frame: EphemeralFrame,
  })
  .refine((note) => note.roomId === note.frame.roomId, {
    message: 'the note names one room and its frame names another',
  });
export type EphemeralNote = z.infer<typeof EphemeralNote>;

/**
 * "Something landed at this position." The rows come from the ledger.
 *
 * Parsed, not cast, for the same reason as the ephemeral channel: `NOTIFY` takes
 * no privilege, so this string is attacker-reachable. The blast radius is much
 * smaller — a forged announcement makes this instance go and *read the ledger*,
 * which is the one source it is allowed to believe — but "small" is not a reason
 * to hand a `roomId` of unknown shape to a query, and a `seq` of unknown type to
 * arithmetic.
 *
 * `origin` is the instance that appended, so it can ignore the echo of its own
 * commit. It is `null` when the row was written by something that did not name
 * itself — a script, a migration, a second application. Null matches no
 * instance, so *everybody* folds it, which is the direction to be wrong in.
 */
export const LedgerNote = z.object({
  origin: z.string().min(1).nullable(),
  roomId: Id,
  seq: z.number().int().positive(),
  roomSeq: z.number().int().positive(),
});
export type LedgerNote = z.infer<typeof LedgerNote>;
