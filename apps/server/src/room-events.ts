import type { Actor, CoreEvent, CoreEventType, TrustedContext } from '@atrium/core';
import {
  AttentionClass,
  ProposalRecorded as CoreProposalRecorded,
  Id,
  ObjectAccepted,
  ObjectCorrected,
  ProposalRejected,
  ProposalSuperseded,
  RationaleReason,
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

/**
 * The core fold deliberately has no process-tree concepts, but the durable
 * server event also carries the execution session that drafted a reading.
 * Optional preserves replay of proposal rows written before this provenance
 * edge was wired; every new command writes either a UUID or an explicit null.
 */
export const ProposalRecorded = CoreProposalRecorded.extend({
  sessionId: Id.nullable().optional(),
});
export type ProposalRecorded = z.infer<typeof ProposalRecorded>;

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

/* ─────────────────────────────────────────────────────────────────────────
 * The agent/plan/session lifecycle — six more ledger-only kinds (#116)
 *
 * These live HERE, not in `@atrium/core`'s `events.ts`, and that placement is
 * the load-bearing part: they must never join `CoreEvent`. The covenant reducer
 * folds six kinds and grows no concept of a plan or a session; these ride the
 * ledger for a `room_seq` and an append order, and `projections.ts` turns them
 * into rows in `plans` / `sessions` / `attention_items`. `isCoreEvent` returns
 * false for every one (they are not in `coreEventTypes`), so folding a room's
 * core-typed subsequence is identical with them present or absent — which is the
 * flip-the-input proof that the covenant is untouched.
 *
 * Every one carries a top-level `roomId`, the same shape `message_posted` has,
 * so `core_events_payload_room_matches` (extended in drizzle/0023) accepts them
 * and `declaredRoomId` reads their room straight off the payload.
 * ───────────────────────────────────────────────────────────────────────── */

const Micros = z.number().int().nonnegative().nullable().default(null);

/** A plan opened — a board created for an agent's work in its channel. */
export const PlanOpened = z.object({
  ...eventBase,
  type: z.literal('plan_opened'),
  roomId: Id,
  planId: Id,
  /** The agent whose work this plan groups — a `users` id of an agent principal. */
  agentUserId: Id,
  title: z.string().min(1).max(200),
  /** The plan's rlimit slice, in micro-dollars. Placeholder (#115 owns enforcement). */
  budgetLimitMicros: Micros,
});
export type PlanOpened = z.infer<typeof PlanOpened>;

/** A plan settled — its receipt is written; it indexes its sessions' receipts. */
export const PlanSettled = z.object({
  ...eventBase,
  type: z.literal('plan_settled'),
  roomId: Id,
  planId: Id,
});
export type PlanSettled = z.infer<typeof PlanSettled>;

/**
 * A session opened under a plan. `planId` is the session's ONE parent — the
 * pstree edge, enforced by the schema's composite FK. There is no
 * `parentSessionId` field here, deliberately: a session never spawns, and the
 * payload has no place to say it did.
 */
export const SessionOpened = z.object({
  ...eventBase,
  type: z.literal('session_opened'),
  roomId: Id,
  sessionId: Id,
  planId: Id,
  harness: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  /**
   * THE EXECUTION-AUTHORITY RECORD, decided at grant (#120 round-6). `provider`
   * means a wired ExecutionProvider owns this session's execution and its
   * terminal; `external` means an outside member settles it (external-settle
   * mode). `executionOwner` is the granting process's instance id for a provider
   * session, NULL for external. Both ride the event so replay reconstructs the
   * grant-time authority deterministically. The capability TOKEN does NOT ride
   * here — it is minted row-only in the projection so it never reaches the wire
   * (`toWire` broadcasts the whole event). Defaulted so a pre-round-6 event (or an
   * in-process caller that predates the field) folds as an external session, which
   * is exactly its historical behaviour.
   */
  executionMode: z.enum(['provider', 'external']).default('external'),
  executionOwner: z.string().min(1).max(200).nullable().default(null),
});
export type SessionOpened = z.infer<typeof SessionOpened>;

/**
 * The verified artifact a session's execution produced (#120): a branch and the
 * commit it points at, in the scratch git remote the ExecutionProvider controls.
 *
 * It rides the exit event's payload — a `~` fact about the process, indexed by
 * the ledger row, NOT a covenant `✓`. The branch is never `main` and is never
 * merged: the land is a human `✓`, so a settled session references a branch
 * waiting for one rather than one the adapter certified. Nullable, because a
 * failing harness produces no verifiable object.
 */
export const ExecutionArtifact = z.object({
  branch: z.string().min(1).max(200),
  commit: z.string().min(1).max(64),
  remote: z.string().min(1).max(1000),
});
export type ExecutionArtifact = z.infer<typeof ExecutionArtifact>;

/** The two spellings of an exit receipt (§9.5). Both non-epistemic (#114 T3). */
const sessionExit = {
  roomId: Id,
  sessionId: Id,
  /** The exit receipt prose. */
  exitSummary: z.string().max(4000).nullable().default(null),
  /** Final spend, micro-dollars. */
  spendMicros: Micros,
  /** Final context fill, 0..1. */
  contextPct: z.number().min(0).max(1).nullable().default(null),
  /**
   * The verified artifact this exit produced (#120), or `null`. Carried in the
   * ledger payload — the durable, receipt-indexed reference to the branch/commit
   * the session's work became; the ledger event remains the index (the ticket's
   * "reuse the ledger"). On the integrated tree the settle projection ALSO
   * persists its branch+commit into `sessions.artifact` (#121's `SessionArtifact`
   * slot), so #121's control-plane review pane certifies exactly the artifact
   * #120 produced. `remote` is #120's internal scratch pointer and is not copied.
   */
  artifact: ExecutionArtifact.nullable().default(null),
};

/**
 * A session settled — a clean exit. Writes the session's exit receipt
 * (`sessions.status/exit_summary/spend`) and NOTHING on `accepted_objects`: a
 * settle can never flip a `~` to a `✓` (#114 T3), and the projection proves it
 * by touching only the `sessions` row.
 */
export const SessionSettled = z.object({
  ...eventBase,
  type: z.literal('session_settled'),
  ...sessionExit,
});
export type SessionSettled = z.infer<typeof SessionSettled>;

/** A session failed — an exit owed attention until triaged. Also non-epistemic. */
export const SessionFailed = z.object({
  ...eventBase,
  type: z.literal('session_failed'),
  ...sessionExit,
});
export type SessionFailed = z.infer<typeof SessionFailed>;

/**
 * A signal raised — escalation, which reuses attention (#112). It names an
 * existing room subject (an object, a proposal or a message — the same closed
 * vocabulary `attention_items` already carries) and a participant to escalate
 * to, and `projectSignalRaised` writes one `attention_items` row for them. The
 * `class` and `reason` are `@atrium/core`'s own attention types, validated here
 * so the wire cannot invent an attention shape core would refuse to render —
 * and imported as types only, so nothing in core changes. Full signal semantics
 * beyond this escalation are #115 / the signal build.
 */
export const SignalRaised = z.object({
  ...eventBase,
  type: z.literal('signal_raised'),
  roomId: Id,
  /** The participant this escalates to — a `users` id (`attention_items.user_id`). */
  targetUserId: Id,
  /** Which table `subjectId` names — the existing attention subject vocabulary. */
  subjectKind: z.enum(['object', 'proposal', 'message']),
  subjectId: Id,
  class: AttentionClass,
  reason: RationaleReason,
});
export type SignalRaised = z.infer<typeof SignalRaised>;

/* ── the budget/rlimit enforcement boundary (#118, from #115's resolution) ────
 *
 * Both ledger-only, like the lifecycle six: they ride the spine for a `room_seq`
 * and never join `CoreEvent`. `plan_rlimit_set` is the human-only
 * spend-authorization that sets/raises a plan's slice; `draw_refused` is the
 * durable receipt a spawn takes when the slice is spent. Neither touches an
 * `accepted_objects` judgement column — a spend-authorization is a SPEND syscall
 * (#115), not a covenant `✓`.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * A plan's rlimit slice set or raised — the human act that funds the plan. The
 * command that produces it (`set_plan_rlimit`) is human-only, refused for a
 * non-human before the append exactly as a machine trying to certify is: no
 * machine-authored path raises a slice (#115 decision 4). `slice` is a count of
 * authorized draws — spawns/continues — this plan may be granted.
 */
export const PlanRlimitSet = z.object({
  ...eventBase,
  type: z.literal('plan_rlimit_set'),
  roomId: Id,
  planId: Id,
  /** The new ceiling on authorized draws. Non-negative; may raise or lower. */
  slice: z.number().int().nonnegative(),
});
export type PlanRlimitSet = z.infer<typeof PlanRlimitSet>;

/**
 * A draw refused at the authorization boundary — the durable, receipted refusal
 * a spawn takes when its plan's slice is spent (#118, #115 decision 2). It is a
 * ROW, not a silent stop-after: `reason=budget`, carrying the slice and the
 * committed authorized-draw count it was checked against, so the refusal is
 * visible and reconciles. No `sessions` row is created and no draw is granted —
 * the whole point is that the draw did NOT happen.
 */
export const DrawRefused = z.object({
  ...eventBase,
  type: z.literal('draw_refused'),
  roomId: Id,
  /** The plan whose slice refused this draw. */
  planId: Id,
  /** Why the draw was refused. Only `budget` today; a closed set that may grow. */
  reason: z.literal('budget'),
  /** The plan's slice at the moment of refusal — what the draw was checked against. */
  slice: z.number().int().nonnegative(),
  /** The committed authorized-draw count at refusal. `+ 1 > slice` is why. */
  authorizedDraws: z.number().int().nonnegative(),
  /** The harness/model the refused spawn would have run — for the receipt. */
  harness: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
});
export type DrawRefused = z.infer<typeof DrawRefused>;

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
  PlanOpened,
  PlanSettled,
  SessionOpened,
  SessionSettled,
  SessionFailed,
  SignalRaised,
  PlanRlimitSet,
  DrawRefused,
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
export type ServerEvent =
  | MessagePosted
  | AttentionResolved
  | PlanOpened
  | PlanSettled
  | SessionOpened
  | SessionSettled
  | SessionFailed
  | SignalRaised
  | PlanRlimitSet
  | DrawRefused;

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
    case 'plan_opened':
    case 'plan_settled':
    case 'session_opened':
    case 'session_settled':
    case 'session_failed':
    case 'signal_raised':
    case 'plan_rlimit_set':
    case 'draw_refused':
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
