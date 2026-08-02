import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_RULE_NAMES,
  type AcceptanceRuleName,
  type AcceptanceVerdict,
  type AcceptanceVisibility,
  type AcceptedObjectType,
  AcceptedObjectType as AcceptedObjectTypeSchema,
  answerBindingRefusal,
  applyAnswerBinding,
  autoAcceptable,
  bindAnswer,
  commitmentAttribution,
  DEFAULT_ACCEPTANCE_RULES,
  decideAcceptance,
  decideSupersession,
  defaultAcceptanceConfig,
  findDuplicate,
  MODEL_ACCEPTANCE_FLOOR,
  modelMintingGate,
  normalizeForReceipt,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  readsAsCommitment,
  reduce,
  resolveAcceptanceConfig,
  serializeState,
} from '../src/index.js';
import {
  ALICE,
  at,
  BOB,
  event,
  human,
  model,
  ROOM,
  room,
  sampleLog,
  UNCITED_TAIL,
} from './fixtures.js';

/**
 * #4's acceptance matrix, one test per cell.
 *
 * The table under test, from `decideAcceptance`'s own doc comment:
 *
 * | type                     | c < θ_min | θ_min ≤ c < θ_auto | c ≥ θ_auto             |
 * | ------------------------ | --------- | ------------------ | ---------------------- |
 * | claim                    | discard   | pending, quiet     | auto-accept            |
 * | open_question            | discard   | pending, quiet     | auto-accept            |
 * | objective                | discard   | pending, quiet     | auto-accept            |
 * | commitment, self-stated  | discard   | pending, quiet     | auto-accept            |
 * | commitment, third-party  | discard   | pending, quiet     | pending, owner confirm |
 * | decision                 | discard   | pending, quiet     | pending, Needs-you     |
 *
 * Eighteen cells, driven from a table rather than written out, so a cell cannot
 * be quietly dropped: the count is asserted at the end.
 */

/**
 * Every sentence the fixtures quote — **one per message**.
 *
 * r5 moved these out of a single five-sentence body. A certifiable quote is now
 * the whole of what its author wrote in the bearing message (see
 * `quoteCoversOwnText`), because a neighbouring sentence can reverse the one
 * being quoted and no rule about the quoted span can see that. Five sentences
 * jammed into one body was a test convenience that no longer describes any
 * message anybody sends, and keeping it would have meant every cell of #4's
 * matrix exercising the referral path instead of the cell it names.
 */
const QUOTE: Record<AcceptedObjectType, string> = {
  decision: 'Reset narrowing on mutating method calls.',
  commitment: "I'll land the migration tomorrow.",
  open_question: 'Do we keep the flag after launch?',
  claim: 'The migration is reversible.',
  objective: 'Ship the narrowing fix this quarter.',
};

/**
 * **From the schema, not restated beside it.** codex's third pass: the
 * cross-product below claimed to derive from `AcceptedObjectType` and was in
 * fact iterating a hand-copied list, so a sixth type would have been invisible
 * to the exhaustiveness assertion that exists to notice exactly that.
 */
const OBJECT_TYPES: AcceptedObjectType[] = [...AcceptedObjectTypeSchema.options];

/** The message each type's quote is the whole of. */
const MESSAGE_ID: Record<AcceptedObjectType, string> = {
  decision: 'msg_decision',
  commitment: 'msg_commitment',
  open_question: 'msg_question',
  claim: 'msg_claim',
  objective: 'msg_objective',
};

const windowWrittenBy = (authorId: string): ProvenanceMessage[] =>
  // …and one message nobody cites, at the end. `laterRevision` refuses a window
  // that stops at the citations, so the last type in this list would otherwise
  // exercise the referral path instead of the cell it names.
  room(...OBJECT_TYPES.map((type) => ({ id: MESSAGE_ID[type], authorId, body: QUOTE[type] })));

/** ALICE wrote all of it, so a claim or commitment of ALICE's is self-stated. */
const aliceMessages: ProvenanceMessage[] = windowWrittenBy(ALICE);
/** ...and the same words from BOB, which makes ALICE's the third party. */
const bobMessages: ProvenanceMessage[] = windowWrittenBy(BOB);

function proposal(overrides: {
  type: AcceptedObjectType;
  confidence: number;
  payload?: Record<string, unknown>;
  proposer?: Proposal['proposer'];
  quote?: string | null;
}): Proposal {
  const payload =
    overrides.payload ??
    ({
      // r4: each statement is the sentence its `QUOTE` carries, word for word.
      // The receipt no longer measures how many words two texts share; it asks
      // whether the statement **is** the quote, so "Land the migration" quoted
      // against "I'll land the migration tomorrow" is a reading a person has to
      // confirm rather than one a model may accept.
      //
      // **Word for word now includes the full stop, and r6's cross-lineage pass
      // is why.** These read `'The migration is reversible'` against a body of
      // `'The migration is reversible.'` until `droppableTokens` was emptied —
      // its last entry, `.`, auto-accepted ``Load `env` …`` against ``Load
      // `.env` …``. Every cell of #4's matrix was therefore exercising a licence
      // rather than the cell it names; they carry the sentence exactly now.
      decision: { statement: QUOTE.decision },
      commitment: { statement: QUOTE.commitment, owner: ALICE },
      open_question: { question: QUOTE.open_question },
      claim: { statement: QUOTE.claim, claimant: ALICE },
      objective: { title: QUOTE.objective },
    }[overrides.type] as Record<string, unknown>);

  return ProposalSchema.parse({
    id: 'prop_matrix',
    roomId: ROOM,
    type: overrides.type,
    payload,
    confidence: overrides.confidence,
    proposer: overrides.proposer ?? { kind: 'model', model: 'test-model' },
    provenance: [MESSAGE_ID[overrides.type]],
    quote: overrides.quote === undefined ? QUOTE[overrides.type] : overrides.quote,
    createdAt: at(1),
  });
}

interface Cell {
  label: string;
  type: AcceptedObjectType;
  band: 'below' | 'between' | 'above';
  attribution?: 'self' | 'third_party';
  verdict: AcceptanceVerdict;
  visibility: AcceptanceVisibility;
  rule: AcceptanceRuleName;
  awaitingConfirmFrom?: string | null;
}

/**
 * A confidence squarely inside each band — **written out, not derived**.
 *
 * Round 2's gauntlet kept finding the same shape here, and it kept being right:
 * these numbers used to be computed from `DEFAULT_ACCEPTANCE_RULES`, which makes
 * the whole matrix invariant under a change to the table. Move θ_auto for a claim
 * from 0.7 to 0.6 and every probe moved with it, so the suite proved the *rules*
 * and said nothing about the *thresholds*. r1 patched that with one pin-by-value
 * test; r2's delta found the derivation still here and the single pin still
 * carrying all of it alone.
 *
 * So the probes are literals, and `pinsMatchTheTable` below checks — from the
 * table, once, in one place — that each literal really is in the band its label
 * claims. A θ change now breaks the probe *and* the pin, and both say why.
 */
const PROBE: Record<AcceptedObjectType, Record<Cell['band'], number>> = {
  //                 below θ_min   in the band   at or above θ_auto
  decision: { below: 0.4, between: 0.6, above: 0.7 },
  commitment: { below: 0.4, between: 0.62, above: 0.75 },
  open_question: { below: 0.3, between: 0.5, above: 0.6 },
  claim: { below: 0.4, between: 0.6, above: 0.7 },
  objective: { below: 0.4, between: 0.62, above: 0.75 },
};

function confidenceFor(type: AcceptedObjectType, band: Cell['band']): number {
  return PROBE[type][band];
}

const CELLS: Cell[] = [];
for (const type of ['claim', 'open_question'] as const) {
  CELLS.push(
    {
      label: `${type} below θ_min`,
      type,
      band: 'below',
      verdict: 'discard',
      visibility: 'none',
      rule: 'below_theta_min',
    },
    {
      label: `${type} in the θ band`,
      type,
      band: 'between',
      verdict: 'pending',
      visibility: 'quiet',
      rule: 'theta_band',
    },
    // **r7 keeps this cell, and the round's second implementation is why that
    // needs saying.** That draft refused `auto_accept` for every claim, on the
    // ground that nothing in a message's words proves they were a claim rather
    // than a commitment. True of the *type*, and it took the auto-accept path
    // with it: `QUOTE.claim` is "The migration is reversible.", an unambiguous
    // assertion quoted verbatim, and it landed in Needs-you at every confidence
    // at or above θ_auto. The rule reads the text now (`readsAsCommitment`) and
    // this cell is refused only when the words could be an undertaking — both
    // sides of that are pinned in the r7 block at the foot of this file.
    {
      label: `${type} at θ_auto`,
      type,
      band: 'above',
      verdict: 'auto_accept',
      visibility: 'accepted',
      rule: 'auto_accept',
    },
  );
}
for (const band of ['below', 'between', 'above'] as const) {
  CELLS.push({
    label: `objective ${{ below: 'below θ_min', between: 'in the θ band', above: 'at θ_auto' }[band]}`,
    type: 'objective',
    band,
    verdict: band === 'below' ? 'discard' : 'pending',
    visibility: band === 'below' ? 'none' : band === 'between' ? 'quiet' : 'needs_you',
    rule:
      band === 'below'
        ? 'below_theta_min'
        : band === 'between'
          ? 'theta_band'
          : 'never_auto_accepts',
  });
}
for (const attribution of ['self', 'third_party'] as const) {
  CELLS.push(
    {
      label: `commitment (${attribution}) below θ_min`,
      type: 'commitment',
      band: 'below',
      attribution,
      verdict: 'discard',
      visibility: 'none',
      rule: 'below_theta_min',
    },
    {
      label: `commitment (${attribution}) in the θ band`,
      type: 'commitment',
      band: 'between',
      attribution,
      verdict: 'pending',
      visibility: 'quiet',
      rule: 'theta_band',
    },
  );
}
CELLS.push(
  {
    label: 'commitment (self) at θ_auto',
    type: 'commitment',
    band: 'above',
    attribution: 'self',
    // r5: a commitment never auto-accepts at any confidence, self-stated or
    // not. #4's row split on who the sentence is *about*; it was silent on who
    // does the accepting, and #44's fact-check drove a model straight through
    // that silence to mint an obligation naming a person.
    verdict: 'pending',
    visibility: 'needs_you',
    rule: 'never_auto_accepts',
  },
  {
    label: 'commitment (third-party) at θ_auto',
    type: 'commitment',
    band: 'above',
    attribution: 'third_party',
    verdict: 'pending',
    visibility: 'needs_you',
    rule: 'third_party_commitment',
    awaitingConfirmFrom: ALICE,
  },
  {
    label: 'decision below θ_min',
    type: 'decision',
    band: 'below',
    verdict: 'discard',
    visibility: 'none',
    rule: 'below_theta_min',
  },
  {
    label: 'decision in the θ band',
    type: 'decision',
    band: 'between',
    verdict: 'pending',
    visibility: 'quiet',
    rule: 'theta_band',
  },
  {
    label: 'decision at θ_auto',
    type: 'decision',
    band: 'above',
    verdict: 'pending',
    visibility: 'needs_you',
    rule: 'never_auto_accepts',
  },
  {
    label: 'decision at confidence 1.0',
    type: 'decision',
    band: 'above',
    verdict: 'pending',
    visibility: 'needs_you',
    rule: 'never_auto_accepts',
  },
);

describe('#4 acceptance matrix — one test per cell', () => {
  for (const cell of CELLS) {
    it(cell.label, () => {
      const confidence = cell.label.endsWith('confidence 1.0')
        ? 1
        : confidenceFor(cell.type, cell.band);
      // Attribution is decided by who wrote the message bearing the sentence, so
      // a third-party cell is the same proposal read against a window somebody
      // else wrote. Every other cell uses the window whose author matches the
      // person named, because a mismatched one is a *receipt* failure and that
      // has its own tests.
      const messages = cell.attribution === 'third_party' ? bobMessages : aliceMessages;
      const decision = decideAcceptance(proposal({ type: cell.type, confidence }), { messages });

      expect(decision.verdict).toBe(cell.verdict);
      expect(decision.visibility).toBe(cell.visibility);
      expect(decision.rule).toBe(cell.rule);
      expect(decision.awaitingConfirmFrom).toBe(cell.awaitingConfirmFrom ?? null);
      // Every decision explains itself: the reason is what a room is shown.
      expect(decision.reason.length).toBeGreaterThan(0);
      // A discard short-circuits before attribution is computed, on purpose:
      // there is nobody to ask about a reading nobody will see.
      if (cell.attribution && cell.verdict !== 'discard') {
        expect(decision.attribution).toBe(cell.attribution);
      }
    });
  }

  it('covers every (type, attribution, band) the matrix has, so none can be dropped', () => {
    /**
     * **Derived from the types, not counted by hand.** The title used to say
     * "eighteen" against a table of nineteen, and the arithmetic beside it was a
     * second hand-maintained restatement of the same fact — this round's own
     * blind review flagged the shape. The cross-product is built from
     * `AcceptedObjectType` and the three bands, with `commitment` split by
     * attribution because that split is a real row of #4's table, so a type
     * added to `objects.ts` makes this fail until it has cells.
     */
    const expected = new Set<string>();
    for (const type of OBJECT_TYPES) {
      for (const band of ['below', 'between', 'above'] as const) {
        if (type === 'commitment') {
          expected.add(`commitment:self:${band}`);
          expected.add(`commitment:third_party:${band}`);
        } else {
          expected.add(`${type}:-:${band}`);
        }
      }
    }
    const covered = new Set(
      CELLS.map((cell) => `${cell.type}:${cell.attribution ?? '-'}:${cell.band}`),
    );
    expect([...covered].sort()).toEqual([...expected].sort());
    // One extra row beyond the cross-product: decision at 1.0, pinning that
    // "never" is a rule and not a threshold.
    expect(CELLS).toHaveLength(expected.size + 1);
  });

  it('gates exactly the types a machine may not perform, and floors the ones it cannot certify', () => {
    // grok's pass: `modelMintingGate` says in its own doc comment that it is
    // derived from the same table `MODEL_ACCEPTANCE_FLOOR` is derived from, "so
    // the named refusal and the unreachable number cannot drift" — and nothing
    // checked it. A `switch` is not a derivation; this is what makes the claim
    // true.
    //
    // **r7's second implementation made these two sets differ and its third put
    // them back.** The middle draft floored `claim` at `+Infinity` on the ground
    // that nothing proves a claim was a claim; that is true of the *type* and it
    // took `auto_accept` away from every claim, including an unambiguous
    // assertion quoted verbatim. The rule reads the *text* now
    // (`typeCertifiableFromText`), which is not a thing a table keyed by type
    // can hold, so the gate and the floor are one question again.
    for (const type of OBJECT_TYPES) {
      expect(modelMintingGate(type) === null, type).toBe(autoAcceptable(type));
      expect(Number.isFinite(MODEL_ACCEPTANCE_FLOOR[type]), type).toBe(autoAcceptable(type));
    }
  });

  it('probes the band each literal claims to be in', () => {
    // The one place the literals above are compared to the table. Without it a
    // θ change could move a band out from under a probe and every cell test
    // would still pass by landing in the wrong cell for the right reason.
    for (const type of Object.keys(PROBE) as AcceptedObjectType[]) {
      const rule = DEFAULT_ACCEPTANCE_RULES[type];
      const probe = PROBE[type];
      expect(probe.below).toBeLessThan(rule.thetaMin);
      expect(probe.between).toBeGreaterThanOrEqual(rule.thetaMin);
      expect(probe.between).toBeLessThan(rule.thetaAuto);
      expect(probe.above).toBeGreaterThanOrEqual(rule.thetaAuto);
    }
  });

  it('reaches every rule name the type declares', () => {
    /**
     * **Driven from `ACCEPTANCE_RULE_NAMES`, which is what `AcceptanceRuleName`
     * is made of.** r4's blind review found this test restating the list by hand
     * and *omitting* `receipt_not_certifiable` — so a test titled "reaches every
     * rule name the type declares" passed while one rule was unreachable from
     * it, and would have gone on passing if that engine behaviour were deleted.
     * A hand-written list is blind to a name that appears; deriving it from the
     * data the type is built out of is blind to neither, because the list and
     * the type are the same object.
     */
    const seen = new Set<AcceptanceRuleName>(CELLS.map((cell) => cell.rule));
    // receipt_not_certifiable — a quote that says more than the statement, and
    // nothing here can tell an aside from a "not".
    seen.add(
      decideAcceptance(
        proposal({
          type: 'claim',
          confidence: 0.9,
          payload: { statement: 'The migration is reversible', claimant: BOB },
          quote: 'The migration is not reversible.',
        }),
        {
          messages: [
            { id: MESSAGE_ID.claim, authorId: BOB, body: 'The migration is not reversible.' },
          ],
        },
      ).rule,
    );
    // type_not_certified — r7: an unimpeachable receipt on words that read as an
    // undertaking as easily as an assertion. Nothing is wrong with the citation;
    // what is missing is any evidence that the words were a *claim*.
    seen.add(
      decideAcceptance(
        proposal({
          type: 'claim',
          confidence: 0.9,
          payload: { statement: 'We will deploy production Friday.', claimant: ALICE },
          quote: 'We will deploy production Friday.',
        }),
        {
          messages: room(
            { id: MESSAGE_ID.claim, authorId: ALICE, body: 'We will deploy production Friday.' },
            UNCITED_TAIL,
          ),
        },
      ).rule,
    );
    // A wrong receipt: the quote is in no cited message at all.
    seen.add(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9, quote: 'never written here' }), {
        messages: aliceMessages,
      }).rule,
    );
    seen.add(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), {
        messages: aliceMessages,
        acceptedObjects: [
          {
            objectId: 'obj_1',
            type: 'claim',
            text: QUOTE.claim,
            messageIds: [MESSAGE_ID.claim],
          },
        ],
      }).rule,
    );
    seen.add(
      decideAcceptance(
        proposal({ type: 'claim', confidence: 0.05, proposer: { kind: 'human', userId: ALICE } }),
        { messages: aliceMessages },
      ).rule,
    );
    seen.add(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), {
        messages: undefined as unknown as ProvenanceMessage[],
      }).rule,
    );
    expect([...seen].sort()).toEqual([...ACCEPTANCE_RULE_NAMES].sort());
  });
});

describe('the receipt is mandatory — no window, no verdict', () => {
  /**
   * Round 1's second blocking finding. `messages` was optional, an absent window
   * produced an empty problem set, and an empty problem set read as a clean
   * receipt — so the caller that forgot the argument got auto-acceptance instead
   * of a refusal. Every direction of that is closed here and in the reducer.
   */
  const noWindow = { messages: undefined as unknown as ProvenanceMessage[] };

  it('discards a model proposal judged with no messages, at any confidence', () => {
    for (const confidence of [0.5, 0.9, 1]) {
      const decision = decideAcceptance(proposal({ type: 'claim', confidence }), noWindow);
      expect(decision.verdict).toBe('discard');
      expect(decision.rule).toBe('missing_message_context');
      expect(decision.reason).toContain('never accepted on trust');
    }
  });

  it('discards it for every type, so no type has a quiet way through', () => {
    for (const type of ['decision', 'commitment', 'open_question', 'claim', 'objective'] as const) {
      expect(decideAcceptance(proposal({ type, confidence: 0.99 }), noWindow).verdict).toBe(
        'discard',
      );
    }
  });

  it('still judges a human-staged proposal, which needs no receipt', () => {
    const decision = decideAcceptance(
      proposal({ type: 'claim', confidence: 0.9, proposer: { kind: 'human', userId: ALICE } }),
      noWindow,
    );
    expect(decision.rule).toBe('human_proposer');
    expect(decision.verdict).toBe('pending');
  });

  it('asks a human-staged commitment’s named owner to confirm, whoever staged it', () => {
    // #4 is about the sentence, not about the machine: a person naming somebody
    // else still does not get to commit them.
    const staged = decideAcceptance(
      proposal({
        type: 'commitment',
        confidence: 0.9,
        proposer: { kind: 'human', userId: BOB },
      }),
      { messages: aliceMessages },
    );
    expect(staged.awaitingConfirmFrom).toBe(ALICE);
    expect(staged.attribution).toBe('third_party');

    const ownWords = decideAcceptance(
      proposal({
        type: 'commitment',
        confidence: 0.9,
        proposer: { kind: 'human', userId: ALICE },
      }),
      { messages: aliceMessages },
    );
    expect(ownWords.awaitingConfirmFrom).toBeNull();
    expect(ownWords.attribution).toBe('self');
  });
});

describe('the θ table itself — pinned by value, not derived', () => {
  /**
   * The matrix above draws its confidences *from* the config, which is what
   * makes it a test of the rules rather than of the numbers — and which means it
   * is invariant under a change to the numbers. Moving θ_auto moves the probe
   * with it and every cell still passes.
   *
   * That is the right shape for the rule table and the wrong shape for the only
   * check on the thresholds, so the thresholds are pinned here separately: once
   * by value, and once behaviourally at fixed confidences that do not move. A θ
   * change now has to come here and say so.
   */
  it('is exactly this table', () => {
    expect(DEFAULT_ACCEPTANCE_RULES).toEqual({
      decision: { thetaAuto: 0.7, thetaMin: 0.5, autoAccept: false },
      commitment: { thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false },
      open_question: { thetaAuto: 0.6, thetaMin: 0.4, autoAccept: true },
      claim: { thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true },
      objective: { thetaAuto: 0.75, thetaMin: 0.5, autoAccept: false },
    });
  });

  it('has the ordering #4 argues for — the cost of being wrong sets the bar', () => {
    const { claim, open_question, commitment, objective } = DEFAULT_ACCEPTANCE_RULES;
    // A spurious question is one click; a missed one is never revisited.
    expect(open_question.thetaAuto).toBeLessThan(claim.thetaAuto);
    // An obligation with a name on it, and a heading everything is filed under,
    // both cost more to get wrong than "X said Y".
    expect(commitment.thetaAuto).toBeGreaterThan(claim.thetaAuto);
    expect(objective.thetaAuto).toBeGreaterThan(claim.thetaAuto);
  });

  it('places fixed confidences in the cells the table implies', () => {
    // Literal numbers on both sides: nothing here moves when the config does.
    const verdictAt = (type: AcceptedObjectType, confidence: number) =>
      decideAcceptance(proposal({ type, confidence }), { messages: aliceMessages }).visibility;

    expect(verdictAt('claim', 0.45)).toBe('none'); // under θ_min 0.5
    expect(verdictAt('claim', 0.6)).toBe('quiet'); // in the band
    expect(verdictAt('claim', 0.75)).toBe('accepted'); // over θ_auto 0.7
    // …and the r7 rule, on the same probe: the same confidence, text that could
    // be an undertaking, refused. `PROBE.claim` is an assertion; this is not.
    expect(
      decideAcceptance(
        proposal({
          type: 'claim',
          confidence: 0.75,
          payload: { statement: 'We will deploy production Friday.', claimant: ALICE },
          quote: 'We will deploy production Friday.',
        }),
        {
          messages: room(
            { id: MESSAGE_ID.claim, authorId: ALICE, body: 'We will deploy production Friday.' },
            UNCITED_TAIL,
          ),
        },
      ).rule,
    ).toBe('type_not_certified');

    expect(verdictAt('open_question', 0.35)).toBe('none');
    expect(verdictAt('open_question', 0.5)).toBe('quiet');
    expect(verdictAt('open_question', 0.65)).toBe('accepted');

    // r5: neither of these accepts at any confidence — θ_auto now buys a place
    // in Needs-you rather than acceptance, exactly as it does for a decision.
    expect(verdictAt('commitment', 0.7)).toBe('quiet'); // still under 0.75
    expect(verdictAt('commitment', 0.8)).toBe('needs_you');

    expect(verdictAt('objective', 0.7)).toBe('quiet');
    expect(verdictAt('objective', 0.8)).toBe('needs_you');

    // A decision at a confidence that would accept any other type.
    expect(verdictAt('decision', 0.99)).toBe('needs_you');
    expect(verdictAt('decision', 0.6)).toBe('quiet');
  });

  it('is the same number the reducer folds against — one table, not two', () => {
    // Round 1's gauntlet closed the gap between these. The floor is derived from
    // the table above rather than restated beside it, and a type that never
    // auto-accepts is unreachable rather than "very high".
    expect(MODEL_ACCEPTANCE_FLOOR).toEqual({
      decision: Number.POSITIVE_INFINITY,
      commitment: Number.POSITIVE_INFINITY,
      open_question: 0.6,
      // r7's middle draft made this `+Infinity` and its third put it back: the
      // rule is about the words, not the type, and a table keyed by type cannot
      // hold one. `reduce.ts` reads `typeCertifiableFromText` over the payload
      // text instead, beside this floor rather than through it.
      claim: 0.7,
      objective: Number.POSITIVE_INFINITY,
    });
    for (const type of OBJECT_TYPES) {
      expect(MODEL_ACCEPTANCE_FLOOR[type], type).toBe(
        autoAcceptable(type) ? DEFAULT_ACCEPTANCE_RULES[type].thetaAuto : Number.POSITIVE_INFINITY,
      );
    }
  });
});

describe('the θ boundaries are inclusive at θ_auto and exclusive at θ_min', () => {
  const context = { messages: aliceMessages };

  /**
   * Every number below is a literal. Round 2's delta: this suite probed with
   * `rule.thetaAuto` and `rule.thetaMin`, so it pinned the *shape* of the
   * inequality — inclusive here, exclusive there — against a table it read at
   * run time, and would have gone on passing at any θ whatsoever. A claim's
   * θ_auto is 0.7 and its θ_min is 0.5, and this suite now says so out loud.
   */
  it('accepts exactly at θ_auto (0.7 for a claim)', () => {
    expect(decideAcceptance(proposal({ type: 'claim', confidence: 0.7 }), context).verdict).toBe(
      'auto_accept',
    );
  });

  it('does not accept a hair under θ_auto (0.6999)', () => {
    const decision = decideAcceptance(proposal({ type: 'claim', confidence: 0.6999 }), context);
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
    expect(decision.rule).toBe('theta_band');
  });

  it('keeps a proposal exactly at θ_min (0.5) rather than discarding it', () => {
    expect(decideAcceptance(proposal({ type: 'claim', confidence: 0.5 }), context).verdict).toBe(
      'pending',
    );
  });

  it('discards a hair under θ_min (0.4999)', () => {
    expect(decideAcceptance(proposal({ type: 'claim', confidence: 0.4999 }), context).verdict).toBe(
      'discard',
    );
  });
});

describe('provenance failure demotes below θ_min, whatever the confidence', () => {
  it('discards a 0.98-confidence claim whose receipt is wrong', () => {
    // The spike's worst output, routed through the engine.
    const decision = decideAcceptance(proposal({ type: 'claim', confidence: 0.98 }), {
      messages: [
        {
          id: MESSAGE_ID.claim,
          authorId: BOB,
          body: '> The migration is reversible.\n\nno she did not say that',
        },
      ],
    });
    expect(decision.verdict).toBe('discard');
    expect(decision.rule).toBe('provenance_failed');
    expect(decision.reason).toContain('reply-blockquote');
  });
});

describe('commitmentAttribution — nobody gets committed by someone else’s sentence', () => {
  const quote = QUOTE.commitment;

  it('is self when the owner wrote the message bearing the sentence', () => {
    expect(commitmentAttribution(ALICE, [MESSAGE_ID.commitment], aliceMessages, quote)).toBe(
      'self',
    );
  });

  it('is third-party when somebody else did', () => {
    expect(commitmentAttribution(ALICE, [MESSAGE_ID.commitment], bobMessages, quote)).toBe(
      'third_party',
    );
  });

  it('is third-party when the messages are not supplied at all', () => {
    // An unproven self-statement is a third-party statement. The safe direction
    // is asking the named person, and this is the direction that is safe.
    expect(commitmentAttribution(ALICE, ['msg_1'], undefined, quote)).toBe('third_party');
    expect(commitmentAttribution(ALICE, ['msg_1'], [], quote)).toBe('third_party');
  });

  it('is third-party when there is no quote to locate the sentence with', () => {
    expect(commitmentAttribution(ALICE, ['msg_1'], aliceMessages, null)).toBe('third_party');
    expect(commitmentAttribution(ALICE, ['msg_1'], aliceMessages, '  ')).toBe('third_party');
  });

  it('does not count a message the proposal did not cite', () => {
    expect(commitmentAttribution(ALICE, ['msg_other'], aliceMessages, quote)).toBe('third_party');
  });

  it('cannot be flipped by padding the citation list', () => {
    // Round 1's gauntlet, major 5: the owner authored *a* cited message, so
    // citing one unrelated thing they wrote turned somebody else's sentence into
    // their own commitment.
    const window: ProvenanceMessage[] = [
      { id: 'msg_pad', authorId: ALICE, body: 'Morning all.' },
      { id: 'msg_commit', authorId: BOB, body: 'Alice will land the migration tomorrow.' },
    ];
    expect(
      commitmentAttribution(
        ALICE,
        ['msg_pad', 'msg_commit'],
        window,
        'Alice will land the migration tomorrow.',
      ),
    ).toBe('third_party');
  });
});

describe('deduplication against accepted state — the spike’s amendment 3', () => {
  const accepted = [
    {
      objectId: 'obj_existing',
      type: 'claim' as const,
      // The accepted object carries the sentence the proposal restates, full stop
      // included: since r6 nothing is droppable, so a re-proposal is a re-proposal
      // of the *same string*.
      text: QUOTE.claim,
      messageIds: [MESSAGE_ID.claim],
    },
  ];

  it('discards a re-proposal of something already accepted', () => {
    const decision = decideAcceptance(proposal({ type: 'claim', confidence: 0.95 }), {
      messages: aliceMessages,
      acceptedObjects: accepted,
    });
    expect(decision.verdict).toBe('discard');
    expect(decision.rule).toBe('duplicate_of_accepted');
    expect(decision.duplicateOf).toBe('obj_existing');
  });

  it('requires both statement similarity and provenance overlap', () => {
    // Same words, different messages: not a duplicate. Two people can say the
    // same thing twice and both are real.
    expect(findDuplicate('claim', QUOTE.claim, ['msg_9'], accepted)).toBeNull();
    // Same message, different words: also not a duplicate. One message carries
    // several readings, which is the ordinary case.
    expect(
      findDuplicate('claim', 'The rollback script is untested', [MESSAGE_ID.claim], accepted),
    ).toBeNull();
  });

  it('does not match across types', () => {
    expect(findDuplicate('open_question', QUOTE.claim, ['msg_1'], accepted)).toBeNull();
  });
});

describe('AcceptanceConfig — the invariants that keep the engine above the floor', () => {
  it('accepts the defaults, and resolves to exactly them', () => {
    // Not `not.toThrow()`: a test whose only assertion is that nothing exploded
    // passes on a function that returns undefined. Round 1's gauntlet named this
    // one specifically.
    expect(resolveAcceptanceConfig()).toEqual(DEFAULT_ACCEPTANCE_RULES);
    expect(defaultAcceptanceConfig).toEqual(DEFAULT_ACCEPTANCE_RULES);
    expect(defaultAcceptanceConfig.claim.thetaAuto).toBe(DEFAULT_ACCEPTANCE_RULES.claim.thetaAuto);
  });

  it('allows a stricter override', () => {
    const config = resolveAcceptanceConfig({ claim: { thetaAuto: 0.95, thetaMin: 0.8 } });
    expect(config.claim.thetaAuto).toBe(0.95);
    expect(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), {
        messages: aliceMessages,
        config,
      }).verdict,
    ).toBe('pending');
  });

  it('refuses a θ_auto below the reducer’s floor', () => {
    // The whole point: a config looser than the floor emits acceptances the
    // reducer refuses, and the only symptom is a growing `issues` list.
    //
    // **`open_question`, not `claim`, since r7.** A claim's floor is
    // `+Infinity` now — no confidence clears it, because nothing in the text
    // certifies that the words were a claim — and the invariant is guarded by
    // `Number.isFinite`, so a claim override cannot exercise it. This has to run
    // on the one type a machine may still mint or it asserts nothing.
    expect(() =>
      resolveAcceptanceConfig({ open_question: { thetaAuto: 0.1, thetaMin: 0.05 } }),
    ).toThrow(/below the reducer's acceptance floor/);
  });

  it('refuses an inverted band', () => {
    expect(() => resolveAcceptanceConfig({ claim: { thetaMin: 0.99, thetaAuto: 0.7 } })).toThrow(
      /pending band would be inverted/,
    );
  });

  it('refuses to turn on decision auto-acceptance', () => {
    expect(() => resolveAcceptanceConfig({ decision: { autoAccept: true } })).toThrow(
      /may never auto-accept/,
    );
  });

  it('keeps every default θ_auto at or above the floor it is checked against', () => {
    for (const [type, rule] of Object.entries(DEFAULT_ACCEPTANCE_RULES)) {
      const floor = MODEL_ACCEPTANCE_FLOOR[type as AcceptedObjectType];
      if (!rule.autoAccept || !Number.isFinite(floor)) continue;
      expect(rule.thetaAuto).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('decideSupersession — #4’s split by what is being retired', () => {
  it('auto-accepts retiring a claim or a question', () => {
    expect(decideSupersession('claim').authority).toBe('auto_accept');
    expect(decideSupersession('open_question').authority).toBe('auto_accept');
  });

  it('requires a human to retire a decision', () => {
    expect(decideSupersession('decision').authority).toBe('requires_human');
  });

  it('requires a human for the two types #4 does not name, rather than guessing', () => {
    expect(decideSupersession('commitment').authority).toBe('requires_human');
    expect(decideSupersession('objective').authority).toBe('requires_human');
  });

  it('is the table the reducer enforces, not a stricter opinion beside it', () => {
    // Round 1's gauntlet, major 6: the reducer gated decisions only, so the two
    // rows this policy added were policy nothing enforced. `guards.test.ts`
    // holds the other half — a model retiring a commitment is refused.
    for (const type of ['decision', 'commitment', 'objective'] as const) {
      expect(decideSupersession(type).authority).toBe('requires_human');
    }
  });
});

describe('answer-binding — the one path to an accepted decision with no model in it', () => {
  const base = reduce(sampleLog());
  const question = event({
    id: 'ev_q',
    at: at(9),
    actor: human(),
    type: 'object_accepted',
    object: {
      id: 'obj_q_open',
      roomId: ROOM,
      type: 'open_question',
      payload: { question: 'Do we keep the flag after launch?' },
      createdAt: at(9),
      updatedAt: at(9),
    },
  });
  const withQuestion = reduce([...sampleLog(), question]);

  const command = {
    at: at(11),
    roomId: ROOM,
    questionObjectId: 'obj_q_open',
    answer: {
      type: 'decision' as const,
      objectId: 'obj_bound_answer',
      payload: {
        statement: 'No — the flag comes out at launch',
        decidedBy: ALICE,
        status: 'active' as const,
      },
    },
    messageIds: ['msg_answer'],
    ids: { acceptEventId: 'ev_bind_a', relationEventId: 'ev_bind_r', relationId: 'rel_bind' },
  };

  it('produces a decision the reducer accepts, with no proposal at all', () => {
    const bound = bindAnswer(withQuestion, command, human());
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error('unreachable');

    const state = reduce(bound.events, withQuestion);
    expect(state.issues).toEqual([]);
    const decision = state.objects.obj_bound_answer;
    expect(decision?.object.type).toBe('decision');
    expect(decision?.object.provenance.proposalId).toBeNull();
    expect(decision?.object.provenance.messageIds).toEqual(['msg_answer']);
    // Nothing was staged: the proposal machinery is bypassed entirely.
    expect(Object.keys(state.proposals)).toEqual(Object.keys(withQuestion.proposals));
  });

  it('flips the question to answered', () => {
    const bound = bindAnswer(withQuestion, command, human());
    if (!bound.ok) throw new Error('unreachable');
    const state = reduce(bound.events, withQuestion);
    const answered = state.objects.obj_q_open?.object;
    expect(answered?.type === 'open_question' && answered.payload.status).toBe('answered');
  });

  it('carries the trusted actor onto both events, not a payload field', () => {
    const bound = bindAnswer(withQuestion, command, human(BOB));
    if (!bound.ok) throw new Error('unreachable');
    expect(bound.events.map((entry) => entry.actor)).toEqual([human(BOB), human(BOB)]);
    for (const entry of bound.events) expect(entry.event).not.toHaveProperty('actor');
  });

  it('is a pure function of the command — same input, byte-identical events', () => {
    const first = bindAnswer(withQuestion, command, human());
    const second = bindAnswer(withQuestion, { ...command }, human());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // And folding it twice from the same base lands on the same bytes.
    if (!first.ok) throw new Error('unreachable');
    expect(serializeState(reduce(first.events, withQuestion))).toBe(
      serializeState(reduce(first.events, withQuestion)),
    );
  });

  it('refuses a model actor — binding is a person answering', () => {
    const refusal = answerBindingRefusal(withQuestion, command, model());
    expect(refusal).toContain('only a human may bind an answer');
  });

  it('refuses a subject that is not an open question', () => {
    expect(
      answerBindingRefusal(
        withQuestion,
        { ...command, questionObjectId: 'obj_decision_2' },
        human(),
      ),
    ).toContain('not an open question');
  });

  it('refuses a question that is already answered', () => {
    // Round 1's gauntlet, major 7: the command never checked that the question
    // was open, so binding a second answer left two `answers` edges and one
    // status, and nothing said which one the room had settled on.
    expect(
      answerBindingRefusal(
        withQuestion,
        { ...command, questionObjectId: 'obj_question_1' },
        human(),
      ),
    ).toContain('already answered');
  });

  it('refuses ids whose order would put the edge before the object', () => {
    // Both events share a timestamp, so the canonical order breaks the tie on
    // the ids the caller picked. Picked the wrong way round, the relation lands
    // first, fails on an unknown target, and the question stays open beside its
    // own answer.
    const refusal = answerBindingRefusal(
      withQuestion,
      { ...command, ids: { ...command.ids, acceptEventId: 'ev_z', relationEventId: 'ev_a' } },
      human(),
    );
    expect(refusal).toContain('must sort strictly before');

    // …and the ordering it insists on is the one that actually works.
    const bound = bindAnswer(withQuestion, command, human());
    if (!bound.ok) throw new Error('unreachable');
    const [accept, relation] = bound.events;
    expect(accept?.event.id).toBe('ev_bind_a');
    expect(relation?.event.id).toBe('ev_bind_r');
    expect(reduce(bound.events, withQuestion).issues).toEqual([]);
    // Handed to the reducer in the other order it still sorts correctly, because
    // `reduce` sorts — the refusal is about the ids, not about the array.
    expect(reduce([...bound.events].reverse(), withQuestion).issues).toEqual([]);
  });

  it('refuses an unknown question, a retracted one, and a cross-room one', () => {
    expect(
      answerBindingRefusal(withQuestion, { ...command, questionObjectId: 'nope' }, human()),
    ).toContain('unknown open question');
    expect(
      answerBindingRefusal(withQuestion, { ...command, roomId: 'room_other' }, human()),
    ).toContain('not "room_other"');

    const retracted = reduce([
      ...sampleLog(),
      question,
      event({
        id: 'ev_retract_q',
        at: at(10),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_q_open',
        action: 'retract',
      }),
    ]);
    expect(answerBindingRefusal(retracted, command, human())).toContain('is retracted');
  });

  it('refuses to overwrite an existing object', () => {
    expect(
      answerBindingRefusal(
        withQuestion,
        { ...command, answer: { ...command.answer, objectId: 'obj_decision_1' } },
        human(),
      ),
    ).toContain('already exists');
  });

  it('leaves the base state untouched — it mints events, it does not apply them', () => {
    const before = serializeState(base);
    bindAnswer(withQuestion, command, human());
    expect(serializeState(base)).toBe(before);
  });

  it('applies as one command, or not at all', () => {
    const applied = applyAnswerBinding(withQuestion, command, human());
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');
    expect(applied.state.objects.obj_bound_answer).toBeDefined();
    const answered = applied.state.objects.obj_q_open?.object;
    expect(answered?.type === 'open_question' && answered.payload.status).toBe('answered');
  });

  it('rolls the acceptance back when the edge cannot land', () => {
    // Two events, one meaning. Folding them one at a time can land the answer
    // and lose the edge, which leaves the room with a decision nobody asked for
    // and a question nobody answered. The relation id here is already spent, so
    // the second append is refused and the first is undone.
    const before = serializeState(withQuestion);
    const result = applyAnswerBinding(
      withQuestion,
      { ...command, ids: { ...command.ids, acceptEventId: 'ev_0', relationEventId: 'ev_08' } },
      human(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toContain('rolled back');
    expect(result.state).toBe(withQuestion);
    expect(serializeState(result.state)).toBe(before);
    expect(result.state.objects.obj_bound_answer).toBeUndefined();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * r7 — the type was the proposal's own word, and the fix reads the text
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * **What a receipt proves, and the one thing it cannot.**
 *
 * Everything above certifies *provenance*: these words are in the record, this
 * person wrote them, nothing later took them back. `proposal.type` is in none of
 * that — the model supplies it — and until r7 it **selected the rule that judged
 * the proposal**. One body, one quote, one author, confidence 0.95: as a
 * `commitment`, `pending / never_auto_accepts`; as a `claim`, `auto_accept`. A
 * commitment nobody confirmed, filed as a machine-accepted claim.
 *
 * Two implementations were measured and discarded before this one — a
 * `refer`-severity receipt problem (which outranks θ and emptied the discard
 * cell into Needs-you, 78 tests) and a type-level predicate (which refused every
 * claim, including unambiguous assertions, and deleted the auto-accept path).
 * `policy.ts` carries both measurements. The shape that survived asks about the
 * **words**, not the type, and the three cases below are the specification.
 */
describe('r7 — a claim whose words could be an undertaking is referred, not accepted', () => {
  const room = (body: string): ProvenanceMessage[] => [
    { id: 'm1', authorId: BOB, body },
    { id: 'm2', authorId: ALICE, body: 'noted, thanks for the update' },
  ];
  const claimOf = (statement: string, confidence = 0.95): Proposal =>
    ProposalSchema.parse({
      id: 'prop_type',
      roomId: ROOM,
      type: 'claim',
      payload: { statement, claimant: BOB },
      confidence,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['m1'],
      quote: statement,
      createdAt: at(1),
    }) as Proposal;

  /** Assertions and nothing else. These must keep auto-accepting: they are the product. */
  const ASSERTIONS = [
    'The backfill completed with 4,218,904 rows and no retries.',
    'The migration is reversible and can be rolled back cleanly.',
    'The build is green on main and the staging cluster is healthy.',
    'The p99 latency dropped to 41 milliseconds after the index landed.',
    // `should` is deliberately not a marker: this is a claim about how things
    // ought to work far more often than it is somebody taking something on.
    'Deployments should be reversible in principle for every service.',
    // …and `can` is capability, not undertaking.
    'The rollback can be run from the runbook without a deploy.',
  ];

  /** Equally an undertaking. These must refer, carrying their quote. */
  const UNDERTAKINGS = [
    'We will deploy production Friday afternoon as planned.',
    '@dhlolo will land the narrowing fix on Friday morning.',
    "I'll take the migration review before the end of the week.",
    'We need to cut the release branch before the end of the quarter.',
    'The team is going to rerun the backfill over the weekend.',
    'Everyone must update their local schema before Thursday.',
  ];

  it('keeps auto-accepting an unambiguous assertion — this is the path, not a cost', () => {
    // **The half r7's middle implementation deleted.** θ_auto exists so a
    // reading genuinely in the record lands without a person's turn; a
    // Current-state pane with no machine-read claims in it is a manual tool with
    // an unused engine.
    for (const statement of ASSERTIONS) {
      const decision = decideAcceptance(claimOf(statement), { messages: room(statement) });
      expect(decision.verdict, statement).toBe('auto_accept');
      expect(decision.rule, statement).toBe('auto_accept');
    }
  });

  it('refers a claim whose words are equally an undertaking', () => {
    for (const statement of UNDERTAKINGS) {
      const decision = decideAcceptance(claimOf(statement), { messages: room(statement) });
      expect(decision.verdict, statement).toBe('pending');
      expect(decision.rule, statement).toBe('type_not_certified');
      expect(decision.visibility, statement).toBe('needs_you');
      // Referred, not destroyed: the reading is staged with its quote for a
      // person to file as a claim or as a commitment.
      expect(decision.reason, statement).toContain('undertaking');
    }
  });

  it('leaves the θ table alone below θ_auto, which the first implementation did not', () => {
    // The measurement that moved this rule out of the receipt: as a `refer`
    // severity it outranked θ, so a reading the table says to *discard* came
    // back `pending` and the whole band came back `receipt_not_certifiable`.
    const undertaking = UNDERTAKINGS[0] as string;
    const messages = room(undertaking);
    expect(decideAcceptance(claimOf(undertaking, 0.4999), { messages }).rule).toBe(
      'below_theta_min',
    );
    expect(decideAcceptance(claimOf(undertaking, 0.4999), { messages }).verdict).toBe('discard');
    expect(decideAcceptance(claimOf(undertaking, 0.6), { messages }).rule).toBe('theta_band');
    expect(decideAcceptance(claimOf(undertaking, 0.7), { messages }).rule).toBe(
      'type_not_certified',
    );
  });

  it('refuses the laundered commitment at the engine', () => {
    // **Split from the reducer half, and r7's ledger is why.** As one test
    // asserting only that no object landed, it passed under a mutation that
    // deleted the *engine* row — because the reducer twin still refused. A test
    // covering two enforcement points measures whichever one is left.
    const statement = 'We will deploy production Friday afternoon as planned.';
    expect(decideAcceptance(claimOf(statement), { messages: room(statement) }).rule).toBe(
      'type_not_certified',
    );
  });

  it('refuses the laundered commitment at the reducer, where it is a boundary', () => {
    // r5's lesson, run over r7's rule: the engine is advice and `appendEvent` is
    // the trust boundary. Both read `typeCertifiableFromText` over the same
    // text, so a proposal the engine refuses cannot be folded behind its back.
    const statement = 'We will deploy production Friday afternoon as planned.';
    const messages = room(statement);
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_1',
          roomId: ROOM,
          type: 'claim',
          payload: { statement, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: statement,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages,
        type: 'object_accepted',
        object: {
          id: 'obj_1',
          roomId: ROOM,
          type: 'claim',
          payload: { statement, claimant: BOB },
          provenance: { messageIds: ['m1'], proposalId: 'prop_1' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('undertaking');
  });

  it('names the residue rather than implying it is covered', () => {
    // **A commitment with no word of undertaking in it is certified as a
    // claim.** No lexical rule sees "I'm on it."; this one does not pretend to.
    // It renders as `~` with its quote, in nobody's Needs-you — the bounded,
    // visible failure the disposition is willing to keep, and it is written into
    // `COMMITMENT_SHAPES` too so nobody discovers it as a surprise.
    const statement = "I'm on it, starting the migration review right now.";
    expect(readsAsCommitment(normalizeForReceipt(statement))).toBe(false);
    expect(decideAcceptance(claimOf(statement), { messages: room(statement) }).verdict).toBe(
      'auto_accept',
    );
  });

  it('reads a value the proposer does not control — over the form the receipt proved', () => {
    // **This test was named after a false premise until r8, and it could not
    // have caught the defect the premise hides.** Its title was "reads a value
    // the proposer does not control, which is the round's rule", and its body
    // varied only `type` while holding `statement === quote === body`. The
    // receipt does not prove `statement === quote`. It proves
    // `normalizeForReceipt(quote) === normalizeForReceipt(statement)` — so the
    // proposer controls the statement freely *inside that equivalence class*,
    // and a test that never moves inside the class is asserting the premise
    // rather than testing it.
    //
    // So the loop below varies both axes: every type the proposal could pick,
    // and every statement in the equivalence class of the author's sentence.
    const body = 'We will deploy production Friday afternoon as planned.';
    const messages = room(body);

    /**
     * Statements the receipt cannot tell apart from `body`. Every one is
     * `normalizeForReceipt`-equal to it and byte-different from it, which is
     * exactly the freedom the certification argument did not account for.
     */
    const INSIDE_THE_CLASS = [
      body,
      // The zero-width space, spliced into the one word every shape reads.
      'We wi​ll deploy production Friday afternoon as planned.',
      'We ⁠will deploy production Friday afternoon as planned.',
      'We wil﻿l deploy production Friday afternoon as planned.',
      'We wi⁤ll deploy production Friday afternoon as planned.',
      // Whitespace runs and the ends, which the fold also forgives.
      '  We  will   deploy production Friday afternoon as planned.  ',
    ];

    for (const statement of INSIDE_THE_CLASS) {
      // The premise, asserted rather than assumed: the receipt really does
      // certify each of these against the author's message.
      expect(normalizeForReceipt(statement), statement).toBe(normalizeForReceipt(body));

      for (const type of ['claim', 'commitment', 'decision', 'objective'] as const) {
        const decision = decideAcceptance(
          ProposalSchema.parse({
            id: 'prop_any',
            roomId: ROOM,
            type,
            payload:
              type === 'claim'
                ? { statement, claimant: BOB }
                : type === 'commitment'
                  ? { statement, owner: BOB }
                  : type === 'decision'
                    ? { statement, decidedBy: BOB }
                    : { title: statement },
            confidence: 0.95,
            proposer: { kind: 'model', model: 'test-model' },
            provenance: ['m1'],
            quote: body,
            createdAt: at(1),
          }) as Proposal,
          { messages },
        );
        expect(decision.verdict, `${type} / ${JSON.stringify(statement)}`).not.toBe('auto_accept');
      }
    }
  });

  it('sees the same words through every difference the receipt forgives', () => {
    // The predicate itself, at the level the engine test above exercises it
    // through. `readsAsCommitment` takes `ReceiptText` since r8, so this loop
    // also documents what that brand buys: there is no way to write the r7 call
    // — `readsAsCommitment(statement)` on a raw string — that compiles.
    const shapes = [
      'We will deploy production Friday.',
      "I'll take the migration review.",
      'The team is going to rerun the backfill.',
      'We need to cut the release branch.',
    ];
    const splices = ['​', '⁠', '⁡', '⁢', '⁣', '⁤', '﻿'];
    for (const shape of shapes) {
      for (const splice of splices) {
        // Splice the invisible into every position in the sentence, not a
        // chosen one: "we picked the spot that works" is how a marker list
        // passes a test it does not survive.
        for (let cut = 1; cut < shape.length; cut++) {
          const poisoned = `${shape.slice(0, cut)}${splice}${shape.slice(cut)}`;
          expect(
            readsAsCommitment(normalizeForReceipt(poisoned)),
            `${JSON.stringify(poisoned)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('folds the typographic apostrophe, which needed no adversary at all', () => {
    // `"The vendor won’t support the legacy API…"` with U+2019 — what every
    // phone and every Slack autocorrect emits — auto-accepted at 0.95, because
    // `/\bwon't\b/i` is ASCII-only while the `'ll` entry beside it carried both
    // spellings. Nobody had to attack anything.
    const statement = 'The vendor won’t support the legacy API after the migration.';
    expect(readsAsCommitment(normalizeForReceipt(statement))).toBe(true);
    expect(decideAcceptance(claimOf(statement), { messages: room(statement) }).rule).toBe(
      'type_not_certified',
    );
  });

  it('reads the plain ways of undertaking something, not only the hedged ones', () => {
    // r8. Not one explicit performative was in `COMMITMENT_SHAPES`; every one of
    // these is the author's verbatim words and every one auto-accepted as a
    // claim at 0.95.
    const PERFORMATIVES = [
      'I promise the narrowing fix lands before the release goes out.',
      'I commit to landing the narrowing fix this week.',
      'I undertake to land the narrowing fix before Thursday.',
      'Consider the narrowing fix handled by me.',
      'Leave the narrowing fix with me.',
      'I got this one, nobody else needs to pick it up.',
      'Count on me for the narrowing fix and the release notes.',
      'I owe you the narrowing fix from last week.',
      'I am landing the narrowing fix right now.',
      'I deploy production on Friday.',
    ];
    for (const statement of PERFORMATIVES) {
      const decision = decideAcceptance(claimOf(statement), { messages: room(statement) });
      expect(decision.rule, statement).toBe('type_not_certified');
      expect(decision.verdict, statement).toBe('pending');
    }
  });

  it('stops firing on four sentences that undertake nothing', () => {
    // The other half of r8's finding, and the direction that costs the product
    // rather than the record: `must`, `need(s) to` and `have to` are deontic
    // necessity — a property of the world — and `going to` was matching a
    // participle. All four are ordinary claims and all four were referred.
    const NOT_UNDERTAKINGS = [
      'The migration must be run before the release branch is cut.',
      'The backfill needs to finish before the index rebuild starts.',
      'You have to be an admin to run the rollback from the runbook.',
      'Every deploy going to production is signed by CI.',
    ];
    for (const statement of NOT_UNDERTAKINGS) {
      const decision = decideAcceptance(claimOf(statement), { messages: room(statement) });
      expect(decision.rule, statement).toBe('auto_accept');
    }
    // …and the deontic sentences that *are* somebody taking something on still
    // refer, so this is a narrowing and not a deletion.
    for (const statement of [
      'We need to cut the release branch before the end of the quarter.',
      'Everyone must update their local schema before Thursday.',
    ]) {
      expect(
        decideAcceptance(claimOf(statement), { messages: room(statement) }).rule,
        statement,
      ).toBe('type_not_certified');
    }
  });
});
