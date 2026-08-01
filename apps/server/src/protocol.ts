import type { Actor } from '@atrium/core';
import { Id } from '@atrium/core';
import { z } from 'zod';
import { Command, type CommandInput, type PresenceState } from './commands.js';
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
