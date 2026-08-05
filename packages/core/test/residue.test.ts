import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectRef,
  type AcceptedObjectType,
  decideAcceptance,
  findDuplicate,
  hasContent,
  isAboutTheWindow,
  isAssertion,
  laterRevision,
  normalizeForReceipt,
  normalizeForRouting,
  orderedTokens,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  type ProvenanceProblemKind,
  QUESTION_MARKS,
  QUESTION_SHAPED_MARKS,
  RECEIPT_POLICY,
  type ReceiptPolicy,
  readsAsQuestion,
  statementBearing,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, ROOM, room } from './fixtures.js';

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
  const messages: ProvenanceMessage[] = room({
    id: 'msg_1',
    authorId: ALICE,
    body: 'We will deploy production Friday. Not.',
  });
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
        room({ id: 'msg_1', authorId: ALICE, body: 'We will deploy production Friday.' }),
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
          room({ id: 'msg_1', authorId: ALICE, body: `${STATEMENT} ${tail}` }),
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
        room({ id: 'msg_1', authorId: ALICE, body: `${STATEMENT}\n> Not.` }),
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
        room({ id: 'msg_1', authorId: ALICE, body: `Hypothetically. ${STATEMENT}` }),
      ),
    ).toEqual(['quote_omits_surrounding_text']);
  });
});

describe('r5 — normalization may not do semantic damage', () => {
  it('does not certify an inline code sample as its author"s assertion', () => {
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: ALICE,
      body: '`Deploy production Friday.`',
    });
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: ALICE,
      body: '```\nDeploy production Friday.\n```',
    });
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: ALICE,
      body: 'Use [https://safe.example/app](https://evil.example/app) today.',
    });
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
        room({ id: 'msg_1', authorId: BOB, body: rendered }),
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

  // **Sharded by plane, r7.** The sweep below is the third full-range brute
  // force in this package, and at 2849 ms it was the next one to cross vitest's
  // 5000 ms default on a slower box — the two that already had are why
  // `vitest.config.ts` now declares a budget. Seventeen shards cover
  // 0…0x10FFFF exactly; the assertion that follows them is the original one,
  // over the union, and it fails loudly if a shard did not run.
  const PLANES = Array.from({ length: 17 }, (_, plane) => plane);
  const deletedByPlane = new Map<number, number[]>();
  /** What each shard actually swept — counted inside the loop, not re-derived. */
  const sweptPerPlane = new Map<number, number>();

  it.each(PLANES)('collects every code point the fold deletes in plane %i', (plane) => {
    const found: number[] = [];
    const start = plane * 0x10000;
    let swept = 0;
    for (let cp = start; cp < start + 0x10000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      // `x` and `y` are ordinary letters, so anything deleted between them fuses.
      if (normalizeForReceipt(`x${String.fromCodePoint(cp)}y`) === 'xy') found.push(cp);
      swept += 1;
    }
    sweptPerPlane.set(plane, swept);
    deletedByPlane.set(plane, found);
  });

  it('deletes exactly this set of code points, and fuses two words with none of them', () => {
    // **r6, and the test it replaces is the reason the defect survived r5.** It
    // was titled "does not fuse two words by deleting the tab between them" and
    // it exercised `\t` — the one control character JavaScript's `\s` actually
    // contains. The rule it was pinning is *no deletion may fuse two words*, and
    // the fold deleted U+0000–U+0008, U+000E–U+001F, U+007F and U+0080–U+009F,
    // every one of which fused. U+0085 NEL is the sharpest: the docblock named it
    // as a member of `\s` and it is not one — it is `Cc`, it is not a
    // LineTerminator, and it is a Unicode **mandatory** line break, so deleting
    // it changes what a reader sees. A comment asserting a property of the
    // language is a factual claim, so this test measures instead of arguing.
    // Every shard ran, and their union is the sweep the unsharded loop did —
    // counted by the shards rather than re-derived from the array, so a plane
    // that did not run fails here instead of passing arithmetic.
    expect(deletedByPlane.size).toBe(PLANES.length);
    expect([...sweptPerPlane.values()].reduce((total, count) => total + count, 0)).toBe(1_112_064);
    const deleted = PLANES.flatMap((plane) => deletedByPlane.get(plane) ?? []).sort(
      (a, b) => a - b,
    );
    // The whole set, written out — the enumeration `matching.ts` says it is.
    expect(deleted.map((cp) => cp.toString(16).toUpperCase().padStart(4, '0'))).toEqual([
      '200B', // ZERO WIDTH SPACE
      '2060', // WORD JOINER
      '2061', // FUNCTION APPLICATION
      '2062', // INVISIBLE TIMES
      '2063', // INVISIBLE SEPARATOR
      '2064', // INVISIBLE PLUS
      'FEFF', // ZERO WIDTH NO-BREAK SPACE
    ]);

    // …and the whitespace rule reads `\p{White_Space}`, which is where the two
    // sets differ: every one of these separates its neighbours rather than
    // joining them, NEL included.
    for (const space of ['\t', '\n', '\v', '\f', '\r', '\u0085', '\u2028', '\u2029', '\u00A0']) {
      expect(
        normalizeForReceipt(`Bob will deploy${space}production Friday.`),
        `${JSON.stringify(space)} must collapse to a space, not vanish`,
      ).toBe('Bob will deploy production Friday.');
    }

    // …and a control that is *not* whitespace is content, so it neither fuses
    // nor disappears: a quote of the fused text does not match the message.
    for (const control of ['\u0001', '\u0008', '\u001F', '\u007F', '\u0080', '\u009F']) {
      expect(
        kinds(
          {
            type: 'claim',
            provenance: ['msg_1'],
            quote: 'Bob will deployproduction Friday.',
            statement: 'Bob will deployproduction Friday.',
            proposer: { kind: 'model' },
            attributedTo: BOB,
          },
          room({
            id: 'msg_1',
            authorId: BOB,
            body: `Bob will deploy${control}production Friday.`,
          }),
        ),
        `${JSON.stringify(control)} must not fuse two words`,
      ).not.toEqual([]);
    }
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
  const messages: ProvenanceMessage[] = room(
    { id: 'msg_1', authorId: ALICE, body: 'We will deploy production Friday.' },
    { id: 'msg_2', authorId: ALICE, body: 'Correction: we will not deploy production Friday.' },
  );
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
        // The window runs past the last citation, and r6's own cross-lineage
        // pass is why: the gate that refuses a window ending at the citations
        // reports the same problem kind, so without a message after `msg_3` this
        // test passed under the mutation it exists to catch.
        room(
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          {
            id: 'msg_2',
            authorId: ALICE,
            body: 'Correction: we will not deploy production Friday.',
          },
          { id: 'msg_3', authorId: BOB, body: 'The staging cluster is green.' },
        ),
      ),
    ).toEqual(['superseded_by_later_message']);
  });

  it('cannot be skipped by citing the correction itself', () => {
    // The repair for the padding attack filtered cited messages out of the scan,
    // and the next pass used *that*: put the correction in a message the proposal
    // cites. A citation is chosen by the proposal, so anything it can exclude is
    // a boundary the proposal controls.
    //
    // **The window carries an uncited message, and r6's ledger is why.** With a
    // window of exactly the two cited messages the round's new rule fires first —
    // a window the proposal chose is not a window — and the reported kind is the
    // same, so `later_scan_skips_cited_messages` escaped: this test refused for
    // a reason that had nothing to do with the rule in its title. Two rules
    // reporting one kind need a fixture that separates them.
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
        room(
          { id: 'msg_1', authorId: ALICE, body: STATEMENT },
          {
            id: 'msg_2',
            authorId: ALICE,
            body: 'Correction: we will not deploy production Friday.',
          },
        ),
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: ALICE,
      body: 'Would we deploy production Friday?',
    });
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

  /**
   * **The completeness instrument, r8 — and the one it replaces is the finding.**
   *
   * What stood here was a hand-written `MARKS_FOUND_BY_REVIEW` list plus an
   * assertion that `QUESTION_MARKS` was a subset of it. Two hand lists, each
   * maintained from the other, and the docblock above them said out loud that
   * this was the "regression half" and the "coverage half". Neither half could
   * see a mark that was in *neither* list, which is every mark r8's review
   * found: the ornaments, the Coptic pair, the medieval mark, the inverted
   * interrobang, the Adlam mark. The source called its list "Unicode's own
   * inventory"; this test asserted it against a copy of itself; and *"Would we
   * deploy production Friday❓"* minted as a claim auto-accepted.
   *
   * Unicode publishes no `Question_Mark` property, so completeness cannot be
   * derived outright. What it *does* publish is `Sentence_Terminal`: every mark
   * that ends a sentence in any script. Partitioning that into "a question mark"
   * and "explicitly not one" is a total classification a machine can check — and
   * any code point Unicode adds to it lands in neither half and fails this test
   * until a person classifies it. That is the property two hand lists cannot
   * have, however carefully either is maintained.
   *
   * It does not reach the marks outside `Sentence_Terminal` — `¿`, `՞`, `;` and
   * the ornaments — so those are exercised one at a time below, and
   * `matching.ts` says so rather than implying the sweep covers them.
   */
  const NOT_A_QUESTION_MARK = new Set([
    // Full stops, in every script that has one.
    0x2e, 0x589, 0x6d4, 0x700, 0x701, 0x702, 0x7f9, 0x837, 0x839, 0x83d, 0x83e, 0x964, 0x965,
    0x104a, 0x104b, 0x1362, 0x1368, 0x166e, 0x1735, 0x1736, 0x17d4, 0x17d5, 0x1803, 0x1809, 0x1aa8,
    0x1aa9, 0x1aaa, 0x1aab, 0x1b4e, 0x1b4f, 0x1b5a, 0x1b5b, 0x1b5e, 0x1b5f, 0x1b7d, 0x1b7e, 0x1b7f,
    0x1c3b, 0x1c3c, 0x1c7e, 0x1c7f, 0x2024, 0x2cf9, 0x2e3c, 0x3002, 0xa4ff, 0xa60e, 0xa6f3, 0xa876,
    0xa877, 0xa8ce, 0xa8cf, 0xa92f, 0xa9c8, 0xa9c9, 0xaaf0, 0xaaf1, 0xabeb, 0xfe12, 0xfe52, 0xff0e,
    0xff61, 0x10a56, 0x10a57, 0x10f55, 0x10f56, 0x10f57, 0x10f58, 0x10f59, 0x10f86, 0x10f87,
    0x10f88, 0x10f89, 0x11047, 0x11048, 0x110be, 0x110bf, 0x110c0, 0x110c1, 0x11141, 0x11142,
    0x111c5, 0x111c6, 0x111cd, 0x111de, 0x111df, 0x11238, 0x11239, 0x1123b, 0x1123c, 0x112a9,
    0x113d4, 0x113d5, 0x1144b, 0x1144c, 0x115c2, 0x115c3, 0x115c9, 0x115ca, 0x115cb, 0x115cc,
    0x115cd, 0x115ce, 0x115cf, 0x115d0, 0x115d1, 0x115d2, 0x115d3, 0x115d4, 0x115d5, 0x115d6,
    0x115d7, 0x11641, 0x11642, 0x1173c, 0x1173d, 0x1173e, 0x11944, 0x11946, 0x11a42, 0x11a43,
    0x11a9b, 0x11a9c, 0x11c41, 0x11c42, 0x11ef7, 0x11ef8, 0x11f43, 0x11f44, 0x16a6e, 0x16a6f,
    0x16af5, 0x16b37, 0x16b38, 0x16b44, 0x16d6e, 0x16d6f, 0x16e98, 0x1bc9f, 0x1da88,
    // Exclamation marks and their script variants.
    0x21, 0x61d, 0x61e, 0x1944, 0x203c, 0x2e53, 0xfe15, 0xfe57, 0xff01,
    // The Cham danda and its double and triple forms. r7 listed U+AA5D as "CHAM
    // QUESTION MARK"; it sits between the spiral and the double danda, and a
    // question mark does not come in a triple form. Classified as a full stop
    // here and carried in `QUESTION_SHAPED_MARKS` — see that constant for why an
    // unverifiable mark refuses without certifying.
    0xaa5d, 0xaa5e, 0xaa5f,
  ]);

  it('classifies every sentence terminator Unicode publishes', () => {
    const strict = new Set(QUESTION_MARKS.map((mark) => mark.codePointAt(0)));
    const unclassified: string[] = [];
    const both: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (!/\p{Sentence_Terminal}/u.test(String.fromCodePoint(cp))) continue;
      const name = `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(cp)}`;
      const isQuestion = strict.has(cp);
      const isNot = NOT_A_QUESTION_MARK.has(cp);
      if (!isQuestion && !isNot) unclassified.push(name);
      if (isQuestion && isNot) both.push(name);
    }
    // A sentence terminator in neither half is a mark nobody has looked at, and
    // which half it belongs in decides whether a question auto-accepts as a
    // claim. So this fails rather than guessing, and that is the whole
    // difference from the pair of hand lists it replaces.
    expect(unclassified, 'sentence terminators classified as neither').toEqual([]);
    expect(both, 'sentence terminators classified as both').toEqual([]);
  });

  it('matches exactly the marks it enumerates, and no others', () => {
    // The `DELETABLE` instrument, turned on this list: a malformed character
    // class — a stray `-` forming a range, a lone surrogate — would silently
    // widen or narrow the regex while the enumeration above still read
    // correctly.
    const strict = new Set(QUESTION_MARKS);
    const shaped = new Set(QUESTION_SHAPED_MARKS);
    const strayStrict: string[] = [];
    const strayShaped: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const character = normalizeForReceipt(String.fromCodePoint(cp));
      const name = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      if (readsAsQuestion(character) !== strict.has(String.fromCodePoint(cp))) {
        strayStrict.push(name);
      }
      if (isAssertion(character) === shaped.has(String.fromCodePoint(cp))) strayShaped.push(name);
    }
    expect(strayStrict).toEqual([]);
    expect(strayShaped).toEqual([]);
  });

  it('refuses an ornament question mark minted as a claim — r5’s defect, reopened', () => {
    // `❓` (U+2753) is what a phone keyboard and every chat client emit, and it
    // was in neither the source list nor the test list that pinned the source
    // list, so this exact input auto-accepted somebody's question as their
    // position. Both directions: minted as a claim it is refused, and minted as
    // the open question it actually is, it is not.
    const body = 'Would we deploy production Friday❓';
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
        room({ id: 'msg_1', authorId: ALICE, body }),
      ),
    ).toContain('statement_is_not_an_assertion');
    expect(
      kinds(
        {
          type: 'open_question',
          provenance: ['msg_1'],
          quote: body,
          statement: body,
          proposer: { kind: 'model' },
        },
        room({ id: 'msg_1', authorId: ALICE, body }),
      ),
    ).not.toContain('statement_is_not_a_question');
  });

  it('refuses an assertion on an unverifiable mark without certifying a question', () => {
    // U+AA5D is in `QUESTION_SHAPED_MARKS` and not in `QUESTION_MARKS`, and the
    // two checks are mirrors whose safe directions are opposite: minted as a
    // claim it is refused (one glance), and minted as an open question it is
    // *also* refused, because it certifies nothing. Nothing accepts on a mark
    // nobody could check.
    const body = 'Bob will deploy production Friday꩝';
    const verdict = (type: 'claim' | 'open_question') =>
      kinds(
        {
          type,
          provenance: ['msg_1'],
          quote: body,
          statement: body,
          proposer: { kind: 'model' },
          ...(type === 'claim' ? { attributedTo: ALICE } : {}),
        },
        room({ id: 'msg_1', authorId: ALICE, body }),
      );
    expect(verdict('claim')).toContain('statement_is_not_an_assertion');
    expect(verdict('open_question')).toContain('statement_is_not_a_question');
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
        room({ id: 'msg_1', authorId: ALICE, body }),
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
        room({ id: 'msg_1', authorId: BOB, body }),
      ),
    ).toContain('statement_is_not_an_assertion');
  });

  it('mints the same sentence as an open question', () => {
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: ALICE,
      body: 'Would we deploy production Friday?',
    });
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
  it('refuses to mint a code literal the author did not write, at every layer', () => {
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

    // **The three assertions above were the whole of this test, and the rule they
    // name was violated one layer up the entire time.** `normalizeForReceipt` is
    // not what the acceptance path compares — `statementBearing` is, over tokens,
    // and the tokenizer discarded whitespace, so a test titled for the code-literal
    // rule passed while both of these auto-accepted with a `payload.statement`
    // their named author never wrote. A test that pins a rule at a layer nothing
    // consults is a test that pins nothing.
    const password = 'Set the deployment password to `a  b` today, everyone.';
    const respaced = 'Set the deployment password to `a b` today, everyone.';
    const command = 'Run `rm -rf / tmp/cache` on the box tonight, everyone.';
    const rehomed = 'Run `rm -rf /tmp/cache` on the box tonight, everyone.';

    for (const [body, minted] of [
      [password, respaced],
      [command, rehomed],
    ] as const) {
      expect(statementBearing(body, minted).borne, `${minted} must not be borne`).toBe(false);
      expect(statementBearing(body, minted).whitespaceDiffers).toBe(true);
      expect(
        kinds(
          {
            type: 'claim',
            provenance: ['msg_1'],
            quote: body,
            statement: minted,
            proposer: { kind: 'model' },
            attributedTo: BOB,
          },
          room({ id: 'msg_1', authorId: BOB, body }),
        ),
      ).toEqual(['statement_respaces_the_quote']);

      // …and at the engine, which is where it would have become a fact.
      const decision = decideAcceptance(
        modelProposal({
          type: 'claim',
          payload: { statement: minted, claimant: BOB },
          quote: body,
        }),
        { messages: room({ id: 'msg_1', authorId: BOB, body }) },
      );
      expect(decision.verdict).toBe('discard');
      expect(decision.rule).toBe('provenance_failed');
    }

    // …and the compliant form still certifies, so this is not "refuse anything
    // with a backtick in it".
    expect(statementBearing(password, password).borne).toBe(true);
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: password,
          statement: password,
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        room({ id: 'msg_1', authorId: BOB, body: password }),
      ),
    ).toEqual([]);
  });
});

describe('r5 — a detected fault is not weakness', () => {
  it('does not let deduplication destroy a discrepancy nobody has seen', () => {
    // This round's own blind review. The referral was moved above θ_min so a
    // detected discrepancy is never destroyed for being low-confidence — and
    // `findDuplicate` was still upstream of it, destroying the same discrepancy
    // for a different reason.
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: BOB,
      body: 'Bob will not deploy production Friday.',
    });
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
          payload: {
            statement: 'Bob will deploy production Friday.',
            claimant: BOB,
            verification: 'unverified',
          },
          messageIds: ['msg_1'],
          retractedAt: null,
          supersededById: null,
        },
      ],
    });
    expect(withoutRoom.rule).toBe('receipt_not_certifiable');
    expect(withRoom.rule).toBe('receipt_not_certifiable');
  });

  it('refers an inverted receipt that sits below theta_min', () => {
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: BOB,
      body: 'Bob will not deploy production Friday.',
    });
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: BOB,
      body: 'Bob will deploy production Friday.',
    });
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: BOB,
      body: 'Bob will deploy production Friday.',
    });
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
    const messages: ProvenanceMessage[] = room({
      id: 'msg_1',
      authorId: BOB,
      body: 'Ship the narrowing fix this quarter.',
    });
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
  const claimOf = (statement: string) =>
    ({ statement, claimant: BOB, verification: 'unverified' }) as const;
  const accepted: AcceptedObjectRef[] = [
    {
      objectId: 'obj_1',
      type: 'claim',
      payload: claimOf('The migration is reversible'),
      messageIds: ['msg_1'],
      retractedAt: null,
      supersededById: null,
    },
    {
      objectId: 'obj_2',
      type: 'claim',
      payload: claimOf('All services restart cleanly'),
      messageIds: ['msg_1'],
      retractedAt: null,
      supersededById: null,
    },
  ];

  it('does not discard the negation of an accepted claim as a re-proposal of it', () => {
    expect(
      findDuplicate('claim', claimOf('The migration is not reversible'), ['msg_1'], accepted),
    ).toBeNull();
  });

  it('does not discard a quantifier substitution either', () => {
    expect(
      findDuplicate('claim', claimOf('Some services restart cleanly'), ['msg_1'], accepted),
    ).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * r7 — the refusal a person reads has to be true about their own message
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Two refusals with the right verdict and a false sentence attached.
 *
 * Neither is a fail-open: every mislabel stays on a non-accepting branch, and
 * r7's blind review verified that in both directions over 200k pairs. They are
 * here because a room is shown these strings. A refusal that names the wrong
 * defect sends somebody to fix a citation that is fine, and — worse for this
 * package specifically — reads as evidence that the check understood the input
 * when it did not.
 *
 * Both fail on `fix/core-engine-r6` as committed.
 */
describe('r7 — a refusal that names words the quote does contain', () => {
  const BODY = 'We deploy production Friday and we deploy staging Monday.';
  const TRANSPOSED = 'We deploy staging Friday and we deploy production Monday.';
  const messages: ProvenanceMessage[] = room(
    { id: 'msg_1', authorId: BOB, body: BODY },
    { id: 'msg_2', authorId: ALICE, body: 'noted, thanks for the schedule' },
  );

  const subject = {
    type: 'claim' as const,
    provenance: ['msg_1'],
    quote: BODY,
    statement: TRANSPOSED,
    proposer: { kind: 'model' as const },
    attributedTo: BOB,
  };

  it('does not tell a room the quote lacks words the quote has', () => {
    // A transposition of a **repeated** token knocks both sides of the
    // resynchroniser out of step, so `unmatchedInStatement` came back holding
    // "Friday", "and", "we", "deploy", "production" — every one of which the
    // quote says — under the sentence *"which the quote does not say"*.
    const problems = validateProposalProvenance(subject, messages);
    expect(problems.map((problem) => problem.kind)).toEqual(['quote_does_not_bear_statement']);
    const detail = problems[0]?.detail ?? '';
    // The five words r7's review found named as absent, all of them present.
    const quoteWords = new Set(orderedTokens(BODY));
    for (const word of ['Friday', 'and', 'we', 'deploy', 'production']) {
      expect(quoteWords.has(word), `${word} is in the quote`).toBe(true);
    }
    expect(detail).not.toContain('which the quote does not say');
    expect(detail).toContain(
      'uses only words the quote contains and puts them in a different order',
    );
  });

  it('still names a word that really is absent, so this is not "never say absent"', () => {
    // The anti-vacuity half: the original message is the common case and has to
    // keep working, or the repair is "stop reporting".
    const problems = validateProposalProvenance(
      { ...subject, statement: 'We deploy production Friday and we redeploy staging Tuesday.' },
      messages,
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['quote_does_not_bear_statement']);
    expect(problems[0]?.detail).toContain('which the quote does not say');
  });

  it('keeps the verdict, which was never the defect', () => {
    // The disposition is right in both spellings, and this pins that the message
    // repair did not move it.
    expect(
      decideAcceptance(
        modelProposal({
          type: 'claim',
          payload: { statement: TRANSPOSED, claimant: BOB },
          quote: BODY,
        }),
        { messages },
      ).verdict,
    ).toBe('discard');
  });
});

describe('r7 — a body too long to scan is not a body that was read', () => {
  // `quoteSpansWholeSentences` answers `false` both when the quote really is cut
  // out of the middle of a sentence and when the body holds more sentences than
  // it will read. Those are opposite facts, and both came out as *"the quote is
  // a span cut out of the middle of a sentence"* — said about a quote that is
  // the **whole body**.
  const SENTENCES = RECEIPT_POLICY.maxScannedSentences + 1;
  const BODY = Array.from({ length: SENTENCES }, (_, index) => `Point ${index} stands.`).join(' ');
  const messages: ProvenanceMessage[] = room(
    { id: 'msg_1', authorId: BOB, body: BODY },
    { id: 'msg_2', authorId: ALICE, body: 'noted, thanks for writing it all out' },
  );

  it('says the check declined rather than calling a whole body a fragment', () => {
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: BODY,
        statement: BODY,
        proposer: { kind: 'model' },
        attributedTo: BOB,
      },
      messages,
    );
    // The quote is the entire message, so "cut out of the middle of a sentence"
    // is false about it in every sense.
    expect(problems.map((problem) => problem.kind)).toContain('quote_span_unscanned');
    expect(problems.map((problem) => problem.kind)).not.toContain('quote_is_a_fragment');
    const unscanned = problems.find((problem) => problem.kind === 'quote_span_unscanned');
    expect(unscanned?.severity).toBe('refer');
    expect(unscanned?.detail).toContain(`more than the ${RECEIPT_POLICY.maxScannedSentences}`);
  });

  it('keeps the disposition — an unread body is not a clean one', () => {
    // The verdict was already right, and the repair is to the sentence only.
    expect(
      decideAcceptance(
        modelProposal({ type: 'claim', payload: { statement: BODY, claimant: BOB }, quote: BODY }),
        { messages },
      ).verdict,
    ).not.toBe('auto_accept');
  });

  it('still calls a real fragment a fragment, under the cap', () => {
    // Anti-vacuity: the branch that was mislabelling everything must still fire
    // on the input it was built for.
    const short = 'It is not true that Bob will deploy production Friday afternoon.';
    expect(
      validateProposalProvenance(
        {
          type: 'claim',
          provenance: ['msg_s'],
          quote: 'Bob will deploy production Friday afternoon.',
          statement: 'Bob will deploy production Friday afternoon.',
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        room(
          { id: 'msg_s', authorId: BOB, body: short },
          { id: 'msg_s2', authorId: ALICE, body: 'understood, thanks for clarifying' },
        ),
      ).map((problem) => problem.kind),
    ).toContain('quote_is_a_fragment');
  });
});

describe('r7 — the two things the link rule was still deleting', () => {
  // r7's blind review ran a 400k-sample collision search over the receipt fold
  // and found exactly five surprising collisions, all of them this rule. The
  // "Four entries" allowlist in `matching.ts` named neither, because neither was
  // ever admitted: the pattern consumed them as syntax and never re-emitted
  // them. Both are author-written text a reader sees, which is r4's own argument
  // for making the destination content.
  const withTitle = 'See [the runbook](https://x.example "Do NOT run step 4") before deploying.';
  const stripped = 'See the runbook https://x.example before deploying.';

  it('keeps a link title, which is text the author wrote', () => {
    // The whole exploit in one pair: a statement that silently drops the
    // author's warning, quoted verbatim, reaching `auto_accept`.
    expect(normalizeForReceipt(withTitle)).not.toBe(normalizeForReceipt(stripped));
    expect(normalizeForReceipt(withTitle)).toContain('Do NOT run step 4');

    const messages: ProvenanceMessage[] = room(
      { id: 'msg_1', authorId: ALICE, body: withTitle },
      { id: 'msg_2', authorId: BOB, body: 'understood, thanks for the pointer' },
    );
    expect(
      validateProposalProvenance(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: stripped,
          statement: stripped,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
        },
        messages,
      ),
    ).not.toEqual([]);
    expect(
      decideAcceptance(
        modelProposal({
          type: 'claim',
          payload: { statement: stripped, claimant: ALICE },
          quote: stripped,
        }),
        { messages },
      ).verdict,
    ).not.toBe('auto_accept');
  });

  it('keeps the image marker, so an embed is not a link', () => {
    // `![alt](url)` embeds and `[alt](url)` links. Folding both to `alt url`
    // made one text out of two different things.
    expect(normalizeForReceipt('See ![the diagram](https://x.example/d.png) here.')).not.toBe(
      normalizeForReceipt('See [the diagram](https://x.example/d.png) here.'),
    );
  });

  it('is the same policy in both folds, which is what "one answer" means', () => {
    // r7 found the two folds carrying separate copies of this callback, and
    // changing one left the other on the old policy — routing dropped every
    // destination, silently, until `escalation.test.ts` caught it. They call one
    // function now.
    //
    // Not equality between the folds: routing is lossier by design (case, NFKC,
    // emphasis). The claim is the narrower one that broke — whatever a link
    // carries, both folds keep it.
    const texts = [
      withTitle,
      'See ![the diagram](https://x.example/d.png) here.',
      'see [the playground](https://example.com/x?y=1) for it',
    ];
    for (const text of texts) {
      for (const fragment of ['Do NOT run step 4', 'https://x.example', 'https://example.com']) {
        if (!text.includes(fragment)) continue;
        expect(normalizeForRouting(text), `${fragment} in routing`).toContain(
          fragment.toLowerCase(),
        );
        expect(normalizeForReceipt(text), `${fragment} in the receipt`).toContain(fragment);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * #86 — A WINDOW THAT STOPS, AND THE TWO WINDOWS THAT ARE THE SAME BYTES.
 *
 * `laterRevision` refuses a window that ends at the citations, because it
 * carries no evidence about what came after the quoted sentence. Widening the
 * supplier to satisfy that (drizzle/0011) creates the question this block is
 * about: a snapshot has to stop somewhere too, and the moment it does, a window
 * the room OUTGREW and a room that simply ENDED arrive here as the same array.
 * This function has no message table and no clock and cannot tell them apart by
 * looking.
 *
 * It does not have to, under one contract: the supplier stops strictly later
 * than this check reads. Then a truncated tail always lands over
 * `maxLaterMessagesScanned` and is referred as `too_many_messages`, and any
 * shorter tail is provably the room's own end.
 *
 * `window_carries_fewer_than_this_check_reads` is what refuses the
 * configuration where that stops holding. Most tests below use a policy the
 * shipped table does not — deliberately, because the whole point is that the
 * shipped table makes this refusal unreachable, and a refusal you cannot reach
 * is one you cannot test by shipping it.
 * ------------------------------------------------------------------------- */
describe('#86 — the supplier’s bound is checked, not trusted', () => {
  const STATEMENT = 'We will deploy production Friday.';

  /** The shipped table with the supplier's bound moved, and nothing else. */
  const carrying = (carried: number): ReceiptPolicy => ({
    ...RECEIPT_POLICY,
    maxLaterMessagesCarried: carried,
  });

  /** A window: the cited sentence, then `tail` messages the room said after it. */
  const windowWithTail = (tail: number): ProvenanceMessage[] => [
    { id: 'msg_1', authorId: ALICE, body: STATEMENT },
    ...Array.from({ length: tail }, (_, i) => ({
      id: `after_${i}`,
      authorId: BOB,
      body: `Unrelated note ${i} about the build.`,
    })),
  ];

  const subject = {
    type: 'claim',
    provenance: ['msg_1'],
    quote: STATEMENT,
    statement: STATEMENT,
    proposer: { kind: 'model' },
    attributedTo: ALICE,
  } as const;

  it('refuses a window standing at a ceiling no higher than the read bound', () => {
    // Catches: `later_revision_drops_the_supplier_bound_check` — deleting the
    // gate entirely. Without it this window scans its 40 messages, finds no
    // correction, and returns `none`, which `validateProposalProvenance` reads
    // as a clean receipt. Everything past 40 was never supplied and never read,
    // and the reading auto-accepts against evidence nobody looked at. That is
    // the under-supply direction, and it is the only direction of #86 that can
    // mint a wrong fact rather than merely refuse a right one.
    expect(laterRevision(STATEMENT, ['msg_1'], windowWithTail(40), carrying(40))).toEqual({
      kind: 'unscanned',
      why: 'window_carries_fewer_than_this_check_reads',
    });
  });

  it('refuses at the ceiling even when carried and scanned are exactly equal', () => {
    // Catches: `later_revision_supplier_bound_uses_strict_less_than` — writing
    // the guard as `maxLaterMessagesCarried < maxLaterMessagesScanned`, which
    // passes the test above and lets the equal case through. Equal is the
    // ambiguous case and it is the whole reason the migration's literal is
    // `+ 1` rather than the same number: a room that ended at exactly 200 and a
    // window cut at exactly 200 are indistinguishable from in here, and
    // certifying one of them is certifying the other.
    const equal = carrying(RECEIPT_POLICY.maxLaterMessagesScanned);
    const window = windowWithTail(RECEIPT_POLICY.maxLaterMessagesScanned);
    expect(laterRevision(STATEMENT, ['msg_1'], window, equal)).toEqual({
      kind: 'unscanned',
      why: 'window_carries_fewer_than_this_check_reads',
    });
  });

  it('leaves a short room alone under the same broken ceiling', () => {
    // Catches: `later_revision_supplier_bound_ignores_the_tail` — refusing on
    // the policy alone, without asking whether THIS window stands at the
    // ceiling. That mutant refuses every acceptance in every room the moment
    // the numbers are misconfigured, which is #86 again in a different costume:
    // a dead model path, this time with a better error message.
    //
    // A room with 3 messages after the citation supplied everything it had. The
    // window is complete, the scan reads all of it, and a broken ceiling did not
    // touch it.
    expect(laterRevision(STATEMENT, ['msg_1'], windowWithTail(3), carrying(40))).toEqual({
      kind: 'none',
      scannedAfterCitations: 3,
    });
  });

  it('measures the tail from the newest citation, not from the scan floor', () => {
    // Catches: `later_revision_supplier_bound_counts_from_the_scan_floor` —
    // using `later.length` (which starts at `scanFloor`, at or before the
    // earliest citation) instead of the run after `lastCited`. The supplier's
    // bound governs only what it appended after the newest citation; comparing
    // it against a count that also includes the cited messages makes the guard
    // fire one message early per extra citation, and it makes a proposal able to
    // move the guard by padding its own citation list — the padding attack this
    // file has been through at three other boundaries.
    //
    // Two citations and 39 messages after the newest of them: one below the
    // ceiling, so this is a complete window and the guard stays quiet. Counting
    // from the scan floor would see 40, hit the ceiling, and refuse.
    const window: ProvenanceMessage[] = [
      { id: 'msg_1', authorId: ALICE, body: STATEMENT },
      { id: 'msg_2', authorId: ALICE, body: 'And the changelog is out.' },
      ...Array.from({ length: 39 }, (_, i) => ({
        id: `after_${i}`,
        authorId: BOB,
        body: `Unrelated note ${i} about the build.`,
      })),
    ];
    expect(laterRevision(STATEMENT, ['msg_1', 'msg_2'], window, carrying(40))).toEqual({
      kind: 'none',
      scannedAfterCitations: 40,
    });
  });

  it('never fires on the shipped table, because a full tail is over-supply', () => {
    // Catches: `receipt_policy_carried_equals_scanned` from the other side, and
    // `window_migration_bound_drifts`.
    //
    // The shipped contract in one assertion: a window standing at
    // `maxLaterMessagesCarried` is, by construction, over
    // `maxLaterMessagesScanned` — so the answer is `too_many_messages`, the
    // EXISTING over-supply refusal, and the new one is unreachable. That is what
    // "the ambiguous window does not exist" means operationally, and it is why
    // over-supply was chosen over a tighter bound: this path already refers.
    const full = windowWithTail(RECEIPT_POLICY.maxLaterMessagesCarried);
    expect(laterRevision(STATEMENT, ['msg_1'], full, RECEIPT_POLICY)).toEqual({
      kind: 'unscanned',
      why: 'too_many_messages',
    });
  });

  it('reports the refusal as a fact about the window, never about the reading', () => {
    // Catches: `problem_evidence_supersession_is_the_proposal`,
    // `problem_evidence_supersession_is_the_cited_messages`.
    //
    // `fix/core-engine-r11` established that a verdict is either a fact about
    // the reading or a fact about the window, and that a window-fact must refer
    // rather than conclude — `attention.ts` used to read a `discard` from a
    // truncated window as "this cycle judged this proposal and it owes nobody
    // anything", resolving somebody's confirm forever from a cycle that could
    // not see the message it was confirming.
    //
    // A window whose supplier stopped too early is a window-fact by exactly that
    // argument: nothing about the READING was established, and what went wrong
    // is how far the window reached. Asserted through
    // `validateProposalProvenance` rather than on the union, because `about` is
    // derived at the seal and it is the derived value `acceptance.ts` and
    // `attention.ts` read.
    const problems = validateProposalProvenance(subject, windowWithTail(40), carrying(40));
    expect(problems.map((problem) => problem.kind)).toEqual(['superseded_by_later_message']);
    expect(problems.every((problem) => problem.severity === 'refer')).toBe(true);
    expect(problems.map((problem) => problem.about)).toEqual(['the_window']);
    expect(isAboutTheWindow(problems)).toBe(true);
  });

  it('tells the room which question was declined, in its own words', () => {
    // Catches: `unscanned_detail_collapses_to_one_sentence`.
    //
    // The detail was a two-armed ternary until #86: `window_ends_at_the_citations`
    // got its own sentence and the other five reasons — a statement too long to
    // align, a statement with no routing tokens, a citation list that reached no
    // message, and both scan caps — all fell into the `else` and were reported
    // as "the window carries more after this citation than this check will read".
    // A fact about the window, stated about refusals that had nothing to do with
    // the window, and the sentence a person reads is what decides whether they go
    // looking at the window or at the proposal.
    //
    // Asserted as distinctness rather than by quoting the strings, because the
    // property is that they do not collapse — quoting them would pin the prose
    // and still let a future pair be made identical one word at a time.
    const cases = [
      { policy: carrying(40), window: windowWithTail(40) },
      { policy: RECEIPT_POLICY, window: windowWithTail(0) },
      {
        policy: RECEIPT_POLICY,
        window: windowWithTail(RECEIPT_POLICY.maxLaterMessagesCarried),
      },
    ];
    const details = cases.map(({ policy, window }, index) => {
      const problems = validateProposalProvenance(subject, window, policy);
      const found = problems.find((problem) => problem.kind === 'superseded_by_later_message');
      expect(found, `case ${index} did not refuse at all`).toBeDefined();
      return found?.detail as string;
    });
    expect(new Set(details).size, 'each declined question gets its own sentence').toBe(
      details.length,
    );
    // …and the new one names the ceiling it stopped at, so the sentence is
    // actionable rather than merely distinct.
    expect(details[0]).toContain('40');
  });
});
