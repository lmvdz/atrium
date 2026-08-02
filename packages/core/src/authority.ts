import type { Actor } from './common.js';
import {
  type ProvenanceMessage,
  referringProblems,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
import { hasContent, isBlank } from './matching.js';
import { type AcceptedObject, type AcceptedObjectType, objectStatement } from './objects.js';
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
 * | Claims auto-accept at confidence ≥ θ, if the text certifies the type | model | **here** + `policy.ts` |
 * | OpenQuestions auto-accept at confidence ≥ θ              | model   | **here**  |
 * | **Commitments never auto-accept** (r5)                   | human   | **here**  |
 * | **Objectives never auto-accept** (r5)                    | human   | **here**  |
 * | **Decisions never auto-accept**                          | human   | **here**  |
 * | A claim becomes `verified`                               | human   | **here**  |
 * | Supersession, split by the type being retired            | per policy | **here** |
 * | **Corrections (amend / retract / restore / …)**          | human   | **here**  |
 * | **Acceptance citing no proposal at all**                 | human   | **here**  |
 * | **Declaring a question answered**                        | human   | **here**  |
 *
 * **That row said "~~Claims auto-accept~~ (r7: human)" until r8, and it was
 * false.** `MODEL_ACCEPTANCE_FLOOR.claim` is `0.7` at runtime — derived from
 * `DEFAULT_ACCEPTANCE_RULES.claim.thetaAuto`, because `autoAccept` stayed `true`
 * for claims — and a model lands a claim end-to-end at it, which is the path the
 * product is built on. r7 built the `+Infinity` version, measured it deleting
 * the auto-accept path entirely, and reverted it; `policy.ts` records the revert
 * in full. This table and the comment on `modelMintingGate` below were written
 * for the version that did not ship and were never brought back, so two comments
 * in this file described a number that had not existed since the same afternoon.
 * Both were found independently by two of r8's reviewers, which is what a
 * comment stating a false fact about the code beside it usually costs.
 *
 * What is actually true: a claim is #4's auto-accept shape — cheap to correct,
 * truth carried separately in `verification` — and it auto-accepts at θ_auto
 * **when the words certify that they were a claim at all**. `type` is supplied
 * by the proposal, so `typeCertifiableFromText` asks whether the sentence could
 * equally be an undertaking, and a sentence that could is referred rather than
 * accepted. That rule is about the *text*, so it cannot live in a table keyed by
 * type; `MODEL_ACCEPTANCE_FLOOR` is the θ half and `typeCertifiableFromText` is
 * the other, and `reduce.ts` runs both.
 *
 * `policy.test.ts` asserts the floor table against `DEFAULT_ACCEPTANCE_RULES`
 * entry by entry, so a prose claim about a number in this file can be checked
 * against the number.
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
 *
 * ## What this floor enforces *independently*, and what it shares
 *
 * r4's receipt claimed two boundaries without qualification, and r4's blind
 * review was right to refuse it: `acceptanceReceiptRefusal` below calls the same
 * `validateProposalProvenance` the engine does, so a defect in quote semantics
 * is a defect in both. The claim is scoped rather than repeated:
 *
 *  - **Independent of the engine, and unreachable from it** — delete
 *    `acceptance.ts` entirely and every one of these still holds. Both blind
 *    reviews found this list short, so it is enumerated rather than gestured at:
 *    every human-only gate above (direct acceptance, decision / commitment /
 *    objective minting, claim verification, supersession, answer relations,
 *    corrections); that a cited proposal exists, is not rejected, accepted or
 *    superseded, and matches the object's type and room; that a non-human acted
 *    on a reading it staged itself; `MODEL_ACCEPTANCE_FLOOR`; payload equality;
 *    provenance equality; that an `objectiveId` points at a real objective in
 *    the same room; that a message window exists; that a quote exists.
 *  - **Shared, by design**: what the quote *means* — one implementation, two
 *    call sites, because two implementations of "does this quote bear this
 *    sentence" would be two answers to one question and `policy.ts` exists to
 *    say why that is the defect rather than the redundancy.
 */
export type HumanOnlyGate =
  /** `object_accepted` with `provenance.proposalId === null`. */
  | 'direct_acceptance'
  /** `object_accepted` for a `decision`, proposal or no proposal. */
  | 'decision_acceptance'
  /**
   * `object_accepted` for a `commitment`. **r5.** #44's fact-check drove a model
   * actor through the whole stack with `{statement: 'Bob will deploy production
   * Friday', owner: 'user_bob'}` and it landed with zero issues: the quote was
   * real, the author was real, and the attribution rules read it as self-stated
   * because the bearing message's author id equalled the owner. Nothing asked
   * whether a machine may put an obligation on a named person at all.
   */
  | 'commitment_acceptance'
  /**
   * `object_accepted` for an `objective`. **r5.** An objective is what
   * everything else is filed under, and `decideSupersession` already reserves
   * *retiring* one to a person — a gate on the way out and none on the way in is
   * a front door with the back door open.
   */
  | 'objective_acceptance'
  /** Any transition of a claim to `verification: 'verified'`. */
  | 'claim_verification'
  /** `supersedes` pointed at a type the supersession policy reserves to people. */
  | 'supersession'
  /** An `answers` edge — declaring a question settled. */
  | 'answer_relation'
  /** `object_corrected`, every verb. */
  | 'correction';

/**
 * The gate a non-human actor hits when it tries to mint this type, or `null`
 * when the type is one a machine may mint.
 *
 * **Derived from the same θ table `MODEL_ACCEPTANCE_FLOOR` is derived from**, so
 * the named refusal and the unreachable number cannot drift: a type that stops
 * auto-accepting acquires a gate here in the same commit, and `policy.test.ts`
 * asserts the two agree for every type rather than trusting this switch.
 *
 * A gate *and* a floor for the same rule is deliberate. The floor alone would
 * refuse these acceptances — `+Infinity` is unreachable — but it would refuse
 * them as "confidence 0.95 is below the floor of Infinity", which tells a room
 * nothing about why. `RETRO.md`: a rule applied at one site is not a rule, and a
 * refusal that does not name itself is a dead end.
 *
 * **`claim` has no gate here and a perfectly reachable floor** — 0.7, the same
 * θ_auto the engine reads. The r7 comment that stood here said the floor was
 * `+Infinity`; see the table above for why that describes a draft rather than
 * the code. A claim's *type* refusal is not "a machine may not perform this act"
 * — a machine reading a room and recording what it found is the whole product —
 * but "nothing in these words proves this was a claim rather than a commitment",
 * which is a fact about the reading and rides with `typeCertifiableFromText`
 * beside θ, not with the gates in this switch.
 *
 * Putting it here as a `claim_acceptance` gate was built and reverted for a
 * separate reason worth keeping: this switch runs before the verified-claim
 * check, so a gate on every claim shadows `claim_verification` into
 * unreachability, and a defence deleted by being shadowed costs more than the
 * message it buys.
 */
export function modelMintingGate(type: AcceptedObjectType): HumanOnlyGate | null {
  switch (type) {
    case 'decision':
      return 'decision_acceptance';
    case 'commitment':
      return 'commitment_acceptance';
    case 'objective':
      return 'objective_acceptance';
    // ── Why `claim` is not in this row ─────────────────────────────────────
    //
    // A model may land a claim: `MODEL_ACCEPTANCE_FLOOR.claim` is 0.7, and an
    // unambiguous assertion quoted verbatim auto-accepting is the path the
    // product exists for. What it may not do is land one whose words read as an
    // undertaking — `typeCertifiableFromText`, enforced one screen down beside
    // the floor rather than here.
    //
    // (The r7 comment on these lines said the floor was `+Infinity` since r7. It
    // was not; that was the draft r7 measured and reverted. Corrected in r8 —
    // see the table at the top of this file.)
    //
    // A `claim_acceptance` gate was built here first and put back for an
    // unrelated reason that still holds: this switch runs **before** the
    // verified-claim check, so a named gate on every claim swallows
    // `claim_verification` whole and makes it unreachable — a defence deleted by
    // being shadowed, which is worse than the message it was buying.
    case 'claim':
    case 'open_question':
      return null;
    default: {
      const exhaustive: never = type;
      // A type nobody has classified is not a type a machine may mint.
      return JSON.stringify(exhaustive) === '' ? null : 'direct_acceptance';
    }
  }
}

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
    case 'commitment_acceptance':
      return `${subject} is a commitment accepted by a ${kind} actor — accepting it writes an obligation onto a named person who never agreed to it, and #4's rule is that nobody gets committed by someone else's sentence; a ${kind} actor may propose the commitment and let the person named, or a person in the room, accept it`;
    case 'objective_acceptance':
      return `${subject} is an objective accepted by a ${kind} actor — an objective is what everything else in the room is filed under, and retiring one already needs a person (#4's supersession split), so minting one does too; a ${kind} actor may propose it and let a person accept`;
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

/**
 * The refusal text for a reading whose *kind of act* the record cannot settle.
 *
 * r7. The receipt proves who wrote a sentence and that nothing later took it
 * back; it cannot prove the sentence was a claim rather than a commitment, and
 * `type` is supplied by the proposal. This is the reducer's half — the engine's
 * is `acceptance.ts`'s `type_not_certified` row — and both call
 * `typeCertifiableFromText`, so the two cannot drift.
 *
 * Not a `HumanOnlyGate`, deliberately: those rows say *a machine may not perform
 * this act*, and a machine reading a room and recording what it found is the
 * whole product. This says *nothing proves this was that act*, which is a fact
 * about the reading. It also has to sit below the verified-claim check rather
 * than in that switch, which runs first and would shadow `claim_verification`
 * into unreachability — built that way once and reverted.
 */
export function uncertifiedTypeRefusal(
  actor: Actor,
  type: AcceptedObjectType,
  subject: string,
): string {
  return `${subject} was accepted as a ${type} by a ${actor.kind} actor, and the quoted words read as something somebody is undertaking to do as easily as something they are asserting — a receipt proves who wrote a sentence, not what kind of act it was, so which of the two this is is the proposal's own word; a ${actor.kind} actor may propose it and let a person accept it as a ${type} or as a commitment`;
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
  /**
   * No message window — **absent, empty, or carrying no message with any content
   * in it** — so the receipt cannot be checked at all. The three were separate
   * checks away from each other across rounds 2 and 3 and are one check now:
   * `messages: []` and `[{body: ''}]` are not windows somebody supplied, they are
   * the same absence spelled differently.
   */
  | 'missing_receipt_context'
  /**
   * A machine reading that quotes nothing. Re-required here rather than trusted
   * from the schema a layer up — round 2's gauntlet found that layer was never
   * reached — and required for **every** model-minted type since r4, because
   * round 3's gauntlet minted an objective through the hole where it was not.
   */
  | 'missing_quote'
  /** The receipt is wrong: the quote, who is named in it, or what it says. */
  | 'receipt_failed'
  /**
   * The receipt could not be judged either way, so a machine may not act on it.
   * The quote contains every word of the statement, in order, and says more —
   * and those extra words may be an aside or may be "not". A person decides.
   */
  | 'receipt_not_certifiable'
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
 *  3. **A window at all.** No messages, no auto-acceptance, ever — and `[]` is
 *     no messages, and so is one message with nothing in it. Round 2's gauntlet
 *     found the `undefined`-only check; round 3's found the `length`-only one.
 *     Absent, empty, and empty-of-content are the same fact about the world.
 *  4. **A quote at all**, for every model-minted type. The schema requires it;
 *     this re-requires it, because round 2's gauntlet found the schema was never
 *     run on the fold path. An empty quote is the same absence as a missing one,
 *     and it is the input the bearing and attribution rules are computed from.
 *  5. **The receipt itself** — the quote is long enough to identify a sentence,
 *     it is in a cited message, it is that author's own text rather than
 *     something they were quoting, exactly one author carries it, and the
 *     statement being minted **is that quote**, with nothing dropped but the
 *     full stop in `RECEIPT_POLICY.droppableTokens`. (This read "nothing dropped
 *     but articles" until r6, describing a set that lost `a`, `an` and `the` in
 *     r4 — the licence it named had been gone for two rounds.)
 *  6. **Certifiability.** A quote that says *more* than the statement is not
 *     refused as wrong and is not accepted as right: nothing here can tell an
 *     aside from a "not", so a machine may not act on it and a person must.
 *  7. **Third-party attribution.** A commitment whose owner did not write the
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

  // ── A window at all, and emptiness as a property of the content ───────────
  //
  // Round 2 closed `undefined`; round 2's gauntlet reopened it with `[]`; round
  // 3's gauntlet reopened it again with `[{ id, authorId, body: '' }]` — one
  // message, so `length === 0` is false, and nothing in it. All three are the
  // same fact: nobody supplied the messages this reading cites. The test is
  // therefore about content, not about the array, and `hasContent` is the one
  // place that decides what content is (a letter or a digit — not a list of the
  // invisible characters somebody has thought of).
  const window = input.messages;
  if (window === undefined || window.length === 0 || !window.some((m) => hasContent(m.body))) {
    const how =
      window === undefined
        ? 'no message window supplied'
        : window.length === 0
          ? 'an empty message window supplied'
          : `a message window of ${window.length} message${window.length === 1 ? '' : 's'} with nothing in any of their bodies`;
    return {
      gate: 'missing_receipt_context',
      detail: `${who} accepted proposal "${proposalId}" with ${how}, so its receipt could not be checked — a reading whose citation cannot be verified is refused, never accepted on trust; a window with no words in it is not a window, it is the same absence written differently`,
    };
  }

  // ── A quote at all, for every model-minted type ───────────────────────────
  //
  // Scoped to claims and commitments until r4, on the argument that they are the
  // two that put a name on somebody. That is true and it is not the whole job:
  // r3's gauntlet minted a model *objective* with `quote: null` against a window
  // of empty bodies, and no quote-length, bearing or attribution check ran on it
  // at all. The quote is what answers "which sentence, in which message" — every
  // type needs that answer, and a type with no quote has no receipt to check.
  if (isBlank(proposal.quote)) {
    return {
      gate: 'missing_quote',
      detail: `${who} accepted ${object.type} proposal "${proposalId}", which quotes nothing — a receipt names the sentence it rests on and only the quote identifies it, so a model-minted ${object.type} with an absent or empty quote is refused rather than resting on whoever happens to be in the citation list`,
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
      // The sentence the object actually asserts — checked *from the object*
      // rather than from the proposal on purpose. Payload binding above has
      // already proved the two are identical, so reading it here says what this
      // check is about: the quote has to bear the thing being minted.
      statement: objectStatement(object),
    },
    window,
  );

  const rejecting = rejectingProblems(problems);
  if (rejecting.length > 0) {
    return {
      gate: 'receipt_failed',
      detail: `${who} accepted proposal "${proposalId}" on a receipt that does not hold: ${rejecting.map((problem) => problem.detail).join('; ')}`,
    };
  }

  // A receipt the check declines to rule on is not a receipt that passed. The
  // acceptance is refused with its own gate name so the log distinguishes "the
  // citation is wrong" from "the citation may be right and nothing here can say
  // so" — the second one is a question for a person, and a person accepting it
  // runs none of this.
  const referring = referringProblems(problems);
  if (referring.length > 0) {
    return {
      gate: 'receipt_not_certifiable',
      detail: `${who} accepted proposal "${proposalId}" on a receipt this check declines to rule on: ${referring.map((problem) => problem.detail).join('; ')}`,
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
