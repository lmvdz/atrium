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

  // **Sharded by plane, and r7's review is why.** As one `it` this loop measured
  // 5277 ms on the reviewer's machine against vitest's undeclared 5000 ms
  // default, so `pnpm test` was a coin flip — six consecutive runs went 1, 1, 0,
  // 1, 0, 0 — and the two tests it flipped were the two brute forces the whole
  // evidentiary posture of this round rests on. A slower box fails always.
  //
  // Seventeen shards cover 0…0x10FFFF exactly, so the totality claim is
  // unchanged and now auditable a plane at a time; each shard runs in roughly a
  // sixteenth of the time, which keeps the per-test budget in `vitest.config.ts`
  // meaningful instead of merely large. The failure message gains the plane.
  const PLANES = Array.from({ length: 17 }, (_, plane) => plane);
  /**
   * What each shard actually checked, recorded by the shard.
   *
   * **Not arithmetic, and that is the point.** The first draft of the companion
   * test below re-derived the covered count from `PLANES` and asserted it came
   * to 1,112,064 — which is true of the *array* whether or not a single shard
   * ran, so `it.skip` on a plane, a `--sequence` change, or a shard that threw
   * before its first iteration would all have left it green. The count is
   * incremented inside the loop that does the work, so the companion test is
   * evidence about the sweep rather than about seventeen multiplications.
   */
  const sweptPerPlane = new Map<number, number>();
  it.each(PLANES)(
    'reassembles a text built from any code point in plane %i, not only the ones somebody listed',
    (plane) => {
      // The corpus above is a list, and a list is the instrument this package
      // keeps being failed for. So: every code point, between two letters.
      const start = plane * 0x10000;
      let swept = 0;
      for (let cp = start; cp < start + 0x10000; cp += 1) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const char = String.fromCodePoint(cp);
        const text = `x${char}y`;
        if (orderedTokens(text).join('') !== normalizeForReceipt(text)) {
          throw new Error(`U+${cp.toString(16).toUpperCase()} does not reassemble`);
        }
        swept += 1;
      }
      sweptPerPlane.set(plane, swept);
    },
  );

  it('swept every code point across the shards, with nothing between them', () => {
    // The shard boundaries are arithmetic, and arithmetic in a test is a place
    // to drop a range silently. Every shard reported what it checked, and the
    // reports add up to the whole of 0…0x10FFFF with the surrogates excluded and
    // nothing else — which is the number this round's headline is stated in.
    expect(sweptPerPlane.size).toBe(PLANES.length);
    const swept = [...sweptPerPlane.values()].reduce((total, count) => total + count, 0);
    expect(swept).toBe(0x110000 - 0x800);
    expect(swept).toBe(1_112_064);
    expect(PLANES.at(-1) as number).toBe(0x10ffff >>> 16);
    // …and no plane reported the surrogate range as covered.
    expect(sweptPerPlane.get(0)).toBe(0x10000 - 0x800);
    for (const plane of PLANES.slice(1))
      expect(sweptPerPlane.get(plane), `plane ${plane}`).toBe(0x10000);
  });

  it('is borne exactly when the two normalized texts are the same string', () => {
    // **The whole guarantee, as an equivalence rather than an implication.**
    //
    // Until the cross-lineage pass this test could only say "borne implies the
    // texts match once the full stops are removed", and it compared two
    // projections rather than two texts — a probe made out of the thing under
    // test, the class r4 was failed for. With `droppableTokens` gone there is
    // nothing left to project through: `borne` is the string comparison, in both
    // directions, and that is asserted here over every ordered pair in the corpus
    // and over a generated space besides.
    for (const quote of CORPUS) {
      for (const statement of CORPUS) {
        const result = statementBearing(quote, statement);
        if (result.undecidable !== null) continue;
        expect(result.borne, `${JSON.stringify([quote, statement])}`).toBe(
          normalizeForReceipt(quote) === normalizeForReceipt(statement),
        );
      }
    }

    // The generated half, so the corpus is not the only witness. Each piece is a
    // class this file has been broken by: a space, a doubled space, a full stop,
    // an ellipsis, both apostrophes, a backtick, a control character.
    const pieces = ['a', ' ', '  ', '.', '...', "'", '’', '`', '\t', ''];
    for (const p1 of pieces) {
      for (const p2 of pieces) {
        for (const q1 of pieces) {
          for (const q2 of pieces) {
            const quote = `w${p1}${p2}z`;
            const statement = `w${q1}${q2}z`;
            const result = statementBearing(quote, statement);
            if (result.undecidable !== null) continue;
            expect(result.borne, `${JSON.stringify([quote, statement])}`).toBe(
              normalizeForReceipt(quote) === normalizeForReceipt(statement),
            );
          }
        }
      }
    }
  });

  it('refuses the code literal a dropped full stop used to rewrite', () => {
    // **grok's blind pass on r6, and codex's cut-off lead on the same line.**
    // `droppableTokens` held `.` on the argument that "a full stop terminates a
    // sentence and carries no other meaning" — a claim about context, enforced by
    // a set-membership test over every `.` token anywhere. `normalizeForReceipt`
    // preserves code spans byte for byte precisely because they are literals, and
    // then the comparison deleted the dots back out of them.
    //
    // Every row here reached `auto_accept` and folded through `appendEvent`.
    for (const [body, minted] of [
      [
        'Load `.env` before the deploy tonight, everyone.',
        'Load `env` before the deploy tonight, everyone.',
      ],
      [
        'Always cd to `..` before the deploy tonight.',
        'Always cd to `` before the deploy tonight.',
      ],
      [
        'Call the `foo.` method on the object tonight.',
        'Call the `foo` method on the object tonight.',
      ],
      [
        'Set the timeout to `3.` seconds for this job.',
        'Set the timeout to `3` seconds for this job.',
      ],
      [
        'We ship Monday. Then we celebrate with the team.',
        'We ship Monday Then we celebrate with the team.',
      ],
      [
        'We will deploy production Friday tonight.',
        'We. will. deploy. production. Friday. tonight.',
      ],
      ['We will deploy production Friday tonight...', 'We will deploy production Friday tonight'],
    ] as const) {
      expect(statementBearing(body, minted).borne, minted).toBe(false);
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
        minted,
      ).not.toEqual([]);
      expect(
        decideAcceptance(modelClaim(minted, body), {
          messages: room({ id: 'msg_1', authorId: BOB, body }),
        }).verdict,
        minted,
      ).not.toBe('auto_accept');
    }
  });

  it('refers, rather than destroys, the model that drops the trailing full stop', () => {
    // The cost of emptying the set, stated as a disposition. A model that quotes
    // a whole message perfectly and leaves off the final `.` is no longer
    // auto-accepted — and it is not thrown away either: the quote says one thing
    // more than the statement, which is the case `refer` exists for.
    const body = 'We will deploy production on Friday afternoon.';
    const minted = 'We will deploy production on Friday afternoon';
    const messages = room({ id: 'msg_1', authorId: BOB, body });
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: body,
        statement: minted,
        proposer: { kind: 'model' },
        attributedTo: BOB,
      },
      messages,
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['quote_carries_more_than_statement']);
    expect(problems[0]?.severity).toBe('refer');
    const decision = decideAcceptance(modelClaim(minted, body), { messages });
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
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
  // The alphabet carries a space, a doubled space, a full stop, both kinds of
  // quote mark, a backtick, a tab, a newline, a control character, a zero-width
  // space and a bidi override — every class this file has been broken by — in
  // every position of a short sentence.
  const SILENCE_ALPHABET = ['a', ' ', '  ', '.', "'", '`', ',', '?', '\t', '\n', '', '​', '‮'];
  /** Every combination the sweep below ranges over, counted rather than asserted. */
  const SILENCE_PAIRS = SILENCE_ALPHABET.length ** 4;
  const checkedPerShard = new Map<string, number>();

  // **Sharded on the quote's first insert, and r7's review is why.** As one `it`
  // this measured 5277 ms on the reviewer's machine against vitest's undeclared
  // 5000 ms default, so `pnpm test` was a coin flip — six consecutive runs went
  // 1, 1, 0, 1, 0, 0 — and this is one of the two brute forces the round's whole
  // evidentiary posture rests on. Thirteen shards, one per alphabet entry, range
  // over the same product; the test below adds up what they covered.
  it.each(SILENCE_ALPHABET)(
    'never refuses a bearing check without naming the difference (quote insert %j)',
    (p1) => {
      // The rule the whole campaign turns on, as a property over a generated
      // space rather than an example: **a check that ran and refused must report
      // something**, or a refusal and a pass are the same value. `escalation.ts`
      // branches on `borne` and names every way it can be false precisely so
      // this holds by construction; this measures it.
      let checked = 0;
      for (const p2 of SILENCE_ALPHABET) {
        for (const q1 of SILENCE_ALPHABET) {
          for (const q2 of SILENCE_ALPHABET) {
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
              room({ id: 'm1', authorId: BOB, body }),
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
      checkedPerShard.set(p1, checked);
      expect(checked).toBeGreaterThan(1500);
    },
  );

  it('covers the same space the unsharded loop did, shard by shard', () => {
    // Sharding a property is a way to check a fraction of it and report the
    // whole. Every shard ran, and their sum is the full product minus exactly
    // the blank combinations the loop skips — computed here, not asserted.
    expect(checkedPerShard.size).toBe(SILENCE_ALPHABET.length);
    const total = [...checkedPerShard.values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(20000);
    let skipped = 0;
    for (const p1 of SILENCE_ALPHABET) {
      for (const p2 of SILENCE_ALPHABET) {
        for (const q1 of SILENCE_ALPHABET) {
          for (const q2 of SILENCE_ALPHABET) {
            if (
              isBlank(`we will deploy${p1}${p2}production friday`) ||
              isBlank(`we will deploy${q1}${q2}production friday`)
            ) {
              skipped += 1;
            }
          }
        }
      }
    }
    expect(total).toBe(SILENCE_PAIRS - skipped);
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
          room({ id: 'm1', authorId: BOB, body }),
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

  it('refuses a window that stops where the citations stop', () => {
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
    expect(problems[0]?.detail).toContain('the newest message this proposal cites');

    expect(
      decideAcceptance(modelClaim(STATEMENT, STATEMENT), { messages: citedOnly }).verdict,
    ).toBe('pending');

    // **And padding the window with something *earlier* does not satisfy it.**
    // grok's blind pass on r6's first repair: that draft asked whether the
    // window held anything the proposal did not choose, and `[uncited, cited]` —
    // an earlier message, which cannot possibly correct a later one — said yes
    // while the scan read exactly zero messages. The question is what the scan
    // *read*, not what the window happened to contain.
    const paddedBefore: ProvenanceMessage[] = [
      { id: 'm_before', authorId: ALICE, body: 'starting the thread for everyone now' },
      wholeRoom[0] as ProvenanceMessage,
    ];
    expect(validateProposalProvenance(subject, paddedBefore).map((p) => p.kind)).toEqual([
      'superseded_by_later_message',
    ]);
    expect(
      decideAcceptance(modelClaim(STATEMENT, STATEMENT), { messages: paddedBefore }).verdict,
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
      why: 'window_ends_at_the_citations',
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
 * Major (r7) — the gate read a value the model controls
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * **The same boundary, a third time, and the first two repairs are why.**
 *
 * r6 asked its existence question from `firstCited + 1` — the index the *scan*
 * starts at — so the gate passed as soon as some uncited message sat after the
 * **earliest** citation. `provenance` is model-supplied, so citing one extra
 * *earlier* message satisfied it while every message the scan read sat at or
 * before the sentence: `[cited, uncited, cited]`, zero messages read after the
 * quoted sentence, `auto_accept`.
 *
 * Every test in this block fails on `fix/core-engine-r6` as committed.
 *
 * The rule: **the existence test runs from the newest citation.** The scan still
 * starts at the earliest one, because a correction sitting between two citations
 * has to be read — and every direction the proposer can push `lastCited` pushes
 * toward a referral.
 */
describe('r7 — padding the citation list with earlier chatter does not turn the scan on', () => {
  const SENTENCE = 'We will deploy production Friday afternoon as planned.';

  /**
   * The whole exploit, as three messages. The sentence is last in the window —
   * **the ordinary case**, a room read up to its newest message — and the two
   * pad messages are the sort of thing that sits above any sentence in any room.
   */
  const ROOM_MESSAGES: ProvenanceMessage[] = [
    { id: 'msg_a', authorId: BOB, body: 'Morning everyone, standup in five minutes.' },
    { id: 'msg_b', authorId: ALICE, body: 'Anyway, the coffee machine downstairs works again.' },
    { id: 'msg_c', authorId: BOB, body: SENTENCE },
  ];

  const cites = (provenance: string[]) => ({
    type: 'claim' as const,
    provenance,
    quote: SENTENCE,
    statement: SENTENCE,
    proposer: { kind: 'model' as const },
    attributedTo: BOB,
  });

  it('reads the newest citation, not the earliest, so a second citation buys nothing', () => {
    // The pair, at the function. One citation: refused, because nothing after
    // the sentence was read. Two citations, the extra one *earlier* than the
    // sentence: on r6 this returned `{ kind: 'none', scannedAfterCitations: 2 }`
    // — a clean scan — and the two messages it counted are the coffee machine
    // and the sentence itself. Neither is evidence about what came after.
    expect(laterRevision(SENTENCE, ['msg_c'], ROOM_MESSAGES)).toEqual({
      kind: 'unscanned',
      why: 'window_ends_at_the_citations',
    });
    expect(laterRevision(SENTENCE, ['msg_a', 'msg_c'], ROOM_MESSAGES)).toEqual({
      kind: 'unscanned',
      why: 'window_ends_at_the_citations',
    });

    // …and the shape stated as the review stated it: `[cited, uncited, cited]`.
    expect(laterRevision(SENTENCE, ['msg_a', 'msg_b', 'msg_c'], ROOM_MESSAGES)).toEqual({
      kind: 'unscanned',
      why: 'window_ends_at_the_citations',
    });
  });

  it('refuses the padded multi-citation window at both enforcement points', () => {
    // They share `validateProposalProvenance`, so they fall together — which is
    // the reason this defect reached `auto_accept` rather than stopping at the
    // engine.
    for (const provenance of [['msg_c'], ['msg_a', 'msg_c'], ['msg_a', 'msg_b', 'msg_c']]) {
      const label = provenance.join('+');
      const problems = validateProposalProvenance(cites(provenance), ROOM_MESSAGES);
      expect(
        problems.map((problem) => problem.kind),
        label,
      ).toEqual(['superseded_by_later_message']);
      expect(problems[0]?.severity, label).toBe('refer');
      expect(
        decideAcceptance(modelClaim(SENTENCE, SENTENCE, provenance), { messages: ROOM_MESSAGES })
          .verdict,
        label,
      ).toBe('pending');
    }

    // Asserted after the loop, deliberately: the wording changed this round too,
    // and a run on `fix/core-engine-r6` must fail on `auto_accept` — the thing
    // that matters — rather than stopping early on a changed sentence.
    expect(
      validateProposalProvenance(cites(['msg_a', 'msg_c']), ROOM_MESSAGES)[0]?.detail,
    ).toContain('the newest message this proposal cites');
  });

  it('refuses the padded window at the reducer, where it is a boundary', () => {
    // r5's lesson, run over r7's defect: the engine is advice and `appendEvent`
    // is the trust boundary. On r6 this landed the object with outcome
    // `applied`; the single-citation form of the same proposal did not.
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
          payload: { statement: SENTENCE, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_a', 'msg_c'],
          quote: SENTENCE,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages: ROOM_MESSAGES,
        type: 'object_accepted',
        object: {
          id: 'obj_1',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: SENTENCE, claimant: BOB },
          provenance: { messageIds: ['msg_a', 'msg_c'], proposalId: 'prop_1' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toBeTruthy();
  });

  it('still reads a correction sitting between two citations', () => {
    // The other half, and the reason the *scan* keeps its earlier floor. Cite
    // the sentence and something later; the correction in between must still be
    // found. Moving the scan's start to `lastCited` would lose this, which is
    // the defect r6 was fixing when it moved the existence test with it.
    const withCorrection: ProvenanceMessage[] = [
      { id: 'm1', authorId: BOB, body: SENTENCE },
      { id: 'm2', authorId: BOB, body: 'Correction: we will not deploy production Friday.' },
      { id: 'm3', authorId: ALICE, body: 'The staging cluster is green.' },
      UNCITED_TAIL,
    ];
    expect(laterRevision(SENTENCE, ['m1', 'm3'], withCorrection)).toMatchObject({
      kind: 'revision',
      message: { id: 'm2' },
    });
  });

  it('lets a genuinely later window through, so this is not "refuse every window"', () => {
    // The gate is about evidence, not about citation count: the same padded
    // citation list passes the moment one message actually sits after the
    // newest citation.
    const withTail: ProvenanceMessage[] = [...ROOM_MESSAGES, UNCITED_TAIL];
    expect(laterRevision(SENTENCE, ['msg_a', 'msg_c'], withTail)).toEqual({
      kind: 'none',
      scannedAfterCitations: 3,
    });
    expect(kinds(cites(['msg_a', 'msg_c']), withTail)).toEqual([]);
  });

  it('cannot be helped by citing something later either', () => {
    // The mirror direction, stated so the fix is not only "not worse": raising
    // `lastCited` makes the gate stricter. Citing the tail turns a passing
    // window into a refused one, and there is no citation list over this window
    // that both cites the newest message and gets scanned.
    const withTail: ProvenanceMessage[] = [...ROOM_MESSAGES, UNCITED_TAIL];
    expect(laterRevision(SENTENCE, ['msg_c', UNCITED_TAIL.id], withTail)).toEqual({
      kind: 'unscanned',
      why: 'window_ends_at_the_citations',
    });
  });

  it('cannot be helped by dropping the citation that carries the quote', () => {
    // `lastCited` is a sound bound on where the sentence sits only because the
    // bearing message is always cited. Not citing it is refused upstream, so
    // the cheaper way of lowering `lastCited` is not available either.
    expect(kinds(cites(['msg_a']), ROOM_MESSAGES)).toEqual([
      'attributed_person_not_author',
      'quote_not_found',
    ]);
    expect(
      decideAcceptance(modelClaim(SENTENCE, SENTENCE, ['msg_a']), { messages: ROOM_MESSAGES })
        .verdict,
    ).not.toBe('auto_accept');
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

/* ─────────────────────────────────────────────────────────────────────────
 * r7 — the union r6 built, and the three paths that merged it anyway
 * ───────────────────────────────────────────────────────────────────────── */

describe('r7 — "checked and clean" is not the value for "never looked"', () => {
  // Found by this round's own foreign-lineage pass, in the code this round
  // wrote. r6 split `LaterRevision` into a tagged union precisely so *nothing
  // corrects this* and *nothing read the window* could not merge — and three
  // paths returned `scanned(0)`, whose docblock reads "the scan ran to the end
  // of the window and found nothing", for calls that opened nothing.
  //
  // None of the three is an acceptance today: `validateProposalProvenance`
  // rejects every input that reaches them (`unknown_message`,
  // `statement_uncheckable`). **That is the objection, not the defence.** The
  // safety of this function's answer was a property of a different function, and
  // this file's standing lesson is that a rule applied at one site is not a rule.
  //
  // Fails on `fix/core-engine-r6` as committed.
  const room: ProvenanceMessage[] = [
    { id: 'm1', authorId: BOB, body: 'We will deploy production Friday afternoon.' },
    { id: 'm2', authorId: BOB, body: 'Correction: we will not deploy production Friday.' },
    { id: 'm3', authorId: ALICE, body: 'understood, thanks' },
  ];

  it('says it read nothing, rather than reporting a clean scan of nothing', () => {
    // A citation list none of whose ids are in the window. There is a correction
    // sitting in `m2` and this call never looked at it.
    expect(laterRevision('We will deploy production Friday afternoon.', ['ghost'], room)).toEqual({
      kind: 'unscanned',
      why: 'no_citation_in_the_window',
    });
    expect(laterRevision('We will deploy production Friday afternoon.', [], room)).toEqual({
      kind: 'unscanned',
      why: 'no_citation_in_the_window',
    });

    // …and the two statement-shaped ways in.
    expect(laterRevision('   ', ['m1'], room)).toEqual({
      kind: 'unscanned',
      why: 'no_statement_to_scan_for',
    });
    expect(laterRevision('...', ['m1'], room)).toEqual({
      kind: 'unscanned',
      why: 'no_statement_to_scan_for',
    });

    // The anti-vacuity half: a real scan still reports `none` with its extent,
    // so this is not "never say clean".
    expect(
      laterRevision(
        'We will deploy production Friday afternoon.',
        ['m1'],
        [
          room[0] as ProvenanceMessage,
          { id: 'm2', authorId: ALICE, body: 'The staging cluster is green.' },
          { id: 'm3', authorId: ALICE, body: 'understood, thanks' },
        ],
      ),
    ).toEqual({ kind: 'none', scannedAfterCitations: 2 });
  });

  it('never reports a clean scan that read zero messages', () => {
    // The property the three paths broke, stated as a property: `none` with
    // `scannedAfterCitations: 0` claims a completed scan of nothing, and the
    // window gate makes it unreachable. Ranged over every citation list this
    // window admits, rather than over the three inputs that were found.
    const ids = ['ghost', 'm1', 'm2', 'm3'];
    const lists: string[][] = [[]];
    for (const a of ids) {
      lists.push([a]);
      for (const b of ids) lists.push([a, b]);
    }
    for (const cites of lists) {
      for (const statement of ['We will deploy production Friday afternoon.', '', '   ', '...']) {
        const result = laterRevision(statement, cites, room);
        if (result.kind !== 'none') continue;
        expect(result.scannedAfterCitations, JSON.stringify([statement, cites])).toBeGreaterThan(0);
      }
    }
  });

  it('reports the missing statement once, not twice', () => {
    // The caller does not ask a question it has already refused: a proposal with
    // no statement is `statement_uncheckable` / `reject`, and telling the room a
    // second time that a check it could never have run did not run is noise, not
    // evidence.
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['m1'],
        quote: 'We will deploy production Friday afternoon.',
        proposer: { kind: 'model' },
      },
      room,
    );
    expect(problems.map((problem) => problem.kind)).toContain('statement_uncheckable');
    expect(problems.every((problem) => problem.severity === 'reject')).toBe(true);
  });
});
