import type { Actor } from './common.js';

/**
 * Who is allowed to do what — the *floor* under the acceptance rules, not the
 * rules themselves.
 *
 * Issue #4 resolved acceptance per type. Most of that matrix is policy that
 * belongs to the θ engine (#21): confidence thresholds, which types a model may
 * propose at all, how a third-party commitment routes to its named owner. But
 * some of it is not policy — it is the trust boundary itself, and a boundary
 * enforced only in the layer above the reducer is a boundary that a second
 * writer, a replay, or a bug can walk around. Those rows live here, and the
 * reducer refuses to fold an event that breaks them.
 *
 * #4's matrix, and where each row is enforced:
 *
 * | rule (#4)                                              | who may | where          |
 * | ------------------------------------------------------ | ------- | -------------- |
 * | Claims auto-accept at confidence ≥ θ                    | model   | #21 (θ)        |
 * | OpenQuestions auto-accept at confidence ≥ θ             | model   | #21 (θ)        |
 * | Commitments: self-stated auto-accepts, third-party waits | model/human | #21 (attribution) |
 * | **Decisions never auto-accept**                          | human   | **here**       |
 * | A claim becomes `verified`                               | human   | **here**       |
 * | Supersession retiring a claim or a question              | model   | (allowed)      |
 * | **Supersession retiring an accepted Decision**            | human   | **here**       |
 * | **Corrections (amend / retract / restore)**               | human   | **here**       |
 * | **Acceptance citing no proposal at all**                  | human   | **here**       |
 *
 * The three rows marked "(allowed)"/"#21" are deliberately *not* gated: a model
 * accepting a claim or an open question through its own proposal is the design
 * (#4), and gating it here would break the auto-accept path the product wants.
 * The `verification` field is what carries truth status for a claim — `~` until
 * a human confirms — so the claim row that matters is the transition to `✓`.
 *
 * Two things deliberately left open, so the omission is a decision and not an
 * oversight:
 *  - `proposal_rejected` is not a correction verb. Withdrawing a staged reading
 *    destroys nothing (the proposal stays in state, rejected and visible), and
 *    an interpreter retiring its own low-confidence proposal is a path #4 wants.
 *  - Commitment attribution (self-stated vs third-party) needs the message the
 *    commitment was drawn from, which the reducer does not have. #21's.
 */
export type HumanOnlyGate =
  /** `object_accepted` with `provenance.proposalId === null`. */
  | 'direct_acceptance'
  /** `object_accepted` for a `decision`, proposal or no proposal. */
  | 'decision_acceptance'
  /** Any transition of a claim to `verification: 'verified'`. */
  | 'claim_verification'
  /** `supersedes` pointed at an accepted `decision`. */
  | 'decision_supersession'
  /** `object_corrected`, every verb. */
  | 'correction';

/** The one predicate every gate is built from. */
export function isHuman(actor: Actor): boolean {
  return actor.kind === 'human';
}

/**
 * The refusal text for a gate. Kept beside the matrix so the reason a room
 * sees and the rule that produced it cannot drift apart, and so every message
 * names both what was refused and the route that stays open — a refusal that
 * does not say what to do instead is a dead end.
 */
export function humanOnlyRefusal(gate: HumanOnlyGate, actor: Actor, subject: string): string {
  const kind = actor.kind;
  switch (gate) {
    case 'direct_acceptance':
      return `${subject} was accepted with no proposal by a ${kind} actor — only a human may accept an object directly; a ${kind} actor must record a proposal and have it accepted`;
    case 'decision_acceptance':
      return `${subject} is a decision accepted by a ${kind} actor — a decision never auto-accepts (issue #4): a ${kind} actor may propose one, but only a human may accept it`;
    case 'claim_verification':
      return `${subject} would become a verified claim on a ${kind} actor's word — only a human may move a claim to "verified"; a ${kind} actor may accept it as unverified or disputed`;
    case 'decision_supersession':
      return `${subject} retires an accepted decision on a ${kind} actor's word — superseding a decision requires a human, exactly as accepting one does; superseding a claim or a question does not`;
    case 'correction':
      return `${subject} was corrected by a ${kind} actor — corrections (amend, retract, restore) are human-only in v1: a correction rewrites what the room already accepted`;
    default: {
      const exhaustive: never = gate;
      return `unknown authority gate ${JSON.stringify(exhaustive)}`;
    }
  }
}
