import { payloadAttributions } from './attribution.js';
import type { Actor } from './common.js';
import {
  type ProvenanceMessage,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
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
 * | Claims auto-accept at confidence ≥ θ                     | model   | **here**  |
 * | OpenQuestions auto-accept at confidence ≥ θ              | model   | **here**  |
 * | Commitments: self-stated auto-accepts, third-party waits | model/human | **here** |
 * | **Decisions never auto-accept**                          | human   | **here**  |
 * | A claim becomes `verified`                               | human   | **here**  |
 * | Supersession, split by the type being retired            | per policy | **here** |
 * | **Corrections (amend / retract / restore / …)**          | human   | **here**  |
 * | **Acceptance citing no proposal at all**                 | human   | **here**  |
 * | **Declaring a question answered**                        | human   | **here**  |
 * | **A name arriving on a sentence** (#4: *committed*)      | only its bearer | **here** |
 * | **A sentence arriving under a name** (#4: *quoted*)      | only its bearer | **here** |
 *
 * The last two rows are one sentence of #4's split in half — *nobody gets
 * committed, **or quoted**, by someone else's sentence* — and they are written
 * as two rows because they were closed a round apart, the second only after the
 * first shipped with the whole sentence quoted at a room and half of it
 * enforced. A matrix row that describes a rule the code does not hold is the
 * defect this lane has now hit three times; both rows are pinned by cells in
 * `authority-matrix.test.ts` that drive the reducer and read what it said.
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
 *  - **A different human accepting a machine-labelled reading**, and a different
 *    human confirming a third-party commitment. That is the design position,
 *    unchanged and load-bearing: they read it, and their judgement is the
 *    receipt. Whether *any* human should be able to confirm a commitment on
 *    somebody else's behalf, or only the named owner, is a real question and a
 *    different one — this rule does not touch it, and the answer today is "any
 *    human other than the stager".
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
 * (`stagedBy.kind !== 'human'`), any person in the room may accept its readings,
 * and the only thing still refused is the case that was never legitimate.
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
  if (proposer !== null && proposer.kind === 'model') {
    return `${actorName(actor)} accepted ${cites}, which they staged themselves as a reading by model "${proposer.model}" — a human acceptance is the receipt for a machine's reading only when the person accepting is not the person who staged it; nobody validates their own attribution to a model. It needs somebody else in the room to accept it, or a non-human acceptance, which is checked against the messages it cites`;
  }
  const foreign = attributedTo.filter((userId) => userId !== actor.userId);
  const named = foreign[0];
  if (named !== undefined) {
    return `${actorName(actor)} accepted ${cites}, which they staged themselves and which puts user "${named}"'s name on it — nobody gets committed, or quoted, by someone else's sentence (#4), and a person confirming their own sentence is that sentence agreeing with itself. It waits for "${named}", or for somebody else in the room to accept it`;
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
  /**
   * No message window — **absent or empty** — so the receipt cannot be checked
   * at all. The two were one check away from each other in round 2 and are one
   * check now: `messages: []` is not a window somebody supplied, it is the same
   * absence spelled differently.
   */
  | 'missing_receipt_context'
  /**
   * A machine reading that names somebody and quotes nothing. Re-required here
   * rather than trusted from the schema a layer up — round 2's gauntlet found
   * that layer was never reached.
   */
  | 'missing_quote'
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
 *  3. **A window at all.** No messages, no auto-acceptance, ever — and `[]` is
 *     no messages. Round 2's gauntlet found the `undefined`-only check: a caller
 *     that passed an empty array got past the door marked "required" and every
 *     check downstream found nothing wrong, because there was nothing to find
 *     anything wrong in. Absent and empty are the same fact about the world.
 *  4. **A quote at all**, for the two types that put a name on somebody. The
 *     schema requires it; this re-requires it, because round 2's gauntlet found
 *     the schema was never run on the fold path. An empty quote is the same
 *     absence as a missing one, and it is the input the whole attribution rule
 *     is computed from.
 *  5. **The receipt itself** — the quote is long enough to identify a sentence,
 *     it is in a cited message, it is that author's own text rather than
 *     something they were quoting, exactly one author carries it, and it bears
 *     the statement being minted.
 *  6. **Third-party attribution.** A commitment whose owner did not write the
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

  if (input.messages === undefined || input.messages.length === 0) {
    const how =
      input.messages === undefined
        ? 'no message window supplied'
        : 'an empty message window supplied';
    return {
      gate: 'missing_receipt_context',
      detail: `${who} accepted proposal "${proposalId}" with ${how}, so its receipt could not be checked — a reading whose citation cannot be verified is refused, never accepted on trust; an empty window is not a window, it is the same absence written differently`,
    };
  }

  const namesAPerson = object.type === 'claim' || object.type === 'commitment';
  if (namesAPerson && (proposal.quote ?? '').trim().length === 0) {
    return {
      gate: 'missing_quote',
      detail: `${who} accepted ${object.type} proposal "${proposalId}", which quotes nothing — attribution is decided from the message bearing the sentence and only the quote identifies it, so a ${object.type} with an absent or empty quote is refused rather than attributed to whoever happens to be in the citation list`,
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
