import type { Actor } from './common.js';
import type { AcceptedObjectType } from './objects.js';
import type { Proposer } from './proposal.js';

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
 *    **#21 narrows this rather than reopening it**: see `ProposalBindingGate` —
 *    a model may retire *its own* reading, not somebody else's.
 *  - Commitment attribution (self-stated vs third-party) needs the message the
 *    commitment was drawn from, which the reducer does not have. #21's, and it
 *    lives in `acceptance.ts` where the message authors are an input.
 *
 * ## What #21 added to this floor, and why each row is here and not upstairs
 *
 * The rows above answer "who may". Three more answer "on what", and they are
 * here for the same reason: a rule enforced only where the events are minted is
 * a rule a second writer walks around.
 *
 *  - **`ProposalBindingGate`** — a non-human actor may only act on a proposal it
 *    authored. Without it, "a model may reject its own low-confidence reading"
 *    reads as "a model may reject any reading", and one interpreter can silently
 *    retire another's — or a human's — staged proposals. Acceptance has the same
 *    hole: a model accepting a *human's* proposal is the human's judgement being
 *    minted by a machine.
 *  - **`MODEL_ACCEPTANCE_FLOOR`** — a non-human actor may not accept a proposal
 *    below the per-type confidence floor. The r4 floor closed every *type* a
 *    model may not mint; it left the write surface open at *any confidence* for
 *    the types it may. `θ` is otherwise a policy the layer above applies to its
 *    own events, which is a policy that only holds while that layer is the only
 *    writer. (The spike measured self-reported confidence as uncorrelated with
 *    correctness — 0.937 mean on wrong objects vs 0.928 on right ones — so this
 *    floor is a write-surface bound, not a quality signal. It is set where a
 *    value is implausible rather than merely low.)
 *
 * Neither replaces the acceptance engine. `acceptance.ts` runs stricter rules
 * over richer inputs and decides what *should* be emitted; this decides what may
 * be folded at all, and it is deliberately the weaker of the two — a floor that
 * duplicated the engine's judgement would have to be given the engine's inputs,
 * and the reducer would stop being a function of the log.
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

/**
 * The three proposal operations a non-human actor may only perform on a
 * proposal it authored itself.
 */
export type ProposalBindingGate =
  /** `object_accepted` citing a proposal somebody else staged. */
  | 'acceptance_binding'
  /** `proposal_rejected` against a proposal somebody else staged. */
  | 'rejection_binding'
  /** `proposal_superseded` against a proposal somebody else staged. */
  | 'supersession_binding';

/**
 * May this actor act on a proposal this proposer staged?
 *
 * A **human** may act on any proposal — that is the whole product: a person
 * reads what the machine staged and judges it. The direction that is closed is
 * the other one.
 *
 * A **model** may act only on its own proposals, matched by model id. Two
 * interpreters run against the same room (#7's two tiers, by construction), and
 * without this the cheap tier could accept the expensive tier's staged readings,
 * or retire them before anyone saw them. Model id is the only identity a model
 * actor carries, so it is the identity that binds.
 *
 * A **system** actor never matches, because `Proposer` has no system variant:
 * nothing the system emits was ever staged by the system, so there is no
 * proposal it can own. It may still do everything a system actor could do
 * before — this closes a door that was never open.
 */
export function actorMatchesProposer(actor: Actor, proposer: Proposer): boolean {
  if (actor.kind === 'human') return true;
  if (actor.kind === 'model') return proposer.kind === 'model' && proposer.model === actor.model;
  return false;
}

/** A short name for a proposer, for refusal texts. */
function proposerName(proposer: Proposer): string {
  return proposer.kind === 'model' ? `model "${proposer.model}"` : `user "${proposer.userId}"`;
}

/** A short name for an actor, for refusal texts. */
export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case 'human':
      return `user "${actor.userId}"`;
    case 'model':
      return `model "${actor.model}"`;
    case 'system':
      return 'the system actor';
    default: {
      const exhaustive: never = actor;
      return JSON.stringify(exhaustive);
    }
  }
}

/** The refusal text for a proposal-binding gate. Kept beside the predicate. */
export function proposalBindingRefusal(
  gate: ProposalBindingGate,
  actor: Actor,
  proposer: Proposer,
  proposalId: string,
): string {
  const who = actorName(actor);
  const whose = proposerName(proposer);
  switch (gate) {
    case 'acceptance_binding':
      return `proposal "${proposalId}" was staged by ${whose} and ${who} tried to accept it — a non-human actor may only accept its own reading; accepting somebody else's is minting their judgement`;
    case 'rejection_binding':
      return `proposal "${proposalId}" was staged by ${whose} and ${who} tried to reject it — a non-human actor may only withdraw its own reading; only a human may reject another's`;
    case 'supersession_binding':
      return `proposal "${proposalId}" was staged by ${whose} and ${who} tried to supersede it — a non-human actor may only retire its own reading with a newer one`;
    default: {
      const exhaustive: never = gate;
      return `unknown proposal binding gate ${JSON.stringify(exhaustive)}`;
    }
  }
}

/**
 * The confidence a non-human actor must clear to accept a proposal of each
 * type. **This is a floor on the write surface, not a tuned θ.**
 *
 * `acceptance.ts` holds the θ_auto/θ_min the product actually runs on, and they
 * are higher; this is the value below which an acceptance is not a judgement
 * call but a malformed event, and it is enforced where nothing can route around
 * it. Read the two together: the engine decides what to emit, this decides what
 * can be folded, and `AcceptanceConfig` refuses to be configured beneath it, so
 * the two can never invert.
 *
 * `decision` is present and set to a value nothing can reach, so the table is
 * total over the five types and cannot silently acquire a hole if the decision
 * gate above it is ever moved. A decision is human-only regardless of
 * confidence — the gate above returns first, and this row is unreachable by
 * construction.
 */
export const MODEL_ACCEPTANCE_FLOOR: Readonly<Record<AcceptedObjectType, number>> = Object.freeze({
  /** Unreachable: `decision_acceptance` refuses every non-human actor first. */
  decision: Number.POSITIVE_INFINITY,
  commitment: 0.5,
  open_question: 0.4,
  claim: 0.5,
  objective: 0.5,
});

/** The refusal text for the confidence floor. */
export function confidenceFloorRefusal(
  actor: Actor,
  type: AcceptedObjectType,
  proposalId: string,
  confidence: number,
): string {
  const floor = MODEL_ACCEPTANCE_FLOOR[type];
  return `${actorName(actor)} accepted ${type} proposal "${proposalId}" at confidence ${confidence}, below the floor of ${floor} for that type — a non-human actor may not mint an object from a reading it does not stand behind; propose it and let a human accept`;
}
