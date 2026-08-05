import { z } from 'zod';
import { type Actor, emptyProvenance, Id, Provenance, Timestamp } from './common.js';
import type { ProvenanceMessage } from './escalation.js';
import { AcceptedObject, AcceptedObjectType } from './objects.js';
import { Proposal } from './proposal.js';
import { Relation } from './relations.js';

/**
 * The event log the reducer folds. Nothing is ever mutated in place and nothing
 * is ever erased — a correction is another event (init.md §5).
 *
 * ## The actor is not in here, and that is the whole point
 *
 * Round 1's gauntlet rated this blocking, from the boundary rather than from an
 * exploit: every human-only gate in `authority.ts` reads `event.actor`, and
 * `event.actor` was part of the payload. A payload is whatever the writer says
 * it is. An interpretation worker emitting `{"actor":{"kind":"human","userId":
 * "alice"}}` was Alice, as far as four rounds of trust gates were concerned —
 * and "the caller is trusted" stops being true the moment there is a second
 * writer, a replayed log, or a bug.
 *
 * So the actor left. It is not an optional field, not a stripped field, not a
 * field the reducer overwrites: **the event schema has no place to put one**,
 * and `CoreEvent` refuses at parse time to accept an input that carries one, so
 * a forged actor cannot even be silently dropped on the floor — it is an error
 * with a message that says where the actor belongs instead.
 *
 * Where it belongs is `TrustedContext`, handed to `appendEvent` beside the
 * event. See that type for the exact seam #22 implements against.
 */

/**
 * The correction verbs (#5's resolution), and how each maps onto this log.
 *
 * | #5 verb       | here                                                        |
 * | ------------- | ----------------------------------------------------------- |
 * | `retype`      | `retype` — "that was only a suggestion": decision → claim     |
 * | `amend`       | `amend` — field edit, *except* the attribution field          |
 * | `reattribute` | `reattribute` — owner / claimant / decidedBy, and only those  |
 * | `reject`      | `retract` — revoke acceptance; the object tombstones          |
 * | `reopen`      | `reopen` — answered → open, prior answer preserved on record  |
 * | `supersede`   | the `supersedes` **relation**, not a correction               |
 *
 * Two of those mappings are worth stating rather than leaving to be inferred.
 * #5's `reject` and this log's `retract` are the same operation under two
 * names — "revoke acceptance; object tombstones but stays in history with its
 * correction chain" is exactly what `retract` already did in the scaffold, and
 * minting a synonym would have given the reducer two code paths to keep
 * identical forever. `restore` is its inverse and has no #5 name because #5
 * never contemplated undoing a rejection; it is kept.
 *
 * `supersede` is a relation because supersession is a *fact about two objects*
 * — the newer one is reachable from the older one, both survive, and #4 splits
 * its authority by what is being retired. A correction has one subject.
 *
 * **Why `amend` and `reattribute` are separate verbs.** "Justin didn't commit,
 * he was estimating" is not a typo fix: it moves an obligation off a named
 * person, which is the single most consequential edit in the product (#4:
 * nobody gets committed by someone else's sentence). Folding it into `amend`
 * would make "who took this off me, and when" a substring search over patches.
 * So `amend` refuses to touch the attribution field and `reattribute` touches
 * nothing else — the correction log then answers that question by verb.
 */
export const CorrectionAction = z.enum([
  'amend',
  'retract',
  'restore',
  'retype',
  'reattribute',
  'reopen',
]);
export type CorrectionAction = z.infer<typeof CorrectionAction>;

const eventBase = {
  id: Id,
  at: Timestamp,
};

export const ProposalRecorded = z.object({
  ...eventBase,
  type: z.literal('proposal_recorded'),
  proposal: Proposal,
});

export const ProposalRejected = z.object({
  ...eventBase,
  type: z.literal('proposal_rejected'),
  proposalId: Id,
  reason: z.string().nullable().default(null),
});

/**
 * Re-interpretation retires a staged reading (#8: a message re-read at a bumped
 * `interpretation_version`). This is what makes `ProposalStatus.superseded` a
 * live value rather than the dead enum #19's gauntlet flagged: a superseded
 * proposal is neither accepted nor rejected — nobody judged it, a newer reading
 * of the same messages replaced it — and collapsing that into `rejected` would
 * tell the room a person declined something no person ever saw.
 *
 * The spike's finding governs *when* a worker may emit this: two identical runs
 * of the same window shared only ~45% of their objects, so superseding every
 * prior proposal on a version bump deletes readings the new run merely failed to
 * re-derive. Supersede only what the new run contradicts. That policy is #23's;
 * the reducer's job is to record the retirement and bind it to an actor.
 */
export const ProposalSuperseded = z.object({
  ...eventBase,
  type: z.literal('proposal_superseded'),
  proposalId: Id,
  /** The newer reading that replaces it, when there is one. */
  supersededByProposalId: Id.nullable().default(null),
  reason: z.string().nullable().default(null),
});

export const ObjectAccepted = z.object({
  ...eventBase,
  type: z.literal('object_accepted'),
  object: AcceptedObject,
});

export const ObjectCorrected = z.object({
  ...eventBase,
  type: z.literal('object_corrected'),
  objectId: Id,
  action: CorrectionAction,
  /** Partial payload patch; validated against the object's own payload schema. */
  patch: z.record(z.string(), z.unknown()).default({}),
  /**
   * `retype` only: the type the object becomes. Ignored by every other verb.
   * Kept as its own field rather than smuggled through `patch`, because the
   * type is not part of any payload schema and a patch key that silently means
   * something structural is how a payload edit becomes a type change by
   * accident.
   */
  toType: AcceptedObjectType.nullable().default(null),
  /**
   * Where the correction came from — the messages that motivated it (#19 r1:
   * "correction events must carry provenance/attribution, not just payload
   * before/after"). Attribution is the trusted actor, which every append
   * carries out of band; this is the other half. A correction with a receipt can
   * be shown next to the thing it corrected; one without is an unexplained edit,
   * and the counterexample extractor that feeds corrections back into the
   * interpretation prompt (#5) has nothing to point at.
   */
  provenance: Provenance.default(emptyProvenance),
  note: z.string().nullable().default(null),
});

export const RelationAdded = z.object({
  ...eventBase,
  type: z.literal('relation_added'),
  relation: Relation,
});

/** The payload union, before the no-actor guard. Exposed for `.options`. */
export const CoreEventVariants = z.discriminatedUnion('type', [
  ProposalRecorded,
  ProposalRejected,
  ProposalSuperseded,
  ObjectAccepted,
  ObjectCorrected,
  RelationAdded,
]);

/**
 * An event payload, refusing any actor an author tries to smuggle in with it.
 *
 * Zod strips unknown keys by default, which would have been the *quiet* fix:
 * the forged actor would vanish and the event would fold happily under whatever
 * actor the command layer supplied. That is safe and it is not honest — a
 * worker sending an actor field believes it is doing something, and it should
 * be told it is not, at the boundary, once. So the guard runs before the union
 * and turns it into a parse error naming the seam.
 */
export const CoreEvent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'actor')) {
      ctx.addIssue({
        code: 'custom',
        path: ['actor'],
        message:
          'an event payload may not carry an actor — the actor is a trusted argument to appendEvent, derived from the authenticated session, never from the payload',
      });
    }
  })
  .pipe(CoreEventVariants);

export type CoreEvent = z.infer<typeof CoreEventVariants>;
export type CoreEventInput = z.input<typeof CoreEventVariants>;
export type CoreEventType = CoreEvent['type'];

/* ─────────────────────────────────────────────────────────────────────────
 * The trusted seam
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The two trusted columns, as a caller supplies them. `trustedContext` turns one
 * of these into the branded value the reducer takes.
 *
 * ## `actor`
 *
 * Derived from the authenticated session at the command layer — a signed-in
 * user id for a human, the worker's own model identity for an interpretation
 * pass, the process identity for the system actor. It is never read off the
 * request body, and it is what every human-only gate in `authority.ts` consults.
 *
 * When the event is persisted, the actor is stored **as a column** on the ledger
 * row (`core_events.actor_kind` / `actor_id`), written by the same transaction
 * that assigns `room_seq`. It is not part of the payload jsonb. A replay reads
 * the column back and hands it here — so a replayed log carries exactly the
 * authority the live append had, and nothing a payload says can change it.
 *
 * ## `messages`
 *
 * The messages a receipt check can be run against. Not "every message the
 * accepted proposal cites" — **the room's messages, in room order, continuing
 * past the ones it cites**, read from the room's own message table in the same
 * request. Also a trusted read, also never payload.
 *
 * **Required, and non-empty, for any non-human acceptance.** Round 1's second
 * blocking finding was that provenance validation was opt-in: omit the window
 * and the problem set came back empty and the reading auto-accepted. Round 2's
 * was the same hole through a different door: `messages: []` passed an
 * `undefined`-only check and came out the far side as "nothing to check". Absent
 * and empty are one case now, and it is a refusal. A human acceptance needs
 * nothing here — a person reading the room *is* the receipt.
 *
 * **And truncated is a third spelling of the same hole, closed in r6.** This
 * sentence used to say "at minimum every message the accepted proposal cites",
 * and a caller that read it literally supplied exactly those — which turns the
 * later-correction scan off, because every message it was allowed to read is one
 * the proposal chose. `AcceptanceContext.messages` has the table showing the
 * same proposal auto-accepting on the narrow window and being refused on the
 * room's; `laterRevision` refuses the narrow one now.
 */
export interface TrustedContextInput {
  actor: Actor;
  messages?: readonly ProvenanceMessage[];
}

declare const trustedContextBrand: unique symbol;

/**
 * Everything the reducer is allowed to believe that did **not** come out of the
 * event payload. This is the interface #22 implements.
 *
 * ## Why it is branded
 *
 * r2's gauntlet, major 2: the type was a plain `{ actor, messages? }`, so any
 * object literal anywhere satisfied it. Nothing distinguished "derived at the
 * seam from an authenticated session" from "assembled three layers down out of
 * whatever was to hand", which is precisely the distinction the type exists to
 * carry. It cannot be written by accident now: the only way to obtain one is
 * `trustedContext(...)` or `authored(...)`, so every place a trusted context is
 * *created* is a place somebody had to type the word `trusted`, and `grep` finds
 * all of them.
 *
 * ## What core does **not** guarantee — stated plainly, because the brand looks
 * like more than it is
 *
 * The brand is a **compile-time discipline, not an authentication mechanism.**
 * `trustedContext({ actor: req.body.actor })` compiles, produces a valid
 * `TrustedContext`, and core will believe every word of it. Concretely, core
 * cannot and does not check:
 *
 *  1. **That `actor` came from an authenticated session.** Core has no session,
 *     no signature, no clock and no I/O — it cannot. If the command layer reads
 *     an actor off a request body, a client is a human as far as every gate in
 *     `authority.ts` is concerned, and nothing here will notice.
 *  2. **That `messages` are the room's real messages, or all of them.** A caller
 *     that fabricates a window fabricates the receipt with it. The window must
 *     be read from the room's own message table inside the same request, and it
 *     must continue past the messages the proposal cites — `laterRevision` reads
 *     nothing else, so a window that stops at the citations is a correction scan
 *     that cannot fire. Core refuses the truncation it can see — a window
 *     holding *nothing but* the citations — and cannot, by looking, tell a
 *     window that stops one message later from a room that genuinely ends there:
 *     they are the same bytes, and distinguishing them needs the message table,
 *     which core does not have.
 *
 *     **#86 narrowed this to the shape of the supplier rather than the shape of
 *     the window.** `RECEIPT_POLICY.maxLaterMessagesCarried` is a number the
 *     supplier and the checker both know — `atrium_receipt_window`
 *     (`drizzle/0011`) stops there, and it is one more than
 *     `maxLaterMessagesScanned`, so a truncated tail always lands over the read
 *     bound and refers while anything shorter is provably the room's end. That
 *     closes it for a caller that honours the bound, and `laterRevision` refuses
 *     by name if the two numbers are ever set so that it could not. It is still
 *     an assertion by the caller — a caller free to fabricate a window is free
 *     to fabricate a short one — which is why this stays on the list.
 *  3. **That a replay reconstructs the authority the live append had.** That
 *     needs the actor stored as immutable ledger columns and read back from
 *     them; core folds whatever the caller hands it. Replaying a payload under a
 *     different actor is replaying a different event, and `replay.test.ts` pins
 *     that the same bytes under a human and a model fold to different states —
 *     which is a demonstration that the actor matters, *not* a guarantee that it
 *     is preserved.
 *
 * All three are #22's, are required for this half to mean anything, and are
 * recorded there. What core does guarantee is the other half and only the other
 * half: given a truthful trusted context, no machine-authored event reaches an
 * accepted or verified object without a receipt that holds.
 */
export interface TrustedContext extends TrustedContextInput {
  readonly [trustedContextBrand]: 'derived at the seam, never from a payload';
}

/**
 * Mint a trusted context. **The only producer**, so the set of places that claim
 * something is trusted is enumerable.
 *
 * This function checks nothing, and that is not an oversight — see
 * `TrustedContext` for the three things core cannot check and #22 must. Calling
 * it is an assertion by the caller, made once, where a reader can find it.
 */
export function trustedContext(input: TrustedContextInput): TrustedContext {
  return input as TrustedContext;
}

/**
 * One ledger row, as `reduce` folds it: the payload plus its trusted columns.
 *
 * `reduce(log)` takes these, not bare events, because a replay must reconstruct
 * the authority of the original append and the payload cannot supply it.
 */
export interface AuthoredEvent extends TrustedContext {
  event: CoreEvent;
}

/**
 * Pair an event with its trusted context — the producer #22's replay path uses,
 * turning a ledger row's columns back into a foldable row.
 */
export function authored(event: CoreEvent, trusted: TrustedContextInput): AuthoredEvent {
  return { ...trusted, event } as AuthoredEvent;
}
