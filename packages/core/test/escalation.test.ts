import { describe, expect, it } from 'vitest';
import {
  bearingMessage,
  CONCESSION_MARKERS,
  contentTokens,
  defaultEscalationConfig,
  type EscalationMessage,
  type EscalationTriggerKind,
  evaluateEscalation,
  FUTURE_PATTERNS,
  hasReplyBlockquote,
  lexicalOverlap,
  normalizeForReceipt,
  normalizeForRouting,
  PROVENANCE_PROBLEM_KINDS,
  type ProvenanceProblemKind,
  provenanceIsClean,
  replyBlockquotes,
  SED_CORRECTION,
  stripReplyBlockquotes,
  triggersForMessage,
  validateProposalProvenance,
} from '../src/index.js';
import {
  DHLOLO,
  JORDAN,
  messageConcession,
  messageDispute,
  messageOpener,
  messageOrdinary,
  messageQuotingOpener,
  messageThirdPartyCommitment,
  spikeWindow,
} from './spike-fixtures.js';

/**
 * The escalation triggers (#8's amendment) and the proposal-validation layer
 * (#23's scope addition), both against real message shapes.
 *
 * The fixtures come from the spike corpus rather than from imagination, because
 * the failures these functions exist to catch are structural — a quote inside
 * somebody else's blockquote, a concession at the tail of a long reply — and a
 * hand-written fixture reproduces the intent while quietly dropping the shape.
 */

const kinds = (
  message: EscalationMessage,
  ...rest: Parameters<typeof triggersForMessage> extends [unknown, ...infer R] ? R : never
): EscalationTriggerKind[] =>
  triggersForMessage(message, ...rest)
    .map((trigger) => trigger.kind)
    .sort();

describe('stripReplyBlockquotes — the highest-value function in the file', () => {
  it('removes quoted lines and keeps the author’s own text', () => {
    const own = stripReplyBlockquotes(messageQuotingOpener.body);
    expect(own).toContain('The error occurs on line 8 not line 5');
    expect(own).not.toContain('I just ran into a problem');
  });

  it('removes nested quotes too — they are quoting harder, not less', () => {
    const text = 'mine\n> theirs\n> > theirs-quoting-someone\nmine again';
    expect(stripReplyBlockquotes(text)).toBe('mine\nmine again');
  });

  it('leaves a message with no quotes untouched', () => {
    expect(stripReplyBlockquotes(messageOpener.body)).toBe(messageOpener.body);
    expect(hasReplyBlockquote(messageOpener.body)).toBe(false);
  });

  it('extracts the quoted blocks, marker-free', () => {
    const blocks = replyBlockquotes(messageDispute.body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('This comparison appears to be unintentional');
  });

  it('does not treat a `>` inside a line as a quote marker', () => {
    const text = 'the type is Array<T> => U, not a quote';
    expect(hasReplyBlockquote(text)).toBe(false);
    expect(stripReplyBlockquotes(text)).toBe(text);
  });
});

describe('normalizeForRouting — the lossy fold, for deciding which model reads a window', () => {
  it('collapses emphasis, code ticks and whitespace, and folds case', () => {
    expect(normalizeForRouting('TypeScript **should   not** be so `confident`')).toBe(
      'typescript should not be so confident',
    );
  });

  it('keeps a markdown link"s destination, exactly as the receipt fold does', () => {
    // r5's third review pass: `laterRevision` runs over this fold, so collapsing
    // a link to its label made a later message that changed only the
    // *destination* read as the same tokens as the one before it. A destination
    // is content wherever it appears, and there is one answer to that now.
    expect(normalizeForRouting('see [the playground](https://example.com/x?y=1) for it')).toBe(
      'see the playground https://example.com/x?y=1 for it',
    );
  });

  it('is the only fold allowed to be this lossy, and it never sees a receipt', () => {
    // Routing decides which model reads a window and whether a reading duplicates
    // one already accepted. Getting either wrong costs a model call or a dropped
    // re-proposal. Getting the receipt wrong mints something false about a named
    // person, which is why the two folds are two functions since r5.
    expect(normalizeForRouting('ｅｖｉｌ.example')).toBe(normalizeForReceipt('evil.example'));
    expect(normalizeForReceipt('ｅｖｉｌ.example')).not.toBe(normalizeForReceipt('evil.example'));
  });
});

describe('trigger 1 — reply-blockquote', () => {
  it('fires on a message quoting an earlier one, and names the match', () => {
    const triggers = triggersForMessage(messageQuotingOpener, [messageOpener]);
    const blockquote = triggers.find((trigger) => trigger.kind === 'reply_blockquote');
    expect(blockquote).toBeDefined();
    expect(blockquote?.matched).toBe(messageOpener.id);
    expect(blockquote?.evidence).toContain('I just ran into a problem');
  });

  it('fires even when the quoted message is outside the window', () => {
    // A 20-message window over a 400-message thread quotes backwards out of
    // itself constantly. Requiring a match would drop the chains this exists for.
    const triggers = triggersForMessage(messageQuotingOpener, []);
    const blockquote = triggers.find((trigger) => trigger.kind === 'reply_blockquote');
    expect(blockquote).toBeDefined();
    expect(blockquote?.matched).toBeNull();
  });

  it('does not fire on a quote too short to be quoting anything', () => {
    const message: EscalationMessage = { id: 'm', authorId: 'a', body: '> yes\nagreed' };
    expect(kinds(message)).not.toContain('reply_blockquote');
  });

  it('does not fire on a message with no quotes at all', () => {
    expect(kinds(messageOpener)).toEqual([]);
    expect(kinds(messageOrdinary)).toEqual([]);
  });
});

describe('trigger 2 — concession markers', () => {
  it('fires on the corpus’s one real concession', () => {
    const triggers = triggersForMessage(messageConcession, [messageDispute]);
    const concession = triggers.find((trigger) => trigger.kind === 'concession_marker');
    expect(concession?.evidence).toBe('you are right');
  });

  it('reads only the author’s own text, not what they quoted', () => {
    // Somebody quoting *your* concession back at you has not conceded.
    const message: EscalationMessage = {
      id: 'm',
      authorId: 'a',
      body: '> Honestly, you are right about the narrowing.\n\nNo, I do not think that follows at all.',
    };
    expect(kinds(message)).toEqual(['reply_blockquote']);
  });

  it('fires on the terse sed form no word list catches', () => {
    const message: EscalationMessage = { id: 'm', authorId: 'a', body: 's/line 8/line 7/' };
    const triggers = triggersForMessage(message);
    expect(triggers.map((trigger) => trigger.kind)).toEqual(['concession_marker']);
    expect(triggers[0]?.evidence).toBe('s/line 8/line 7/');
  });

  it('respects word boundaries — "factually" is not "actually"', () => {
    const message: EscalationMessage = {
      id: 'm',
      authorId: 'a',
      body: 'factually the compiler is correct here',
    };
    expect(kinds(message)).toEqual([]);
  });
});

describe('trigger 2 — every marker in the table, one case each', () => {
  /**
   * The round-1 gauntlet's test-vacuity finding, closed: three of twenty-one
   * markers were exercised and the rest were decoration — deleting them left the
   * suite green. This drives the cases *from the array*, so every entry is
   * exercised, and pins the array by value, so deleting one fails here even
   * though the table would happily shrink with it. Both halves are needed: the
   * table alone cannot notice a row that stopped existing.
   */
  it('is exactly this list', () => {
    expect(CONCESSION_MARKERS).toEqual([
      'you are right',
      "you're right",
      'you were right',
      'i was wrong',
      "i'm wrong",
      'i am wrong',
      'i stand corrected',
      'my mistake',
      'my bad',
      'correction',
      'corrected',
      'actually',
      'never mind',
      'nevermind',
      'scratch that',
      'disregard that',
      'on second thought',
      'fair enough',
      'good point',
      'i take that back',
      'withdrawn',
    ]);
  });

  for (const marker of CONCESSION_MARKERS) {
    it(`fires on "${marker}", and names it as the evidence`, () => {
      const message: EscalationMessage = { id: 'm', authorId: 'a', body: `Ok. ${marker}.` };
      const triggers = triggersForMessage(message).filter(
        (trigger) => trigger.kind === 'concession_marker',
      );
      expect(triggers).toHaveLength(1);
      // Exactly this marker, not merely "some marker fired": an entry whose
      // evidence is always another entry's is an entry that does nothing.
      expect(triggers[0]?.evidence).toBe(marker);
    });
  }

  it('fires on the sed form, which is in no word list', () => {
    const triggers = triggersForMessage({ id: 'm', authorId: 'a', body: 's/line 8/line 7/' });
    expect(triggers.map((trigger) => trigger.kind)).toEqual(['concession_marker']);
    expect(SED_CORRECTION.test('s/line 8/line 7/')).toBe(true);
    // …and not on a path or a URL, which is what the `\b` and the closing slash
    // are for.
    expect(SED_CORRECTION.test('docs/api/v1/')).toBe(false);
    expect(SED_CORRECTION.test('https://example.com/x/')).toBe(false);
  });
});

describe('trigger 3 — named-person future tense', () => {
  /**
   * Five patterns, and round 1 exercised two. Each case below matches exactly
   * one pattern — asserted, not assumed — so deleting any pattern drops its case
   * and the suite goes red rather than quietly covering less.
   */
  const CASES: Array<{ pattern: number; body: string; evidence: string }> = [
    { pattern: 0, body: '@dhlolo will take the narrowing fix.', evidence: '@dhlolo will' },
    { pattern: 1, body: 'you should rerun the suite first', evidence: 'you should' },
    { pattern: 2, body: 'Can you rerun the RWC suite?', evidence: 'Can you' },
    { pattern: 3, body: '@dhlolo take the branch cut this week', evidence: '@dhlolo take' },
    { pattern: 4, body: 'please review the patch before Friday', evidence: 'please review' },
  ];

  it('is exactly these five patterns', () => {
    expect(FUTURE_PATTERNS.map(String)).toEqual([
      '/@[\\w-]+\\s+(?:will|should|can|could|needs? to|is going to|has to|must|please)\\b/i',
      '/\\byou\\s+(?:will|should|need to|needs to|ought to|have to|must|can|could)\\b/i',
      '/\\b(?:can|could|would|will)\\s+you\\b/i',
      '/@[\\w-]+[,:]?\\s+(?:please|take|handle|own|pick up)\\b/i',
      '/\\bplease\\s+(?:can|could|take|handle|own|pick up|review|land|ship)\\b/i',
    ]);
  });

  it('has a case for every pattern', () => {
    expect(CASES.map((entry) => entry.pattern)).toEqual(
      FUTURE_PATTERNS.map((_pattern, index) => index),
    );
  });

  for (const testCase of CASES) {
    it(`pattern ${testCase.pattern} fires on "${testCase.body}"`, () => {
      // Exactly one pattern matches, so this case is testing the one it claims.
      const matching = FUTURE_PATTERNS.map((pattern, index) =>
        pattern.test(testCase.body) ? index : -1,
      ).filter((index) => index >= 0);
      expect(matching).toEqual([testCase.pattern]);

      const triggers = triggersForMessage({ id: 'm', authorId: 'a', body: testCase.body });
      const future = triggers.find((trigger) => trigger.kind === 'named_person_future');
      expect(future?.evidence).toBe(testCase.evidence);
    });
  }
});

describe('trigger 3 — the corpus shapes', () => {
  it('fires on somebody committing somebody else', () => {
    const triggers = triggersForMessage(messageThirdPartyCommitment);
    const future = triggers.find((trigger) => trigger.kind === 'named_person_future');
    expect(future?.evidence).toBe('@dhlolo will');
  });

  it('fires on a bare second-person request', () => {
    const message: EscalationMessage = {
      id: 'm',
      authorId: 'a',
      body: 'Can you rerun the RWC suite?',
    };
    expect(kinds(message)).toEqual(['named_person_future']);
  });

  it('does not fire on a plain @mention with no ask', () => {
    const message: EscalationMessage = {
      id: 'm',
      authorId: 'a',
      body: '@ahejlsberg and I discussed this last week.',
    };
    expect(kinds(message)).toEqual([]);
  });
});

describe('trigger 4 — overlap with an accepted decision', () => {
  const decision = {
    objectId: 'obj_d1',
    statement: 'Narrowing resets on every method call that could mutate a class property',
  };

  it('fires when a long message restates a short accepted decision', () => {
    const message: EscalationMessage = {
      id: 'm',
      authorId: 'a',
      body: 'I disagree — narrowing should not reset on every method call, because a class property mutation is rare and the cost of resetting could be enormous for large codebases with many method invocations.',
    };
    const triggers = triggersForMessage(message, [], [decision]);
    const overlap = triggers.find((trigger) => trigger.kind === 'accepted_decision_overlap');
    expect(overlap?.matched).toBe('obj_d1');
  });

  it('does not fire on an unrelated message', () => {
    expect(kinds(messageOrdinary, [], [decision])).toEqual([]);
  });

  it('scores containment, not Jaccard — length must not dilute a restatement', () => {
    const statement = 'ship the flag default off';
    const short = 'ship the flag default off';
    const padded = `${'unrelated words about compilers and inference '.repeat(20)} ${short}`;
    expect(lexicalOverlap(short, statement)).toBe(1);
    expect(lexicalOverlap(padded, statement)).toBe(1);
  });

  it('drops stopwords and short tokens before comparing', () => {
    expect([...contentTokens('the and for it is a to be')].sort()).toEqual([]);
  });
});

describe('defaultEscalationConfig — pinned by value, and by what it does', () => {
  /**
   * Round 1: the config had no by-value test at all, so every threshold in it
   * could be changed without a single assertion noticing — including the ones
   * the trigger tests draw their fixtures from.
   */
  it('is exactly this table', () => {
    expect(defaultEscalationConfig).toEqual({
      minQuoteLength: 24,
      decisionOverlapThreshold: 0.5,
      decisionOverlapMinTokens: 3,
      maxScanChars: 20000,
      maxHistoryScanned: 200,
      maxComparedDecisions: 200,
    });
  });

  it('puts the quote-length line exactly where the number says', () => {
    // Literal lengths on both sides: nothing here moves when the config does.
    const quote = (length: number) => 'ab '.repeat(Math.ceil(length / 3)).slice(0, length);
    expect(normalizeForRouting(quote(23)).length).toBeLessThan(24);
    expect(
      triggersForMessage({ id: 'm', authorId: 'a', body: `> ${quote(23)}\nmine` }).map(
        (trigger) => trigger.kind,
      ),
    ).toEqual([]);
    expect(
      triggersForMessage({ id: 'm', authorId: 'a', body: `> ${quote(30)}\nmine` }).map(
        (trigger) => trigger.kind,
      ),
    ).toEqual(['reply_blockquote']);
  });

  it('bounds the work per call, so content cannot choose the cost', () => {
    // The cap, observed rather than asserted about: a marker past `maxScanChars`
    // is not read, which is the visible consequence of not scanning it. Without
    // a bound, normalization is linear in whatever somebody pastes.
    const filler = 'x'.repeat(defaultEscalationConfig.maxScanChars);
    const message: EscalationMessage = { id: 'm', authorId: 'a', body: `${filler} you are right` };
    expect(kinds(message)).toEqual([]);
    expect(kinds({ ...message, body: `you are right ${filler}` })).toEqual(['concession_marker']);
  });

  it('bounds the decisions compared against one message', () => {
    const decision = { objectId: 'obj_real', statement: 'narrowing resets on mutating calls' };
    const padding = Array.from(
      { length: defaultEscalationConfig.maxComparedDecisions },
      (_, i) => ({
        objectId: `obj_pad_${i}`,
        statement: `unrelated padding statement number ${i} about compilers`,
      }),
    );
    const body = 'narrowing resets on mutating calls, we decided';
    // Inside the cap it fires…
    expect(
      triggersForMessage({ id: 'm', authorId: 'a', body }, [], [decision, ...padding]).some(
        (trigger) => trigger.kind === 'accepted_decision_overlap',
      ),
    ).toBe(true);
    // …and a decision pushed past it is simply not compared.
    expect(
      triggersForMessage({ id: 'm', authorId: 'a', body }, [], [...padding, decision]).some(
        (trigger) => trigger.kind === 'accepted_decision_overlap',
      ),
    ).toBe(false);
  });
});

describe('bearingMessage — which message actually carries the sentence', () => {
  it('finds the message whose own text contains the quote', () => {
    const found = bearingMessage('The error occurs on line 8 not line 5', [
      messageOpener,
      messageQuotingOpener,
    ]);
    expect(found?.id).toBe(messageQuotingOpener.id);
  });

  it('does not count a message that was only quoting it', () => {
    // messageQuotingOpener reproduces every word of messageOpener inside a
    // blockquote. That is the trap, and this is the function that refuses it.
    const quoted = 'I just ran into a problem with this for the first time';
    expect(bearingMessage(quoted, [messageQuotingOpener])).toBeNull();
    expect(bearingMessage(quoted, [messageOpener])?.id).toBe(messageOpener.id);
  });

  it('is null for a quote nobody wrote, and for an empty one', () => {
    expect(bearingMessage('nobody ever said this', [messageOpener])).toBeNull();
    expect(bearingMessage('   ', [messageOpener])).toBeNull();
  });
});

describe('evaluateEscalation — the whole window', () => {
  it('escalates the spike window and says exactly why', () => {
    const verdict = evaluateEscalation({ messages: spikeWindow });
    expect(verdict.escalate).toBe(true);
    expect(verdict.kinds).toEqual(['concession_marker', 'reply_blockquote']);
    // Attribution survives to the log: which message, and what in it.
    expect(verdict.triggers.map((trigger) => trigger.messageId)).toEqual([
      messageQuotingOpener.id,
      messageDispute.id,
      messageConcession.id,
      messageConcession.id,
    ]);
  });

  it('does not escalate a window of ordinary technical prose', () => {
    const verdict = evaluateEscalation({ messages: [messageOpener, messageOrdinary] });
    expect(verdict.escalate).toBe(false);
    expect(verdict.triggers).toEqual([]);
    expect(verdict.kinds).toEqual([]);
  });

  it('matches a quote against messages before the window', () => {
    const verdict = evaluateEscalation({
      messages: [messageQuotingOpener],
      priorMessages: [messageOpener],
    });
    expect(verdict.triggers[0]?.matched).toBe(messageOpener.id);
  });

  it('is deterministic — same window, byte-identical verdict', () => {
    const a = evaluateEscalation({ messages: spikeWindow });
    const b = evaluateEscalation({ messages: [...spikeWindow] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('fires on the third-party-commitment shape the corpus never produced', () => {
    // #4 spends most of its length on this case and the spike could not test it:
    // one commitment across six runs, self-attributed. The trigger is built from
    // sentence shape, and this pins that it fires.
    const verdict = evaluateEscalation({ messages: [messageThirdPartyCommitment] });
    expect(verdict.escalate).toBe(true);
    expect(verdict.kinds).toEqual(['named_person_future']);
  });
});

/* ───────────────────────────────────────────────────────────────────────── */

describe('validateProposalProvenance — the spike’s three post-checks', () => {
  const messages = [messageOpener, messageQuotingOpener, messageDispute].map((message) => ({
    id: message.id,
    authorId: message.authorId,
    body: message.body,
  }));

  /**
   * The whole final sentence of `messageDispute`.
   *
   * r4: a compliant quote is one or more **whole sentences** of the cited
   * message. These fixtures used to quote a span out of the middle of this
   * sentence, which is the shape r4's own blind review turned into an
   * auto-accept of an inverted claim ("it is not true that …" left outside the
   * scissors), so they quote the sentence.
   */
  const DISPUTE_SENTENCE =
    "While TypeScript is correct that `this.state` must be `'online'` immediately after line 5, " +
    'line 6 (`this.bar()`) changes that, so TypeScript *should not* be so confident that ' +
    "`this.state` is still `'online'` after line 6.";
  /**
   * The same sentence with the emphasis a model drops while quoting, **written
   * out** rather than computed.
   *
   * r4's blind review, third occurrence of the derived-probe class in this
   * ticket (after r3's θ probes and r4's `maxAlignedTokens + 1`): this constant
   * used to read `normalizeForReceipt(DISPUTE_SENTENCE)` and was then used as the
   * *expected* value below. Delete the emphasis rule from the normalizer and the
   * fixture and the assertion move together — the test goes on passing while the
   * behaviour it names is gone. A probe computed by the code under test cannot
   * fail on that code.
   *
   * The backticks survive on purpose: since r5 a code span is content, not
   * formatting, so a model that drops *those* has changed the sentence. What it
   * may drop is the paired `*…*`, and that is the only difference between this
   * string and the one above.
   */
  const DISPUTE_SENTENCE_PLAIN = DISPUTE_SENTENCE;

  const problemKinds = (...args: Parameters<typeof validateProposalProvenance>) =>
    validateProposalProvenance(...args)
      .map((problem) => problem.kind)
      .sort();

  it('catches the worst error in the whole spike', () => {
    // A Claim attributed to jordanbtucker, citing dhlolo's message, quoting a
    // sentence that is in it only because dhlolo blockquoted him. Claim text
    // right, claimant right, provenance overlap non-empty, receipt wrong — and
    // a naive substring matcher scores it as a pass.
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: [messageQuotingOpener.id],
        quote:
          'I just ran into a problem with this for the first time despite using TypeScript for years.',
        statement:
          'I just ran into a problem with this for the first time despite using TypeScript for years.',
        proposer: { kind: 'model' },
        attributedTo: JORDAN,
      },
      messages,
    );
    expect(problems.map((problem) => problem.kind).sort()).toEqual([
      'attributed_person_not_author',
      'quote_only_in_reply_blockquote',
    ]);
    expect(problems[0]?.detail).toContain('was quoting someone else');
    expect(provenanceIsClean(problems)).toBe(false);
  });

  it('refers the same claim when its author wrote more around the sentence', () => {
    // r5. Citing the right message and quoting a whole sentence of it verbatim
    // is no longer a certification: `messageOpener` runs to three paragraphs and
    // a code fence, and a sentence pulled out of that is a sentence whose
    // neighbours nothing here has read. The attribution is right, the quote is
    // right, and the disposition is `refer` rather than `[]`.
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: [messageOpener.id],
        quote:
          'I just ran into a problem with this for the first time despite using TypeScript for years.',
        statement:
          'I just ran into a problem with this for the first time despite using TypeScript for years.',
        proposer: { kind: 'model' },
        attributedTo: JORDAN,
      },
      messages,
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['quote_omits_surrounding_text']);
    expect(problems[0]?.severity).toBe('refer');
  });

  it('passes the claim when the quote is the whole of what that author wrote', () => {
    // …and the certifying form, so the rule above is not simply "refuse
    // everything". The guarantee this shape earns is stronger than the one r4
    // could state: somebody wrote this message, and it says exactly this.
    const sentence =
      'I just ran into a problem with this for the first time despite using TypeScript for years.';
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: ['m_short'],
          quote: sentence,
          statement: sentence,
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        [{ id: 'm_short', authorId: JORDAN, body: sentence }],
      ),
    ).toEqual([]);
  });

  it('finds a quote reproduced exactly, and reports only the scissors', () => {
    // r5's fourth pass retired the emphasis licence, so the compliant quote is
    // the sentence as written. The *only* finding here is that the author wrote
    // more around it — not that the quote could not be found or did not bear its
    // statement.
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: DISPUTE_SENTENCE_PLAIN,
          statement: DISPUTE_SENTENCE_PLAIN,
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual(['quote_omits_surrounding_text']);
  });

  it('does not forgive the backticks, because a code span is mention and not use', () => {
    // r4's blind review: `normalizeForReceipt` deleted backticks, so
    // "`Deploy production Friday.`" — a sample its author was displaying —
    // became an assertion its author made. Since r5 the delimiters are content,
    // so a quote that drops them is not the sentence that was written.
    const body = '`Deploy production Friday and roll back Monday.`';
    const dropped = 'Deploy production Friday and roll back Monday.';
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: ['m_code'],
          quote: dropped,
          statement: dropped,
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        [{ id: 'm_code', authorId: JORDAN, body }],
      ),
    ).not.toEqual([]);
  });

  it('rejects a quote elided with an ellipsis that is not verbatim anywhere', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'While TypeScript is correct that ... after line 6',
          statement: 'While TypeScript is correct that after line 6',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
      // Two findings, not one, and the second is r3's: with no bearing message
      // the attribution is *unsupported*, where round 2 fell back to "did the
      // claimant write any cited message" and answered yes.
      // (`problemKinds` sorts, so this reads alphabetically.)
    ).toEqual(['attributed_person_not_author', 'elided_quote']);
  });

  it('reports a plain missing quote separately from an elided one', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'nobody in this thread ever wrote this sentence',
          statement: 'nobody in this thread ever wrote this sentence',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual(['attributed_person_not_author', 'quote_not_found']);
  });

  it('catches a cited message that is not in the window', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: ['msg_nowhere'],
          quote: 'I just ran into a problem with this for the first time',
          proposer: { kind: 'model' },
        },
        messages,
      ),
    ).toEqual(['unknown_message']);
  });

  it('catches a model proposal citing nothing at all', () => {
    expect(
      problemKinds({ type: 'claim', provenance: [], proposer: { kind: 'model' } }, messages),
    ).toEqual(['no_provenance']);
  });

  it('lets a human proposal cite nothing', () => {
    expect(
      problemKinds({ type: 'claim', provenance: [], proposer: { kind: 'human' } }, messages),
    ).toEqual([]);
  });

  it('requires a commitment’s owner to have authored a cited message', () => {
    const problems = problemKinds(
      {
        type: 'commitment',
        provenance: [messageDispute.id],
        quote: DISPUTE_SENTENCE,
        proposer: { kind: 'model' },
        attributedTo: DHLOLO,
        statement: DISPUTE_SENTENCE,
      },
      messages,
    );
    expect(problems).toEqual(['attributed_person_not_author', 'quote_omits_surrounding_text']);
  });

  it('does not let a padded citation list flip attribution', () => {
    /**
     * Round 1's gauntlet, major 5. The owner authored *a* cited message — an
     * unrelated one — and the check read that as a self-statement. Cite the
     * message where somebody else committed them, plus any message they ever
     * wrote, and an obligation nobody agreed to auto-accepts.
     *
     * The finding is bound to the message bearing the sentence now, so the
     * padding is inert.
     */
    const window = [
      { id: 'm_pad', authorId: DHLOLO, body: 'Morning all, the CI is green again.' },
      { id: 'm_commit', authorId: JORDAN, body: '@dhlolo will land the narrowing fix on Friday.' },
    ];
    const subject = {
      type: 'commitment' as const,
      provenance: ['m_pad', 'm_commit'],
      quote: '@dhlolo will land the narrowing fix on Friday.',
      statement: '@dhlolo will land the narrowing fix on Friday.',
      proposer: { kind: 'model' as const },
      attributedTo: DHLOLO,
    };
    const problems = validateProposalProvenance(subject, window);
    expect(problems.map((problem) => problem.kind)).toEqual(['attributed_person_not_author']);
    expect(problems[0]?.messageId).toBe('m_commit');
    expect(problems[0]?.detail).toContain('the message bearing it');

    // …and when the owner really did write the bearing sentence, it is clean —
    // the check has not simply become "always third-party".
    expect(
      validateProposalProvenance(
        {
          ...subject,
          quote: "I'll land the narrowing fix on Friday.",
          statement: "I'll land the narrowing fix on Friday.",
          provenance: ['m_pad', 'm_self'],
        },
        [
          ...window,
          { id: 'm_self', authorId: DHLOLO, body: "I'll land the narrowing fix on Friday." },
        ],
      ),
    ).toEqual([]);
  });

  it('reports the same finding at different severities for claim and commitment', () => {
    // The spike's "…or force `attribution: third_party`". On a claim this is a
    // wrong receipt and the reading dies; on a commitment it is precisely the
    // case #4 designs the confirm flow for, and killing it would delete the flow.
    const subject = {
      provenance: [messageDispute.id],
      quote: DISPUTE_SENTENCE,
      statement: DISPUTE_SENTENCE,
      proposer: { kind: 'model' as const },
      attributedTo: DHLOLO,
    };
    const asClaim = validateProposalProvenance({ ...subject, type: 'claim' }, messages);
    const asCommitment = validateProposalProvenance({ ...subject, type: 'commitment' }, messages);

    const attribution = (problems: ReturnType<typeof validateProposalProvenance>) =>
      problems.find((problem) => problem.kind === 'attributed_person_not_author');
    expect(attribution(asClaim)?.severity).toBe('reject');
    expect(attribution(asCommitment)?.severity).toBe('reclassify');
  });

  it('marks every wrong-receipt problem as rejecting', () => {
    const rejecting = validateProposalProvenance(
      {
        type: 'claim',
        provenance: [messageQuotingOpener.id],
        quote: 'I just ran into a problem with this for the first time despite using TypeScript',
        statement:
          'I just ran into a problem with this for the first time despite using TypeScript',
        proposer: { kind: 'model' },
      },
      messages,
    );
    expect(rejecting.map((problem) => problem.severity)).toEqual(['reject']);
  });

  it('does not police attribution on types that name nobody — but still requires their receipt', () => {
    // Catches: re-scoping `missing_quote` to `claim || commitment`. A type that
    // names nobody has no attribution to police and still has a sentence, and
    // r3's gauntlet minted a model objective through the version of this rule
    // that read "no name, no receipt".
    const quoted = DISPUTE_SENTENCE_PLAIN;
    expect(
      problemKinds(
        {
          type: 'open_question',
          provenance: [messageDispute.id],
          quote: quoted,
          statement: quoted,
          proposer: { kind: 'model' },
        },
        messages,
      ),
      // The one finding is about the scissors, not about attribution: an open
      // question names nobody, so `attributed_person_not_author` cannot fire.
    ).toEqual(['quote_omits_surrounding_text']);
    expect(
      problemKinds(
        { type: 'open_question', provenance: [messageDispute.id], proposer: { kind: 'model' } },
        messages,
      ),
    ).toEqual(['missing_quote']);
    expect(
      problemKinds(
        {
          type: 'objective',
          provenance: [messageDispute.id],
          quote: null,
          proposer: { kind: 'model' },
        },
        messages,
      ),
    ).toEqual(['missing_quote']);
  });

  it('covers every problem kind it declares', () => {
    // A taxonomy with an unreachable member is a taxonomy that has drifted.
    //
    // **Driven from `PROVENANCE_PROBLEM_KINDS`, which is what the type is made
    // of.** r4 wrote this list out by hand on the argument that a restated list
    // notices a kind that stops existing — true, and it is blind to a kind that
    // starts existing, which is the failure r4's blind review found one file
    // over (`acceptance.test.ts`'s "reaches every rule name the type declares",
    // silently missing one). Since the type is derived from this array, adding a
    // kind without a case fails here and deleting one fails at its call site.
    const seen = new Set<ProvenanceProblemKind>();
    const cases: Parameters<typeof validateProposalProvenance>[] = [
      // no_provenance
      [{ type: 'claim', provenance: [], proposer: { kind: 'model' } }, messages],
      // unknown_message
      [
        {
          type: 'claim',
          provenance: ['nope'],
          quote: 'I just ran into a problem with this for the first time',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // missing_quote — a model claim that names somebody and quotes nothing
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ],
      // quote_not_found
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'never written anywhere in this whole thread',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // quote_only_in_reply_blockquote
      [
        {
          type: 'claim',
          provenance: [messageQuotingOpener.id],
          quote: 'I just ran into a problem with this for the first time',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // elided_quote
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'While TypeScript is correct that ... after line 6',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // quote_too_short — real words of the cited author, too few to name a sentence
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'line 6',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // quote_does_not_bear_statement — verbatim, right author, wrong sentence
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote:
            "While TypeScript is correct that `this.state` must be `'online'` immediately after line 5",
          statement: 'the release is blocked until the flag ships',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // quote_carries_more_than_statement — every word of the statement is in
      // the quote, in order, and the quote says more. r3's gauntlet lives here.
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote:
            "While TypeScript is correct that `this.state` must be `'online'` immediately after line 5",
          statement: 'TypeScript is correct that this.state must be online after line 5',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // statement_uncheckable — a model reading with a real quote and nothing
      // to check it against. Refused, not skipped.
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote:
            "While TypeScript is correct that `this.state` must be `'online'` immediately after line 5",
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // ambiguous_quote — two cited authors, both saying it in their own words
      [
        {
          type: 'claim',
          provenance: ['m_a', 'm_b'],
          quote: 'we should reset narrowing on mutating method calls',
          proposer: { kind: 'model' },
        },
        [
          {
            id: 'm_a',
            authorId: JORDAN,
            body: 'we should reset narrowing on mutating method calls',
          },
          {
            id: 'm_b',
            authorId: DHLOLO,
            body: 'we should reset narrowing on mutating method calls',
          },
        ],
      ],
      // quote_omits_surrounding_text — whole sentences, and the author wrote more
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: DISPUTE_SENTENCE,
          statement: DISPUTE_SENTENCE,
          proposer: { kind: 'model' },
        },
        messages,
      ],
      // superseded_by_later_message — a later message restates it with a `not`
      [
        {
          type: 'claim',
          provenance: ['m_first'],
          quote: 'We will deploy production on Friday afternoon.',
          statement: 'We will deploy production on Friday afternoon.',
          proposer: { kind: 'model' },
        },
        [
          {
            id: 'm_first',
            authorId: JORDAN,
            body: 'We will deploy production on Friday afternoon.',
          },
          {
            id: 'm_second',
            authorId: JORDAN,
            body: 'Correction: we will not deploy production on Friday afternoon.',
          },
        ],
      ],
      // statement_is_not_an_assertion — a question minted as something else
      [
        {
          type: 'claim',
          provenance: ['m_ask'],
          quote: 'Would we deploy production on Friday afternoon?',
          statement: 'Would we deploy production on Friday afternoon?',
          proposer: { kind: 'model' },
        },
        [
          {
            id: 'm_ask',
            authorId: JORDAN,
            body: 'Would we deploy production on Friday afternoon?',
          },
        ],
      ],
      // attributed_person_not_author
      [
        {
          type: 'commitment',
          provenance: [messageDispute.id],
          quote:
            "While TypeScript is correct that `this.state` must be `'online'` immediately after line 5",
          statement:
            'TypeScript is correct that this.state must be online immediately after line 5',
          proposer: { kind: 'model' },
          attributedTo: DHLOLO,
        },
        messages,
      ],
    ];
    for (const args of cases) {
      for (const problem of validateProposalProvenance(...args)) seen.add(problem.kind);
    }
    expect([...seen].sort()).toEqual([...PROVENANCE_PROBLEM_KINDS].sort());
  });
});
