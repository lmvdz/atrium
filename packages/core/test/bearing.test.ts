import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectType,
  decideAcceptance,
  hasContent,
  isBlank,
  normalizeForMatch,
  orderedTokens,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  projectAttention,
  RECEIPT_POLICY,
  reduce,
  statementBearing,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, event, model, ROOM } from './fixtures.js';

/**
 * **Round 3's gauntlet, major 1: the receipt accepted the negation of what it
 * validated.**
 *
 * > `escalation.ts:248` classifies `not` as a stopword, `contentTokens` (`:320`)
 * > deduplicates, and `lexicalOverlap` (`:338`) measures token-set containment. A
 * > model cites *"Bob will not deploy production Friday"* and mints *"Bob will
 * > deploy production Friday"*: long, verbatim, correctly attributed, **100%
 * > support**, auto-accepted at sufficient confidence.
 *
 * Every test in this file names the mutation it catches, and every one of them
 * fails on `fix/core-engine-r3`.
 *
 * The rule they pin, stated once: **auto-acceptance requires the asserted
 * statement to be the quoted span with nothing removed but the articles in
 * `RECEIPT_POLICY.droppableWords`, in the order it was written.** There is one
 * affirmative answer and two negative ones — the statement says something the
 * quote does not (wrong, discarded) and the quote says something the statement
 * drops (unjudgeable, referred to a person) — and no third disposition where a
 * machine gets to decide it is probably fine.
 */

/** The pair from the receipt, verbatim. */
const TRUTH = 'Bob will not deploy production Friday';
const INVERSION = 'Bob will deploy production Friday';

const window: ProvenanceMessage[] = [{ id: 'msg_1', authorId: BOB, body: TRUTH }];

function modelProposal(overrides: {
  type?: AcceptedObjectType;
  statement: string;
  quote: string | null;
  claimant?: string;
  provenance?: string[];
  confidence?: number;
}): Proposal {
  const type = overrides.type ?? 'claim';
  const payload: Record<string, unknown> =
    type === 'claim'
      ? { statement: overrides.statement, claimant: overrides.claimant ?? BOB }
      : type === 'commitment'
        ? { statement: overrides.statement, owner: overrides.claimant ?? BOB }
        : type === 'open_question'
          ? { question: overrides.statement }
          : type === 'objective'
            ? { title: overrides.statement }
            : { statement: overrides.statement };
  return ProposalSchema.parse({
    id: 'prop_1',
    roomId: ROOM,
    type,
    payload,
    confidence: overrides.confidence ?? 0.95,
    proposer: { kind: 'model', model: 'test-model' },
    provenance: overrides.provenance ?? ['msg_1'],
    quote: overrides.quote,
    createdAt: at(1),
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * The finding itself, at every layer that could have accepted it
 * ───────────────────────────────────────────────────────────────────────── */

describe('the receipt refuses the negation of the sentence it validates', () => {
  it('refuses the exact pair from the gauntlet at the acceptance engine', () => {
    // Catches: `bearing_forgives_interposed_words`, `receipt_policy_droppable_widened`,
    // `quote_bearing_disabled`. On r3 this returned `auto_accept` at 100%
    // support, because `not` was a stopword and overlap was set containment.
    const decision = decideAcceptance(
      modelProposal({ statement: INVERSION, quote: TRUTH }),
      { messages: window },
    );

    expect(decision.verdict).not.toBe('auto_accept');
    expect(decision.visibility).not.toBe('accepted');
    expect(decision.rule).toBe('receipt_not_certifiable');
    expect(decision.reason).toContain('"not"');
    expect(decision.reason).toContain('a person has to read the quote');
  });

  it('refuses the exact pair from the gauntlet at the reducer, where it is a boundary', () => {
    // Catches: `refer_severity_ignored_reducer`. The engine is what a worker
    // asks; the reducer is what nothing can route around, and r3's finding
    // reached an accepted object through both.
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_neg',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: INVERSION, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote: TRUTH,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages: window,
        type: 'object_accepted',
        object: {
          id: 'obj_neg',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: INVERSION, claimant: BOB },
          provenance: { messageIds: ['msg_1'], proposalId: 'prop_neg' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);

    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('declines to rule on');
    expect(state.issues.at(-1)?.reason).toContain('"not"');
  });

  it('accepts the sentence Bob actually wrote, so the rule is not "refuse everything"', () => {
    // Catches: any mutation that makes `statementBearing` always false — the
    // refusals above have to be about the negation, not about the check being
    // broken.
    const decision = decideAcceptance(modelProposal({ statement: TRUTH, quote: TRUTH }), {
      messages: window,
    });
    expect(decision.verdict).toBe('auto_accept');
  });

  it('leaves the reading staged rather than deleting it, so a person sees the discrepancy', () => {
    // Catches: giving `quote_carries_more_than_statement` `reject` severity.
    // Discarding would hide the inversion; the whole value of a receipt is that
    // a person can put the quote beside the statement and see it.
    const decision = decideAcceptance(
      modelProposal({ statement: INVERSION, quote: TRUTH }),
      { messages: window },
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
  });

  it('silences the confirm request and records why, rather than asking Bob to confirm it', () => {
    // Catches: `attention_certifiable_silence_dropped`. A third-party commitment
    // that may be the negation of what somebody wrote must not turn into a
    // notification asking them to confirm it.
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_commit',
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: INVERSION, owner: ALICE },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote: TRUTH,
          createdAt: at(1),
        },
      }),
    ]);
    const panel = projectAttention(state, { now: at(3), messages: window });
    expect(panel.items).toEqual([]);
    expect(panel.refusals.map((refusal) => refusal.proposalId)).toEqual(['prop_commit']);
    expect(panel.refusals[0]?.reason).toContain('"not"');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * The adversarial table
 * ───────────────────────────────────────────────────────────────────────── */

describe('statementBearing — the evasions a stopword list cannot enumerate', () => {
  /**
   * Each of these is a quote and a statement that a *lexical overlap* check
   * scores as support. They are written out one by one rather than table-driven
   * on purpose: a ledger entry has to be able to name the test that pins it, and
   * a template-titled test has no name to give.
   *
   * The point they make together is that none of them is on a list. The check has
   * no list of dangerous words — only three articles that may differ — so a form
   * nobody thought of fails by default instead of passing by default.
   */
  const refuses = (quote: string, statement: string) => {
    const result = statementBearing(quote, statement);
    expect(result.borne, `"${statement}" must not be borne by "${quote}"`).toBe(false);
    expect(result.undecidable).toBeNull();
    expect(
      result.unmatchedInQuote.length + result.unmatchedInStatement.length,
      'the refusal must name the discrepancy',
    ).toBeGreaterThan(0);
    return result;
  };

  it('refuses negation', () => {
    // Catches: `bearing_forgives_interposed_words`, `receipt_policy_droppable_widened`.
    // The pair from r3's gauntlet, at the function.
    expect(refuses(TRUTH, INVERSION).unmatchedInQuote).toEqual(['not']);
  });

  it('refuses double negation', () => {
    // Catches: `ordered_tokens_dedup`. A Set cannot hold two `not`s.
    refuses('Bob will not not deploy production Friday', 'Bob will not deploy production Friday');
  });

  it('refuses "no longer"', () => {
    // Catches: `bearing_drops_short_tokens`. `no` is two characters, and
    // `contentTokens` drops anything under three.
    refuses(
      'we are no longer shipping the flag this quarter',
      'we are shipping the flag this quarter',
    );
  });

  it('refuses a trailing "unless"', () => {
    // Catches: `bearing_forgives_the_tail`. The condition is *after* the span the
    // statement covers, so checking only the covering span misses it entirely.
    refuses('we ship on Friday unless the migration is still red', 'we ship on Friday');
  });

  it('refuses a trailing "except"', () => {
    // Catches: `bearing_forgives_the_tail`.
    refuses(
      'every service restarts tonight except the payments worker',
      'every service restarts tonight',
    );
  });

  it('refuses a quote that is a superset carrying an unrelated sentence', () => {
    // Catches: `bearing_forgives_the_tail`. The statement is in there verbatim,
    // and what else is in there is not something a string comparison can weigh.
    refuses(
      'Bob will deploy production Friday, and separately the payments worker is broken',
      'Bob will deploy production Friday',
    );
  });

  it('refuses a contracted modal read as its expansion', () => {
    // Catches: `bearing_forgives_missing_statement_words`. `won\'t` is not `will`.
    refuses("Bob won't deploy production Friday", 'Bob will deploy production Friday');
  });

  it('refuses "declined to" read as an intention', () => {
    // Catches: `bearing_forgives_the_tail`, `bearing_forgives_missing_statement_words`.
    refuses('Bob declined to deploy production on Friday', 'Bob will deploy production on Friday');
  });

  it('refuses a quantifier flip from all to some', () => {
    // Catches: `bearing_forgives_missing_statement_words`. `all` and `some` are
    // both on r3's stopword list, so this scored 100% support there.
    refuses('all of the services restart tonight', 'some of the services restart tonight');
  });

  it('refuses a quantifier flip from none to some', () => {
    // Catches: `bearing_forgives_missing_statement_words`.
    refuses('none of the services restart tonight', 'some of the services restart tonight');
  });

  it('refuses a modal flip from might to will', () => {
    // Catches: `bearing_forgives_missing_statement_words`. `might` and `will` are
    // the difference between a plan and a fact.
    refuses('we might cut the release on Friday', 'we will cut the release on Friday');
  });

  it('refuses a modal flip from must not to must', () => {
    // Catches: `bearing_forgives_interposed_words`.
    refuses('we must not cut the release on Friday', 'we must cut the release on Friday');
  });

  it('refuses a leading hedge the statement drops', () => {
    // Catches: `bearing_forgives_interposed_words`. The qualifier is *before* the
    // span, which is the other half of why the whole quote has to be accounted
    // for rather than only the part the statement covers.
    refuses("I don't think Bob will deploy production Friday", 'Bob will deploy production Friday');
  });

  it('refuses a statement that inserts a word the quote does not contain', () => {
    // Catches: `bearing_forgives_missing_statement_words`. Isolated on purpose:
    // most substitutions leave a leftover on *both* sides, so the other branch
    // catches them too and this rule looks pinned when it is not. Here the quote
    // has nothing extra and the statement has one word the quote never said,
    // which is the only shape that reaches this branch alone.
    const result = refuses('we ship on Friday afternoon', 'we ship it on Friday afternoon');
    expect(result.unmatchedInStatement).toEqual(['it']);
    expect(result.unmatchedInQuote).toEqual([]);
  });

  it('refuses a statement that runs past the end of its quote', () => {
    // Catches: `bearing_forgives_the_statement_tail`. The quote stops and the
    // statement keeps asserting — a receipt that covers the first half of a
    // sentence is not a receipt for the sentence.
    const result = refuses('we ship on Friday', 'we ship on Friday unless the migration is red');
    expect(result.unmatchedInStatement).toEqual(['unless', 'migration', 'is', 'red']);
    expect(result.unmatchedInQuote).toEqual([]);
  });

  it('refuses an order reversal — who blocks whom', () => {
    // Catches: `bearing_forgives_the_statement_tail`. A set has no order, so
    // "the migration blocks the release" and its reverse were the same reading.
    refuses('the migration blocks the release', 'the release blocks the migration');
  });

  it('names the interposed word rather than scrambling the rest of the alignment', () => {
    // Catches: removing the lookahead resync (`q.indexOf(st, i + 1) !== -1`).
    // Without it one extra word knocks every later token out of alignment and
    // the refusal blames the whole sentence, which is a refusal nobody can act
    // on.
    const result = statementBearing(TRUTH, INVERSION);
    expect(result.unmatchedInQuote).toEqual(['not']);
    expect(result.unmatchedInStatement).toEqual([]);
  });

  it('counts a repeated word twice, so double negation is not one negation', () => {
    // Catches: `ordered_tokens_dedup`. `contentTokens` returns a Set, which is
    // why r3 could not have told these apart even with `not` off the stopword
    // list — the second `not` would have collapsed into the first.
    expect(orderedTokens('not not deploy')).toEqual(['not', 'not', 'deploy']);
    expect(statementBearing('bob will not not deploy', 'bob will not deploy').borne).toBe(false);
  });

  it('keeps two-letter words, because "no" inverts a sentence', () => {
    // Catches: `bearing_drops_short_tokens`. `contentTokens` drops anything under
    // three characters, which is correct for topic routing and fatal here.
    expect(orderedTokens('there is no flag')).toEqual(['there', 'is', 'no', 'flag']);
    expect(statementBearing('there is no flag left', 'there is flag left').borne).toBe(false);
  });

  it('does not treat a contraction as its expansion', () => {
    // Catches: splitting on the apostrophe, which would turn `won't` into
    // `won` + `t` and `I'll` into `i` + `ll` — and make "won't" and "will" argue
    // about tokens that are not words.
    expect(orderedTokens("bob won't deploy")).toEqual(['bob', "won't", 'deploy']);
    expect(statementBearing("bob won't deploy", 'bob will deploy').borne).toBe(false);
  });

  it('reads an edge apostrophe as a quotation mark, not a letter', () => {
    // The other direction of the same rule: `'online'` is the word `online`, so
    // a model quoting a backticked term does not fail for punctuation.
    expect(orderedTokens("`'online'` state")).toEqual(['online', 'state']);
  });

  it('accepts the compliant forms, in both directions, for the three articles', () => {
    // Catches: emptying `droppableWords`, which would make the check refuse
    // every real reading and be useless in the opposite way.
    expect(statementBearing('ship the flag on Friday', 'ship flag on Friday').borne).toBe(true);
    expect(statementBearing('ship flag on Friday', 'ship the flag on Friday').borne).toBe(true);
    expect(statementBearing('deploy a service', 'deploy an service').borne).toBe(true);
  });

  it('accepts a quote whose formatting the model dropped', () => {
    // Catches: removing the markdown fold from `normalizeForMatch`. Three of the
    // spike's eight apparent provenance failures were this and nothing else.
    expect(
      statementBearing(
        "so **TypeScript** should not be so confident that `this.state` is still `'online'`",
        'so TypeScript should not be so confident that this.state is still online',
      ).borne,
    ).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Refusing rather than approximating
 * ───────────────────────────────────────────────────────────────────────── */

describe('the bearing check refuses what it cannot judge', () => {
  it('refuses an input too large to align rather than approximating it', () => {
    // Catches: `receipt_policy_align_cap_raised`. The alignment resynchronises
    // with a lookahead, so it is O(n·m), and `quote` arrives from the same
    // untrusted place every other field does. Above the cap the answer is a
    // refusal, not a cheaper answer.
    //
    // **401 written out, not `maxAlignedTokens + 1`.** The ledger caught the
    // derived version: a probe computed from the table it is testing moves with
    // the table, so raising the cap to four million left this passing. Same
    // vacuity r3's gauntlet found in the θ probes, one file over.
    const huge = Array.from({ length: 401 }, (_, i) => `w${i}`).join(' ');
    const result = statementBearing(huge, huge);
    expect(RECEIPT_POLICY.maxAlignedTokens).toBe(400);
    expect(result.borne).toBe(false);
    expect(result.undecidable).toBe('too_long');
    // …and 400 is inside the cap, so the refusal is the bound and not the check
    // giving up on anything long.
    const fits = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    expect(statementBearing(fits, fits).borne).toBe(true);
  });

  it('refuses a model reading with a real quote and no statement to check it against', () => {
    // Catches: `statement_uncheckable_skipped`. r3 made `statement` optional and
    // called its absence "honest" — a check that does not run reads exactly like
    // a check that passed, which is the fail-open shape every round of this
    // ticket has found somewhere else.
    const problems = validateProposalProvenance(
      {
        type: 'claim',
        provenance: ['msg_1'],
        quote: TRUTH,
        proposer: { kind: 'model' },
      },
      window,
    );
    expect(problems.map((problem) => problem.kind)).toContain('statement_uncheckable');
    expect(problems.every((problem) => problem.severity === 'reject')).toBe(true);
  });

  it('is undecidable, not borne, for an empty side', () => {
    expect(statementBearing('', 'anything at all').undecidable).toBe('empty_quote');
    expect(statementBearing('anything at all', '').undecidable).toBe('empty_statement');
    expect(statementBearing('   ', 'anything').borne).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Emptiness is a property of the content
 * ───────────────────────────────────────────────────────────────────────── */

describe('emptiness is a property of the content, not of the container', () => {
  it('reads a zero-width character as no content at all', () => {
    // Catches: `blank_is_trim`. r3's gauntlet, as a polish note that is really a
    // principle: `"​"` is not `""`, so it walked past every `trim()` marked
    // "required" and was refused three checks later as not-found. An accidental
    // refusal is one refactor from an accidental acceptance.
    for (const blank of ['', '   ', '​', '​‍﻿', '­', '⁠', '…', '—']) {
      expect(hasContent(blank), `${JSON.stringify(blank)} must carry no content`).toBe(false);
      expect(isBlank(blank)).toBe(true);
    }
    for (const filled of ['a', '1', '+1', ' x ', '​x']) {
      expect(hasContent(filled), `${JSON.stringify(filled)} must carry content`).toBe(true);
    }
    expect(hasContent(null)).toBe(false);
    expect(hasContent(undefined)).toBe(false);
  });

  it('matches a quote whose words a zero-width character was spliced into', () => {
    // Catches: `normalize_keeps_invisibles`. The other half of the same rule: an
    // invisible character must not make a correct quote *fail*, or the refusal
    // is again happening for the wrong reason.
    expect(normalizeForMatch('ship​ it')).toBe('ship it');
    expect(normalizeForMatch('ship it')).toBe('ship it');
    expect(statementBearing('ship​ the flag', 'ship the flag').borne).toBe(true);
  });

  it('refuses a window of messages that exist and say nothing, at the engine', () => {
    // Catches: `blank_window_engine`. r3's gauntlet: the array is non-empty, so
    // `length === 0` is false, and there is nothing in it to find anything wrong
    // in. `[]` and `[{ body: '' }]` are the same fact about the world.
    const decision = decideAcceptance(modelProposal({ statement: TRUTH, quote: TRUTH }), {
      messages: [
        { id: 'msg_1', authorId: BOB, body: '' },
        { id: 'msg_2', authorId: ALICE, body: '​  ' },
      ],
    });
    expect(decision.verdict).toBe('discard');
    expect(decision.rule).toBe('missing_message_context');
    expect(decision.reason).toContain('not one of them has any words in it');
  });

  it('refuses a window of messages that exist and say nothing, at the reducer', () => {
    // Catches: `blank_window_reducer`.
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_blank',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: TRUTH, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote: TRUTH,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages: [{ id: 'msg_1', authorId: BOB, body: '​' }],
        type: 'object_accepted',
        object: {
          id: 'obj_blank',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: TRUTH, claimant: BOB },
          provenance: { messageIds: ['msg_1'], proposalId: 'prop_blank' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('with nothing in any of their bodies');
  });

  it('refuses a model objective minted with no quote against a window of empty bodies', () => {
    // Catches: `reducer_quote_gate_rescoped`, `validator_quote_requirement_rescoped`,
    // `proposal_quote_rescoped`. **This is r3's gauntlet, major 2, whole.** The
    // missing-quote gate was scoped to claims and commitments, so an objective
    // with `quote: null` citing one empty message passed the non-empty-array
    // check and no further check ran at all.
    expect(() =>
      modelProposal({ type: 'objective', statement: 'Ship the narrowing fix', quote: null }),
    ).toThrow(/must quote the message that carries it/);

    // …and the same thing arriving past the schema, which is where r2's gauntlet
    // found the schema was not being run.
    const problems = validateProposalProvenance(
      { type: 'objective', provenance: ['msg_1'], quote: null, proposer: { kind: 'model' } },
      [{ id: 'msg_1', authorId: BOB, body: '' }],
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['missing_quote']);
  });

  it('requires a quote from a model reading of every type, not only the two that name a person', () => {
    // Catches: `validator_quote_requirement_rescoped`.
    for (const type of [
      'decision',
      'commitment',
      'open_question',
      'claim',
      'objective',
    ] as AcceptedObjectType[]) {
      const problems = validateProposalProvenance(
        { type, provenance: ['msg_1'], quote: '​', proposer: { kind: 'model' } },
        window,
      );
      expect(
        problems.map((problem) => problem.kind),
        `${type} must require a quote`,
      ).toContain('missing_quote');
    }
  });
});
