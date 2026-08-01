import { Id } from '@atrium/core';
import { z } from 'zod';
import { Command, type PresenceState } from './commands.js';
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

/** One ledger entry as the wire carries it. */
export interface WireEvent {
  roomId: string;
  /** Per-room position — the client's cursor, and what `since` takes back. */
  roomSeq: number;
  /** Global position. Diagnostics and cross-room ordering; not a client cursor. */
  seq: number;
  event: RoomEvent;
}

export type ServerFrame =
  | { type: 'welcome'; connectionId: string; userId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | { type: 'subscribed'; roomId: string; head: number; seenSeq: number }
  | { type: 'unsubscribed'; roomId: string }
  | { type: 'event'; entry: WireEvent }
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
