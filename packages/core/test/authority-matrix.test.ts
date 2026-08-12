import { describe, expect, it } from 'vitest';
import {
  AcceptedObject as AcceptedObjectSchema,
  type AcceptedObjectType,
  AcceptedObjectType as AcceptedObjectTypeSchema,
  type Actor,
  type AuthoredEvent,
  acceptanceReceiptRefusal,
  authored,
  type CoreEvent,
  CoreEvent as CoreEventSchema,
  type CoreState,
  type CorrectionAction,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  type RelationKind,
  reduce,
  serializeState,
} from '../src/index.js';
import { ALICE, BOB } from './fixtures.js';

/**
 * The authority matrix, checked against an **independent oracle** rather than
 * example by example.
 *
 * r4's delta routed this: the actor floor was pinned by hand-written cases, one
 * per gate, which proves the gates that were thought of and says nothing about
 * the ones that were not. Here the case space is enumerated — every event type
 * against every kind of actor, and for the types that have sub-shapes (five
 * object types, six correction verbs, five relation kinds, cited-or-direct
 * proposals, above-or-below the confidence floor, and since r2 five shapes of
 * receipt) every one of those too — and a table written from #4 and
 * `authority.ts`'s doc comment says what each cell should do.
 *
 * **The oracle restates every rule; it never calls one.** It does not call
 * `isHuman`, `actorMatchesProposer`, `MODEL_ACCEPTANCE_FLOOR`,
 * `acceptanceReceiptRefusal` or `RECEIPT_POLICY` — the expectations below are
 * written out from #4 and `authority.ts`'s doc comment. A shared predicate would
 * make the two sides agree by construction, which is exactly the defect the
 * replay suite's own oracle exists to avoid.
 *
 * The four values it does import from `../src` are the machinery under test and
 * its plumbing — `CoreEvent` (to parse a payload), `authored` (to pair one with
 * its trusted columns), `reduce` and `serializeState`. None of them encodes an
 * authority decision, which is the property that matters; "imports only types"
 * is what round 2 claimed here and it was never true.
 *
 * Two things round 2 fixed in the harness itself, both found by the r1 gauntlet:
 *
 *  - **The recording actor is drawn independently of the proposer.** It was
 *    derived from it, so the proposal-lifecycle loop's eight cells were two
 *    logs run four times each.
 *  - **"Reaches every gate" walks the reducer's output**, not the oracle's. The
 *    old version asked the oracle what the oracle would say, which is a
 *    tautology dressed as a coverage assertion: a gate the reducer had stopped
 *    firing would still have been "reached".
 */

const ROOM = 'room_1';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

/**
 * The five kinds of actor the matrix ranges over.
 *
 * `agent` is the identified non-human: it carries a user id exactly as `human`
 * does, and it is a machine exactly as `model` is. Adding it to this list rather
 * than writing agent cases by hand is the point — the whole case space is
 * re-enumerated against it, every event type, every object type, every receipt
 * shape, every correction verb, every relation kind. The oracle below says what
 * each cell should do, restated from #4 rather than imported from `authority.ts`,
 * so an implementation that let an agent through anywhere is a failing cell
 * rather than a missing test.
 *
 * The mutation this closes: `isHuman` written as `kind !== 'model' && kind !==
 * 'system'`. That spelling passes every cell of this matrix as it stood before
 * `agent` existed, and opens every gate in it for the one kind that was added.
 */
type ActorKind = 'human' | 'agent' | 'model_proposer' | 'model_other' | 'system';
const ACTOR_KINDS: ActorKind[] = ['human', 'agent', 'model_proposer', 'model_other', 'system'];

/**
 * A `users` row that is not a person. Distinct from ALICE and BOB because the
 * attribution gates compare ids: an agent sharing ALICE's id would make "the
 * accepter is the person this names" true by accident and hide whichever gate
 * that made unreachable.
 */
const SCRIBE = 'user_scribe';

function actorOf(kind: ActorKind): Actor {
  switch (kind) {
    case 'human':
      return { kind: 'human', userId: ALICE };
    case 'agent':
      return { kind: 'agent', userId: SCRIBE };
    case 'model_proposer':
      return { kind: 'model', model: MODEL_A };
    case 'model_other':
      return { kind: 'model', model: MODEL_B };
    case 'system':
      return { kind: 'system' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Restated from the specification, not imported from the source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every refusal the matrix can produce, and the text a room is shown for it.
 *
 * The markers are what makes the oracle checkable: the reducer says *why* it
 * refused, and a table that only checked "something was refused" would pass on
 * a reducer that refused everything for the wrong reason.
 */
const GATES = {
  decision_acceptance: 'never auto-accepts',
  commitment_acceptance: 'writes an obligation onto a named person',
  objective_acceptance: 'what everything else in the room is filed under',
  claim_verification: 'would become a verified claim',
  direct_acceptance: 'only a human may accept an object directly',
  supersession: 'retires an accepted',
  // #95, #96 r2. A second supersession gate, on the other axis: the one above
  // asks what TYPE is being retired, this one asks whether a person has already
  // put their name to THIS ONE. The markers have no overlap, so a cell that
  // reaches the wrong one is a failing cell rather than a silently satisfied
  // assertion.
  confirmed_supersession: 'retires an object a person has already confirmed',
  // #96 r3. The other axis of the same relation rule: retiring a machine's own
  // unconfirmed `~`. #95 reserves that to a person too — an agent owns no
  // proposal, so every unconfirmed accepted object it reaches belongs to
  // another machine, and unmaking it is not the machine's to do. The marker is
  // the clause that names the `~` case and appears in no other refusal.
  unconfirmed_supersession: 'even an unconfirmed reading',
  answer_relation: 'declares an open question answered',
  correction: 'corrections (amend, retract, restore)',
  // #4's sentence has two halves and so does the correction gate: a name
  // arriving on a sentence, and a sentence arriving under a name. The markers
  // are the two verbs the refusals lead with — `selfStagedReadingRefusal` also
  // ends in "…'s name on it", so a marker cut there would swallow it.
  correction_attribution: 'putting user',
  correction_quotation: 'rewording a sentence',
  // The core lane's verb-split guard, which the merge put IN FRONT of the two
  // above for one shape: a `retype` whose patch moves the attribution field.
  // It is not a weaker version of `correction_attribution` and it is not
  // redundant with it — it refuses the move even ONTO the corrector, where the
  // attribution gate has nothing to say, because what it is protecting is that
  // the correction log can be read by verb ("who took this off Alice" must be
  // answerable by looking for `reattribute` rows). `correction_attribution`
  // still guards every other route a name can arrive by; this closes the one
  // route where a name change would otherwise have been logged as a retype.
  retype_moves_a_name: 'a retype says how the sentence was read',
  acceptance_binding: 'may only accept its own reading',
  rejection_binding: 'may only withdraw its own reading',
  supersession_binding: 'may only retire its own reading',
  confidence_floor: 'below the floor',
  // r7. Not a threshold and not an authority row: the words could be an
  // undertaking as easily as an assertion, and a receipt cannot settle which.
  // The matrix's claim text is an assertion, so this fires only on the probe
  // below — a gate reachable by exactly one row is still a gate, and the
  // coverage assertion is what keeps it honest.
  uncertified_type: 'read as something somebody is undertaking to do',
  payload_binding: 'does not carry its payload',
  provenance_binding: 'the receipt may not change on the way through',
  missing_receipt_context: 'no message window supplied',
  receipt_failed: 'on a receipt that does not hold',
  receipt_not_certifiable: 'on a receipt this check declines to rule on',
  third_party_confirm: 'waits for the named owner to confirm',
  // Both grounds of the r9 gate, which is one gate: the marker is the clause the
  // two refusals share, not the tail either of them ends in.
  self_staged_reading: 'which they staged themselves',
} as const;
type Gate = keyof typeof GATES;

/**
 * θ, restated. Round 2 collapsed the reducer's floor into the engine's θ_auto,
 * so these are #4's confident lines — and a type that never auto-accepts is
 * unreachable rather than merely high.
 */
const FLOOR: Record<AcceptedObjectType, number> = {
  decision: Number.POSITIVE_INFINITY,
  // r5: a commitment writes an obligation onto a named person and an objective
  // is what everything else is filed under. Neither is a machine's to mint.
  commitment: Number.POSITIVE_INFINITY,
  open_question: 0.6,
  claim: 0.7,
  objective: Number.POSITIVE_INFINITY,
};

/**
 * Supersession authority, restated from #4's split by what is retired.
 *
 * **This table is only half of the rule, and until #96 r2 the matrix behaved as
 * though it were all of it.** `claim: false` and `open_question: false` are #4's
 * words and they are right about the *type*: retiring a reading is cheap to
 * correct. What the two `false`s said, cell for cell, was that an authenticated
 * agent may retire a claim a **person accepted** — and a passing test asserting
 * that is exactly the class this repository's own rules warn about. Both of
 * #96's blind critics found it, from opposite lineages, in the source rather
 * than here.
 *
 * The other half is `RETIRING_AN_ACCEPTED_OBJECT_NEEDS_HUMAN` below. Both are
 * restated from #4 and #95 rather than imported, like everything else in this
 * oracle.
 */
const SUPERSESSION_NEEDS_HUMAN: Record<AcceptedObjectType, boolean> = {
  decision: true,
  commitment: true,
  objective: true,
  claim: false,
  open_question: false,
};

/**
 * #95's rule, restated: **a non-human may never retire a standing accepted
 * object by superseding it**, whatever the type table above says about its
 * type, and *whether or not a person has confirmed it*.
 *
 * Not a `Record` because it is not keyed by type — that is the whole point of
 * it. Kind answers *may this species certify at all*; this answers *may this
 * actor unmake this standing object*. Both must pass. #96 r2 read this as the
 * confirmed subset (`… && retires.confirmed`); r2's blind critic found the
 * unconfirmed cells still `allowed`, because an agent owns no proposal so every
 * unconfirmed accepted object it reaches was accepted by a *model* — a foreign
 * reading, and #95 reserves unmaking one to a person exactly as it reserves a
 * `✓`. The rule is on the relation, so the flag is unconditional; only the
 * *reason* still splits on confirmed state.
 *
 * "Confirmed" is restated here too, rather than read from `epistemicStateOf` —
 * an object is confirmed once a person has accepted or corrected it. The cells
 * below build the two states the only two ways the reducer allows: a human
 * acceptance (confirmed) and a model acceptance of a cited proposal at θ
 * (unconfirmed), the latter accepted by `model_a` so a differing actor is a
 * genuinely foreign retirement.
 */
const RETIRING_AN_ACCEPTED_OBJECT_NEEDS_HUMAN = true;

/**
 * The types a machine can put on the board at all, so the only ones that have an
 * unconfirmed state to be retired from.
 *
 * Everything else is human-only to accept (`FLOOR` is unreachable for three of
 * them), so a machine-accepted decision, commitment or objective is not a thing
 * this matrix can build — which is itself one of the rules above, and is why the
 * enumeration below is not a plain cross-product.
 */
const MACHINE_MINTABLE: AcceptedObjectType[] = ['claim', 'open_question'];

/**
 * Restated, not imported. One kind is a person; everything else is a machine,
 * including the one that holds an account — an agent's identity buys it
 * membership and attribution, and buys it nothing at any gate below.
 */
const isHumanKind = (kind: ActorKind) => kind === 'human';

/**
 * "A model may act only on its own proposals; a human on any; the system on
 * none — and an agent on none, because no proposal is staged by one."
 *
 * `Proposer` is `human | model`. There is no agent proposer to match, so an
 * agent owns nothing and every binding gate refuses it. This is a fact about the
 * proposal vocabulary rather than a policy about agents, and it is why the
 * command layer refuses to stage an agent's proposal at all instead of writing
 * one down as somebody else's.
 */
function ownsProposal(kind: ActorKind, proposer: 'model_a' | 'human'): boolean {
  if (kind === 'human') return true;
  if (kind === 'model_proposer') return proposer === 'model_a';
  return false;
}

interface AcceptanceCase {
  kind: 'object_accepted';
  actor: ActorKind;
  type: AcceptedObjectType;
  /** Cited proposal, or none at all (the answer-binding shape). */
  cited: 'model_a' | 'human' | 'none';
  /**
   * Who *staged* the cited proposal, drawn independently of what it names as
   * proposer and of who accepts it.
   *
   * A dimension as of r9, and it is a dimension because of what it cost to leave
   * fixed: every acceptance cell above recorded its proposal as `model_proposer`,
   * so "a **person** staged a **model**-attributed reading and then accepted it
   * himself" was not a cell in this matrix at all. That is D1 — the gauntlet
   * minted a commitment against a colleague through it, over one socket, from an
   * ordinary membership. The lifecycle matrix below already varied `recordedBy`
   * for rejection and supersession; acceptance is where it mattered most and was
   * the one row that held it constant.
   */
  recordedBy: ActorKind;
  /** Whether the cited proposal clears this type's floor. */
  confidence: 'above' | 'below';
  /** Only meaningful for a claim. */
  verified: boolean;
}

/**
 * The acceptance row of the matrix, in the order the rules bind.
 *
 * Order is part of the specification, not an implementation detail: a model
 * accepting a decision must be told that decisions are human-only, not sent to
 * fix its provenance first, because fixing the provenance would not help.
 */
function expectedForAcceptance(testCase: AcceptanceCase): Gate | 'allowed' {
  const human = isHumanKind(testCase.actor);
  if (testCase.type === 'decision' && !human) return 'decision_acceptance';
  if (testCase.type === 'commitment' && !human) return 'commitment_acceptance';
  if (testCase.type === 'objective' && !human) return 'objective_acceptance';
  if (testCase.type === 'claim' && testCase.verified && !human) return 'claim_verification';
  if (testCase.cited === 'none' && !human) return 'direct_acceptance';
  if (testCase.cited !== 'none' && !ownsProposal(testCase.actor, testCase.cited)) {
    return 'acceptance_binding';
  }
  // "A person's acceptance is not a receipt for a reading they staged themselves,
  // when that reading wears a machine's name or puts somebody else's name on
  // something." Restated from `selfStagedReadingRefusal`, not imported from it.
  //
  // `recordedBy: 'human'` is ALICE and so is the human accepter, which is what
  // makes those the same person. `NAMES` above says who each payload names:
  // BOB for a `claim` and a `commitment`, ALICE for a `decision` — so a decision
  // is *not* somebody else's here, and the r10 rule that added `decidedBy` to
  // the checked set is exercised by `attention.test.ts` and `guards.test.ts`
  // rather than by this cell.
  //
  // **`cited === 'none'` is inside the clause as of r10.** It used to be
  // excluded, which made "a person mints an obligation against a colleague
  // outright, with no proposal and no second party" an *allowed* cell of this
  // matrix — the fifth route, alongside the three verbs r10's brief named. An
  // acceptance citing no proposal has no stager but the accepter, so the
  // self-staged clause applies to it by construction, not by analogy.
  if (human && (testCase.cited === 'none' || testCase.recordedBy === 'human')) {
    const namesSomebodyElse = NAMES[testCase.type] !== null && NAMES[testCase.type] !== ALICE;
    if (testCase.cited === 'model_a' || namesSomebodyElse) return 'self_staged_reading';
  }
  if (testCase.cited !== 'none' && !human && testCase.confidence === 'below') {
    return 'confidence_floor';
  }
  return 'allowed';
}

/** The shapes a receipt can take on the way through acceptance. */
type ReceiptShape =
  | 'faithful'
  // r7: the receipt is perfect and the words could be an undertaking. Nothing
  // about the citation is wrong; what is missing is any evidence of the *kind*
  // of act, which is the one field the proposal supplies.
  | 'uncertified_type'
  | 'payload'
  | 'citations'
  | 'no_window'
  | 'wrong_author'
  | 'uncertifiable';
const RECEIPT_SHAPES: ReceiptShape[] = [
  'faithful',
  'uncertified_type',
  'payload',
  'citations',
  'no_window',
  'wrong_author',
  // r5: the quote contains every word of the statement, in order, and says
  // more. `receipt_not_certifiable` was declared as a gate in r4 and no case in
  // this matrix reached it, so the reducer could have stopped enforcing it
  // without a test noticing.
  'uncertifiable',
];

/**
 * The receipt row, added in round 2 — every one of these was a call-site manner
 * before, and a caller that skipped it got an auto-acceptance.
 *
 * A human runs none of it: a person accepting a reading has read it.
 */
function expectedForReceipt(actor: ActorKind, shape: ReceiptShape): Gate | 'allowed' {
  if (!ownsProposal(actor, 'model_a')) return 'acceptance_binding';
  if (isHumanKind(actor)) return 'allowed';
  switch (shape) {
    case 'payload':
      return 'payload_binding';
    case 'citations':
      return 'provenance_binding';
    case 'no_window':
      return 'missing_receipt_context';
    case 'wrong_author':
      return 'receipt_failed';
    case 'uncertifiable':
      return 'receipt_not_certifiable';
    case 'uncertified_type':
      return 'uncertified_type';
    case 'faithful':
      return 'allowed';
  }
}

function expectedForCorrection(actor: ActorKind): Gate | 'allowed' {
  return isHumanKind(actor) ? 'allowed' : 'correction';
}

function expectedForRelation(
  actor: ActorKind,
  kind: RelationKind,
  retires: { type: AcceptedObjectType; confirmed: boolean } | null,
): Gate | 'allowed' {
  if (kind === 'answers' && !isHumanKind(actor)) return 'answer_relation';
  if (kind === 'supersedes' && retires !== null && !isHumanKind(actor)) {
    // The type row first: it is the more specific answer, and a machine retiring
    // a decision should hear "a decision needs the hand that accepted one"
    // rather than the general rule.
    if (SUPERSESSION_NEEDS_HUMAN[retires.type]) return 'supersession';
    // Then #95's relation row, which is what the two `false`s above leave to it:
    // a non-human never retires a standing accepted object by superseding it,
    // confirmed or not. #96 r2 closed only the confirmed cells; r3 closes the
    // unconfirmed ones its critic found still `allowed`. The two report
    // different reasons — a `✓` unmade vs a `~` unmade — but neither is a
    // machine's to do, so the flag is unconditional and only the reason splits.
    if (RETIRING_AN_ACCEPTED_OBJECT_NEEDS_HUMAN) {
      return retires.confirmed ? 'confirmed_supersession' : 'unconfirmed_supersession';
    }
  }
  return 'allowed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Log construction. Each case is a self-contained log, so nothing but the rule
// under test can refuse it.
// ─────────────────────────────────────────────────────────────────────────────

let clock = 0;
/**
 * The next distinct instant, in the one canonical spelling.
 *
 * One second apart rather than one minute: the old version spelled the hour as
 * `10 + clock / 60`, which walks past `23` — and `24:00:00.000Z` is not a real
 * instant, so `Timestamp` refuses it and every case built after the 840th event
 * dies on a parse error nobody would read as "the matrix outgrew its clock".
 * #22 r11 added twenty cells and found it. Seconds carry this file to nearly
 * fifty thousand events, and `Date#toISOString` is the spelling `Timestamp`
 * exists to insist on, so the format cannot drift from it by hand.
 */
const CLOCK_EPOCH = Date.parse('2026-07-31T10:00:00.000Z');
function nextAt(): string {
  clock += 1;
  return new Date(CLOCK_EPOCH + clock * 1000).toISOString();
}

const parse = (input: unknown): CoreEvent => CoreEventSchema.parse(input);

/** One ledger row: payload, plus the trusted columns. */
function row(
  input: unknown,
  actor: ActorKind | Actor,
  messages?: readonly ProvenanceMessage[],
): AuthoredEvent {
  return authored(parse(input), {
    actor: typeof actor === 'string' ? actorOf(actor) : actor,
    ...(messages === undefined ? {} : { messages }),
  });
}

/** The sentence each type is read out of, and who wrote it. */
/**
 * The sentence each type is read out of.
 *
 * Every one is at least `RECEIPT_POLICY.minQuoteLength` characters once
 * normalized, and every one is quoted verbatim as its own statement — because
 * since r3 the receipt requires both, and a matrix built out of "a claim" would
 * be testing the length rule instead of the authority rules. The oracle does not
 * import the number; these are simply written long.
 */
const TEXT: Record<AcceptedObjectType, string> = {
  decision: 'we adopt the watermark contract',
  commitment: 'wire the flag into the server tomorrow',
  open_question: 'do we keep the flag after launch?',
  claim: 'the build is green on main today',
  objective: 'ship the narrowing fix this quarter',
};

/**
 * One sentence per message.
 *
 * r4 required the quote to be one or more *whole sentences* of the message. r5
 * requires it to be **all** of them — a neighbouring sentence can reverse the
 * one being quoted ("We will deploy Friday. Not.") and no rule about the quoted
 * span can see that. So each of these sentences gets its own message, which is
 * also what a room actually looks like; five of them in one body was a fixture
 * convenience that now routes every cell of this matrix to the referral path
 * instead of the authority rule it names.
 */
const MSG_FOR: Record<AcceptedObjectType, string> = {
  decision: 'msg_decision',
  commitment: 'msg_commitment',
  open_question: 'msg_question',
  claim: 'msg_claim',
  objective: 'msg_objective',
};

const windowWrittenBy = (authorId: string): ProvenanceMessage[] => [
  { id: UNDERTAKING_MSG, authorId, body: UNDERTAKING_CLAIM },
  ...(Object.keys(TEXT) as AcceptedObjectType[]).map((type) => ({
    id: MSG_FOR[type],
    authorId,
    // **The body is the sentence, with no terminator added.** It used to append
    // a full stop when `TEXT` did not carry one, and the payload statement did
    // not — so every certifying cell of this matrix was riding
    // `droppableTokens`, whose last entry r6's cross-lineage pass broke. The
    // authority rules are what this file is about; the receipt has its own.
    body: TEXT[type],
  })),
];

/**
 * The claim's sentence with one word dropped: every word of it is in the quote,
 * in order, and the quote says more. Nothing here can tell an aside from a
 * "not", which is what `receipt_not_certifiable` is for.
 */
const REDUCED_CLAIM = 'the build is green on main';

/**
 * r7: a claim whose words are equally an undertaking. It gets its own message,
 * because the quote must be the whole of what its author wrote.
 */
const UNDERTAKING_CLAIM = 'we will deploy the narrowing fix on friday';
const UNDERTAKING_MSG = 'msg_undertaking';

/** BOB wrote all of it, and BOB is the claimant and the owner. */
const WINDOW: ProvenanceMessage[] = windowWrittenBy(BOB);
/** The same words from somebody else, which breaks every attribution. */
const WRONG_AUTHOR_WINDOW: ProvenanceMessage[] = windowWrittenBy(ALICE);

function payloadFor(type: AcceptedObjectType, verified = false): Record<string, unknown> {
  switch (type) {
    case 'decision':
      return { statement: TEXT.decision, decidedBy: ALICE };
    case 'commitment':
      return { statement: TEXT.commitment, owner: BOB };
    case 'open_question':
      return { question: TEXT.open_question };
    case 'claim':
      return {
        statement: TEXT.claim,
        claimant: BOB,
        ...(verified ? { verification: 'verified' } : {}),
      };
    case 'objective':
      return { title: TEXT.objective };
  }
}

/**
 * Who each fixture payload above names, restated rather than derived.
 *
 * Load-bearing since #22 r10: a direct acceptance (no proposal) may only put the
 * accepter's own name on something, so a *setup* row that needs an object named
 * for BOB has to be minted by BOB. The matrix cells that probe the rule keep
 * minting as ALICE — that is the case under test.
 */
const NAMES: Record<AcceptedObjectType, string | null> = {
  decision: ALICE,
  commitment: BOB,
  claim: BOB,
  open_question: null,
  objective: null,
};

/**
 * **Which field** each type puts a person in, and which one holds its sentence —
 * restated, never imported.
 *
 * `attribution.ts` derives both from `PAYLOAD_FIELD_ROLE`, which is exactly why
 * this file writes them out by hand: an oracle that imported `ATTRIBUTION_FIELD`
 * and `TEXT_FIELD` would agree with the classification under test by
 * construction, and a payload field reclassified in error would move both sides
 * together and be invisible here. Reclassify `commitment.statement` as a detail
 * and the source stops calling it text; these two tables do not, and the matrix
 * goes red.
 */
const NAME_KEY: Record<AcceptedObjectType, string | null> = {
  decision: 'decidedBy',
  commitment: 'owner',
  claim: 'claimant',
  open_question: null,
  objective: null,
};

const TEXT_KEY: Record<AcceptedObjectType, string> = {
  decision: 'statement',
  commitment: 'statement',
  claim: 'statement',
  open_question: 'question',
  objective: 'title',
};

function proposalEvent(input: {
  id: string;
  type: AcceptedObjectType;
  proposer: 'model_a' | 'human';
  confidence: number;
  verified?: boolean;
  /** A statement that is a strict reduction of the quote — the referral shape. */
  statement?: string;
  /** Who recorded it — drawn independently of who it names as proposer. */
  recordedBy: ActorKind;
  /** r7: stage a different sentence, from a different message, verbatim. */
  quoting?: { text: string; messageId: string };
}): AuthoredEvent {
  const at = nextAt();
  const payload = payloadFor(input.type, input.verified);
  if (input.quoting !== undefined) payload.statement = input.quoting.text;
  if (input.statement !== undefined) payload.statement = input.statement;
  return row(
    {
      id: `ev_${input.id}`,
      at,
      type: 'proposal_recorded',
      proposal: {
        id: input.id,
        roomId: ROOM,
        type: input.type,
        payload,
        confidence: input.confidence,
        proposer:
          input.proposer === 'model_a'
            ? { kind: 'model', model: MODEL_A }
            : { kind: 'human', userId: ALICE },
        provenance: [input.quoting?.messageId ?? MSG_FOR[input.type]],
        quote: input.quoting?.text ?? TEXT[input.type],
        createdAt: at,
      },
    },
    input.recordedBy,
  );
}

function acceptEvent(input: {
  id: string;
  objectId: string;
  type: AcceptedObjectType;
  actor: ActorKind;
  proposalId: string | null;
  verified?: boolean;
  statement?: string;
  citing?: string[];
  messages?: readonly ProvenanceMessage[];
  /**
   * Whose name the object stands under, overriding `payloadFor`'s default —
   * and, for a setup row, who mints it. The r11 matrix needs the same object
   * named for the corrector and for somebody else, and "which field holds the
   * name" is restated in `NAME_KEY` rather than imported, like every other rule
   * this oracle knows.
   */
  names?: string;
  /**
   * This row is scaffolding, not the case under test: mint it under whoever the
   * payload names, so #22 r10's attribution gate lets it through and the object
   * exists for the verb or relation actually being probed.
   */
  setup?: true;
}): AuthoredEvent {
  const at = nextAt();
  const payload = payloadFor(input.type, input.verified);
  const nameKey = NAME_KEY[input.type];
  if (input.names !== undefined && nameKey !== null) payload[nameKey] = input.names;
  if (input.statement !== undefined) payload[TEXT_KEY[input.type]] = input.statement;
  return row(
    {
      id: `ev_${input.id}`,
      at,
      type: 'object_accepted',
      object: {
        id: input.objectId,
        roomId: ROOM,
        type: input.type,
        payload,
        provenance: {
          messageIds: input.citing ?? [MSG_FOR[input.type]],
          proposalId: input.proposalId,
        },
        createdAt: at,
        updatedAt: at,
      },
    },
    input.setup && input.actor === 'human' && (input.names ?? NAMES[input.type]) !== null
      ? { kind: 'human', userId: (input.names ?? NAMES[input.type]) as string }
      : input.actor,
    input.messages === undefined ? WINDOW : input.messages,
  );
}

/**
 * Did the reducer refuse, and with which gate?
 *
 * Every verdict is recorded in `observed`, which the coverage test at the foot
 * of the file reads. That set is built from what the *reducer* said — the round-1
 * version built it from what the oracle predicted, so a gate the reducer had
 * stopped firing was still "reached".
 */
const observed = new Set<Gate | 'allowed'>();

function verdictOf(state: CoreState, eventId: string): Gate | 'allowed' {
  const issue = state.issues.find((entry) => entry.eventId === eventId);
  if (!issue) {
    observed.add('allowed');
    return 'allowed';
  }
  for (const [gate, marker] of Object.entries(GATES)) {
    if (issue.reason.includes(marker)) {
      observed.add(gate as Gate);
      return gate as Gate;
    }
  }
  throw new Error(`refusal did not match any known gate: ${issue.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **From the schema.** `acceptance.test.ts` was corrected to `.options` and this
 * one was left restating the list — grok's fourth pass. The oracle in this file
 * restates the *rules* on purpose, which is what makes it independent; the set
 * of types is not a rule, it is the domain the rules range over, and a type
 * missing from it is a whole column of the matrix nobody runs.
 */
const OBJECT_TYPES: AcceptedObjectType[] = [...AcceptedObjectTypeSchema.options];

const acceptanceCases: AcceptanceCase[] = [];
for (const actor of ACTOR_KINDS) {
  for (const type of OBJECT_TYPES) {
    for (const cited of ['model_a', 'human', 'none'] as const) {
      for (const confidence of ['above', 'below'] as const) {
        // Confidence is a property of the cited proposal; with none cited there
        // is nothing to be above or below, so that half of the cross-product is
        // not a cell, it is the same cell twice.
        if (cited === 'none' && confidence === 'below') continue;
        const verifiedVariants = type === 'claim' ? [false, true] : [false];
        // Who staged it, for the same reason: with nothing cited there is no
        // staging to attribute. Two stagers rather than all four — a human and a
        // model — because the rule this dimension exists for splits on exactly
        // that, and the system actor cannot appear as a proposer at all.
        const recordedByVariants: ActorKind[] =
          cited === 'none' ? ['model_proposer'] : ['model_proposer', 'human'];
        for (const verified of verifiedVariants) {
          for (const recordedBy of recordedByVariants) {
            acceptanceCases.push({
              kind: 'object_accepted',
              actor,
              type,
              cited,
              recordedBy,
              confidence,
              verified,
            });
          }
        }
      }
    }
  }
}

describe('authority matrix — object_accepted, every actor × type × citation × confidence', () => {
  for (const testCase of acceptanceCases) {
    const label = `${testCase.actor} accepts ${testCase.type}${testCase.verified ? ' (verified)' : ''} via ${testCase.cited}${testCase.cited === 'none' ? '' : ` staged by ${testCase.recordedBy} @${testCase.confidence} floor`}`;
    it(label, () => {
      const suffix = `${acceptanceCases.indexOf(testCase)}`;
      const events: AuthoredEvent[] = [];
      let proposalId: string | null = null;

      if (testCase.cited !== 'none') {
        proposalId = `prop_${suffix}`;
        const floor = FLOOR[testCase.type];
        // Below the floor means below it; above means comfortably over. For a
        // decision the floor is unreachable, so "above" is just a high number —
        // the decision gate returns before the floor is consulted.
        const confidence =
          testCase.confidence === 'below'
            ? Number.isFinite(floor)
              ? Math.max(0, floor - 0.1)
              : 0.4
            : 0.95;
        events.push(
          proposalEvent({
            id: proposalId,
            type: testCase.type,
            proposer: testCase.cited,
            confidence,
            verified: testCase.verified,
            // Independent of the proposer, and of the accepting actor.
            recordedBy: testCase.recordedBy,
          }),
        );
      }

      const acceptId = `acc_${suffix}`;
      events.push(
        acceptEvent({
          id: acceptId,
          objectId: `obj_${suffix}`,
          type: testCase.type,
          actor: testCase.actor,
          proposalId,
          verified: testCase.verified,
        }),
      );

      const state = reduce(events);
      const expected = expectedForAcceptance(testCase);
      expect(verdictOf(state, `ev_${acceptId}`)).toBe(expected);
      // The gate is not decorative: a refusal means no object.
      expect(Object.keys(state.objects)).toEqual(expected === 'allowed' ? [`obj_${suffix}`] : []);
    });
  }
});

describe('authority matrix — the receipt, every actor × shape', () => {
  for (const actor of ACTOR_KINDS) {
    for (const shape of RECEIPT_SHAPES) {
      it(`${actor} accepts a claim with a ${shape} receipt`, () => {
        const suffix = `${actor}_${shape}`;
        const proposalId = `prop_r_${suffix}`;
        const events: AuthoredEvent[] = [
          proposalEvent({
            id: proposalId,
            type: 'claim',
            proposer: 'model_a',
            confidence: 0.95,
            recordedBy: 'model_proposer',
            ...(shape === 'uncertifiable' ? { statement: REDUCED_CLAIM } : {}),
            ...(shape === 'uncertified_type'
              ? { quoting: { text: UNDERTAKING_CLAIM, messageId: UNDERTAKING_MSG } }
              : {}),
          }),
          acceptEvent({
            id: `acc_r_${suffix}`,
            objectId: `obj_r_${suffix}`,
            type: 'claim',
            actor,
            proposalId,
            ...(shape === 'uncertifiable' ? { statement: REDUCED_CLAIM } : {}),
            ...(shape === 'uncertified_type'
              ? { statement: UNDERTAKING_CLAIM, citing: [UNDERTAKING_MSG] }
              : {}),
            ...(shape === 'payload' ? { statement: 'something else entirely' } : {}),
            ...(shape === 'citations' ? { citing: [MSG_FOR.claim, MSG_FOR.objective] } : {}),
            ...(shape === 'no_window' ? { messages: undefined } : {}),
            ...(shape === 'wrong_author' ? { messages: WRONG_AUTHOR_WINDOW } : {}),
          }),
        ];
        // `undefined` means "supply the default window", so the no-window shape
        // has to strip the key rather than pass undefined through.
        if (shape === 'no_window') {
          const accept = events[1] as AuthoredEvent;
          events[1] = authored(accept.event, { actor: accept.actor });
        }

        const state = reduce(events);
        const expected = expectedForReceipt(actor, shape);
        expect(verdictOf(state, `ev_acc_r_${suffix}`)).toBe(expected);
        expect(Object.keys(state.objects)).toEqual(
          expected === 'allowed' ? [`obj_r_${suffix}`] : [],
        );
      });
    }
  }

  it('refuses a model accepting a commitment before the receipt is even read', () => {
    // Until r5 this reached the sixth receipt gate — the owner did not write the
    // message bearing the sentence, so #4's third-party case waited for them. It
    // no longer gets that far: a machine may not mint a commitment at any
    // confidence, whoever wrote the sentence. `third_party_confirm` is exercised
    // directly below, because a check that is deleted for being unreachable
    // under today's type row is a check that will not be there when the row
    // moves.
    const proposalId = 'prop_third_party';
    const state = reduce([
      proposalEvent({
        id: proposalId,
        type: 'commitment',
        proposer: 'model_a',
        confidence: 0.95,
        recordedBy: 'model_proposer',
      }),
      acceptEvent({
        id: 'acc_third_party',
        objectId: 'obj_third_party',
        type: 'commitment',
        actor: 'model_proposer',
        proposalId,
        messages: WRONG_AUTHOR_WINDOW,
      }),
    ]);
    expect(verdictOf(state, 'ev_acc_third_party')).toBe('commitment_acceptance');
    expect(state.objects).toEqual({});
  });

  it('keeps the third-party receipt gate live under the row that now hides it', () => {
    const stamp = nextAt();
    const payload = { statement: TEXT.commitment, owner: BOB };
    const refusal = acceptanceReceiptRefusal({
      actor: actorOf('model_proposer'),
      proposalId: 'prop_tp',
      proposal: ProposalSchema.parse({
        id: 'prop_tp',
        roomId: ROOM,
        type: 'commitment',
        payload,
        confidence: 0.95,
        proposer: { kind: 'model', model: MODEL_A },
        provenance: [MSG_FOR.commitment],
        quote: TEXT.commitment,
        createdAt: stamp,
      }),
      object: AcceptedObjectSchema.parse({
        id: 'obj_tp',
        roomId: ROOM,
        type: 'commitment',
        payload,
        provenance: { messageIds: [MSG_FOR.commitment], proposalId: 'prop_tp' },
        createdAt: stamp,
        updatedAt: stamp,
      }),
      // The same sentence, written by somebody who is not its owner.
      messages: WRONG_AUTHOR_WINDOW,
    });
    expect(refusal?.gate).toBe('third_party_confirm');
  });
});

describe('authority matrix — proposal lifecycle, every recorder × actor × proposer', () => {
  /**
   * Three independent dimensions, and round 1 collapsed two of them: the actor
   * that *recorded* the proposal was derived from the proposer, so eight cells
   * were two logs run four times. Recording is open to everybody by design and
   * the loop has to be able to see that, rather than assuming it.
   */
  for (const recordedBy of ACTOR_KINDS) {
    for (const proposer of ['model_a', 'human'] as const) {
      it(`${recordedBy} records a ${proposer} proposal`, () => {
        // Recording a reading is not accepting it, so no actor is gated here —
        // that is the whole shape of the trust model and it must stay open.
        const state = reduce([
          proposalEvent({
            id: `p_rec_${recordedBy}_${proposer}`,
            type: 'claim',
            proposer,
            confidence: 0.9,
            recordedBy,
          }),
        ]);
        expect(state.issues).toEqual([]);
        expect(state.proposals[`p_rec_${recordedBy}_${proposer}`]?.status).toBe('proposed');
      });

      for (const actor of ACTOR_KINDS) {
        it(`${actor} rejects a ${proposer} proposal recorded by ${recordedBy}`, () => {
          const id = `p_rej_${recordedBy}_${actor}_${proposer}`;
          const state = reduce([
            proposalEvent({ id, type: 'claim', proposer, confidence: 0.9, recordedBy }),
            row(
              {
                id: `ev_rej_${id}`,
                at: nextAt(),
                type: 'proposal_rejected',
                proposalId: id,
                reason: 'on reflection, no',
              },
              actor,
            ),
          ]);
          const expected = ownsProposal(actor, proposer) ? 'allowed' : 'rejection_binding';
          expect(verdictOf(state, `ev_rej_${id}`)).toBe(expected);
          expect(state.proposals[id]?.status).toBe(
            expected === 'allowed' ? 'rejected' : 'proposed',
          );
        });

        it(`${actor} supersedes a ${proposer} proposal recorded by ${recordedBy}`, () => {
          const id = `p_sup_${recordedBy}_${actor}_${proposer}`;
          const state = reduce([
            proposalEvent({ id, type: 'claim', proposer, confidence: 0.9, recordedBy }),
            row(
              {
                id: `ev_sup_${id}`,
                at: nextAt(),
                type: 'proposal_superseded',
                proposalId: id,
                reason: 're-read at a bumped interpretation version',
              },
              actor,
            ),
          ]);
          const expected = ownsProposal(actor, proposer) ? 'allowed' : 'supersession_binding';
          expect(verdictOf(state, `ev_sup_${id}`)).toBe(expected);
          expect(state.proposals[id]?.status).toBe(
            expected === 'allowed' ? 'superseded' : 'proposed',
          );
        });
      }
    }
  }
});

describe('authority matrix — object_corrected, every actor × verb', () => {
  const VERBS: CorrectionAction[] = [
    'amend',
    'retract',
    'restore',
    'retype',
    'reattribute',
    'reopen',
  ];

  /** A log that leaves one object in the state each verb can legally act on. */
  function setupFor(
    verb: CorrectionAction,
    suffix: string,
  ): { events: AuthoredEvent[]; objectId: string } {
    const objectId = `obj_c_${suffix}`;
    const events: AuthoredEvent[] = [];

    if (verb === 'reopen') {
      // An answered question: accept a question and a decision, then answer it.
      const answerId = `obj_ans_${suffix}`;
      events.push(
        acceptEvent({
          id: `q_${suffix}`,
          objectId,
          type: 'open_question',
          actor: 'human',
          proposalId: null,
          setup: true,
        }),
        acceptEvent({
          id: `a_${suffix}`,
          objectId: answerId,
          type: 'decision',
          actor: 'human',
          proposalId: null,
          setup: true,
        }),
        row(
          {
            id: `ev_ans_${suffix}`,
            at: nextAt(),
            type: 'relation_added',
            relation: {
              id: `rel_ans_${suffix}`,
              roomId: ROOM,
              kind: 'answers',
              fromObjectId: objectId,
              to: { kind: 'object', objectId: answerId },
              createdAt: nextAt(),
            },
          },
          'human',
        ),
      );
      return { events, objectId };
    }

    // `amend` acts on an objective: it has a text field and names nobody.
    //
    // It used to act on the same BOB-owned commitment as the verbs below, with
    // `{statement: 'reworded'}` — which is #22 r11's defect written as a
    // fixture. Rewording a sentence that stands under somebody else's name is
    // now refused, so that cell was asserting `allowed` for the act the round
    // exists to close. This axis of the matrix is *who may correct at all*, and
    // an objective answers that without dragging a second rule into the cell;
    // whose name is on the object is its own axis, in the matrix below.
    events.push(
      acceptEvent({
        id: `c_${suffix}`,
        objectId,
        type: verb === 'amend' ? 'objective' : 'commitment',
        actor: 'human',
        proposalId: null,
        setup: true,
      }),
    );
    if (verb === 'restore') {
      events.push(
        row(
          {
            id: `ev_pre_${suffix}`,
            at: nextAt(),
            type: 'object_corrected',
            objectId,
            action: 'retract',
          },
          'human',
        ),
      );
    }
    return { events, objectId };
  }

  function patchFor(verb: CorrectionAction): Record<string, unknown> {
    if (verb === 'amend') return { title: 'reworded, and nobody is named on it' };
    if (verb === 'reattribute') return { owner: ALICE };
    // Empty since r8: `retypeCarryOver` moves the commitment's `owner` onto the
    // claim's `claimant`, and a patch naming a *different* person is refused as
    // an unlogged reattribution. This row is about authority, not attribution.
    if (verb === 'retype') return {};
    return {};
  }

  for (const actor of ACTOR_KINDS) {
    for (const verb of VERBS) {
      it(`${actor} performs "${verb}"`, () => {
        const suffix = `${actor}_${verb}`;
        const { events, objectId } = setupFor(verb, suffix);
        const correctionId = `ev_corr_${suffix}`;
        events.push(
          row(
            {
              id: correctionId,
              at: nextAt(),
              type: 'object_corrected',
              objectId,
              action: verb,
              ...(verb === 'retype' ? { toType: 'claim' } : {}),
              patch: patchFor(verb),
            },
            actor,
          ),
        );

        const state = reduce(events);
        const expected = expectedForCorrection(actor);
        expect(verdictOf(state, correctionId)).toBe(expected);
        // A refused correction leaves the object exactly as it was.
        expect(state.corrections.some((entry) => entry.eventId === correctionId)).toBe(
          expected === 'allowed',
        );
      });
    }
  }

  it('names the verification rule when a model’s correction would produce a ✓', () => {
    // Doubly closed — corrections are human-only *and* verification is — and the
    // reported reason must be the specific one, so the room is told the rule
    // that would still apply if the other were ever relaxed.
    const objectId = 'obj_verify_probe';
    const state = reduce([
      acceptEvent({
        id: 'vp_setup',
        objectId,
        type: 'claim',
        actor: 'human',
        proposalId: null,
        setup: true,
      }),
      row(
        {
          id: 'ev_vp',
          at: nextAt(),
          type: 'object_corrected',
          objectId,
          action: 'amend',
          patch: { verification: 'verified' },
        },
        'model_other',
      ),
    ]);
    expect(verdictOf(state, 'ev_vp')).toBe('claim_verification');
  });
});

/**
 * The second axis of the correction matrix: **whose name the object stands
 * under, and what the correction asserts under it.**
 *
 * The matrix above ranges over actors and answers *may this actor correct at
 * all*. It cannot see #22 r11, because r11's defect is a human doing a
 * human-only thing: ALICE rewording BOB's sentence, five times, `ack` with
 * `issues: []` every time, ending at a `✓` claim in which BOB confesses to
 * taking kickbacks and BOB wrote none of the words.
 *
 * So the same six verbs run again here, against the *same object* named for the
 * corrector and named for somebody else, and each case declares two facts about
 * itself: whom it leaves the object naming, and whether it leaves a different
 * sentence. The oracle is #4's sentence with both halves in it — *nobody gets
 * committed, or quoted, by someone else's sentence* — and it is written out
 * rather than called.
 *
 * Every legal verb r10 made a named mutant of is in here as a cell that must
 * stay `allowed` on somebody else's object: `retract`, `restore`, `reopen`,
 * `amend` of a due date, `amend` of a status, and a `retype` that carries the
 * sentence across unchanged. A gate that fired on a name being *present* rather
 * than a sentence *changing* would freeze all six, which is the other bug and
 * just as shipped.
 */
describe('authority matrix — object_corrected, every verb × whose name it stands under', () => {
  /** What the object says before any correction; `REWORDED` is what it must not be made to say. */
  const ORIGINAL = 'wire the flag into the server tomorrow';
  const REWORDED = 'i have been taking kickbacks from the vendor';

  interface AssertionCase {
    label: string;
    verb: CorrectionAction;
    toType?: AcceptedObjectType;
    /** Whose name the object stands under once this has been applied. */
    namesAfter: (before: string) => string;
    /** Does it leave a different sentence? */
    rewords: boolean;
    patch: (before: string) => Record<string, unknown>;
    /** An extra correction to run first, so the verb has something to act on. */
    prepare?: 'retract' | 'close';
  }

  /** The person a correction would hand it to: whoever is not already named. */
  const theOther = (before: string) => (before === ALICE ? BOB : ALICE);

  const CASES: AssertionCase[] = [
    {
      label: 'amend the sentence',
      verb: 'amend',
      namesAfter: (before) => before,
      rewords: true,
      patch: () => ({ statement: REWORDED }),
    },
    {
      label: 'amend the due date',
      verb: 'amend',
      namesAfter: (before) => before,
      rewords: false,
      patch: () => ({ due: '2026-08-01T10:00:00.000Z' }),
    },
    {
      label: 'amend the status',
      verb: 'amend',
      namesAfter: (before) => before,
      rewords: false,
      patch: () => ({ status: 'done' }),
    },
    {
      label: 'retract it',
      verb: 'retract',
      namesAfter: (before) => before,
      rewords: false,
      patch: () => ({}),
    },
    {
      label: 'restore it',
      verb: 'restore',
      namesAfter: (before) => before,
      rewords: false,
      patch: () => ({}),
      prepare: 'retract',
    },
    {
      label: 'reopen it',
      verb: 'reopen',
      namesAfter: (before) => before,
      rewords: false,
      patch: () => ({}),
      prepare: 'close',
    },
    {
      label: 'retype it, carrying the sentence',
      verb: 'retype',
      toType: 'claim',
      namesAfter: (before) => before,
      rewords: false,
      patch: (before) => ({ claimant: before }),
    },
    {
      label: 'retype it and reword it in the same act',
      verb: 'retype',
      toType: 'claim',
      namesAfter: (before) => before,
      rewords: true,
      patch: (before) => ({ claimant: before, statement: REWORDED }),
    },
    {
      label: 'retype it onto the other person',
      verb: 'retype',
      toType: 'claim',
      namesAfter: theOther,
      rewords: false,
      patch: (before) => ({ claimant: theOther(before) }),
    },
    {
      label: 'reattribute it onto the other person',
      verb: 'reattribute',
      namesAfter: theOther,
      rewords: false,
      patch: (before) => ({ owner: theOther(before) }),
    },
  ];

  /**
   * #4, restated: a correction is one person's act, so it may only assert
   * things under its own author's name. A name arriving that is not the
   * corrector's is the first half; a sentence changing under a name that is not
   * the corrector's is the second. ALICE corrects throughout.
   */
  function expectedForAssertion(namedBefore: string, testCase: AssertionCase): Gate | 'allowed' {
    const namedAfter = testCase.namesAfter(namedBefore);
    // FIRST, BECAUSE IT FIRES FIRST. `retypeStructuralRefusal`'s sibling — the
    // guard that a retype may not move the attribution field — lives inside
    // `planRetype`, and a plan that never gets built never reaches the
    // attribution gate in `applyObjectCorrected`. It refuses a name move on a
    // retype unconditionally, including onto the corrector, so this arm is
    // ahead of BOTH clauses below and is not conditioned on who is named.
    if (testCase.verb === 'retype' && namedAfter !== namedBefore) return 'retype_moves_a_name';
    if (namedAfter !== namedBefore && namedAfter !== ALICE) return 'correction_attribution';
    if (testCase.rewords && namedAfter !== ALICE) return 'correction_quotation';
    return 'allowed';
  }

  for (const standsUnder of ['the corrector', 'somebody else'] as const) {
    const namedBefore = standsUnder === 'the corrector' ? ALICE : BOB;

    for (const testCase of CASES) {
      it(`ALICE tries to ${testCase.label}, on a commitment standing under ${standsUnder}`, () => {
        const suffix = `${standsUnder === 'the corrector' ? 'own' : 'other'}_${testCase.label.replace(/[^a-z]+/g, '_')}`;
        const objectId = `obj_a_${suffix}`;
        const events: AuthoredEvent[] = [
          acceptEvent({
            // `acceptEvent` prefixes this with `ev_`, so it must not read as
            // the correction's own id — two rows sharing one event id is a
            // redelivery, and the reducer drops the second in silence.
            id: `seed_${suffix}`,
            objectId,
            type: 'commitment',
            actor: 'human',
            proposalId: null,
            names: namedBefore,
            statement: ORIGINAL,
            setup: true,
          }),
        ];

        // Scaffolding runs as the person named, so a cell can never fail on the
        // rule it is not testing.
        const owner: Actor = { kind: 'human', userId: namedBefore };
        if (testCase.prepare !== undefined) {
          events.push(
            row(
              {
                id: `ev_prep_${suffix}`,
                at: nextAt(),
                type: 'object_corrected',
                objectId,
                ...(testCase.prepare === 'retract'
                  ? { action: 'retract' }
                  : { action: 'amend', patch: { status: 'done' } }),
              },
              owner,
            ),
          );
        }

        const correctionId = `ev_a_${suffix}`;
        events.push(
          row(
            {
              id: correctionId,
              at: nextAt(),
              type: 'object_corrected',
              objectId,
              action: testCase.verb,
              ...(testCase.toType === undefined ? {} : { toType: testCase.toType }),
              patch: testCase.patch(namedBefore),
            },
            'human',
          ),
        );

        const state = reduce(events);
        const expected = expectedForAssertion(namedBefore, testCase);
        expect(verdictOf(state, correctionId)).toBe(expected);
        expect(state.corrections.some((entry) => entry.eventId === correctionId)).toBe(
          expected === 'allowed',
        );

        // A refused correction leaves the sentence exactly as it was — the
        // point of the round. `issues: []` with the object already rewritten is
        // the shape r10 shipped.
        const record = state.objects[objectId];
        if (!record) throw new Error('setup did not produce an object');
        const text = (record.object.payload as Record<string, unknown>)[
          TEXT_KEY[record.object.type]
        ];
        expect(text).toBe(expected === 'allowed' && testCase.rewords ? REWORDED : ORIGINAL);
      });
    }
  }
});

describe('authority matrix — relation_added, every actor × kind × retired type', () => {
  const KINDS: RelationKind[] = ['supersedes', 'depends_on', 'blocks', 'answers', 'evidence'];

  for (const actor of ACTOR_KINDS) {
    for (const kind of KINDS) {
      // `supersedes` is the only kind whose authority depends on what it points
      // at, so it is the only one enumerated over the target's type — and since
      // round 2 that enumeration has to cover the whole policy table, not just
      // the decision row of it.
      //
      // **#96 r2 added the second axis: the epistemic state of the thing being
      // retired.** Every cell here used to build its target with a *human*
      // acceptance, so every one of them retired a `✓` — and the ones the type
      // table calls `auto_accept` asserted that a machine may unmake a person's
      // judgement. r2 moved those from "allowed" to a refusal, but only for the
      // confirmed cells.
      //
      // **#96 r3 finishes it: the unconfirmed half refuses too.** r2 left it
      // open on the theory that a machine replacing its own `~` is the
      // covenant's left-hand side — but that path is `proposal_superseded` on a
      // *pending* proposal (the `superseded a proposal` block above, still
      // `allowed`), not a `supersedes` relation retiring a *standing accepted*
      // object. This block only builds the latter, and #95 reserves every such
      // retirement to a person: the unconfirmed target here is accepted by
      // `model_a`, so any non-`model_a` actor retiring it is a machine unmaking
      // another machine's reading — foreign, and refused. The cell proves the
      // relation rule fires without a `✓` in sight; drafting a fresh `~` stays
      // open and is the acceptance suites' business, not this relation's.
      const targets: { type: AcceptedObjectType; confirmed: boolean }[] =
        kind === 'supersedes'
          ? (['decision', 'commitment', 'objective', 'claim', 'open_question'] as const).flatMap(
              (type) => [
                { type, confirmed: true },
                // Only where a machine can mint one at all — see MACHINE_MINTABLE.
                ...(MACHINE_MINTABLE.includes(type) ? [{ type, confirmed: false }] : []),
              ],
            )
          : [{ type: 'decision' as AcceptedObjectType, confirmed: true }];

      for (const target of targets) {
        const label = `${actor} adds "${kind}"${kind === 'supersedes' ? ` retiring ${target.confirmed ? 'a confirmed' : 'an unconfirmed'} ${target.type}` : ''}`;
        it(label, () => {
          const suffix = `${actor}_${kind}_${target.type}_${target.confirmed ? 'c' : 'u'}`;
          const fromType: AcceptedObjectType = kind === 'answers' ? 'open_question' : target.type;
          const toType: AcceptedObjectType = kind === 'answers' ? 'decision' : target.type;
          const fromId = `obj_from_${suffix}`;
          const toId = `obj_to_${suffix}`;

          // The object being retired, in the state the cell names.
          //
          //  - confirmed: a person accepted it outright, which is the one act
          //    that makes an object the room's word rather than a reading.
          //  - unconfirmed: a model staged a reading and accepted its own at θ,
          //    which is the only route to an object no person has touched. It
          //    needs the receipt window and a proposal, so it is two events.
          const retiredProposalId = `prop_t_${suffix}`;
          const retiredSetup: AuthoredEvent[] = target.confirmed
            ? [
                acceptEvent({
                  id: `t_${suffix}`,
                  objectId: toId,
                  type: toType,
                  actor: 'human',
                  proposalId: null,
                  setup: true,
                }),
              ]
            : [
                proposalEvent({
                  id: retiredProposalId,
                  type: toType,
                  proposer: 'model_a',
                  confidence: 0.95,
                  recordedBy: 'model_proposer',
                }),
                acceptEvent({
                  id: `t_${suffix}`,
                  objectId: toId,
                  type: toType,
                  actor: 'model_proposer',
                  proposalId: retiredProposalId,
                }),
              ];

          const events: AuthoredEvent[] = [
            acceptEvent({
              id: `f_${suffix}`,
              objectId: fromId,
              type: fromType,
              actor: 'human',
              proposalId: null,
              setup: true,
            }),
            ...retiredSetup,
            row(
              {
                id: `ev_rel_${suffix}`,
                at: nextAt(),
                type: 'relation_added',
                relation: {
                  id: `rel_${suffix}`,
                  roomId: ROOM,
                  kind,
                  fromObjectId: fromId,
                  to:
                    kind === 'evidence'
                      ? { kind: 'message', messageId: 'msg_1' }
                      : { kind: 'object', objectId: toId },
                  createdAt: nextAt(),
                },
              },
              actor,
            ),
          ];

          const state = reduce(events);
          // The setup has to have produced both objects, or a refusal below
          // would be the setup failing rather than the rule firing — which is
          // how a matrix cell quietly stops testing anything.
          expect(Object.keys(state.objects).sort()).toEqual([fromId, toId].sort());

          const expected = expectedForRelation(actor, kind, kind === 'supersedes' ? target : null);
          expect(verdictOf(state, `ev_rel_${suffix}`)).toBe(expected);
          expect(state.relations.map((relation) => relation.id)).toEqual(
            expected === 'allowed' ? [`rel_${suffix}`] : [],
          );
          // And the fold, not the verdict: a refused supersession leaves the
          // object standing. `issues: []` with the row already retired is the
          // shape this round is closing.
          const retiredRecord = state.objects[toId];
          if (!retiredRecord) throw new Error('setup did not produce the retired object');
          expect(retiredRecord.supersededById).toBe(
            expected === 'allowed' && kind === 'supersedes' ? fromId : null,
          );
        });
      }
    }
  }
});

describe('the matrix as a whole', () => {
  it('enumerates every cell it claims to — 5 actors × 5 types × 9 citation/staging/confidence shapes', () => {
    // Per actor, per type: two cited proposals × two confidence bands × two
    // stagers, plus the one direct shape (with nothing cited there is no band and
    // no staging) = 9. Five types, of which `claim` is doubled for
    // verified/unverified: 4×9 + 9×2 = 54 per actor.
    //
    // The staging dimension is r9's and is the one that was missing: every cell
    // here used to be recorded by `model_proposer`, so the whole *human*-staged
    // half of the space — where D1 lives — was outside the enumeration while the
    // file's own header claimed the case space was enumerated.
    //
    // Five actors since `agent`, and the leading factor is written out rather
    // than read from `ACTOR_KINDS.length` on purpose: derived from the same list
    // the loops range over, this assertion would agree with itself no matter what
    // that list held, which is precisely the vacuity it exists to rule out. The
    // number is the claim in the title, and both move by hand when a kind is
    // added.
    expect(acceptanceCases).toHaveLength(5 * (4 * 9 + 9 * 2));
    const distinct = new Set(
      acceptanceCases.map(
        (entry) =>
          `${entry.actor}|${entry.type}|${entry.cited}|${entry.recordedBy}|${entry.confidence}|${entry.verified}`,
      ),
    );
    expect(distinct.size).toBe(acceptanceCases.length);
  });

  it('is not vacuous — the oracle refuses a substantial share of the space', () => {
    const refused = acceptanceCases.filter(
      (entry) => expectedForAcceptance(entry) !== 'allowed',
    ).length;
    expect(refused).toBeGreaterThan(acceptanceCases.length / 3);
    expect(refused).toBeLessThan(acceptanceCases.length);
  });

  it('leaves the human row open except where a person is the only judgement in the room', () => {
    /**
     * Until r9 this said "entirely open — the floor gates machines, not people",
     * and that was the whole claim: θ, the receipt, and the attribution rules
     * exist to bound *machines*, and a person's judgement is the receipt.
     *
     * It is still the claim, and r9 narrows it by one shape rather than weakening
     * it. The narrowing is not about people being untrusted — it is that a person
     * accepting a reading **they** staged is not a second judgement about a
     * reading, and both things the human path skips on the strength of one (the
     * receipt checks, and #4's third-party confirmation) assume there is one.
     *
     * Written as a partition rather than as "allowed unless refused", so a third
     * refusal creeping into the human row fails here instead of being absorbed.
     *
     * **r10 widens the exception without widening the claim.** "The person
     * accepting staged it" is true of an acceptance that cites *no* proposal too
     * — there is nobody else in it at all — and r9's version excluded that shape
     * with `cited !== 'none'`, which left a person free to mint an obligation
     * against a colleague outright. Same rule, one fewer carve-out.
     */
    const humanRow = acceptanceCases.filter((entry) => entry.actor === 'human');
    const namesSomebodyElse = (entry: AcceptanceCase) =>
      NAMES[entry.type] !== null && NAMES[entry.type] !== ALICE;
    const onlyJudgementInTheRoom = (entry: AcceptanceCase) =>
      (entry.cited === 'none' || entry.recordedBy === 'human') &&
      (entry.cited === 'model_a' || namesSomebodyElse(entry));

    // The exception is a real part of the space, not an empty set the partition
    // is trivially true over — and all three of its grounds are populated.
    expect(
      humanRow.filter((entry) => onlyJudgementInTheRoom(entry) && entry.cited === 'model_a').length,
    ).toBeGreaterThan(0);
    expect(
      humanRow.filter((entry) => onlyJudgementInTheRoom(entry) && entry.cited === 'human').length,
    ).toBeGreaterThan(0);
    expect(
      humanRow.filter((entry) => onlyJudgementInTheRoom(entry) && entry.cited === 'none').length,
    ).toBeGreaterThan(0);

    for (const testCase of humanRow) {
      expect(expectedForAcceptance(testCase)).toBe(
        onlyJudgementInTheRoom(testCase) ? 'self_staged_reading' : 'allowed',
      );
    }
    for (const shape of RECEIPT_SHAPES) {
      expect(expectedForReceipt('human', shape)).toBe('allowed');
    }
  });

  it('folds identically however the cases are ordered', () => {
    // The matrix is about authority, and authority must not depend on arrival
    // order any more than anything else in the reducer does.
    const events = [
      proposalEvent({
        id: 'ord_p',
        type: 'claim',
        proposer: 'model_a',
        confidence: 0.9,
        recordedBy: 'model_proposer',
      }),
      acceptEvent({
        id: 'ord_a',
        objectId: 'obj_ord',
        type: 'claim',
        actor: 'model_other',
        proposalId: 'ord_p',
      }),
    ];
    expect(serializeState(reduce(events))).toBe(serializeState(reduce([...events].reverse())));
  });

  it('reached every gate in the table — walking what the reducer said, not what the oracle predicts', () => {
    // Round 1 built this set from `expectedFor…`, which asks the oracle whether
    // the oracle would refuse: a gate the reducer had stopped firing would still
    // have been "reached". `observed` is filled by `verdictOf` from
    // `state.issues`, so this fails when the reducer goes quiet.
    // `third_party_confirm` is the one gate no `object_accepted` can reach
    // while commitment is human-only (r5) — the type gate fires three checks
    // earlier. It is not deleted, and it is not quietly excused either: the test
    // above calls `acceptanceReceiptRefusal` directly and pins that it still
    // fires, so "unreachable through this door" never becomes "gone".
    const behindATypeRow: Gate[] = ['third_party_confirm'];
    expect([...observed].sort()).toEqual(
      [
        ...Object.keys(GATES).filter((gate) => !behindATypeRow.includes(gate as Gate)),
        'allowed',
      ].sort(),
    );
  });
});
