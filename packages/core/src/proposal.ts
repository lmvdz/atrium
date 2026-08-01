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
