import type { Actor } from './common.js';
import {
  type ProvenanceMessage,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
import type { AcceptedObject, AcceptedObjectType } from './objects.js';
import { decideSupersession, MODEL_ACCEPTANCE_FLOOR } from './policy.js';
import type { Proposer, StoredProposal } from './proposal.js';
import { canonicalJson } from './state.js';

/**
 * Who is allowed to do what, and on what evidence — the *floor* under the
 * acceptance rules, enforced where nothing can route around it.
 *
 * Issue #4 resolved acceptance per type. Some of that matrix is policy that
 * belongs to the θ engine; the rest is the trust boundary itself, and a boundary
 * enforced only in the layer above the reducer is a boundary that a second
 * writer, a replay, or a bug walks around. Those rows live here, and the reducer
 * refuses to fold an event that breaks them.
 *
 * #4's matrix, and where each row is enforced:
 *
 * | rule (#4)                                               | who may | where     |
 * | ------------------------------------------------------- | ------- | --------- |
 * | Claims auto-accept at confidence ≥ θ                     | model   | **here**  |
 * | OpenQuestions auto-accept at confidence ≥ θ              | model   | **here**  |
 * | Commitments: self-stated auto-accepts, third-party waits | model/human | **here** |
 * | **Decisions never auto-accept**                          | human   | **here**  |
 * | A claim becomes `verified`                               | human   | **here**  |
 * | Supersession, split by the type being retired            | per policy | **here** |
 * | **Corrections (amend / retract / restore / …)**          | human   | **here**  |
 * | **Acceptance citing no proposal at all**                 | human   | **here**  |
 * | **Declaring a question answered**                        | human   | **here**  |
 *
 * ## What round 2 moved down here, and why
 *
 * Every row above that used to say "#21 (θ)" or "the engine" now says **here**.
 * Round 1's gauntlet found the same shape twice:
 *
 *  1. **The actor was forgeable.** Every gate below reads an actor, and the
 *     actor used to be part of the event payload — so a worker could declare
 *     itself human and walk through all of them. The actor now arrives out of
 *     band (`TrustedContext`), derived from the authenticated session, and the
 *     event schema has nowhere to put one.
 *  2. **The receipt checks were opt-in.** θ, quote-matching, and "did the person
 *     named actually say this" lived in `acceptance.ts`, which the layer that
 *     mints events calls *if it remembers to* and which returned "no problems"
 *     when handed no messages. A check that fails open when its input is missing
 *     is a manner, not a boundary. They are conditions of folding now:
 *     `acceptanceReceiptRefusal` runs on every non-human acceptance, and an
 *     acceptance whose messages the reducer cannot see is refused rather than
 *     waved through.
 *
 * Two things are still deliberately left open, so the omission is a decision:
 *  - `proposal_recorded` is open to every actor. Recording a reading is not
 *    asserting it; the whole trust model is that staging is free and acceptance
 *    is not.
 *  - `proposal_rejected` is not a correction verb — withdrawing a staged reading
 *    destroys nothing — but it is narrowed by `ProposalBindingGate`: a model may
 *    retire *its own* reading, not somebody else's.
 *
 * `acceptance.ts` still exists and is still stricter: it runs over richer inputs
 * (what the room already accepted, the whole window) and decides what a worker
 * should emit at all. It reads the same θ table this file does, so the two
 * cannot invert.
 */
export type HumanOnlyGate =
  /** `object_accepted` with `provenance.proposalId === null`. */
  | 'direct_acceptance'
  /** `object_accepted` for a `decision`, proposal or no proposal. */
  | 'decision_acceptance'
  /** Any transition of a claim to `verification: 'verified'`. */
  | 'claim_verification'
  /** `supersedes` pointed at a type the supersession policy reserves to people. */
  | 'supersession'
  /** An `answers` edge — declaring a question settled. */
  | 'answer_relation'
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
export function humanOnlyRefusal(
  gate: HumanOnlyGate,
  actor: Actor,
  subject: string,
  retiredType?: AcceptedObjectType,
): string {
  const kind = actor.kind;
  switch (gate) {
    case 'direct_acceptance':
      return `${subject} was accepted with no proposal by a ${kind} actor — only a human may accept an object directly; a ${kind} actor must record a proposal and have it accepted`;
    case 'decision_acceptance':
      return `${subject} is a decision accepted by a ${kind} actor — a decision never auto-accepts (issue #4): a ${kind} actor may propose one, but only a human may accept it`;
    case 'claim_verification':
      return `${subject} would become a verified claim on a ${kind} actor's word — only a human may move a claim to "verified"; a ${kind} actor may accept it as unverified or disputed`;
    case 'supersession':
      return `${subject} retires an accepted ${retiredType ?? 'object'} on a ${kind} actor's word — ${retiredType ? decideSupersession(retiredType).reason : 'this type needs a human'}; a ${kind} actor may propose the replacement and let a person retire it`;
    case 'answer_relation':
      return `${subject} declares an open question answered on a ${kind} actor's word — only a human may bind an answer (#4: a decision reaches the room through answer-binding or an explicit accept, never through inference); a ${kind} actor may propose the answer and let a person bind it`;
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

/* ─────────────────────────────────────────────────────────────────────────
 * The receipt, as a condition of folding
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Why a non-human acceptance was refused on its receipt rather than on its
 * actor. One name per check, so a caller can switch and a test can pin.
 */
export type AcceptanceReceiptGate =
  /** The object's payload is not the payload that was staged. */
  | 'payload_binding'
  /** The object's cited messages are not the proposal's. */
  | 'provenance_binding'
  /** No message window was supplied, so the receipt cannot be checked at all. */
  | 'missing_receipt_context'
  /** The receipt is wrong: the quote, or who is named in it. */
  | 'receipt_failed'
  /** A commitment somebody else's sentence put a name on. It needs their word. */
  | 'third_party_confirm';

export interface AcceptanceReceiptRefusal {
  gate: AcceptanceReceiptGate;
  detail: string;
}

/**
 * Everything a **non-human** acceptance must survive beyond "may this actor
 * touch this proposal at all".
 *
 * Each of these was a call-site manner in round 1 and is a trust boundary now.
 * They run in this order because the answers get more expensive and less
 * certain as you go down: what was staged is a fact about two payloads, the
 * receipt is a fact about the room's messages, and third-party attribution is a
 * judgement about a person.
 *
 *  1. **Payload binding.** The proposal is the thing a person could have read
 *     before it landed. An acceptance that cites it while minting a *different*
 *     statement — or a different owner — has used the citation as a permission
 *     slip: r1's gauntlet, "staging a self-owned commitment then minting a
 *     third-party one". Canonical equality, so key order is never a difference.
 *  2. **Provenance binding.** Same argument, applied to the receipt: an
 *     acceptance may not add or drop cited messages on the way through, because
 *     the citation set is what the attribution rules below are computed over.
 *  3. **A window at all.** No messages, no auto-acceptance, ever.
 *  4. **The receipt itself** — the quote is in a cited message, and is that
 *     author's own text rather than something they were quoting.
 *  5. **Third-party attribution.** A commitment whose owner did not write the
 *     message bearing it is not a self-statement, and #4 is unambiguous that
 *     nobody gets committed by someone else's sentence. It is a real reading and
 *     it goes to the named person to confirm — through a human acceptance, not
 *     through this path.
 *
 * A human acceptance runs none of this: a person accepting a reading has read
 * it, and their judgement is the receipt. That asymmetry is the product.
 */
export function acceptanceReceiptRefusal(input: {
  actor: Actor;
  proposalId: string;
  proposal: StoredProposal;
  object: AcceptedObject;
  messages: readonly ProvenanceMessage[] | undefined;
}): AcceptanceReceiptRefusal | null {
  const { object, proposal, proposalId } = input;
  const who = actorName(input.actor);

  if (canonicalJson(object.payload) !== canonicalJson(proposal.payload)) {
    return {
      gate: 'payload_binding',
      detail: `object "${object.id}" cites proposal "${proposalId}" but does not carry its payload — ${who} may only accept the reading that was staged, not mint a different one behind a citation that says a person could have checked it`,
    };
  }

  const objectCites = [...object.provenance.messageIds].sort();
  const proposalCites = [...proposal.provenance].sort();
  if (canonicalJson(objectCites) !== canonicalJson(proposalCites)) {
    return {
      gate: 'provenance_binding',
      detail: `object "${object.id}" cites messages [${objectCites.join(', ')}] but proposal "${proposalId}" was staged against [${proposalCites.join(', ')}] — the receipt may not change on the way through acceptance; it is what the attribution rules are computed over`,
    };
  }

  if (input.messages === undefined) {
    return {
      gate: 'missing_receipt_context',
      detail: `${who} accepted proposal "${proposalId}" with no message window supplied, so its receipt could not be checked — a reading whose citation cannot be verified is refused, never accepted on trust`,
    };
  }

  const attributedTo =
    object.type === 'claim'
      ? object.payload.claimant
      : object.type === 'commitment'
        ? object.payload.owner
        : null;

  const problems = validateProposalProvenance(
    {
      type: proposal.type,
      provenance: proposal.provenance,
      quote: proposal.quote,
      proposer: proposal.proposer,
      attributedTo,
    },
    input.messages,
  );

  const rejecting = rejectingProblems(problems);
  if (rejecting.length > 0) {
    return {
      gate: 'receipt_failed',
      detail: `${who} accepted proposal "${proposalId}" on a receipt that does not hold: ${rejecting.map((problem) => problem.detail).join('; ')}`,
    };
  }

  const thirdParty = problems.find((problem) => problem.kind === 'attributed_person_not_author');
  if (thirdParty) {
    return {
      gate: 'third_party_confirm',
      detail: `${who} accepted proposal "${proposalId}" as a commitment for somebody who did not write it: ${thirdParty.detail}. Nobody gets committed by someone else's sentence (#4) — it waits for the named owner to confirm, and only a human acceptance can carry that confirmation`,
    };
  }

  return null;
}
