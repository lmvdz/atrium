import type { Actor } from '@atrium/core';
import { Id } from '@atrium/core';
import { z } from 'zod';
import { Command, type CommandInput, PresenceState } from './commands.js';
import type { CommandErrorCode } from './ledger.js';
import type { RoomEvent } from './room-events.js';

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

export type ServerFrame =
  | { type: 'welcome'; connectionId: string; userId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | { type: 'subscribed'; roomId: string; head: number; seenSeq: number }
  | { type: 'unsubscribed'; roomId: string }
  | { type: 'event'; entry: WireEvent }
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
      entries: WireEvent[];
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
    }
  | { type: 'nack'; commandId: string; code: CommandErrorCode | 'malformed'; message: string }
  | { type: 'presence'; roomId: string; userId: string; state: PresenceState; at: string }
  | { type: 'typing'; roomId: string; userId: string; typing: boolean; at: string }
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
 * `presence` and `typing`, the two frames that are statements about *now* and
 * have no ledger to be read back from. Nothing else. A frame naming any other
 * type does not parse, and `event` in particular cannot be spelled here at all.
 *
 * ## What this does not close, said plainly
 *
 * The bus authenticates nobody, and a schema cannot. A forged **presence** or
 * **typing** frame, well-formed and naming a room consistently, is still relayed
 * to that room's subscribers by anything that can reach the database. That is a
 * real residual and it is the deliberate shape of the fix rather than an
 * oversight: the two frames left on this channel are the two whose worst case is
 * a wrong dot beside a name for a few seconds, both are re-established by the
 * next real update, and neither is written down anywhere. What is closed is the
 * *durable* case — the one where a forgery becomes history a client still
 * believes after a reload.
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
