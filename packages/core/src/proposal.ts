import { z } from 'zod';
import { Id, Timestamp } from './common.js';
import { isBlank } from './matching.js';

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
  /**
   * Source messages this reading was drawn from. **Enforced non-empty for model
   * proposers** by the refinement below — see `Proposal`.
   */
  provenance: z.array(Id).default([]),
  /**
   * The span of a cited message this reading rests on, verbatim. Optional
   * because a human staging a proposal is not quoting anything, but when a model
   * supplies one it is checkable, and `validateProposalProvenance` checks it:
   * the quote must appear in a cited message *after* GitHub reply-blockquotes
   * are stripped. The interpretation spike's worst error — a claim attributed to
   * the wrong person at 0.98 confidence — was a quote that only existed inside
   * somebody else's reply-blockquote, and nothing but this field makes that
   * detectable without a model.
   */
  quote: z.string().nullable().default(null),
  interpretationId: Id.nullable().default(null),
  status: ProposalStatus.default('proposed'),
  createdAt: Timestamp,
});

/** The payload is validated against the same schema the accepted object will use. */
const ProposalShape = z.discriminatedUnion('type', [
  proposalBase.extend({ type: z.literal('decision'), payload: DecisionPayload }),
  proposalBase.extend({ type: z.literal('commitment'), payload: CommitmentPayload }),
  proposalBase.extend({ type: z.literal('open_question'), payload: OpenQuestionPayload }),
  proposalBase.extend({ type: z.literal('claim'), payload: ClaimPayload }),
  proposalBase.extend({ type: z.literal('objective'), payload: ObjectivePayload }),
]);

/**
 * The proposal, with the two rules that could not be expressed field-by-field.
 *
 * **1. A model proposal must cite at least one message.** This was a comment on
 * `provenance` and nothing else — routed out of #19's gauntlet, because a
 * comment is not a constraint. Provenance is the receipt: it is what the UI
 * shows under a `~`, what `validateProposalProvenance` checks a quote against,
 * and what a person clicks to decide whether the reading is right. A model
 * proposal with no receipt is an assertion, which is the one thing the
 * acceptance boundary exists to refuse. A *human* proposer may cite nothing —
 * a person staging their own reading is the receipt.
 *
 * **2. A model proposal must quote the message it was read out of — every type.**
 * r1's gauntlet found the attribution check was satisfied by the owner having
 * authored *any* cited message, so padding `provenance` with one message the
 * owner happened to write flipped a third-party commitment into a self-statement.
 * The fix binds attribution to the message that carries the sentence, and the
 * only thing that identifies that message is the quote.
 *
 * That argument scoped the rule to claims and commitments, the two types that put
 * a name on somebody, and **r3's gauntlet found the scope was the hole**: a model
 * objective with `quote: null` cited one message with an empty body and reached
 * accepted state with no receipt check running at all. Attribution is one thing
 * the quote answers; the other is "which sentence, in which message", and every
 * type is minted from a sentence. So the quote is mandatory for all five —
 * without it there is no answer to what this reading rests on, and the honest
 * reading of no answer is that it rests on nothing.
 *
 * Emptiness is `isBlank`: a quote of `"​"` or `"…"` carries no words and is
 * the same absence as `null`, checked in the one place that decides what content
 * is rather than by a `trim()` that only knows about spaces.
 */
export const Proposal = ProposalShape.superRefine((proposal, ctx) => {
  if (proposal.proposer.kind !== 'model') return;
  if (proposal.provenance.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['provenance'],
      message:
        'a model proposal must cite at least one source message — a reading with no receipt cannot be checked, and an unbacked `~` is an assertion',
    });
  }
  if (isBlank(proposal.quote)) {
    ctx.addIssue({
      code: 'custom',
      path: ['quote'],
      message: `a model ${proposal.type} proposal must quote the message that carries it — a receipt names the sentence it rests on, and without the quote there is nothing to identify it`,
    });
  }
});

export type Proposal = z.infer<typeof Proposal>;
export type ProposalInput = z.input<typeof Proposal>;

/** The union without the cross-field rule, for callers that need `.options`. */
export const ProposalVariants = ProposalShape;

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
