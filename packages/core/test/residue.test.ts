import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectType,
  decideAcceptance,
  findDuplicate,
  hasContent,
  normalizeForReceipt,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  type ProvenanceProblemKind,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, ROOM } from './fixtures.js';

/**
 * Round 5: the residue.
 *
 * Every test in this file is an input that lands inside a limitation round 4
 * documented in its own prose and then auto-accepted or silently discarded
 * anyway. The file exists because writing a limit down changes nothing about
 * what the program does with an input that falls inside it.
 *
 * Each test names the round-4 sentence it falsifies.
 */

const kinds = (...args: Parameters<typeof validateProposalProvenance>): ProvenanceProblemKind[] =>
  validateProposalProvenance(...args)
    .map((problem) => problem.kind)
    .sort();

function modelProposal(overrides: {
  type: AcceptedObjectType;
  payload: Record<string, unknown>;
  quote: string;
  provenance?: string[];
  confidence?: number;
}): Proposal {
  return ProposalSchema.parse({
    id: 'prop_r5',
    roomId: ROOM,
    type: overrides.type,
    payload: overrides.payload,
    confidence: overrides.confidence ?? 0.95,
    proposer: { kind: 'model', model: 'test-model' },
    provenance: overrides.provenance ?? ['msg_1'],
    quote: overrides.quote,
    createdAt: at(1),
  }) as Proposal;
}

describe('r5 — polarity in a neighbouring sentence', () => {
  // escalation.ts:533 — "polarity that lives in a different sentence ('I will
  // deploy Friday. Not.') is not visible to this and is not visible to any span
  // rule". True, and the code auto-accepted it anyway.
  const messages: ProvenanceMessage[] = [
    { id: 'msg_1', authorId: ALICE, body: 'We will deploy production Friday. Not.' },
  ];
  const STATEMENT = 'We will deploy production Friday.';

  it('does not certify a quote whose message carries a trailing inverter', () => {
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).toEqual(['quote_omits_surrounding_text']);
  });

  it('does not auto-accept it at the engine either', () => {
    const decision = decideAcceptance(
      modelProposal({
        type: 'claim',
        payload: { statement: STATEMENT, claimant: ALICE },
        quote: STATEMENT,
      }),
      { messages },
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.rule).toBe('receipt_not_certifiable');
  });

  it('certifies the same sentence when it is the whole of what the author wrote', () => {
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [{ id: 'msg_1', authorId: ALICE, body: 'We will deploy production Friday.' }],
      ),
    ).toEqual([]);
  });

  it('refers every other way a neighbouring sentence changes the force', () => {
    // The generalisation: the rule is not a list of inverters, so each of these
    // is refused by the same clause rather than by an entry someone added.
    for (const tail of [
      'Not.',
      'Unless CI is red.',
      'Or maybe not.',
      'I was going to, anyway.',
      'Instead we will wait for Monday.',
      'Right?',
      'Correction: we will not.',
      'Just kidding.',
      'That was wrong.',
    ]) {
      expect(
        kinds(
          {
            type: 'claim',
            provenance: ['msg_1'],
            quote: STATEMENT,
            statement: STATEMENT,
            proposer: { kind: 'model' },
            attributedTo: ALICE,
          },
          [{ id: 'msg_1', authorId: ALICE, body: `${STATEMENT} ${tail}` }],
        ),
      ).toEqual(['quote_omits_surrounding_text']);
    }
  });

  it('refers a leading sentence too — the scissors cut both ways', () => {
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [{ id: 'msg_1', authorId: ALICE, body: `Hypothetically. ${STATEMENT}` }],
      ),
    ).toEqual(['quote_omits_surrounding_text']);
  });
});

describe('r5 — normalization may not do semantic damage', () => {
  it('does not certify an inline code sample as its author"s assertion', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: ALICE, body: '`Deploy production Friday.`' },
    ];
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: 'Deploy production Friday.',
          statement: 'Deploy production Friday.',
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).not.toEqual([]);
  });

  it('does not certify a fenced code block as its author"s assertion', () => {
    const messages: ProvenanceMessage[] = [
      {
        id: 'msg_1',
        authorId: ALICE,
        body: '```\nDeploy production Friday.\n```',
      },
    ];
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: '```\nDeploy production Friday.\n```',
          statement: 'Deploy production Friday.',
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).not.toEqual([]);
  });

  it('does not let a markdown link"s destination vanish', () => {
    // The security one: the accepted statement names the safe URL while the
    // record's actionable link points somewhere else.
    const messages: ProvenanceMessage[] = [
      {
        id: 'msg_1',
        authorId: ALICE,
        body: 'Use [https://safe.example/app](https://evil.example/app) today.',
      },
    ];
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: 'Use https://safe.example/app today.',
          statement: 'Use https://safe.example/app today.',
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).not.toEqual([]);
  });

  it('does not fold distinct identifiers onto each other', () => {
    // NFKC maps the fullwidth and compatibility forms onto ASCII, so two
    // different hostnames, two different identifiers, compare equal.
    expect(normalizeForReceipt('https://ｅｖｉｌ.example/app')).not.toBe(
      normalizeForReceipt('https://evil.example/app'),
    );
    expect(normalizeForReceipt('ﬁle_handle')).not.toBe(normalizeForReceipt('file_handle'));
  });
});

describe('r5 — a later correction is part of the receipt', () => {
  const messages: ProvenanceMessage[] = [
    { id: 'msg_1', authorId: ALICE, body: 'We will deploy production Friday.' },
    { id: 'msg_2', authorId: ALICE, body: 'Correction: we will not deploy production Friday.' },
  ];
  const STATEMENT = 'We will deploy production Friday.';

  it('refuses to certify a sentence a later message in the window corrects', () => {
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('does not auto-accept it at the engine', () => {
    const decision = decideAcceptance(
      modelProposal({
        type: 'claim',
        payload: { statement: STATEMENT, claimant: ALICE },
        quote: STATEMENT,
      }),
      { messages },
    );
    expect(decision.rule).toBe('receipt_not_certifiable');
  });

  it('leaves an unrelated later message alone', () => {
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [
          messages[0] as ProvenanceMessage,
          { id: 'msg_2', authorId: BOB, body: 'The staging cluster is green.' },
        ],
      ),
    ).toEqual([]);
  });
});

describe('r5 — speech-act fitness', () => {
  it('does not mint a question as a claim', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: ALICE, body: 'Would we deploy production Friday?' },
    ];
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: 'Would we deploy production Friday?',
          statement: 'Would we deploy production Friday?',
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).toEqual(['statement_is_not_an_assertion']);
  });

  it('mints the same sentence as an open question', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: ALICE, body: 'Would we deploy production Friday?' },
    ];
    expect(
      kinds(
        {
          type: 'open_question',
          provenance: ['msg_1'],
          quote: 'Would we deploy production Friday?',
          statement: 'Would we deploy production Friday?',
          proposer: { kind: 'model' },
        },
        messages,
      ),
    ).toEqual([]);
  });
});

describe('r5 — a detected fault is not weakness', () => {
  it('refers an inverted receipt that sits below theta_min', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: BOB, body: 'Bob will not deploy production Friday.' },
    ];
    const decision = decideAcceptance(
      modelProposal({
        type: 'claim',
        payload: { statement: 'Bob will deploy production Friday.', claimant: BOB },
        quote: 'Bob will not deploy production Friday.',
        confidence: 0.4999,
      }),
      { messages },
    );
    expect(decision.rule).toBe('receipt_not_certifiable');
    expect(decision.verdict).toBe('pending');
  });

  it('still discards a weak reading whose receipt is clean', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: BOB, body: 'Bob will deploy production Friday.' },
    ];
    const decision = decideAcceptance(
      modelProposal({
        type: 'claim',
        payload: { statement: 'Bob will deploy production Friday.', claimant: BOB },
        quote: 'Bob will deploy production Friday.',
        confidence: 0.4999,
      }),
      { messages },
    );
    expect(decision.rule).toBe('below_theta_min');
    expect(decision.verdict).toBe('discard');
  });
});

describe('r5 — an emoji is content', () => {
  it('counts an emoji-only message as having something in it', () => {
    expect(hasContent('🚫🚫🚫')).toBe(true);
  });

  it('does not disguise an emoji-only quote as a blank one', () => {
    const parsed = ProposalSchema.safeParse({
      id: 'prop_r5',
      roomId: ROOM,
      type: 'claim',
      payload: { statement: '🚫🚫🚫', claimant: ALICE },
      confidence: 0.9,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_1'],
      quote: '🚫🚫🚫',
      createdAt: at(1),
    });
    expect(parsed.success).toBe(true);
  });

  it('still calls punctuation and invisible characters absence', () => {
    expect(hasContent('…')).toBe(false);
    expect(hasContent('​')).toBe(false);
  });
});

describe('r5 — a model may not mint an obligation with a name on it', () => {
  it('refuses a model-accepted third-party commitment at the floor', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: BOB, body: 'Bob will deploy production Friday.' },
    ];
    const decision = decideAcceptance(
      modelProposal({
        type: 'commitment',
        payload: { statement: 'Bob will deploy production Friday.', owner: BOB },
        quote: 'Bob will deploy production Friday.',
      }),
      { messages },
    );
    expect(decision.verdict).not.toBe('auto_accept');
  });

  it('refuses a model-accepted objective too', () => {
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: BOB, body: 'Ship the narrowing fix this quarter.' },
    ];
    const decision = decideAcceptance(
      modelProposal({
        type: 'objective',
        payload: { title: 'Ship the narrowing fix this quarter.' },
        quote: 'Ship the narrowing fix this quarter.',
      }),
      { messages },
    );
    expect(decision.verdict).not.toBe('auto_accept');
  });
});

describe('r5 — the audit"s own find: a contradiction is not a duplicate', () => {
  /**
   * Not on any reviewer's list. It came out of the sweep this round was asked to
   * run first: for every documented limitation, what does the code do with an
   * input inside it? `escalation.ts` says of its stopword table, in bold, that it
   * "has not decided whether a reading becomes a fact since r4, and it must never
   * do so again" — and `findDuplicate` still scored similarity over it, while
   * *discarding* what it matched.
   */
  const accepted = [
    {
      objectId: 'obj_1',
      type: 'claim' as const,
      text: 'The migration is reversible',
      messageIds: ['msg_1'],
    },
    {
      objectId: 'obj_2',
      type: 'claim' as const,
      text: 'All services restart cleanly',
      messageIds: ['msg_1'],
    },
  ];

  it('does not discard the negation of an accepted claim as a re-proposal of it', () => {
    expect(
      findDuplicate('claim', 'The migration is not reversible', ['msg_1'], accepted),
    ).toBeNull();
  });

  it('does not discard a quantifier substitution either', () => {
    expect(findDuplicate('claim', 'Some services restart cleanly', ['msg_1'], accepted)).toBeNull();
  });
});
