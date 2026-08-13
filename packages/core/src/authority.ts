import { payloadAttributions } from './attribution.js';
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
import { type Proposer, proposerIsMachine, type StoredProposal } from './proposal.js';
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
 * | A claim becomes `verified`                               | a human who is neither its claimant nor its stager (#68/#95) | **here** |
 * | **Confirming a third-party commitment** (#67/#95)        | its named owner | **here** |
 * | **Amending a reading at acceptance** (#81/#95)           | only under the accepter's own name | **here** |
 * | Supersession, split by the type being retired            | per policy | **here** |
 * | **Retiring anything a person has confirmed** (#95, r2)   | human   | **here**  |
 * | **Corrections (amend / retract / restore / …)**          | human   | **here**  |
 * | **Acceptance citing no proposal at all**                 | human   | **here**  |
 * | **Declaring a question answered**                        | human   | **here**  |
 * | **A name arriving on a sentence** (#4: *committed*)      | only its bearer | **here** |
 * | **A sentence arriving under a name** (#4: *quoted*)      | only its bearer | **here** |
 *
 * The first three rows are #95's relation matrix, decided in #102: kind answers
 * *may this species certify at all* (the rows below), relation answers *may this
 * actor certify this object* (`selfVerificationRefusal`, `ownerConfirmRefusal`,
 * `acceptanceAttributionRefusal`). Both must pass.
 *
 * The last two rows are one sentence of #4's split in half — *nobody gets
 * committed, **or quoted**, by someone else's sentence* — and they are written
 * as two rows because they were closed a round apart, the second only after the
 * first shipped with the whole sentence quoted at a room and half of it
 * enforced. A matrix row that describes a rule the code does not hold is the
 * defect this lane has now hit three times; both rows are pinned by cells in
 * `authority-matrix.test.ts` that drive the reducer and read what it said.
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
  /**
   * `supersedes` pointed at an object a **person has already touched**,
   * whatever its type. **#95, #96 r2.**
   *
   * The gate above keys on the *type* being retired, which is #4's split and is
   * the whole of what the reducer asked until now. #90's audit found what that
   * leaves standing once a machine can hold an account: `decideSupersession`
   * says a claim and an open question `auto_accept`, so an authenticated agent
   * could retire a claim **a person had accepted** — a `✓` deleted on a
   * machine's word, which is the covenant read backwards. Both foreign-lineage
   * critics found it independently and this build's own authority matrix pinned
   * it as correct.
   *
   * #95 decided the rule this enforces: **a non-human may never retire an
   * accepted object via supersession at all** — confirmed or not — it may only
   * draft a superseding reading. Kind answers *may this species certify at all*;
   * the answer for retirement is simply no. `epistemicStateOf(target)` is read
   * only to choose *which* reason the refusal carries (`confirmed_supersession`
   * vs `unconfirmed_supersession`), never to decide whether to refuse.
   *
   * (The first cut of this gate keyed the refusal on `confirmed` alone — the
   * narrow interim of #95's table. #96 round 3 broadened it after a blind critic
   * found that left a non-human free to retire another machine's unconfirmed
   * `~`, which — since an agent owns no proposal — is always foreign. #102 still
   * owns the full HUMAN relation matrix: who verified, who stated, who owns.)
   *
   * Ordered *after* `supersession` on purpose: a machine retiring a confirmed
   * decision is refused by the type rule and hears the type rule's more specific
   * reason. This general gate then catches every remaining non-human
   * retirement — the `auto_accept` types (claim, open question) at any epistemic
   * state — which are exactly the cells the type table left open.
   *
   * What stays open, and must: a machine may always **draft** a superseding
   * reading and let a person retire the old one. That is the covenant's
   * left-hand side and nothing here narrows it — `proposal_superseded` on a
   * *pending* proposal, a different event, stays open too. What is closed is
   * retiring a *standing accepted* object by a `supersedes` relation.
   */
  | 'confirmed_supersession'
  /**
   * `supersedes` pointed at an accepted object no person has confirmed —
   * a model's own unconfirmed `~`. **#96 r3.**
   *
   * The gate above closed the `✓` half of #95; its blind critic found the `~`
   * half still open, because `!isHuman(actor) && epistemicStateOf === 'confirmed'`
   * refused only a person's judgement and let a machine unmake another machine's
   * reading. #95's decided rule is on the *relation*, not the epistemic state: a
   * non-human **never** retires a standing accepted object by superseding it, it
   * only drafts a fresh `~`. Since an agent owns no proposal of its own, every
   * unconfirmed accepted object it can reach was accepted by a model, so this
   * cell is always a foreign retirement — which is why closing it is the whole
   * of #95's non-human-supersede rule, not a further narrowing. The distinct
   * gate value keeps the *reason* honest: this retirement destroyed no person's
   * `✓`, and the refusal says so.
   */
  | 'unconfirmed_supersession'
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

/**
 * The one predicate every gate is built from.
 *
 * Written as an allowlist of the single kind that passes, and that spelling is
 * now load-bearing rather than stylistic. An `agent` actor holds a `users` row,
 * a session and a room membership — everything that used to be sufficient to be
 * treated as a person by anything downstream of a session. Written as
 * `kind !== 'model' && kind !== 'system'` this function would have silently
 * started returning true for it, and every gate below would have opened at once.
 * One kind passes; anything the union gains is a machine until this line says
 * otherwise.
 *
 * Takes only the `kind` — the whole question is which kind, and nothing else on
 * an actor bears on it. Narrowing the parameter is what lets the read model ask
 * the same predicate off a projected `accepted_by_kind` column (via
 * `epistemicStateFromAcceptance`) without reconstructing a whole Actor: the
 * rendered `✓` and the enforced gate then read one function, not two.
 */
export function isHuman(actor: Pick<Actor, 'kind'>): boolean {
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
  /**
   * "a model actor", "a human actor", "a system actor" — and "an agent actor".
   *
   * A refusal is prose the room reads. Interpolating the discriminant straight
   * into `a ${kind}` was correct for every kind the union had when it was
   * written and is wrong for the first one that starts with a vowel, so the
   * article is derived from the word rather than assumed. Every existing message
   * is byte-identical; only the new kind reads differently, which is the point.
   */
  const a = /^[aeiou]/.test(kind) ? 'an' : 'a';
  switch (gate) {
    case 'direct_acceptance':
      return `${subject} was accepted with no proposal by ${a} ${kind} actor — only a human may accept an object directly; ${a} ${kind} actor must record a proposal and have it accepted`;
    case 'decision_acceptance':
      return `${subject} is a decision accepted by ${a} ${kind} actor — a decision never auto-accepts (issue #4): ${a} ${kind} actor may propose one, but only a human may accept it`;
    case 'commitment_acceptance':
      return `${subject} is a commitment accepted by ${a} ${kind} actor — accepting it writes an obligation onto a named person who never agreed to it, and #4's rule is that nobody gets committed by someone else's sentence; ${a} ${kind} actor may propose the commitment and let the person it names — its owner, and only its owner (#67) — confirm it`;
    case 'objective_acceptance':
      return `${subject} is an objective accepted by ${a} ${kind} actor — an objective is what everything else in the room is filed under, and retiring one already needs a person (#4's supersession split), so minting one does too; ${a} ${kind} actor may propose it and let a person accept`;
    case 'claim_verification':
      return `${subject} would become a verified claim on ${a} ${kind} actor's word — only a human may move a claim to "verified"; ${a} ${kind} actor may accept it as unverified or disputed`;
    case 'supersession':
      return `${subject} retires an accepted ${retiredType ?? 'object'} on ${a} ${kind} actor's word — ${retiredType ? decideSupersession(retiredType).reason : 'this type needs a human'}; ${a} ${kind} actor may propose the replacement and let a person retire it`;
    case 'confirmed_supersession':
      return `${subject} retires an object a person has already confirmed, on a ${kind} actor's word — a non-human may never retire anything the room has confirmed (#95), whatever its type: the ✓ is a person's judgement and unmaking it is the same act as making it; a ${kind} actor may draft a superseding reading (~) and let a person retire the old one`;
    case 'unconfirmed_supersession':
      return `${subject} supersedes an accepted ${retiredType ?? 'object'} on a ${kind} actor's word — a non-human may never retire a standing accepted object by superseding it (#95), even an unconfirmed reading another machine accepted; a ${kind} actor may draft a superseding reading (~) and let a person retire the old one`;
    case 'answer_relation':
      return `${subject} declares an open question answered on ${a} ${kind} actor's word — only a human may bind an answer (#4: a decision reaches the room through answer-binding or an explicit accept, never through inference); ${a} ${kind} actor may propose the answer and let a person bind it`;
    case 'correction':
      return `${subject} was corrected by ${a} ${kind} actor — corrections (amend, retract, restore) are human-only in v1: a correction rewrites what the room already accepted`;
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
 *
 * An **agent** matches its own proposals, matched by user id — and this is the
 * decision #117 came back to make, which `Proposer` gaining an agent variant is
 * exactly the day for. The prior comment here said an agent owns nothing because
 * `Proposer` had no agent variant; now it does, and the principled answer is the
 * one that keeps a model and an agent on the identical footing this whole ticket
 * rests on. An agent is a machine that stages as itself, so — like a model with
 * its own reading — it may withdraw or supersede the reading it staged, and may
 * accept it only as far as a machine acceptance reaches: to `~`, never to `✓`.
 * The user id is the identity an agent actor carries (a model carries a model
 * string), so it is the identity that binds. This opens NO self-certify path:
 * the reducer's `isHuman` gates refuse a machine minting a `✓` whether or not it
 * owns the reading, and `apps/server`'s covenant gate refuses every
 * certification-class command from a non-human before the append. What this
 * unlocks is only a machine managing its own `~`.
 */
export function actorMatchesProposer(actor: Actor, proposer: Proposer): boolean {
  if (actor.kind === 'human') return true;
  if (actor.kind === 'model') return proposer.kind === 'model' && proposer.model === actor.model;
  if (actor.kind === 'agent') return proposer.kind === 'agent' && proposer.userId === actor.userId;
  return false;
}

/**
 * The one human acceptance that is not a receipt: **your own** reading, when
 * that reading either wears a machine's name or puts somebody else's name on
 * something (#22 r9, D1).
 *
 * ## The claim this narrows, and why it survives narrowing
 *
 * `acceptanceReceiptRefusal` below says a human acceptance runs none of the
 * receipt gates, and that asymmetry is the product: **a person who reads a
 * machine's reading and accepts it is the receipt.** That is still the rule.
 * What it assumed, without saying so, is that the person reading the reading is
 * not the person who wrote it. Every gate it skips — the quote has to be in a
 * cited message, the named person has to have written it, the provenance has to
 * validate — is skipped on the strength of a human judgement that a *second*
 * party exercised. When the accepter is the stager, there is no second party
 * and no judgement was exercised at all: the same person wrote the sentence,
 * dressed it as a machine's reading, and blessed it.
 *
 * The gauntlet executed exactly that, over one socket, from an ordinary
 * membership: `record_proposal` with `proposer: {kind:'model', model:…}`, a
 * quote that appears in no cited message, a `commitment` owned by somebody else
 * — then `accept_proposal` on it. Both acked, `issues: []`, and out came a
 * durable commitment naming the victim, under a `proposals` row reading
 * `proposer_kind='model'`. The machine dressing is the whole of the harm: it
 * launders a member's sentence into a reading nobody is answerable for.
 *
 * ## Refused, not re-checked
 *
 * The tempting fix is to run the receipt gates on this acceptance instead of
 * skipping them. It does not hold: `atrium_receipt_window` derives NULL for a
 * human actor by construction, so the gates would have no window and would
 * refuse every self-acceptance as `missing_receipt_context` — the right answer
 * for the wrong reason, and a fail-open the moment somebody "fixes" the window
 * derivation. And a receipt that *did* validate would still not make this
 * acceptance a receipt, because the person checking is the person being checked.
 *
 * So this is a refusal in the shape of the thing that is actually missing: a
 * machine-attributed reading needs a human other than its stager to accept it.
 *
 * ## The second clause, and why it is the same defect rather than another one
 *
 * The first version of this rule keyed on the machine label alone, and the live
 * proof showed what that left standing: with `proposer` gone from the command
 * layer, the gauntlet's *exact* two-command sequence still minted a durable
 * `commitment` owned by the victim. All that changed was the dressing — the row
 * now read `proposer_kind='human'`, `proposer_user_id=<attacker>`. Same command,
 * same victim, same obligation, and #4 is unambiguous that **nobody gets
 * committed by someone else's sentence.**
 *
 * The reason it survived is worth stating, because it is the same sentence twice.
 * `acceptanceReceiptRefusal`'s sixth gate refuses a third-party commitment and
 * says it "waits for the named owner to confirm, and only a human acceptance can
 * carry that confirmation" — so a human acceptance *is* the confirmation. Which
 * human was never asked. When the confirming human is the one who wrote the
 * sentence, the confirmation is the sentence agreeing with itself.
 *
 * So the rule refuses a self-accepted staged reading on **either** ground:
 *
 *  1. it is machine-attributed — a reading nobody is answerable for, blessed by
 *     the person who typed it; or
 *  2. it attributes something to somebody other than the accepter — any payload
 *     field `attribution.ts` classifies as holding a person's id, holding
 *     somebody who is not the person accepting.
 *
 * **(2) used to say "a `claim`'s claimant or a `commitment`'s owner", and the
 * paragraph that stood here said a decision "names nobody". That was false, and
 * r10's D2 is what it cost.** `DecisionPayload` carries `decidedBy`;
 * `ATTRIBUTION_FIELD` had always said so; the *acceptance* path read a second,
 * narrower answer (`payloadAttributedTo`) that returned `null` for a decision.
 * So two commands — stage `{statement: "We are cancelling the audit",
 * decidedBy: <victim>}`, accept it yourself — put the victim's name on a
 * cancelled audit with `issues: []` twice, no correction verb involved and no
 * second person anywhere in it. (It was retractable afterwards, like anything
 * else; what it was not was refusable at the point it became durable.) The
 * set is derived from one classification of every payload field now, so the
 * sentence cannot drift from the code again: an objective and an open question
 * name nobody, a decision, a commitment and a claim each name one person, and a
 * payload that grows a name field nobody classified does not compile.
 *
 * ## What stays open, deliberately
 *
 *  - **A person staging and accepting their own commitment or claim.** "I will do
 *    X", "I said Y" — owner or claimant is the accepter, so there is no second
 *    person in it and nobody else's word is being spoken.
 *  - **A person staging and accepting an objective or an open question**, and a
 *    decision they did not put anybody else's name on. Those name nobody but the
 *    person asserting them; see above.
 *  - **A different human accepting a machine-labelled reading.** That is the
 *    design position, unchanged and load-bearing: they read it, and their
 *    judgement is the receipt. **Confirming a third-party *commitment* is no
 *    longer part of it** — #67 asked whether any human or only the named owner
 *    may, #95 decided the owner, and #102's `ownerConfirmRefusal` enforces that
 *    beside this gate. So this rule still refuses the *stager* accepting their
 *    own third-party reading, and `ownerConfirmRefusal` refuses *every other
 *    non-owner* accepting a commitment; between them, only the owner confirms one.
 *  - **A non-human accepter.** Already covered, and harder: `actorMatchesProposer`
 *    binds it to its own model id and `acceptanceReceiptRefusal` runs in full.
 *
 * ## Why it is not enough on its own, and what pairs with it
 *
 * `apps/server/src/commands.ts` no longer lets a socket choose `proposer` at all
 * — a participant-staged proposal is a *human* proposal, by construction, so
 * today nothing reachable from the wire can even build the input this refuses.
 * That closes today's door; this closes the class. When #21's pipeline lands and
 * a legitimate seam mints model proposals again, the pipeline is the stager
 * (`stagedBy.kind !== 'human'`), any person in the room may accept its readings
 * — a commitment still only by its owner (#67, `ownerConfirmRefusal`) — and the
 * only thing still refused is the case that was never legitimate.
 */
export function selfStagedReadingRefusal(input: {
  actor: Actor;
  /** `null` when the acceptance cites no proposal at all — see below. */
  proposalId: string | null;
  /** `null` for the same reason: with no proposal there is no reading to describe. */
  proposer: Proposer | null;
  stagedBy: Actor;
  /**
   * Everybody the object being minted puts a name on — every field
   * `attribution.ts` classifies as holding a person's id, in field order.
   *
   * Taken from the *object*, as `acceptanceReceiptRefusal` takes its statement
   * from the object: payload binding is not checked on the human path, so the
   * object is the thing whose attribution is about to become durable, and it is
   * the one this must be computed from. Computed by `payloadAttributions` and by
   * nothing else — a caller that spelled the ladder out by hand is how the
   * `decidedBy` hole (r10, D2) stayed open with the right table two files away.
   */
  attributedTo: readonly string[];
}): string | null {
  const { actor, proposer, stagedBy, attributedTo } = input;
  if (actor.kind !== 'human') return null;
  // Only the person who typed it. Anybody else accepting is a second judgement,
  // which is what the human path is built on.
  //
  // An acceptance that cites *no* proposal has no second party by construction —
  // there is no staged reading and no stager, only this one act — so the caller
  // passes the accepter as `stagedBy` and every clause below applies to it. That
  // route is human-only (`humanOnlyRefusal('direct_acceptance', …)`), unreachable
  // from today's command layer, and was outside this gate entirely until r10.
  if (stagedBy.kind !== 'human' || stagedBy.userId !== actor.userId) return null;

  const cites = input.proposalId === null ? 'no proposal' : `proposal "${input.proposalId}"`;
  // The machine predicate, not `kind === 'model'`: an `agent`-dressed reading is
  // a machine reading exactly as a model's is (#117), and this gate — whose whole
  // job is to refuse a stager blessing their own machine label (r9) — must not
  // let the `agent` label walk through the door the `model` label is refused at.
  if (proposer !== null && proposerIsMachine(proposer)) {
    const machine =
      proposer.kind === 'model' ? `model "${proposer.model}"` : `agent "${proposer.userId}"`;
    return `${actorName(actor)} accepted ${cites}, which they staged themselves as a reading by ${machine} — a human acceptance is the receipt for a machine's reading only when the person accepting is not the person who staged it; nobody validates their own attribution to a machine. It needs somebody else in the room to accept it, or a non-human acceptance, which is checked against the messages it cites`;
  }
  const foreign = attributedTo.filter((userId) => userId !== actor.userId);
  const named = foreign[0];
  if (named !== undefined) {
    return `${actorName(actor)} accepted ${cites}, which they staged themselves and which puts user "${named}"'s name on it — nobody gets committed, or quoted, by someone else's sentence (#4), and a person confirming their own sentence is that sentence agreeing with itself. It waits for "${named}" — and if it names them as a commitment's owner, only "${named}" may confirm it (#67); a claim somebody else names, any other member may accept`;
  }
  return null;
}

/**
 * The same rule, one act later: **a correction may not assert anything under a
 * name that is not the actor's own** — neither putting somebody's name on a
 * sentence (#22 r10, D1/D3) nor putting a sentence under somebody's name (#22
 * r11).
 *
 * ## Two clauses, because #4's sentence has two halves
 *
 * *Nobody gets committed, **or quoted**, by someone else's sentence.* Until r11
 * this function enforced the first half and quoted the whole thing. It compared
 * name sets and never looked at the text, so:
 *
 * ```
 * Bob:     accept  {statement: "I'll review the Q3 deck before Friday", owner: Bob}
 * Mallory: amend   {statement: "I falsified the Q3 revenue figures"}
 * Mallory: retype  → claim {claimant: Bob}      ← legal: Bob's name was already there
 * Mallory: amend   {verification: "verified"}
 * Mallory: amend   {statement: "I have been taking kickbacks from the vendor"}
 * ```
 *
 * — five commands, every one `ack` with `issues: []`, ending at
 * `type=claim, claimant=Bob, verification=verified, revision=5`, with a
 * statement Bob never wrote and would never write. Not one name arrived, so
 * clause one had nothing to say; the sentence under Bob's name was replaced
 * wholesale. That is being quoted by someone else's sentence in the most
 * literal reading the phrase has.
 *
 * So there are two clauses now and they are the same rule applied to the two
 * things a correction can move:
 *
 *  1. **A name arriving on a sentence.** Refused unless it is the actor's own.
 *  2. **A sentence arriving under a name.** Refused unless every name it lands
 *     under is the actor's own.
 *
 * Both are computed *here*, from the two objects, rather than by the caller:
 * `payloadAttributions` answers who, `objectStatement` answers what, and
 * neither question is re-answered anywhere on this path. r10's finding was that
 * a caller which spells the who-ladder out by hand is how the `decidedBy` hole
 * stayed open with the right table two files away; passing the objects in makes
 * the hand-spelled version unrepresentable rather than merely discouraged.
 *
 * ## Why this is `selfStagedReadingRefusal` again rather than a new policy
 *
 * r9 closed the forged-commitment class at the acceptance path and closed it
 * correctly. What it left standing is that acceptance is not the only way a
 * person's name arrives on an accepted object — `reattribute` moves one by
 * definition, `retype` mints one on a type that never had it, and `amend` is
 * only kept off it by a separate check. r10's gauntlet drove all three:
 * `reattribute` onto a colleague, onto a colleague via `retype` from an
 * objective, and onto a uuid belonging to no user at all, each with `ack`,
 * `issues: []`.
 *
 * The rule is not a second, stricter one. It is the *same* rule, evaluated where
 * its precondition is always true. `selfStagedReadingRefusal` refuses when the
 * person who wrote the naming sentence is also the person who blessed it. A
 * correction is one command by one actor: the sentence and the blessing are the
 * same act, so there is never a second party, so the clause always applies.
 * Read the other way round: what makes `Carol accepts Alice's reading that Bob
 * committed` legal today is Carol's independent judgement, and no correction has
 * an equivalent of Carol.
 *
 * ## `before`, and why the gate is about *arrival* rather than presence
 *
 * A commitment already owned by Bob may be amended (its due date), reopened, and
 * retracted by anyone in the room, because none of those acts asserts Bob's
 * name — it is already there, put there by an act this gate already judged.
 * Only a name that is in `after` and not in `before` is a new assertion, and only
 * new assertions are refused. That is what keeps every existing correction verb
 * working while closing the three that move a name.
 *
 * Clause two is `before`-relative in exactly the same way, and for exactly the
 * same reason. The trigger is the sentence *changing*, not the sentence
 * existing: `retract`, `restore` and `reopen` leave the text byte-identical and
 * so assert nothing about it, and `amend {due}` moves a `detail` field and
 * leaves the text alone. All of those keep working on somebody else's object,
 * as r10 made a named mutant to ensure. `retype` also survives it — carrying a
 * decision's `statement` into a claim's `statement` is the same string under a
 * new key, which is a statement about how the sentence was *read* and not a new
 * sentence. `TEXT_FIELD` is what makes that comparison possible across the key
 * rename, and it is derived from `PAYLOAD_FIELD_ROLE` rather than listed here:
 * a sixth type, or a renamed text key, is classified once in `attribution.ts`
 * and checked here with nothing edited.
 *
 * ## Which names clause two measures against
 *
 * The names on the object **after**, not before. A name that departs in the
 * same act is no longer borne by the sentence — `retype` from Bob's commitment
 * to Mallory's own claim, reworded, leaves Mallory's words under Mallory's
 * name, and there is nobody left to have been quoted. A name that stays is the
 * whole case above. And by the time clause two runs, clause one has already
 * refused every foreign name that *arrived*, so anything foreign still standing
 * in `after` was in `before` too — put there by an act this gate judged, on a
 * sentence that is now being replaced under it.
 *
 * ## What this closes without an FK
 *
 * `reattribute { owner: <a uuid that is no user> }` is refused by this too, and
 * not because anything checked the uuid: it is refused because it is not the
 * actor's own. The reducer has no membership table and should not grow one; a
 * rule of "your own name only" needs no directory to enforce.
 *
 * ## The legitimate case it costs, stated rather than hidden
 *
 * "The interpreter attributed this to Alice; it is really Bob's" can no longer
 * be fixed by a third party in one verb. Bob does it himself — which is #4 read
 * literally — or the object is retracted and re-staged, and a *second* person
 * accepts the re-reading. The two-person path is the point; the one-person path
 * was the defect.
 *
 * Clause two costs the same thing one field over, and it is the larger of the
 * two: **"the interpreter garbled Bob's sentence" can no longer be tidied by a
 * colleague either.** That reads like a loss until you notice what the tidying
 * does — a correction is human-only, so it sets `humanTouchedAt` and the object
 * becomes `✓`. A third party rewording a machine's reading of Bob's words does
 * not fix an attribution, it *ratifies* one, and it ratifies whatever it just
 * typed. The route the gauntlet drove through an accepted commitment runs
 * identically through a `~` claim, and comes out the same way: a verified
 * sentence in Bob's name that Bob never wrote. So the affordance and the defect
 * were one affordance. Bob refines his own reading — which is the correction
 * the product most needs and the one this keeps — and anybody else retracts it
 * and stages a re-reading a second person accepts.
 */
export function correctionAttributionRefusal(input: {
  actor: Actor;
  objectId: string;
  action: string;
  /**
   * The object as the room reads it now, and as the plan would leave it.
   *
   * Whole objects rather than pre-computed name sets: both questions this gate
   * asks — *who does this name* and *what does it say* — are answered here, by
   * `payloadAttributions` and `objectStatement`, so no caller can answer either
   * one differently. See the header.
   */
  before: AcceptedObject;
  after: AcceptedObject;
}): string | null {
  const { actor, before, after } = input;
  const isForeign = (userId: string): boolean => actor.kind !== 'human' || userId !== actor.userId;

  const namedBefore = payloadAttributions(before.type, before.payload);
  const namedAfter = payloadAttributions(after.type, after.payload);

  // Clause one: a name arriving on a sentence.
  const arriving = namedAfter.filter((userId) => !namedBefore.includes(userId)).filter(isForeign);
  const gained = arriving[0];
  if (gained !== undefined) {
    return `${actorName(actor)} applied "${input.action}" to object "${input.objectId}", putting user "${gained}"'s name on it — nobody gets committed, or quoted, by someone else's sentence (#4), and a correction is one person's act with no second party in it, so it may only put that person's own name on something. It waits for "${gained}" to take it, or retract this and stage a reading somebody else can accept`;
  }

  // Clause two: a sentence arriving under a name. `TEXT_FIELD`, via
  // `objectStatement`, is what makes this comparable across a retype's key
  // rename — the text is the same string whether it is a `statement` or a
  // `question`.
  if (objectStatement(after) === objectStatement(before)) return null;
  const quoted = namedAfter.filter(isForeign)[0];
  if (quoted === undefined) return null;
  return `${actorName(actor)} applied "${input.action}" to object "${input.objectId}", rewording a sentence that stands under user "${quoted}"'s name — nobody gets committed, or quoted, by someone else's sentence (#4), and a correction is one person's act with no second party in it, so it may only reword a sentence that names nobody but that person. It waits for "${quoted}" to reword it, or retract this and stage a reading somebody else can accept`;
}

/**
 * Verification is a second pair of eyes, on the human path too (#68, #95).
 *
 * `claim_verification` (the `HumanOnlyGate`) answers *may this species verify at
 * all* — no machine may. This answers the relation question #95 decided for the
 * one species that can: **a human may verify a claim only when they are neither
 * the person it quotes nor the person who staged the reading.** Self-verification
 * is #68's hole — `record_proposal {claimant: mallory, verification: 'verified'}`
 * then `accept_proposal`, or an `amend {verification}` on one's own claim, mints
 * a `✓` self-exculpatory claim with no second party anywhere in it.
 *
 * What it does **not** narrow, and must not (see #68's own redirect): a
 * disinterested third party verifying somebody else's claim. "X says this claim
 * of Bob's checks out" is X's own recorded judgement, and gating it toward the
 * claimant would mean only Bob may ever verify Bob — the sentence agreeing with
 * itself, which is the very shape this refuses. So the two forbidden relations
 * are the claimant and the stager; every other member is who verification is for.
 *
 * ## `claimant` is a spoofable stand-in, and this gate is only the cheap layer
 *
 * An earlier version of this header claimed `claimant` is "the author of the
 * source message by construction, held equal by `acceptanceReceiptRefusal`'s
 * `attributed_person_not_author` gate." **That is false, and #102's round-1
 * gauntlet is what it cost.** That receipt gate binds a *commitment*'s `owner`
 * to the bearing message's author (`commitmentAttribution`); a claim's
 * attribution resolves to `null` in the receipt (see `judgeAcceptance`), so
 * nothing anywhere holds `claimant` equal to the source author — and on the
 * human path the receipt gates do not run at all. So a claim minted with
 * `claimant: Bob` whose source message was authored by Alice is representable,
 * and this gate — comparing the actor to `claimant` — waves Alice through to
 * verify her own sentence.
 *
 * The reducer cannot close that on its own: it has no message window on the
 * human path (`atrium_receipt_window` is NULL for humans by construction) and no
 * messages in `CoreState` at all, so it cannot resolve the real author. So this
 * gate stays as the cheap first layer — it still refuses the honest case where
 * the actor *is* the named claimant, and is mutation-covered in `packages/core`
 * — and the **authoritative** check, "the verifier is not the author of the
 * claim's source message", lives one layer up in `apps/server`
 * (`selfVerificationAuthorRefusal`), which holds the message context the reducer
 * lacks. Two layers, one rule; see that function and #102 finding 1.
 */
export function selfVerificationRefusal(input: {
  actor: Actor;
  /**
   * The claim's `claimant` — the reducer's (spoofable) stand-in for the author
   * of the source message. Anchoring to the *real* author is the command layer's
   * job; see the header.
   */
  claimant: string;
  /** Who staged the reading, or `null` when it was minted with no proposal. */
  stagedBy: Actor | null;
}): string | null {
  const { actor, claimant, stagedBy } = input;
  // The species question is `claim_verification`'s; this is only the relation
  // one, so it has nothing to say about a non-human actor — that actor was
  // already refused for what it is, one gate up.
  if (actor.kind !== 'human') return null;
  if (actor.userId === claimant) {
    return `${actorName(actor)} would mark a claim verified that names them as its claimant — verification is a second pair of eyes (#68, #95), and the person a claim quotes may not be the one who vouches it is true: that is the sentence agreeing with itself. It waits for another member to verify it`;
  }
  if (stagedBy !== null && stagedBy.kind === 'human' && stagedBy.userId === actor.userId) {
    return `${actorName(actor)} would mark a claim verified that they staged the reading of — verification is a second pair of eyes (#68, #95): the member who staged a reading may not be the one who confirms it true. It waits for another member to verify it`;
  }
  return null;
}

/**
 * A third-party commitment is confirmed by its **owner**, not by any member
 * (#67, #95).
 *
 * `commitment_acceptance` (the `HumanOnlyGate`) refuses a *machine* minting a
 * commitment at all. This answers the relation question for the humans it lets
 * through, which #67 filed as open and #95 decided: #4's rule is *nobody gets
 * committed by someone else's sentence*, and a colleague confirming on the
 * owner's behalf is that same act one step removed — the confirmation the room
 * needs is the named person's. `selfStagedReadingRefusal` already refuses the
 * *stager* confirming their own third-party reading; this is the other side of
 * the same rule, and together they leave exactly one member who may confirm: the
 * owner.
 *
 * The owner is on the payload, so the reducer answers this alone — no session
 * context is required. What it costs is stated in #67 and accepted by #95: a
 * correct reading of an absent colleague's commitment now waits for that
 * colleague rather than for any member, and the record already says who confirmed.
 */
export function ownerConfirmRefusal(input: { actor: Actor; owner: string }): string | null {
  const { actor, owner } = input;
  // The species question belongs to `commitment_acceptance`; a machine is already
  // refused there. This is the relation gate for the members it admits.
  if (actor.kind !== 'human') return null;
  if (actor.userId === owner) return null;
  return `${actorName(actor)} accepted a commitment owned by user "${owner}", who is somebody else — a third-party commitment is confirmed by the person it names, not by any member on their behalf (#67, #95): nobody gets committed by someone else's sentence, and confirming for them is that same act one step removed. It waits for "${owner}" to confirm it, or a member may leave the reading staged for them`;
}

/**
 * A disinterested `✓ verified` vouch is not unmade by a silent `retract`
 * (#68/#95, #110).
 *
 * `retract` withdraws an accepted object from current state, kept on the
 * append-only record. The established correction model (see
 * `authority-matrix.test.ts`) lets a member retract a *confirmed* object —
 * withdrawing a colleague's accepted commitment or decision is a legitimate room
 * correction, and the attribution gates already refuse the parts that rename or
 * reword. What that model never contained is the act #110's certify flow
 * introduced: a claim a **second, disinterested pair of eyes verified** true
 * (`verification === 'verified'`, #68). That vouch is the weightiest thing a
 * person puts on a sentence, and the round-1 build let ANY member silently
 * withdraw it — including another person's — with no precondition. That is the
 * covenant breach: unmaking a person's verification is itself a judgement act
 * (#95), the mirror of #96's rule that a member may not retire a confirmed
 * object by superseding it.
 *
 * The complete, safe answer is that `retract` is not the door verification
 * leaves by. A `✓ verified` claim is not withdrawn silently by anyone — the
 * scenario never needs it (its removal act is on a `~`, #110), and unmaking a
 * verification is done in the open through re-verification (`amend`), which
 * `selfVerificationRefusal` already gates. This refuses every `retract` of a
 * verified claim rather than guess an unrecorded verifier (the reducer records
 * `humanTouchedAt` but never *which* human — see `selfVerificationRefusal`'s
 * header), the same safe-complete stance the `✓`-lapse in `applyObjectCorrected`
 * takes. A `~` reading and a confirmed-but-unverified object stay retractable, so
 * the correction model is untouched; only the verification vouch is protected.
 *
 * The species gate is one layer up (`applyObjectCorrected` refuses every
 * non-human correction), so this is only the relation question for the humans it
 * admits.
 */
export function retractVerifiedClaimRefusal(input: {
  actor: Actor;
  /** The object being retracted. Only a claim's `verification` bears on this. */
  object: AcceptedObject;
}): string | null {
  const { actor, object } = input;
  // Non-humans are refused correcting at all one layer up; nothing to add here.
  if (actor.kind !== 'human') return null;
  // Only a claim carries a verification vouch. Everything else — including a
  // confirmed commitment or decision — stays retractable under the established
  // correction model.
  if (object.type !== 'claim' || object.payload.verification !== 'verified') return null;
  return `${actorName(actor)} would withdraw a ✓ verified claim by retracting it — a claim a second, disinterested member vouched is true (#68, #95). Unmaking that verification is a judgement act, the mirror of the rule that a member may not retire a confirmed object by superseding it (#96), and it is not done by a silent withdrawal: the vouch stays on the record and is unmade in the open through a re-verification. A machine's unconfirmed reading (\`~\`) or an unverified object may still be removed`;
}

/**
 * #81/H3, and it is `correctionAttributionRefusal`'s clause two moved one act
 * earlier — to acceptance. A human accepting somebody else's staged reading may
 * fix its wording (that is much of what acceptance is for) but may not mint a
 * *different sentence under a third party's name*, nor add a third party's name
 * to it. The driven case: BOB stages `claim {claimant: BOB, "the build is green"}`,
 * ALICE accepts it as `claim {claimant: BOB, "I take kickbacks"}` — a sentence in
 * BOB's name that BOB never wrote, `issues: []`, `✓`.
 *
 * `acceptanceReceiptRefusal`'s payload binding forbids this for a *machine*; the
 * human path skips it, on the correct theory that a person's acceptance is a
 * receipt. But a receipt for whose sentence? Only for one that names nobody but
 * the accepter, or one accepted **verbatim** — the two clauses below, computed
 * from `payloadAttributions` (who) and `objectStatement` (what), never at the
 * call site (r10's lesson).
 *
 * Runs on the human path only, and pairs with `selfStagedReadingRefusal`, which
 * handles the accepter who also *staged* the reading. This handles the accepter
 * who did not — the #81 case, where the staged reading is somebody else's and the
 * accepter mints a changed one over the top of it. Unreachable from today's wire
 * (`objectFromProposal` rebuilds the payload from the stored proposal), so it is
 * a reducer-boundary rule exactly as r10's `decidedBy` and r11's clause two were:
 * the reducer is the gatekeeper of what becomes state, not the command layer.
 */
export function acceptanceAttributionRefusal(input: {
  actor: Actor;
  objectId: string;
  proposalId: string;
  /** The staged reading, shaped as the object it would have minted verbatim. */
  staged: AcceptedObject;
  /** What is actually being minted. */
  object: AcceptedObject;
}): string | null {
  const { actor, staged, object } = input;
  if (actor.kind !== 'human') return null;
  const isForeign = (userId: string): boolean => userId !== actor.userId;
  const namedStaged = payloadAttributions(staged.type, staged.payload);
  const namedMinted = payloadAttributions(object.type, object.payload);

  // Clause one: a name arriving on the minted object that the staged reading did
  // not carry. `retype`/`reattribute`'s acceptance-time twin.
  const arriving = namedMinted.filter((userId) => !namedStaged.includes(userId)).filter(isForeign);
  const gained = arriving[0];
  if (gained !== undefined) {
    return `${actorName(actor)} accepted proposal "${input.proposalId}" but minted object "${input.objectId}" with user "${gained}"'s name on a sentence the staged reading did not carry — a human acceptance may fix a reading's wording, but nobody gets committed, or quoted, by someone else's sentence (#4, #81): it may mint only the accepter's own name. Accept it as staged, or stage a reading "${gained}" can accept`;
  }

  // Clause two: the sentence changed and still stands under a foreign name.
  // `objectStatement` (via `TEXT_FIELD`) is what makes this comparable across
  // types, so a reworded acceptance is caught wherever the text lives.
  if (objectStatement(object) === objectStatement(staged)) return null;
  const quoted = namedMinted.filter(isForeign)[0];
  if (quoted === undefined) return null;
  return `${actorName(actor)} accepted proposal "${input.proposalId}" but minted object "${input.objectId}" restating a sentence that stands under user "${quoted}"'s name — a human acceptance may fix a reading's wording only when it names nobody but the accepter; nobody gets quoted by someone else's sentence (#4, #81). Accept it as staged, or stage a reading "${quoted}" can accept`;
}

/** A short name for a proposer, for refusal texts. */
function proposerName(proposer: Proposer): string {
  if (proposer.kind === 'model') return `model "${proposer.model}"`;
  if (proposer.kind === 'agent') return `agent "${proposer.userId}"`;
  return `user "${proposer.userId}"`;
}

/** A short name for an actor, for refusal texts. */
export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case 'human':
      return `user "${actor.userId}"`;
    // Named by its identity, like a person, and labelled as a machine, like a
    // model. Both halves matter in a refusal: the room needs to know which
    // participant was refused, and it needs to know the refusal was about what
    // that participant *is* rather than about which account it holds.
    case 'agent':
      return `agent "${actor.userId}"`;
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
  // Same article rule as `humanOnlyRefusal`; see the note there.
  const a = /^[aeiou]/.test(actor.kind) ? 'an' : 'a';
  return `${subject} was accepted as a ${type} by ${a} ${actor.kind} actor, and the quoted words read as something somebody is undertaking to do as easily as something they are asserting — a receipt proves who wrote a sentence, not what kind of act it was, so which of the two this is is the proposal's own word; ${a} ${actor.kind} actor may propose it and let a person accept it as a ${type} or as a commitment`;
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
 * it, and their judgement is the receipt. That asymmetry is the product — with
 * the one exception r9 found, which is not an exception to the asymmetry but to
 * the word *reading*: a person who accepts a machine-labelled proposal **they
 * themselves staged** has read nothing but their own sentence, and there is no
 * judgement in it to be the receipt. That case is refused before this function
 * is reached; see `selfStagedReadingRefusal`.
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
