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
  QUESTION_MARKS,
  RECEIPT_POLICY,
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

  it('refers a quote whose author put the inverter in their own blockquote', () => {
    // grok's blind pass, and this round's own defect class reappearing through
    // the helper built to prevent a different one. `stripReplyBlockquotes`
    // deletes every line beginning with `>` whether or not anybody else ever
    // wrote it — right for asking *who wrote the quote*, wrong for asking *what
    // surrounds it*. Coverage reads the body now.
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
        [{ id: 'msg_1', authorId: ALICE, body: `${STATEMENT}\n> Not.` }],
      ),
    ).toEqual(['quote_omits_surrounding_text']);
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

  it('does not delete a bidi override, which decides what the reader sees', () => {
    // The review's second pass, and it broke this file's own comment. The claim
    // was that dropping a format character "cannot map two texts a reader sees as
    // different onto one". A body of `Bob will \u202Eton\u202C deploy production
    // Friday.` **renders as** "Bob will not deploy production Friday." — deleting
    // the override normalized the source to `ton`, a quote of `ton` matched it,
    // and the record minted the affirmative of what its author visibly wrote.
    const rendered = 'Bob will \u202Eton\u202C deploy production Friday.';
    const bytes = 'Bob will ton deploy production Friday.';
    expect(normalizeForReceipt(rendered)).not.toBe(normalizeForReceipt(bytes));
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: bytes,
          statement: bytes,
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        [{ id: 'msg_1', authorId: BOB, body: rendered }],
      ),
    ).not.toEqual([]);
    // …and a character that really does render as nothing is still dropped, so
    // r3's finding stays closed.
    expect(normalizeForReceipt('ship\u200B it')).toBe('ship it');
  });

  it('does not delete a character that renders as something', () => {
    // The third pass, on the second pass's repair. Subtracting the bidi set from
    // `\p{Cf}` was a denylist of the exceptions somebody had thought of, and the
    // next reviewer produced two more: a soft hyphen renders as a hyphen at a
    // line break (`re-sign` is not `resign`), and a zero-width joiner decides
    // whether two emoji are one glyph.
    expect(normalizeForReceipt('re\u00ADsign the agreement')).not.toBe(
      normalizeForReceipt('resign the agreement'),
    );
    expect(normalizeForReceipt('\u{1F469}\u200D\u{1F4BB}')).not.toBe(
      normalizeForReceipt('\u{1F469}\u{1F4BB}'),
    );
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

  it('refuses to certify when a later message takes something back in other words', () => {
    // **This round's own blind cross-lineage review, on this round's own fix.**
    // The structural test only sees a correction that reuses the sentence, and
    // codex produced the one it does not: "Correction: the deployment is
    // cancelled." shares not one content token with "We will deploy production
    // Friday." (`deploy` and `deployment` are different tokens), aligns with
    // nothing, and auto-accepted.
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
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          { id: 'msg_2', authorId: ALICE, body: 'Correction: the deployment is cancelled.' },
        ],
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('cannot be skipped by padding the citation list', () => {
    // The review's second pass. The scan used to start after the *last* cited
    // message, so citing the message that carries the sentence **and** an
    // unrelated later one put the correction behind the scan's start. Padding a
    // citation list to move a boundary is r1's attribution attack, one guard over.
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1', 'msg_3'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          {
            id: 'msg_2',
            authorId: ALICE,
            body: 'Correction: we will not deploy production Friday.',
          },
          { id: 'msg_3', authorId: BOB, body: 'The staging cluster is green.' },
        ],
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('cannot be skipped by citing the correction itself', () => {
    // The repair for the padding attack filtered cited messages out of the scan,
    // and the next pass used *that*: put the correction in a message the proposal
    // cites. A citation is chosen by the proposal, so anything it can exclude is
    // a boundary the proposal controls.
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1', 'msg_2'],
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          {
            id: 'msg_2',
            authorId: ALICE,
            body: 'Correction: we will not deploy production Friday.',
          },
        ],
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('refuses to certify when a later message drops a word from the sentence', () => {
    // The mirror image of the addition case, and the r3 inversion run backwards:
    // the quote says "not", the later message does not, and the earlier reading
    // is the one being certified.
    const negated = 'We will not deploy production Friday.';
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: negated,
          statement: negated,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [
          { id: 'msg_1', authorId: ALICE, body: negated },
          { id: 'msg_2', authorId: ALICE, body: 'We will deploy production Friday.' },
        ],
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('does not fire on the conversational half of the concession list', () => {
    // The marker list acceptance reads is the subset that *performs* a
    // withdrawal. "Good point" concedes something and retracts nothing, and it
    // appears in ordinary technical prose — referring on it would cost a person
    // a glance for nothing.
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
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          { id: 'msg_2', authorId: BOB, body: 'Good point, that lines up with the release plan.' },
        ],
      ),
    ).toEqual([]);
  });

  it('refuses when the window is longer than the scan will read', () => {
    // The audit's second find, and it was in this round's own first draft: the
    // scan stopped at `maxLaterMessagesScanned` and returned "nothing found",
    // defended by a comment saying a miss was the safe direction. A limit in a
    // comment with an auto-accept under it is the exact shape r4 was failed for.
    const many: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: ALICE, body: STATEMENT },
      ...Array.from({ length: RECEIPT_POLICY.maxLaterMessagesScanned + 1 }, (_, i) => ({
        id: `pad_${i}`,
        authorId: ALICE,
        body: `Unrelated note ${i} about the build.`,
      })),
      { id: 'msg_z', authorId: ALICE, body: 'Correction: we will not deploy production Friday.' },
    ];
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
        many,
      ),
    ).toEqual(['superseded_by_later_message']);
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

  it('reads every spelling of a question mark, not only the ASCII one', () => {
    // This round's own blind cross-lineage review. Dropping NFKC from the
    // receipt fold was right — it made distinct hostnames compare equal — and it
    // left this check reading one spelling of a mark that has several. `？`
    // (U+FF1F) is a distinct token, and the claim auto-accepted.
    // Driven from the exported inventory, so a mark added to the source without
    // a case here is not possible, and one removed from it fails.
    for (const mark of [...QUESTION_MARKS, '？', '﹖']) {
      const body = `Would we deploy production Friday${mark}`;
      expect(
        kinds(
          {
            type: 'claim',
            provenance: ['msg_1'],
            quote: body,
            statement: body,
            proposer: { kind: 'model' },
            attributedTo: ALICE,
          },
          [{ id: 'msg_1', authorId: ALICE, body }],
        ),
      ).toContain('statement_is_not_an_assertion');
    }
  });

  it('reads a mark a canonical decomposition would destroy', () => {
    // U+037E GREEK QUESTION MARK decomposes to an ASCII semicolon, so a check
    // that normalized first would see punctuation and call it an assertion. The
    // mutation ledger is what surfaced this: the row deleting the fold *escaped*,
    // because by then the enumerated inventory made the fold redundant — and a
    // second mechanism no input can distinguish is one to delete, not to keep.
    const body = 'Would we deploy production Friday\u037E';
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: body,
          statement: body,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        [{ id: 'msg_1', authorId: ALICE, body }],
      ),
    ).toContain('statement_is_not_an_assertion');
  });

  it('reads a mark that opens the sentence instead of closing it', () => {
    // The review's second pass, after its first pass found the fullwidth form:
    // a Spanish interrogative opens with `¿` and need carry no other mark.
    const body = '¿Bob will deploy production Friday';
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: body,
          statement: body,
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        [{ id: 'msg_1', authorId: BOB, body }],
      ),
    ).toContain('statement_is_not_an_assertion');
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

describe('r5 — a code span is compared byte for byte', () => {
  it('does not collapse whitespace inside a code literal', () => {
    // This round's own blind review, on this round's own allowlist. Every entry
    // in it is an argument about prose, and the whitespace one was being carried
    // into a literal: two spaces in a sentence are a line wrap, two spaces in a
    // password are a different password.
    expect(normalizeForReceipt('Set the password to `a  b` today.')).not.toBe(
      normalizeForReceipt('Set the password to `a b` today.'),
    );
    // …and prose either side of the literal still folds.
    expect(normalizeForReceipt('Set   the password to `a  b`   today.')).toBe(
      normalizeForReceipt('Set the password to `a  b` today.'),
    );
  });
});

describe('r5 — a detected fault is not weakness', () => {
  it('does not let deduplication destroy a discrepancy nobody has seen', () => {
    // This round's own blind review. The referral was moved above θ_min so a
    // detected discrepancy is never destroyed for being low-confidence — and
    // `findDuplicate` was still upstream of it, destroying the same discrepancy
    // for a different reason.
    const messages: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: BOB, body: 'Bob will not deploy production Friday.' },
    ];
    const staged = modelProposal({
      type: 'claim',
      payload: { statement: 'Bob will deploy production Friday.', claimant: BOB },
      quote: 'Bob will not deploy production Friday.',
    });
    const withoutRoom = decideAcceptance(staged, { messages });
    const withRoom = decideAcceptance(staged, {
      messages,
      acceptedObjects: [
        {
          objectId: 'obj_old',
          type: 'claim',
          text: 'Bob will deploy production Friday.',
          messageIds: ['msg_1'],
        },
      ],
    });
    expect(withoutRoom.rule).toBe('receipt_not_certifiable');
    expect(withRoom.rule).toBe('receipt_not_certifiable');
  });

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

  it('counts a flag as content, which is not a pictograph', () => {
    // The review's second pass. 🇺🇸 is two regional-indicator letters and matches
    // `\p{Extended_Pictographic}` nowhere, so the first draft of the emoji fix
    // still called a flag-only message nothing.
    expect(hasContent('🇺🇸')).toBe(true);
    expect(hasContent('🇺🇸🇯🇵')).toBe(true);
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
