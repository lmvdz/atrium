import { z } from 'zod';
import { Id, Timestamp } from './common.js';
import {
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from './objects.js';

/**
 * Pre-acceptance staging. A proposal is what the interpreter *thinks* happened.
 * It renders as `~`, never as a fact, until a human accepts it — that boundary
 * is the whole trust model (init.md §5).
 */

export const Proposer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('human'), userId: Id }),
]);
export type Proposer = z.infer<typeof Proposer>;

export const ProposalStatus = z.enum(['proposed', 'accepted', 'rejected', 'superseded']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

const proposalBase = z.object({
  id: Id,
  roomId: Id,
  /** Model self-reported confidence, 0..1. Acceptance rules read this. */
  confidence: z.number().min(0).max(1),
  proposer: Proposer,
  /** Source messages this reading was drawn from. Never empty for model proposals. */
  provenance: z.array(Id).default([]),
  interpretationId: Id.nullable().default(null),
  status: ProposalStatus.default('proposed'),
  createdAt: Timestamp,
});

/** The payload is validated against the same schema the accepted object will use. */
export const Proposal = z.discriminatedUnion('type', [
  proposalBase.extend({ type: z.literal('decision'), payload: DecisionPayload }),
  proposalBase.extend({ type: z.literal('commitment'), payload: CommitmentPayload }),
  proposalBase.extend({ type: z.literal('open_question'), payload: OpenQuestionPayload }),
  proposalBase.extend({ type: z.literal('claim'), payload: ClaimPayload }),
  proposalBase.extend({ type: z.literal('objective'), payload: ObjectivePayload }),
]);

export type Proposal = z.infer<typeof Proposal>;
export type ProposalInput = z.input<typeof Proposal>;

/** `Omit` that distributes over a union, so the `type` discriminator survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A proposal as the reducer stores it: everything the event carried *except*
 * `status`.
 *
 * Status is lifecycle, and lifecycle belongs to the log — `proposal_rejected`
 * and `object_accepted` move it. Keeping a second, mutable copy inside the
 * stored proposal gave two answers to one question, and only one of them was
 * ever updated. `ProposalRecord.status` is the only status there is; use
 * `proposalWithStatus` when a caller wants the whole proposal back.
 */
export type StoredProposal = DistributiveOmit<Proposal, 'status'>;

/** Drops the wire status so the record cannot hold a stale second copy of it. */
export function storeProposal(proposal: Proposal): StoredProposal {
  const { status: _status, ...rest } = proposal;
  return rest as StoredProposal;
}
