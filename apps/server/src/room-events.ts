import type { Actor, CoreEvent, CoreEventType, TrustedContext } from '@atrium/core';
import {
  Id,
  ObjectAccepted,
  ObjectCorrected,
  ProposalRecorded,
  ProposalRejected,
  ProposalSuperseded,
  RelationAdded,
  Timestamp,
} from '@atrium/core';
import { coreEventTypes } from '@atrium/db';
import { z } from 'zod';

/**
 * What may take a position in `core_events` — the ledger's event union.
 *
 * It is deliberately wider than @atrium/core's `CoreEvent`. The reducer folds
 * six kinds; a room's history has two more that the reducer has no concept of
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
 *
 * ## The actor is not in here either (#21 r3)
 *
 * Round 2 of this ticket put `actor` in `eventBase`, so every ledger event
 * carried one inside its payload. #21's r2/r3 contract took the actor out of
 * `CoreEvent` entirely and made `CoreEvent.parse` **throw** on a payload that
 * carries one — the actor is a trusted value derived from the authenticated
 * session, and a payload is whatever the writer says it is.
 *
 * So the envelope carries it instead, for the ledger-only kinds too. There is
 * exactly one reason to hold the two ledger-only kinds to the same rule as the
 * six the reducer folds: the constraint that enforces it is a constraint on the
 * *table*, and a table cannot enforce "no actor in the payload, unless the type
 * is one of these two". A rule with an exception is a rule with a door.
 *
 * `AuthoredRoomEvent` is one ledger row as this server passes it around: the
 * payload, plus the trusted columns beside it. It is the server-side shape of
 * @atrium/core's `AuthoredEvent`, widened to the two extra kinds.
 */

const eventBase = {
  id: Id,
  at: Timestamp,
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const MessageAttachment = z.object({
  id: Id,
  key: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const MessageReference = z.object({
  ordinal: z.number().int().min(0),
  kind: z.enum(['human', 'agent', 'attachment', 'proposal', 'object']),
  targetId: Id,
  start: z.number().int().min(0),
  end: z.number().int().positive(),
  surface: z.string().min(1),
});
export type MessageReference = z.infer<typeof MessageReference>;

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
  references: z.array(MessageReference).max(100).default([]),
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

/** The payload union, before the no-actor guard. */
const RoomEventVariants = z.discriminatedUnion('type', [
  ProposalRecorded,
  ProposalRejected,
  ProposalSuperseded,
  ObjectAccepted,
  ObjectCorrected,
  RelationAdded,
  MessagePosted,
  AttentionResolved,
]);

/**
 * A ledger payload, refusing any actor a writer tries to smuggle in with it.
 *
 * This mirrors `CoreEvent`'s own guard rather than delegating to it, because the
 * two ledger-only kinds never reach `CoreEvent.parse` and would otherwise be the
 * one door in the wall. The message is the same one core gives, for the same
 * reason: a writer sending an actor field believes it is doing something, and it
 * should be told once, at the boundary, that it is not.
 */
export const RoomEvent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'actor')) {
      ctx.addIssue({
        code: 'custom',
        path: ['actor'],
        message:
          'a ledger event payload may not carry an actor — the actor is a trusted column on the row, derived from the authenticated session, never from the payload',
      });
    }
  })
  .pipe(RoomEventVariants);

export type RoomEvent = z.infer<typeof RoomEventVariants>;
export type RoomEventType = RoomEvent['type'];

/**
 * One ledger row as this server folds and fans it out: payload plus trusted
 * context. The server-side twin of `@atrium/core`'s `AuthoredEvent`.
 */
export interface AuthoredRoomEvent {
  event: RoomEvent;
  trusted: TrustedContext;
}

/** Pair a ledger payload with the trusted context it was appended under. */
export function authoredRoomEvent(event: RoomEvent, trusted: TrustedContext): AuthoredRoomEvent {
  return { event, trusted };
}

/**
 * The messages this event's receipt is checked against — the *second* trusted
 * column, and the reason live ≡ replay survives #21's contract.
 *
 * A non-human `object_accepted` is refused by the reducer unless it is handed a
 * non-empty window containing the messages the reading cites. If the live append
 * supplies one and a replay does not, the same row folds two different ways and
 * the guarantee this whole ticket rests on is gone. So the window is not
 * something the command layer knows and the replay guesses: it is **derived from
 * the event**, by both paths, from the same durable table.
 *
 * `provenance.messageIds` is inside the payload, so the derivation is a pure
 * function of the row. The bodies come from `messages`, which is append-only
 * substrate — a message's text never changes, so loading the same ids tomorrow
 * yields the same window it did at append time. That is what makes this
 * reconstructible rather than merely repeatable.
 *
 * Everything else gets an empty list, because nothing else has a receipt.
 */
export function provenanceMessageIds(event: RoomEvent): readonly string[] {
  return event.type === 'object_accepted' ? event.object.provenance.messageIds : [];
}

/** True when the reducer will demand a message window for this row. */
export function needsMessageWindow(event: RoomEvent, actor: Actor): boolean {
  return actor.kind !== 'human' && provenanceMessageIds(event).length > 0;
}

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
 * Core events carry their room inside the thing they are about, and three of
 * them (`proposal_rejected`, `proposal_superseded`, `object_corrected`) do not
 * carry it at all — they name something the state already knows the room of.
 * Those return `null` and the caller resolves them against `CoreState`; see
 * `resolveRoomId` in `ledger.ts`, which is also where the answer is checked
 * against the room the command was authorized for. The two must agree, or an
 * authorized command would write into a room nobody checked.
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
    case 'proposal_superseded':
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
 * @atrium/core grows a seventh and it is not listed above, this stops compiling.
 */
type Assert<A extends B, B> = A;
export type _CoreEventCoverage = Assert<CoreEventType, RoomEventType>;
