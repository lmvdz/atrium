import { describe, expect, it } from 'vitest';
import {
  type AcceptanceRuleName,
  type AcceptanceVerdict,
  type AcceptanceVisibility,
  type AcceptedObjectType,
  answerBindingRefusal,
  applyAnswerBinding,
  bindAnswer,
  commitmentAttribution,
  DEFAULT_ACCEPTANCE_RULES,
  decideAcceptance,
  decideSupersession,
  defaultAcceptanceConfig,
  findDuplicate,
  MODEL_ACCEPTANCE_FLOOR,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  reduce,
  resolveAcceptanceConfig,
  serializeState,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM, sampleLog } from './fixtures.js';

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

/** Every sentence the fixtures quote, in one message. */
const BODY = [
  "I'll land the migration tomorrow.",
  'The migration is reversible.',
  'Reset narrowing on mutating method calls.',
  'Ship the narrowing fix.',
  'Do we keep the flag after launch?',
].join(' ');

/** ALICE wrote all of it, so a claim or commitment of ALICE's is self-stated. */
const aliceMessages: ProvenanceMessage[] = [{ id: 'msg_1', authorId: ALICE, body: BODY }];
/** …and the same words from BOB, which makes ALICE's the third party. */
const bobMessages: ProvenanceMessage[] = [{ id: 'msg_1', authorId: BOB, body: BODY }];

const QUOTE: Record<AcceptedObjectType, string> = {
  decision: 'Reset narrowing on mutating method calls.',
  commitment: "I'll land the migration tomorrow.",
  open_question: 'Do we keep the flag after launch?',
  claim: 'The migration is reversible.',
  objective: 'Ship the narrowing fix.',
};

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
      decision: { statement: 'Reset narrowing on mutating method calls' },
      commitment: { statement: 'Land the migration', owner: ALICE },
      open_question: { question: 'Do we keep the flag after launch?' },
      claim: { statement: 'The migration is reversible', claimant: ALICE },
      objective: { title: 'Ship the narrowing fix' },
    }[overrides.type] as Record<string, unknown>);

  return ProposalSchema.parse({
    id: 'prop_matrix',
    roomId: ROOM,
    type: overrides.type,
    payload,
    confidence: overrides.confidence,
    proposer: overrides.proposer ?? { kind: 'model', model: 'test-model' },
    provenance: ['msg_1'],
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

/** A confidence squarely inside each band, derived from the config not guessed. */
function confidenceFor(type: AcceptedObjectType, band: Cell['band']): number {
  const rule = DEFAULT_ACCEPTANCE_RULES[type];
  switch (band) {
    case 'below':
      return Math.max(0, rule.thetaMin - 0.1);
    case 'between':
      return (rule.thetaMin + rule.thetaAuto) / 2;
    case 'above':
      return rule.thetaAuto;
  }
}

const CELLS: Cell[] = [];
for (const type of ['claim', 'open_question', 'objective'] as const) {
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
    verdict: 'auto_accept',
    visibility: 'accepted',
    rule: 'auto_accept',
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

  it('covers all eighteen cells, so none can be quietly dropped', () => {
    const covered = new Set(
      CELLS.map((cell) => `${cell.type}:${cell.attribution ?? '-'}:${cell.band}`),
    );
    // 3 simple types × 3 bands + commitment 2 attributions × 3 bands + decision × 3
    expect(covered.size).toBe(3 * 3 + 2 * 3 + 3);
    // One extra row: decision at 1.0, pinning that "never" is not a threshold.
    expect(CELLS).toHaveLength(19);
  });

  it('reaches every rule name the type declares', () => {
    const reachable: AcceptanceRuleName[] = [
      'missing_message_context',
      'provenance_failed',
      'duplicate_of_accepted',
      'below_theta_min',
      'theta_band',
      'auto_accept',
      'never_auto_accepts',
      'third_party_commitment',
      'human_proposer',
    ];
    const seen = new Set<AcceptanceRuleName>(CELLS.map((cell) => cell.rule));
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
            text: 'The migration is reversible',
            messageIds: ['msg_1'],
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
    expect([...seen].sort()).toEqual([...reachable].sort());
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
      commitment: { thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true },
      open_question: { thetaAuto: 0.6, thetaMin: 0.4, autoAccept: true },
      claim: { thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true },
      objective: { thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true },
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

    expect(verdictAt('open_question', 0.35)).toBe('none');
    expect(verdictAt('open_question', 0.5)).toBe('quiet');
    expect(verdictAt('open_question', 0.65)).toBe('accepted');

    expect(verdictAt('commitment', 0.7)).toBe('quiet'); // still under 0.75
    expect(verdictAt('commitment', 0.8)).toBe('accepted');

    expect(verdictAt('objective', 0.7)).toBe('quiet');
    expect(verdictAt('objective', 0.8)).toBe('accepted');

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
      commitment: 0.75,
      open_question: 0.6,
      claim: 0.7,
      objective: 0.75,
    });
    for (const [type, rule] of Object.entries(DEFAULT_ACCEPTANCE_RULES)) {
      expect(MODEL_ACCEPTANCE_FLOOR[type as AcceptedObjectType]).toBe(
        rule.autoAccept ? rule.thetaAuto : Number.POSITIVE_INFINITY,
      );
    }
  });
});

describe('the θ boundaries are inclusive at θ_auto and exclusive at θ_min', () => {
  const context = { messages: aliceMessages };

  it('accepts exactly at θ_auto', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(
      decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaAuto }), context).verdict,
    ).toBe('auto_accept');
  });

  it('does not accept a hair under θ_auto', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    const decision = decideAcceptance(
      proposal({ type: 'claim', confidence: rule.thetaAuto - 0.0001 }),
      context,
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
  });

  it('keeps a proposal exactly at θ_min rather than discarding it', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(
      decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaMin }), context).verdict,
    ).toBe('pending');
  });

  it('discards a hair under θ_min', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(
      decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaMin - 0.0001 }), context)
        .verdict,
    ).toBe('discard');
  });
});

describe('provenance failure demotes below θ_min, whatever the confidence', () => {
  it('discards a 0.98-confidence claim whose receipt is wrong', () => {
    // The spike's worst output, routed through the engine.
    const decision = decideAcceptance(proposal({ type: 'claim', confidence: 0.98 }), {
      messages: [
        {
          id: 'msg_1',
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
    expect(commitmentAttribution(ALICE, ['msg_1'], aliceMessages, quote)).toBe('self');
  });

  it('is third-party when somebody else did', () => {
    expect(commitmentAttribution(ALICE, ['msg_1'], bobMessages, quote)).toBe('third_party');
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
      text: 'The migration is reversible',
      messageIds: ['msg_1'],
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
    expect(findDuplicate('claim', 'The migration is reversible', ['msg_9'], accepted)).toBeNull();
    // Same message, different words: also not a duplicate. One message carries
    // several readings, which is the ordinary case.
    expect(
      findDuplicate('claim', 'The rollback script is untested', ['msg_1'], accepted),
    ).toBeNull();
  });

  it('does not match across types', () => {
    expect(
      findDuplicate('open_question', 'The migration is reversible', ['msg_1'], accepted),
    ).toBeNull();
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
    expect(() => resolveAcceptanceConfig({ claim: { thetaAuto: 0.1, thetaMin: 0.05 } })).toThrow(
      /below the reducer's acceptance floor/,
    );
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
