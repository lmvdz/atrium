import { z } from 'zod';
import { Actor, emptyProvenance, Id, Provenance, Timestamp } from './common.js';
import { AcceptedObject, AcceptedObjectType } from './objects.js';
import { Proposal } from './proposal.js';
import { Relation } from './relations.js';

/**
 * The event log the reducer folds. Nothing is ever mutated in place and nothing
 * is ever erased — a correction is another event (init.md §5).
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
  actor: Actor,
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
   * before/after"). Attribution is `actor`, which every event carries; this is
   * the other half. A correction with a receipt can be shown next to the thing
   * it corrected; one without is an unexplained edit, and the counterexample
   * extractor that feeds corrections back into the interpretation prompt (#5)
   * has nothing to point at.
   */
  provenance: Provenance.default(emptyProvenance),
  note: z.string().nullable().default(null),
});

export const RelationAdded = z.object({
  ...eventBase,
  type: z.literal('relation_added'),
  relation: Relation,
});

export const CoreEvent = z.discriminatedUnion('type', [
  ProposalRecorded,
  ProposalRejected,
  ProposalSuperseded,
  ObjectAccepted,
  ObjectCorrected,
  RelationAdded,
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
export type CoreEventInput = z.input<typeof CoreEvent>;
export type CoreEventType = CoreEvent['type'];
