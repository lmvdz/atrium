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

/** The four kinds of actor the matrix ranges over. */
type ActorKind = 'human' | 'model_proposer' | 'model_other' | 'system';
const ACTOR_KINDS: ActorKind[] = ['human', 'model_proposer', 'model_other', 'system'];

function actorOf(kind: ActorKind): Actor {
  switch (kind) {
    case 'human':
      return { kind: 'human', userId: ALICE };
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
  answer_relation: 'declares an open question answered',
  correction: 'corrections (amend, retract, restore)',
  acceptance_binding: 'may only accept its own reading',
  rejection_binding: 'may only withdraw its own reading',
  supersession_binding: 'may only retire its own reading',
  confidence_floor: 'below the floor',
  // r7. A claim's floor is unreachable — nothing in the words establishes that
  // they were a claim rather than a commitment — so it refuses in words rather
  // than reporting an unreachable number. Its own row, because 'refused for a
  // reason' and 'refused by a threshold' are different facts about a reading.
  certification_floor: 'nothing in the words says whether they were a',
  payload_binding: 'does not carry its payload',
  provenance_binding: 'the receipt may not change on the way through',
  missing_receipt_context: 'no message window supplied',
  receipt_failed: 'on a receipt that does not hold',
  receipt_not_certifiable: 'on a receipt this check declines to rule on',
  third_party_confirm: 'waits for the named owner to confirm',
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
  // r7: a machine may perform this act and cannot certify that it *was* this
  // act, so no confidence clears it. See `typeCertifiableFromText`.
  claim: Number.POSITIVE_INFINITY,
  objective: Number.POSITIVE_INFINITY,
};

/** Supersession authority, restated from #4's split by what is retired. */
const SUPERSESSION_NEEDS_HUMAN: Record<AcceptedObjectType, boolean> = {
  decision: true,
  commitment: true,
  objective: true,
  claim: false,
  open_question: false,
};

const isHumanKind = (kind: ActorKind) => kind === 'human';

/** "A model may act only on its own proposals; a human on any; the system on none." */
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
  if (testCase.cited !== 'none' && !human) {
    // r7. An unreachable floor and a missed threshold are refused at the same
    // point and say different things, so the oracle splits them the way the
    // reducer does.
    if (!Number.isFinite(FLOOR[testCase.type])) return 'certification_floor';
    if (testCase.confidence === 'below') return 'confidence_floor';
  }
  return 'allowed';
}

/** The shapes a receipt can take on the way through acceptance. */
type ReceiptShape =
  | 'faithful'
  | 'payload'
  | 'citations'
  | 'no_window'
  | 'wrong_author'
  | 'uncertifiable';
const RECEIPT_SHAPES: ReceiptShape[] = [
  'faithful',
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
    // r7. A model with a *perfect* receipt still does not land a claim: the
    // receipt certifies that these words are in the record and who wrote them,
    // and says nothing about whether they were a claim rather than a commitment,
    // which is the one field the proposal supplies. The receipt row of this
    // matrix runs on claims, so this cell is the whole finding in one line —
    // "faithful" used to mean "allowed", and faithfulness was never the question
    // the type was answering.
    case 'faithful':
      return 'certification_floor';
  }
}

function expectedForCorrection(actor: ActorKind): Gate | 'allowed' {
  return isHumanKind(actor) ? 'allowed' : 'correction';
}

function expectedForRelation(
  actor: ActorKind,
  kind: RelationKind,
  retires: AcceptedObjectType | null,
): Gate | 'allowed' {
  if (kind === 'answers' && !isHumanKind(actor)) return 'answer_relation';
  if (
    kind === 'supersedes' &&
    retires !== null &&
    SUPERSESSION_NEEDS_HUMAN[retires] &&
    !isHumanKind(actor)
  ) {
    return 'supersession';
  }
  return 'allowed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Log construction. Each case is a self-contained log, so nothing but the rule
// under test can refuse it.
// ─────────────────────────────────────────────────────────────────────────────

let clock = 0;
function nextAt(): string {
  clock += 1;
  return `2026-07-31T${String(10 + Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}:00.000Z`;
}

const parse = (input: unknown): CoreEvent => CoreEventSchema.parse(input);

/** One ledger row: payload, plus the trusted columns. */
function row(
  input: unknown,
  actor: ActorKind,
  messages?: readonly ProvenanceMessage[],
): AuthoredEvent {
  return authored(parse(input), {
    actor: actorOf(actor),
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

const windowWrittenBy = (authorId: string): ProvenanceMessage[] =>
  (Object.keys(TEXT) as AcceptedObjectType[]).map((type) => ({
    id: MSG_FOR[type],
    authorId,
    // **The body is the sentence, with no terminator added.** It used to append
    // a full stop when `TEXT` did not carry one, and the payload statement did
    // not — so every certifying cell of this matrix was riding
    // `droppableTokens`, whose last entry r6's cross-lineage pass broke. The
    // authority rules are what this file is about; the receipt has its own.
    body: TEXT[type],
  }));

/**
 * The claim's sentence with one word dropped: every word of it is in the quote,
 * in order, and the quote says more. Nothing here can tell an aside from a
 * "not", which is what `receipt_not_certifiable` is for.
 */
const REDUCED_CLAIM = 'the build is green on main';

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
}): AuthoredEvent {
  const at = nextAt();
  const payload = payloadFor(input.type, input.verified);
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
        provenance: [MSG_FOR[input.type]],
        quote: TEXT[input.type],
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
}): AuthoredEvent {
  const at = nextAt();
  const payload = payloadFor(input.type, input.verified);
  if (input.statement !== undefined) {
    payload[
      input.type === 'open_question'
        ? 'question'
        : input.type === 'objective'
          ? 'title'
          : 'statement'
    ] = input.statement;
  }
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
    input.actor,
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
        for (const verified of verifiedVariants) {
          acceptanceCases.push({
            kind: 'object_accepted',
            actor,
            type,
            cited,
            confidence,
            verified,
          });
        }
      }
    }
  }
}

describe('authority matrix — object_accepted, every actor × type × citation × confidence', () => {
  for (const testCase of acceptanceCases) {
    const label = `${testCase.actor} accepts ${testCase.type}${testCase.verified ? ' (verified)' : ''} via ${testCase.cited}${testCase.cited === 'none' ? '' : ` @${testCase.confidence} floor`}`;
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
            recordedBy: 'model_proposer',
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
          }),
          acceptEvent({
            id: `acc_r_${suffix}`,
            objectId: `obj_r_${suffix}`,
            type: 'claim',
            actor,
            proposalId,
            ...(shape === 'uncertifiable' ? { statement: REDUCED_CLAIM } : {}),
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
        }),
        acceptEvent({
          id: `a_${suffix}`,
          objectId: answerId,
          type: 'decision',
          actor: 'human',
          proposalId: null,
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

    // Everything else acts on a commitment: it has both a text field and an
    // attribution field, so `amend`, `reattribute` and `retype` all apply.
    events.push(
      acceptEvent({
        id: `c_${suffix}`,
        objectId,
        type: 'commitment',
        actor: 'human',
        proposalId: null,
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
    if (verb === 'amend') return { statement: 'reworded' };
    if (verb === 'reattribute') return { owner: ALICE };
    if (verb === 'retype') return { claimant: ALICE };
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
      acceptEvent({ id: 'vp_setup', objectId, type: 'claim', actor: 'human', proposalId: null }),
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

describe('authority matrix — relation_added, every actor × kind × retired type', () => {
  const KINDS: RelationKind[] = ['supersedes', 'depends_on', 'blocks', 'answers', 'evidence'];

  for (const actor of ACTOR_KINDS) {
    for (const kind of KINDS) {
      // `supersedes` is the only kind whose authority depends on what it points
      // at, so it is the only one enumerated over the target's type — and since
      // round 2 that enumeration has to cover the whole policy table, not just
      // the decision row of it.
      const targets: AcceptedObjectType[] =
        kind === 'supersedes'
          ? ['decision', 'commitment', 'objective', 'claim', 'open_question']
          : ['decision'];

      for (const target of targets) {
        it(`${actor} adds "${kind}"${kind === 'supersedes' ? ` retiring a ${target}` : ''}`, () => {
          const suffix = `${actor}_${kind}_${target}`;
          const fromType: AcceptedObjectType = kind === 'answers' ? 'open_question' : target;
          const toType: AcceptedObjectType = kind === 'answers' ? 'decision' : target;
          const fromId = `obj_from_${suffix}`;
          const toId = `obj_to_${suffix}`;

          const events: AuthoredEvent[] = [
            acceptEvent({
              id: `f_${suffix}`,
              objectId: fromId,
              type: fromType,
              actor: 'human',
              proposalId: null,
            }),
            acceptEvent({
              id: `t_${suffix}`,
              objectId: toId,
              type: toType,
              actor: 'human',
              proposalId: null,
            }),
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
          const expected = expectedForRelation(actor, kind, kind === 'supersedes' ? target : null);
          expect(verdictOf(state, `ev_rel_${suffix}`)).toBe(expected);
          expect(state.relations.map((relation) => relation.id)).toEqual(
            expected === 'allowed' ? [`rel_${suffix}`] : [],
          );
        });
      }
    }
  }
});

describe('the matrix as a whole', () => {
  it('enumerates every cell it claims to — 4 actors × 5 types × 5 citation/confidence shapes', () => {
    // Per actor, per type: two cited proposals × two confidence bands, plus the
    // one direct shape (with nothing cited there is no band) = 5. Five types, of
    // which `claim` is doubled for verified/unverified: 4×5 + 5×2 = 30.
    expect(acceptanceCases).toHaveLength(4 * (4 * 5 + 5 * 2));
    const distinct = new Set(
      acceptanceCases.map(
        (entry) =>
          `${entry.actor}|${entry.type}|${entry.cited}|${entry.confidence}|${entry.verified}`,
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

  it('leaves the human row entirely open — the floor gates machines, not people', () => {
    for (const testCase of acceptanceCases.filter((entry) => entry.actor === 'human')) {
      expect(expectedForAcceptance(testCase)).toBe('allowed');
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
