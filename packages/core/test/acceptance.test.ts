import { describe, expect, it } from 'vitest';
import {
  type AcceptanceRuleName,
  type AcceptanceVerdict,
  type AcceptanceVisibility,
  type AcceptedObjectType,
  answerBindingRefusal,
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

/** Messages ALICE wrote, so a commitment owned by ALICE is self-stated. */
const aliceMessages: ProvenanceMessage[] = [
  { id: 'msg_1', authorId: ALICE, body: "I'll land the migration tomorrow." },
];
/** …and the same window with BOB as the author, making ALICE's the third party. */
const bobMessages: ProvenanceMessage[] = [
  { id: 'msg_1', authorId: BOB, body: 'Alice will land the migration tomorrow.' },
];

function proposal(overrides: {
  type: AcceptedObjectType;
  confidence: number;
  payload?: Record<string, unknown>;
  proposer?: Proposal['proposer'];
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
    rule: 'decision_never_auto',
  },
  {
    label: 'decision at confidence 1.0',
    type: 'decision',
    band: 'above',
    verdict: 'pending',
    visibility: 'needs_you',
    rule: 'decision_never_auto',
  },
);

describe('#4 acceptance matrix — one test per cell', () => {
  for (const cell of CELLS) {
    it(cell.label, () => {
      const confidence = cell.label.endsWith('confidence 1.0')
        ? 1
        : confidenceFor(cell.type, cell.band);
      // Attribution is only meaningful for commitments, and it is the message
      // window that decides it — so only commitment cells supply one. Handing a
      // claim a window whose author is not its claimant would be testing the
      // provenance check, which has its own tests.
      const messages =
        cell.attribution === undefined
          ? undefined
          : cell.attribution === 'self'
            ? aliceMessages
            : bobMessages;
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
      'provenance_failed',
      'duplicate_of_accepted',
      'below_theta_min',
      'theta_band',
      'auto_accept',
      'decision_never_auto',
      'third_party_commitment',
      'human_proposer',
    ];
    const seen = new Set<AcceptanceRuleName>(CELLS.map((cell) => cell.rule));
    seen.add(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), {
        messages: aliceMessages,
        provenanceProblems: [
          { kind: 'quote_not_found', severity: 'reject', detail: 'nope', messageId: null },
        ],
      }).rule,
    );
    seen.add(
      decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), {
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
      ).rule,
    );
    expect([...seen].sort()).toEqual([...reachable].sort());
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

  it('pins the reducer floor by value too', () => {
    expect(MODEL_ACCEPTANCE_FLOOR).toEqual({
      decision: Number.POSITIVE_INFINITY,
      commitment: 0.5,
      open_question: 0.4,
      claim: 0.5,
      objective: 0.5,
    });
  });
});

describe('the θ boundaries are inclusive at θ_auto and exclusive at θ_min', () => {
  it('accepts exactly at θ_auto', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaAuto })).verdict).toBe(
      'auto_accept',
    );
  });

  it('does not accept a hair under θ_auto', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    const decision = decideAcceptance(
      proposal({ type: 'claim', confidence: rule.thetaAuto - 0.0001 }),
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
  });

  it('keeps a proposal exactly at θ_min rather than discarding it', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaMin })).verdict).toBe(
      'pending',
    );
  });

  it('discards a hair under θ_min', () => {
    const rule = DEFAULT_ACCEPTANCE_RULES.claim;
    expect(
      decideAcceptance(proposal({ type: 'claim', confidence: rule.thetaMin - 0.0001 })).verdict,
    ).toBe('discard');
  });
});

describe('provenance failure demotes below θ_min, whatever the confidence', () => {
  it('discards a 0.98-confidence claim whose receipt is wrong', () => {
    // The spike's worst output, routed through the engine.
    const decision = decideAcceptance(proposal({ type: 'claim', confidence: 0.98 }), {
      messages: [{ id: 'msg_1', authorId: BOB, body: '> alice said a thing\n\nno she did not' }],
    });
    expect(decision.verdict).toBe('discard');
    expect(decision.rule).toBe('provenance_failed');
    expect(decision.reason).toContain('authored none of the cited messages');
  });
});

describe('commitmentAttribution — nobody gets committed by someone else’s sentence', () => {
  it('is self when the owner wrote a cited message', () => {
    expect(commitmentAttribution(ALICE, ['msg_1'], aliceMessages)).toBe('self');
  });

  it('is third-party when somebody else did', () => {
    expect(commitmentAttribution(ALICE, ['msg_1'], bobMessages)).toBe('third_party');
  });

  it('is third-party when the messages are not supplied at all', () => {
    // An unproven self-statement is a third-party statement. The safe direction
    // is asking the named person, and this is the direction that is safe.
    expect(commitmentAttribution(ALICE, ['msg_1'], undefined)).toBe('third_party');
    expect(commitmentAttribution(ALICE, ['msg_1'], [])).toBe('third_party');
  });

  it('does not count a message the proposal did not cite', () => {
    expect(commitmentAttribution(ALICE, ['msg_other'], aliceMessages)).toBe('third_party');
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
  it('accepts the defaults', () => {
    expect(() => resolveAcceptanceConfig()).not.toThrow();
    expect(defaultAcceptanceConfig.claim.thetaAuto).toBe(DEFAULT_ACCEPTANCE_RULES.claim.thetaAuto);
  });

  it('allows a stricter override', () => {
    const config = resolveAcceptanceConfig({ claim: { thetaAuto: 0.95, thetaMin: 0.8 } });
    expect(config.claim.thetaAuto).toBe(0.95);
    expect(decideAcceptance(proposal({ type: 'claim', confidence: 0.9 }), { config }).verdict).toBe(
      'pending',
    );
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

  it('is at least as strict as the reducer floor on every type', () => {
    // The floor gates decisions only. The engine may add rows and may never
    // remove one.
    expect(decideSupersession('decision').authority).toBe('requires_human');
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
    actor: human(),
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
    const bound = bindAnswer(withQuestion, command);
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
    const bound = bindAnswer(withQuestion, command);
    if (!bound.ok) throw new Error('unreachable');
    const state = reduce(bound.events, withQuestion);
    const answered = state.objects.obj_q_open?.object;
    expect(answered?.type === 'open_question' && answered.payload.status).toBe('answered');
  });

  it('is a pure function of the command — same input, byte-identical events', () => {
    const first = bindAnswer(withQuestion, command);
    const second = bindAnswer(withQuestion, { ...command });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // And folding it twice from the same base lands on the same bytes.
    if (!first.ok) throw new Error('unreachable');
    expect(serializeState(reduce(first.events, withQuestion))).toBe(
      serializeState(reduce(first.events, withQuestion)),
    );
  });

  it('refuses a model actor — binding is a person answering', () => {
    const refusal = answerBindingRefusal(withQuestion, { ...command, actor: model() });
    expect(refusal).toContain('only a human may bind an answer');
  });

  it('refuses a subject that is not an open question', () => {
    expect(
      answerBindingRefusal(withQuestion, { ...command, questionObjectId: 'obj_decision_2' }),
    ).toContain('not an open question');
  });

  it('refuses an unknown question, a retracted one, and a cross-room one', () => {
    expect(answerBindingRefusal(withQuestion, { ...command, questionObjectId: 'nope' })).toContain(
      'unknown open question',
    );
    expect(answerBindingRefusal(withQuestion, { ...command, roomId: 'room_other' })).toContain(
      'not "room_other"',
    );

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
    expect(answerBindingRefusal(retracted, command)).toContain('is retracted');
  });

  it('refuses to overwrite an existing object', () => {
    expect(
      answerBindingRefusal(withQuestion, {
        ...command,
        answer: { ...command.answer, objectId: 'obj_decision_1' },
      }),
    ).toContain('already exists');
  });

  it('leaves the base state untouched — it mints events, it does not apply them', () => {
    const before = serializeState(base);
    bindAnswer(withQuestion, command);
    expect(serializeState(base)).toBe(before);
  });
});
