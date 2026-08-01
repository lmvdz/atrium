import { describe, expect, it } from 'vitest';
import {
  contentTokens,
  type EscalationMessage,
  type EscalationTriggerKind,
  evaluateEscalation,
  hasReplyBlockquote,
  lexicalOverlap,
  normalizeForMatch,
  type ProvenanceProblemKind,
  provenanceIsClean,
  replyBlockquotes,
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

describe('normalizeForMatch — the formatting both tiers drop while quoting', () => {
  it('collapses emphasis, code ticks and whitespace', () => {
    expect(normalizeForMatch('TypeScript **should   not** be so `confident`')).toBe(
      'typescript should not be so confident',
    );
  });

  it('collapses a markdown link to its text', () => {
    expect(normalizeForMatch('see [the playground](https://example.com/x?y=1) for it')).toBe(
      'see the playground for it',
    );
  });

  it('makes a correctly-quoted span match despite dropped markdown', () => {
    // Three of the eight apparent provenance failures in the spike were exactly
    // this: the model quoted correctly and dropped the `**`.
    const source = 'so TypeScript *should not* be so confident that `this.state` is still online';
    const quoted = 'so TypeScript should not be so confident that this.state is still online';
    expect(normalizeForMatch(source)).toContain(normalizeForMatch(quoted));
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

describe('trigger 3 — named-person future tense', () => {
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

  it('passes the same claim when it cites the message its author actually wrote', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageOpener.id],
          quote:
            'I just ran into a problem with this for the first time despite using TypeScript for years.',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual([]);
  });

  it('accepts a quote whose markdown the model dropped', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          // The source says *should not* and `this.state`; the model dropped both.
          quote: 'so TypeScript should not be so confident that this.state is still',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual([]);
  });

  it('rejects a quote elided with an ellipsis that is not verbatim anywhere', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'While TypeScript is correct that ... after line 6',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual(['elided_quote']);
  });

  it('reports a plain missing quote separately from an elided one', () => {
    expect(
      problemKinds(
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'nobody in this thread ever wrote this sentence',
          proposer: { kind: 'model' },
          attributedTo: JORDAN,
        },
        messages,
      ),
    ).toEqual(['quote_not_found']);
  });

  it('catches a cited message that is not in the window', () => {
    expect(
      problemKinds(
        { type: 'claim', provenance: ['msg_nowhere'], proposer: { kind: 'model' } },
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
        proposer: { kind: 'model' },
        attributedTo: DHLOLO,
      },
      messages,
    );
    expect(problems).toEqual(['attributed_person_not_author']);
  });

  it('reports the same finding at different severities for claim and commitment', () => {
    // The spike's "…or force `attribution: third_party`". On a claim this is a
    // wrong receipt and the reading dies; on a commitment it is precisely the
    // case #4 designs the confirm flow for, and killing it would delete the flow.
    const subject = {
      provenance: [messageDispute.id],
      proposer: { kind: 'model' as const },
      attributedTo: DHLOLO,
    };
    const asClaim = validateProposalProvenance({ ...subject, type: 'claim' }, messages);
    const asCommitment = validateProposalProvenance({ ...subject, type: 'commitment' }, messages);

    expect(asClaim[0]?.kind).toBe('attributed_person_not_author');
    expect(asClaim[0]?.severity).toBe('reject');
    expect(asCommitment[0]?.kind).toBe('attributed_person_not_author');
    expect(asCommitment[0]?.severity).toBe('reclassify');
  });

  it('marks every wrong-receipt problem as rejecting', () => {
    const rejecting = validateProposalProvenance(
      {
        type: 'claim',
        provenance: [messageQuotingOpener.id],
        quote: 'I just ran into a problem with this for the first time despite using TypeScript',
        proposer: { kind: 'model' },
      },
      messages,
    );
    expect(rejecting.map((problem) => problem.severity)).toEqual(['reject']);
  });

  it('does not police attribution on types that name nobody', () => {
    expect(
      problemKinds(
        { type: 'open_question', provenance: [messageDispute.id], proposer: { kind: 'model' } },
        messages,
      ),
    ).toEqual([]);
  });

  it('covers every problem kind it declares', () => {
    // A taxonomy with an unreachable member is a taxonomy that has drifted.
    const declared: ProvenanceProblemKind[] = [
      'no_provenance',
      'unknown_message',
      'quote_not_found',
      'quote_only_in_reply_blockquote',
      'elided_quote',
      'attributed_person_not_author',
    ];
    const seen = new Set<ProvenanceProblemKind>();
    const cases: Parameters<typeof validateProposalProvenance>[] = [
      [{ type: 'claim', provenance: [], proposer: { kind: 'model' } }, messages],
      [{ type: 'claim', provenance: ['nope'], proposer: { kind: 'model' } }, messages],
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'never written',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      [
        {
          type: 'claim',
          provenance: [messageQuotingOpener.id],
          quote: 'I just ran into a problem with this for the first time',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      [
        {
          type: 'claim',
          provenance: [messageDispute.id],
          quote: 'While TypeScript is correct that ... after line 6',
          proposer: { kind: 'model' },
        },
        messages,
      ],
      [
        {
          type: 'commitment',
          provenance: [messageDispute.id],
          proposer: { kind: 'model' },
          attributedTo: DHLOLO,
        },
        messages,
      ],
    ];
    for (const args of cases) {
      for (const problem of validateProposalProvenance(...args)) seen.add(problem.kind);
    }
    expect([...seen].sort()).toEqual([...declared].sort());
  });
});
