import {
  Actor,
  type CoreEvent,
  type CoreEventType,
  Id,
  ObjectAccepted,
  ObjectCorrected,
  ProposalRecorded,
  ProposalRejected,
  RelationAdded,
  Timestamp,
} from '@atrium/core';
import { coreEventTypes } from '@atrium/db';
import { z } from 'zod';

/**
 * What may take a position in `core_events` — the ledger's event union.
 *
 * It is deliberately wider than @atrium/core's `CoreEvent`. The reducer folds
 * five kinds; a room's history has two more that the reducer has no concept of
 * and should not grow one for:
 *
 *  - `message_posted` — substrate, not semantics. #12 lists it as an event kind
 *    and the acceptance test for #22 replays a burst of them, so it must be in
 *    the ledger with a `room_seq`; but a message is not a decision, a claim or
 *    an edge, and teaching the core to fold one would put raw conversation
 *    inside the state that is supposed to be the *understanding* of it.
 *  - `attention_resolved` — a per-person projection being dismissed. Routing is
 *    #21's; the act of resolving is room history and clients must see it.
 *
 * Presence and typing are **not** here, and a test asserts that a flood of them
 * writes zero rows (#14: presence is ephemeral, never evented).
 *
 * The split is what `isCoreEvent` decides, and it is the whole basis of the
 * live ≡ replay check: folding the ledger means folding its core-typed
 * subsequence, which is in canonical order because the whole ledger is.
 */

const eventBase = {
  id: Id,
  at: Timestamp,
  actor: Actor,
};

export const MessageAttachment = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const MessagePosted = z.object({
  ...eventBase,
  type: z.literal('message_posted'),
  roomId: Id,
  messageId: Id,
  body: z.string().min(1),
  replyToId: Id.nullable().default(null),
  /** The sender's idempotency key — also what its own optimistic echo matches on. */
  clientMessageId: z.string().min(1).nullable().default(null),
  attachments: z.array(MessageAttachment).default([]),
});
export type MessagePosted = z.infer<typeof MessagePosted>;

export const AttentionResolved = z.object({
  ...eventBase,
  type: z.literal('attention_resolved'),
  roomId: Id,
  attentionId: Id,
  status: z.enum(['resolved', 'dismissed']),
});
export type AttentionResolved = z.infer<typeof AttentionResolved>;

export const RoomEvent = z.discriminatedUnion('type', [
  ProposalRecorded,
  ProposalRejected,
  ObjectAccepted,
  ObjectCorrected,
  RelationAdded,
  MessagePosted,
  AttentionResolved,
]);
export type RoomEvent = z.infer<typeof RoomEvent>;
export type RoomEventType = RoomEvent['type'];

/** Ledger-only kinds: real history, but nothing the reducer folds. */
export type ServerEvent = MessagePosted | AttentionResolved;

/** True when @atrium/core's `reduce` consumes this event. */
export function isCoreEvent(event: RoomEvent): event is CoreEvent {
  return (coreEventTypes as readonly string[]).includes(event.type);
}

/** True for the ledger-only kinds — the complement of `isCoreEvent`. */
export function isServerEvent(event: RoomEvent): event is ServerEvent {
  return !isCoreEvent(event);
}

/**
 * The room an event belongs to.
 *
 * Core events carry their room inside the thing they are about, and two of them
 * (`proposal_rejected`, `object_corrected`) do not carry it at all — they name
 * something the state already knows the room of. Those return `null` and the
 * caller resolves them against `CoreState`; see `resolveRoomId` in
 * `ledger.ts`, which is also where the answer is checked against the room the
 * command was authorized for. The two must agree, or an authorized command
 * would write into a room nobody checked.
 */
export function declaredRoomId(event: RoomEvent): string | null {
  switch (event.type) {
    case 'proposal_recorded':
      return event.proposal.roomId;
    case 'object_accepted':
      return event.object.roomId;
    case 'relation_added':
      return event.relation.roomId;
    case 'message_posted':
    case 'attention_resolved':
      return event.roomId;
    case 'proposal_rejected':
    case 'object_corrected':
      return null;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Compile-time proof that every core event type is a member of this union. If
 * @atrium/core grows a sixth and it is not listed above, this stops compiling.
 */
type Assert<A extends B, B> = A;
export type _CoreEventCoverage = Assert<CoreEventType, RoomEventType>;
