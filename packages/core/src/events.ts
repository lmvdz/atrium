import { z } from 'zod';
import { Actor, Id, Timestamp } from './common.js';
import { AcceptedObject } from './objects.js';
import { Proposal } from './proposal.js';
import { Relation } from './relations.js';

/**
 * The event log the reducer folds. Nothing is ever mutated in place and nothing
 * is ever erased — a correction is another event (init.md §5).
 */

/**
 * `amend` patches the payload, `retract` withdraws an object without deleting
 * it ("that was only a suggestion, not a decision"), `restore` undoes a
 * retraction. All three keep the prior value on the record.
 */
export const CorrectionAction = z.enum(['amend', 'retract', 'restore']);
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
  ObjectAccepted,
  ObjectCorrected,
  RelationAdded,
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
export type CoreEventInput = z.input<typeof CoreEvent>;
export type CoreEventType = CoreEvent['type'];
