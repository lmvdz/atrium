import { describe, expect, it } from 'vitest';
import {
  decideAcceptance,
  hasReplyBlockquote,
  isBlank,
  laterRevision,
  normalizeForReceipt,
  orderedTokens,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  type ProvenanceProblem,
  RECEIPT_POLICY,
  reduce,
  routingTokens,
  SED_CORRECTION,
  sentencesOf,
  statementBearing,
  stripReplyBlockquotes,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, event, model, ROOM, room, UNCITED_TAIL } from './fixtures.js';

/**
 * **Round 6: what the comparison actually compares.**
 *
 * r5's receipt held against every attempt to move the scissors. It failed on
 * what sat underneath: `statementBearing` proved *token* equality and claimed
 * *text* equality, in those words, in two docblocks and in `RECEIPT_POLICY`.
 * `orderedTokens` discarded all whitespace and every standalone apostrophe, and
 * that comparison is the only one the acceptance path makes between the quote
 * and the statement being minted — so four bodies, quoted verbatim, minted a
 * `payload.statement` their named author never wrote and reached `auto_accept`.
 *
 * Every test here fails on `fix/core-engine-r5` as committed.
 *
 * The rule they pin, stated once and provable rather than asserted: **the token
 * stream reassembles the text it came from**, so two equal token streams are two
 * equal texts, so `borne` means what the docblock has always said it meant.
 */

const kinds = (...args: Parameters<typeof validateProposalProvenance>): string[] =>
  validateProposalProvenance(...args)
    .map((problem) => problem.kind)
    .sort();

const severities = (...args: Parameters<typeof validateProposalProvenance>): string[] => [
  ...new Set(
    validateProposalProvenance(...args).map((problem: ProvenanceProblem) => problem.severity),
  ),
];

function modelClaim(statement: string, quote: string, provenance = ['msg_1']): Proposal {
  return ProposalSchema.parse({
    id: 'prop_r6',
    roomId: ROOM,
    type: 'claim',
    payload: { statement, claimant: BOB },
    confidence: 0.95,
    proposer: { kind: 'model', model: 'test-model' },
    provenance,
    quote,
    createdAt: at(1),
  }) as Proposal;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Major 1 — the tokenizer discarded what the receipt claimed to prove
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The corpus every property below runs over. Chosen to hit each rule the
 * tokenizer and the fold argue about, in every script and shape the file has
 * been broken by.
 */
const CORPUS = [
  '',
  ' ',
  '.',
  'a',
  "won't",
  "'online' state",
  '`a  b`',
  'Set the deployment password to `a  b` today, everyone.',
  'Run `rm -rf / tmp/cache` on the box tonight.',
  'We will deploy production Friday, promise.',
  "'We will deploy production Friday.'",
  '‘We will deploy production Friday.’',
  'Bob will не развернёт продакшен',
  '❌ Bob will 🚫 deploy 🇺🇸 production',
  'Use [https://safe.example/a](https://evil.example/a) today.',
  '```\nDeploy production Friday.\n```',
  'a​b﻿c',
  'xyzw',
  'so **TypeScript** should not — 2*3*4 — src/*.ts*.map',
  'While TypeScript is correct that ... after line 6',
  'Mr. Smith will deploy 1.5 boxes.',
  'multi\nline\tbody\r\nwith  spacing',
];

describe('r6 — the token stream is the text, so token equality is text equality', () => {
  it('reassembles the normalized text exactly, for every text', () => {
    // **The load-bearing assertion of the round.** Everything `statementBearing`
    // claims follows from this one line: if joining the tokens rebuilds the
    // normalized text, then two equal token streams are two equal texts, and
    // `borne` is a fact about the strings rather than about a projection of them.
    //
    // r5's tokenizer, `[^\s']`, fails this on any text with a space in it.
    for (const text of CORPUS) {
      expect(orderedTokens(text).join(''), JSON.stringify(text)).toBe(normalizeForReceipt(text));
    }
  });

  it('reassembles a text built from any code point, not only the ones somebody listed', () => {
    // The corpus above is a list, and a list is the instrument this package keeps
    // being failed for. So: every code point, in a word, on its own, and between
    // two letters.
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      const text = `x${char}y`;
      if (orderedTokens(text).join('') !== normalizeForReceipt(text)) {
        throw new Error(`U+${cp.toString(16).toUpperCase()} does not reassemble`);
      }
    }
  });

  it('never reports borne for two texts that are not the same text', () => {
    // The theorem the reassembly buys, checked over every ordered pair in the
    // corpus: `borne` implies the two normalized texts are equal once the
    // droppable tokens are taken out of each. Nothing here inspects *how* the
    // alignment decided; it checks the claim the docblock makes.
    //
    // **The comparison runs over `normalizeForReceipt` and not over the tokens.**
    // Computing it from `orderedTokens` would be a probe made out of the thing
    // under test — the class r4 was failed for and r6 found twice more — and it
    // passes on `fix/core-engine-r5` for exactly that reason: r5's tokenizer
    // drops the spaces on *both* sides, so a projection is compared with itself.
    // The full stop is spelled out because it is the only member of the set, and
    // the line above holds that to be true.
    expect([...RECEIPT_POLICY.droppableTokens].sort()).toEqual(['.']);
    const withoutDroppable = (text: string): string =>
      normalizeForReceipt(text).replaceAll('.', '').replace(/\s+/gu, ' ').trim();

    for (const quote of CORPUS) {
      for (const statement of CORPUS) {
        const result = statementBearing(quote, statement);
        if (!result.borne) continue;
        expect(withoutDroppable(quote), `"${quote}" was borne by "${statement}"`).toBe(
          withoutDroppable(statement),
        );
      }
    }
  });

  it('is borne by itself, for every text in the corpus that has content', () => {
    // The other direction, so "never borne" is not how the property above passes.
    for (const text of CORPUS) {
      // Emptiness is a property of the content, not of the container: `"."` and
      // `" "` carry no letter, digit or pictograph, so they are refused as blank
      // before the alignment ever runs. That rule is `bearing.test.ts`'s.
      if (isBlank(text)) continue;
      if (orderedTokens(text).length > RECEIPT_POLICY.maxAlignedTokens) continue;
      expect(statementBearing(text, text).borne, JSON.stringify(text)).toBe(true);
    }
  });
});

describe('r6 — a receipt that refuses says what it found', () => {
  it('never refuses a bearing check without naming the difference', () => {
    // The rule the whole campaign turns on, as a property over a generated space
    // rather than an example: **a check that ran and refused must report
    // something**, or a refusal and a pass are the same value. `escalation.ts`
    // branches on `borne` and names every way it can be false precisely so this
    // holds by construction; this measures it.
    //
    // The alphabet carries a space, a doubled space, a full stop, both kinds of
    // quote mark, a backtick, a tab, a newline, a control character, a
    // zero-width space and a bidi override — every class this file has been
    // broken by — in every position of a short sentence.
    const alphabet = ['a', ' ', '  ', '.', "'", '`', ',', '?', '\t', '\n', '', '​', '‮'];
    let checked = 0;
    for (const p1 of alphabet) {
      for (const p2 of alphabet) {
        for (const q1 of alphabet) {
          for (const q2 of alphabet) {
            const body = `we will deploy${p1}${p2}production friday`;
            const minted = `we will deploy${q1}${q2}production friday`;
            if (isBlank(body) || isBlank(minted)) continue;
            checked += 1;
            const problems = validateProposalProvenance(
              {
                type: 'claim',
                provenance: ['m1'],
                quote: body,
                statement: minted,
                proposer: { kind: 'model' },
                attributedTo: BOB,
              },
              [
                { id: 'm0', authorId: ALICE, body: 'earlier unrelated chatter' },
                { id: 'm1', authorId: BOB, body },
              ],
            );
            if (!statementBearing(body, minted).borne) {
              expect(
                problems.length,
                `${JSON.stringify([body, minted])} refused silently`,
              ).toBeGreaterThan(0);
            }
            for (const problem of problems) {
              expect(problem.detail.length, problem.kind).toBeGreaterThan(20);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20000);
  });

  it('never refuses a message quoted as itself', () => {
    // The anti-vacuity half: the property above is satisfied by a check that
    // refuses everything, so the same alphabet has to come back clean when the
    // statement really is the quote.
    const alphabet = ['a', ' ', '  ', '.', "'", '`', ',', '\t', '\n', '', '​'];
    for (const p1 of alphabet) {
      for (const p2 of alphabet) {
        const body = `we will deploy${p1}${p2}production on friday afternoon`;
        if (isBlank(body)) continue;
        const problems = validateProposalProvenance(
          {
            type: 'claim',
            provenance: ['m1'],
            quote: body,
            statement: body,
            proposer: { kind: 'model' },
            attributedTo: BOB,
          },
          [
            { id: 'm0', authorId: ALICE, body: 'earlier unrelated chatter' },
            { id: 'm1', authorId: BOB, body },
          ],
        );
        expect(
          problems.map((problem) => problem.kind),
          JSON.stringify(body),
        ).toEqual([]);
      }
    }
  });
});

describe('r6 — the four bodies that minted a sentence nobody wrote', () => {
  /**
   * Each row is a message body, quoted **verbatim and in its entirety**, and the
   * statement r5 minted from it. Every one reached `auto_accept` and applied
   * through `appendEvent` as a model actor.
   */
  const ROWS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a space inside a code literal moves a path',
      'Run `rm -rf / tmp/cache` on the box tonight, everyone.',
      'Run `rm -rf /tmp/cache` on the box tonight, everyone.',
    ],
    [
      'a doubled space inside a code literal is a different password',
      'Set the deployment password to `a  b` today, everyone.',
      'Set the deployment password to `a b` today, everyone.',
    ],
    [
      'quotation marks added around two words',
      'We will deploy production Friday, everyone, promise.',
      "We will 'deploy' production 'Friday', everyone, promise.",
    ],
    [
      'a displayed sentence minted as an asserted one',
      "'We will deploy production on Friday afternoon.'",
      'We will deploy production on Friday afternoon.',
    ],
  ];

  it('refuses every one of the four at the engine', () => {
    for (const [name, body, minted] of ROWS) {
      const messages = room({ id: 'msg_1', authorId: BOB, body });
      expect(statementBearing(body, minted).borne, name).toBe(false);
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
          messages,
        ),
        name,
      ).not.toEqual([]);

      const decision = decideAcceptance(modelClaim(minted, body), { messages });
      expect(decision.verdict, name).not.toBe('auto_accept');
    }
  });

  it('refuses every one of the four at the reducer, where it is a boundary', () => {
    // The engine is advice; `appendEvent` is the trust boundary, and r5's
    // finding was that all four applied there as a model actor.
    for (const [name, body, minted] of ROWS) {
      const messages = room({ id: 'msg_1', authorId: BOB, body });
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
            payload: { statement: minted, claimant: BOB },
            confidence: 0.95,
            proposer: { kind: 'model', model: 'test-model' },
            provenance: ['msg_1'],
            quote: body,
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
            payload: { statement: minted, claimant: BOB },
            provenance: { messageIds: ['msg_1'], proposalId: 'prop_1' },
            createdAt: at(2),
            updatedAt: at(2),
          },
        }),
      ]);
      expect(state.objects, name).toEqual({});
      expect(state.issues.at(-1)?.reason, name).toBeTruthy();
    }
  });

  it('accepts each of them when the statement really is the quote', () => {
    // …so the four refusals above are about the difference, not about the check
    // having been broken into refusing everything with a backtick in it.
    for (const [, body] of ROWS) {
      const messages = room({ id: 'msg_1', authorId: BOB, body });
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
          messages,
        ),
        body,
      ).toEqual([]);
    }
  });

  it('names the difference in a form a reader can act on', () => {
    // A refusal that reads `the quote says ""` is a refusal nobody can use, and
    // `orderedTokens` emits characters with no glyph now. Spacing gets its own
    // problem kind rather than a `" "` in a list; an invisible token is named by
    // its code point.
    const respaced = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: 'Set the deployment password to `a  b` today, everyone.',
        statement: 'Set the deployment password to `a b` today, everyone.',
        proposer: { kind: 'model' },
      },
      room({
        id: 'msg_1',
        authorId: BOB,
        body: 'Set the deployment password to `a  b` today, everyone.',
      }),
    );
    expect(respaced.map((problem) => problem.kind)).toEqual(['statement_respaces_the_quote']);
    expect(respaced[0]?.detail).toContain('spaces them differently');

    const invisible = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: 'We will deploy production on Friday afternoon.',
        statement: 'We will deploy production on Friday afternoon.',
        proposer: { kind: 'model' },
      },
      room({
        id: 'msg_1',
        authorId: BOB,
        body: 'We will deploy production on Friday afternoon.',
      }),
    );
    expect(invisible.map((problem) => problem.kind)).toEqual(['quote_does_not_bear_statement']);
    expect(invisible[0]?.detail).toContain('U+0001');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Moderate 3 — an unjudgeable input is referred, not destroyed
 * ───────────────────────────────────────────────────────────────────────── */

describe('r6 — a message too long to align is referred, never discarded', () => {
  /** An ordinary long design comment: over the cap, quoted whole, correct in every other way. */
  const LONG = `${Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')}.`;

  it('is past the cap, so this test is about the cap and not about a long sentence', () => {
    expect(orderedTokens(LONG).length).toBeGreaterThan(RECEIPT_POLICY.maxAlignedTokens);
    expect(statementBearing(LONG, LONG).undecidable).toBe('too_long');
  });

  it('refers it rather than rejecting it', () => {
    // `refer` is defined as "the check cannot judge this, so a person must —
    // never auto-accepted, **never discarded**", and `undecidable` is defined as
    // "the check declined to run at all". r5 gave this `reject`, which
    // `acceptance.ts` turns into `discard`: the reading was destroyed and the
    // room was told its citation had failed, which was not true.
    const messages = room({ id: 'msg_1', authorId: BOB, body: LONG });
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: LONG,
        statement: LONG,
        proposer: { kind: 'model' },
        attributedTo: BOB,
      },
      messages,
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['statement_uncheckable']);
    expect(problems[0]?.severity).toBe('refer');
    expect(problems[0]?.detail).toContain('never checked');

    const decision = decideAcceptance(modelClaim(LONG, LONG), { messages });
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
    expect(decision.rule).toBe('receipt_not_certifiable');
  });

  it('still rejects the two that are genuinely malformed', () => {
    // The split is by *why* the check declined. No statement and no quote are
    // malformed readings — there is no sentence, so there is nothing to show a
    // person either.
    const messages = room({ id: 'msg_1', authorId: BOB, body: 'the build is green on main' });
    expect(
      severities(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: 'the build is green on main',
          proposer: { kind: 'model' },
        },
        messages,
      ),
    ).toEqual(['reject']);
    expect(statementBearing('the build is green on main', '').undecidable).toBe('empty_statement');
    expect(statementBearing('', 'the build is green on main').undecidable).toBe('empty_quote');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Moderate 4 — a window the proposal chose is not a window
 * ───────────────────────────────────────────────────────────────────────── */

describe('r6 — the correction scan cannot be turned off by the window the caller passes', () => {
  const STATEMENT = 'We will deploy production on Friday afternoon.';
  const wholeRoom: ProvenanceMessage[] = [
    { id: 'msg_1', authorId: BOB, body: STATEMENT },
    { id: 'msg_2', authorId: BOB, body: 'Correction: we will not deploy production on Friday.' },
  ];
  const subject = {
    type: 'claim' as const,
    provenance: ['msg_1'],
    quote: STATEMENT,
    statement: STATEMENT,
    proposer: { kind: 'model' as const },
    attributedTo: BOB,
  };

  it('refuses a window that is nothing but the messages the proposal cites', () => {
    // The demonstration, in one pair: the same proposal, refused against the room
    // and auto-accepted against "the messages this receipt cites" — which is the
    // natural reading of the field and what `commitmentAttribution` narrows to one
    // function over. r5 had no contract and no check, so truncation was invisible
    // in exactly the way `messages: []` and `[{ body: '' }]` were before it.
    expect(kinds(subject, wholeRoom)).toEqual(['superseded_by_later_message']);

    const citedOnly = wholeRoom.filter((message) => message.id === 'msg_1');
    const problems = validateProposalProvenance(subject, citedOnly);
    expect(problems.map((problem) => problem.kind)).toEqual(['superseded_by_later_message']);
    expect(problems[0]?.severity).toBe('refer');
    expect(problems[0]?.detail).toContain('nothing but');

    expect(
      decideAcceptance(modelClaim(STATEMENT, STATEMENT), { messages: citedOnly }).verdict,
    ).toBe('pending');
  });

  it('says how far it read, so "found nothing" is not "read nothing"', () => {
    // The other half of the finding: nothing recorded the scan's extent, so a
    // clean result and an unperformed one were the same value.
    const scanned = laterRevision(
      STATEMENT,
      ['msg_1'],
      [
        { id: 'msg_1', authorId: BOB, body: STATEMENT },
        { id: 'msg_2', authorId: ALICE, body: 'The staging cluster is green.' },
        UNCITED_TAIL,
      ],
    );
    expect(scanned).toEqual({ kind: 'none', scannedAfterCitations: 2 });

    expect(laterRevision(STATEMENT, ['msg_1'], wholeRoom)).toMatchObject({ kind: 'revision' });
    expect(laterRevision(STATEMENT, ['msg_1'], [wholeRoom[0] as ProvenanceMessage])).toEqual({
      kind: 'unscanned',
      why: 'window_is_only_the_citations',
    });
  });

  it('is a tagged union, so the three answers cannot be told apart by truthiness', () => {
    // `RETRO.md`: validate a union by its tag, not by key presence. Until r6 this
    // was `{…} | 'unscanned' | null` and every caller used falsiness — three
    // states one refactor away from being one, and the two that must never merge
    // are *nothing corrects this* and *nothing read the window*.
    const tags = new Set<string>();
    tags.add(laterRevision(STATEMENT, ['msg_1'], wholeRoom).kind);
    tags.add(laterRevision(STATEMENT, ['msg_1'], [wholeRoom[0] as ProvenanceMessage]).kind);
    tags.add(
      laterRevision(
        STATEMENT,
        ['msg_1'],
        [{ id: 'msg_1', authorId: BOB, body: STATEMENT }, UNCITED_TAIL],
      ).kind,
    );
    expect([...tags].sort()).toEqual(['none', 'revision', 'unscanned']);
  });

  it('lets the ordinary window through, so this is not "refuse every window"', () => {
    expect(
      kinds(subject, [
        { id: 'msg_1', authorId: BOB, body: STATEMENT },
        { id: 'msg_2', authorId: ALICE, body: 'The staging cluster is green.' },
      ]),
    ).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * The minors that were false statements about the code
 * ───────────────────────────────────────────────────────────────────────── */

describe('r6 — the stated limits are the real ones', () => {
  it('fires the sed-correction pattern on a URL, which its comment denied', () => {
    // `escalation.ts` claimed a URL could not match because "the `s` is preceded
    // by a word character and `\b` fails". True of the `s` in `https`, false of a
    // path segment named `s`. The disposition is unchanged — a hit only ever adds
    // a referral — and the comment now says what the pattern does.
    expect(SED_CORRECTION.test('https://x.example/s/abc/def/')).toBe(true);
    expect(SED_CORRECTION.test('s/wrong/right/')).toBe(true);
    // …and the shapes it really does miss.
    expect(SED_CORRECTION.test('https://x.example/app')).toBe(false);
    expect(SED_CORRECTION.test('docs/api/v1/')).toBe(false);
  });

  it('reads a line break the way every renderer does, not the way a newline does', () => {
    // **This round's own fix, run back over the rest of the package.** Once
    // `\p{White_Space}` replaced `\s` in the fold, `split('\n')` and
    // `sentencesOf`'s `\n+` were the same defect at the other question: U+0085
    // NEL, U+2028 and U+2029 end a line everywhere a line is rendered.
    //
    // A body whose breaks are NEL was **one line**, so a reply-blockquote on its
    // first line swallowed the author's own words with it, and a multi-sentence
    // body read as a single sentence — which is `quoteSpansWholeSentences`'
    // whole input. Both failed closed, which is why they survived; a refusal for
    // a reason nobody wrote down is one refactor from an acceptance for it.
    for (const separator of ['\n', '\u0085', '\u2028', '\u2029', '\r\n']) {
      expect(
        sentencesOf(`One sentence${separator}Two sentence`),
        JSON.stringify(separator),
      ).toEqual(['One sentence', 'Two sentence']);
      expect(
        stripReplyBlockquotes(`> somebody else wrote this${separator}Agreed, all of it.`),
        JSON.stringify(separator),
      ).toContain('Agreed, all of it.');
      expect(hasReplyBlockquote(`Agreed.${separator}> somebody else wrote this`)).toBe(true);
    }

    // …and the quote-anchoring check reads the sentences, so a NEL-separated
    // neighbour is a neighbour: quoting one sentence of two is a referral, not a
    // clean receipt.
    const body = 'We will deploy production Friday.\u0085Not.';
    expect(
      kinds(
        {
          type: 'claim',
          provenance: ['msg_1'],
          quote: 'We will deploy production Friday.',
          statement: 'We will deploy production Friday.',
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        room({ id: 'msg_1', authorId: BOB, body }),
      ),
    ).toEqual(['quote_omits_surrounding_text']);
  });

  it('drops whitespace from the detector"s tokens and only from the detector"s', () => {
    // Two tokenizations, one difference, and the difference is measured rather
    // than asserted: the routing fold has already collapsed every run to one
    // space, so a space token there carries no information — and carrying it
    // anyway made the correction scan resynchronise on the space instead of the
    // word, so a plain contradiction read as an unrelated sentence.
    expect(orderedTokens('we will not deploy')).toContain(' ');
    expect(routingTokens('we will not deploy')).not.toContain(' ');
    expect(routingTokens('we will not deploy')).toEqual(['we', 'will', 'not', 'deploy']);

    const negated = 'We will not deploy production Friday.';
    expect(
      laterRevision(
        negated,
        ['msg_1'],
        [
          { id: 'msg_1', authorId: BOB, body: negated },
          { id: 'msg_2', authorId: BOB, body: 'We will deploy production Friday.' },
        ],
      ),
    ).toMatchObject({ kind: 'revision', added: ['not'] });
  });
});
