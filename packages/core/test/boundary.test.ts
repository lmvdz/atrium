import { describe, expect, it } from 'vitest';
import {
  type AcceptedObject,
  type AcceptedObjectRef,
  acceptanceReceiptRefusal,
  appendEvent,
  bearingMessage,
  bearingMessages,
  type CoreState,
  commitmentAttribution,
  decideAcceptance,
  defaultEscalationConfig,
  emptyState,
  findDuplicate,
  foldEvents,
  orderedTokens,
  type Proposal,
  type ProvenanceMessage,
  projectAttention,
  RECEIPT_POLICY,
  reduce,
  type StoredProposal,
  statementBearing,
  trustedContext,
  validateProposalProvenance,
  wasConsumed,
} from '../src/index.js';
import { ALICE, append, at, BOB, event, human, model, ROOM, rawEvent, room } from './fixtures.js';

/**
 * Round 2's gauntlet found one defect twice, and this file is the whole answer
 * to it: **absent or empty required receipt input is a refusal, never a skip.**
 *
 * The two routes in were independent and they met in the same place.
 *
 *  - *Unparsed boundary.* `appendEvent` and `reduce` never ran `CoreEvent.parse`.
 *    Every schema rule the package has — a model claim must quote the message
 *    that carries it, a payload may not smuggle an actor — was enforced only by
 *    tests that parsed their own fixtures before folding them. A caller handing
 *    over a plain object got none of it. **Every fixture in this file is raw**
 *    where the point is the boundary; `rawEvent` exists so the cast that makes
 *    that possible is written down once.
 *  - *Empty presence.* `messages: []` and a whitespace `quote` walked past
 *    checks that asked only about `undefined`, and everything downstream then
 *    found nothing wrong because there was nothing to look in. With an empty
 *    quote, attribution fell back to "did anybody in the citation list write
 *    anything" — the padding attack round 1 closed, reopened through the empty
 *    string.
 *
 * Plus major 1: a quote that is real, verbatim and correctly attributed, and has
 * nothing to do with the sentence being minted.
 */

const CLAIM = 'the migration is reversible and can be rolled back';
/** r7: the one type a machine may still mint, so the window carries one too. */
const QUESTION = 'do we keep the migration flag after launch?';
const WINDOW: ProvenanceMessage[] = room(
  { id: 'msg_1', authorId: ALICE, body: CLAIM },
  { id: 'msg_q', authorId: ALICE, body: QUESTION },
);

/** A model claim proposal, as an untyped caller would hand it over. */
function rawClaimProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev_p',
    at: at(1),
    type: 'proposal_recorded',
    proposal: {
      id: 'prop_1',
      roomId: ROOM,
      type: 'claim',
      payload: { statement: CLAIM, claimant: ALICE },
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_1'],
      quote: CLAIM,
      createdAt: at(1),
      ...overrides,
    },
  };
}

/**
 * The same pair as an open question — the one type a machine may still mint
 * since r7, so "a well-formed row folds" has something to be shown on.
 */
function rawQuestionProposal(): Record<string, unknown> {
  return {
    id: 'ev_p',
    at: at(1),
    type: 'proposal_recorded',
    proposal: {
      id: 'prop_1',
      roomId: ROOM,
      type: 'open_question',
      payload: { question: QUESTION },
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_q'],
      quote: QUESTION,
      createdAt: at(1),
    },
  };
}

function rawQuestionAcceptance(): Record<string, unknown> {
  return {
    id: 'ev_a',
    at: at(2),
    type: 'object_accepted',
    object: {
      id: 'obj_1',
      roomId: ROOM,
      type: 'open_question',
      payload: { question: QUESTION },
      provenance: { messageIds: ['msg_q'], proposalId: 'prop_1' },
      createdAt: at(2),
      updatedAt: at(2),
    },
  };
}

/** The acceptance that would turn it into a fact. */
function rawAcceptance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev_a',
    at: at(2),
    type: 'object_accepted',
    object: {
      id: 'obj_1',
      roomId: ROOM,
      type: 'claim',
      payload: { statement: CLAIM, claimant: ALICE },
      provenance: { messageIds: ['msg_1'], proposalId: 'prop_1' },
      createdAt: at(2),
      updatedAt: at(2),
      ...overrides,
    },
  };
}

describe('the boundary — appendEvent and reduce parse before they fold', () => {
  it('refuses a raw model claim proposal that quotes nothing, and never records it', () => {
    // The exact shape round 2's gauntlet described: no `quote` key at all. The
    // schema has forbidden this since r2 and the reducer never ran the schema,
    // so the proposal landed, the acceptance cited it, and an object with an
    // unanswerable attribution became a fact.
    const raw = rawClaimProposal();
    delete (raw.proposal as Record<string, unknown>).quote;

    const { state, outcomes } = foldEvents([
      rawEvent(raw, { actor: model() }),
      rawEvent(rawAcceptance(), { actor: model(), messages: WINDOW }),
    ]);

    expect(outcomes[0]?.outcome).toBe('malformed');
    expect(outcomes[0]?.outcome === 'malformed' && outcomes[0].detail).toContain('quote');
    expect(state.proposals).toEqual({});
    // …and the acceptance that would have ridden on it dies with it, because a
    // machine acceptance must cite a proposal that exists.
    expect(state.objects).toEqual({});
  });

  it('refuses a whitespace-only quote exactly as it refuses a missing one', () => {
    const { state, outcomes } = foldEvents([
      rawEvent(rawClaimProposal({ quote: '   \n\t ' }), { actor: model() }),
    ]);
    expect(outcomes[0]?.outcome).toBe('malformed');
    expect(state.proposals).toEqual({});
  });

  it('refuses a raw payload that smuggles an actor, naming the seam', () => {
    // The guard existed in r2 and was unreachable from the fold path — the only
    // thing that ran it was a test calling `CoreEvent.parse` by hand.
    const raw = { ...rawClaimProposal(), actor: { kind: 'human', userId: ALICE } };
    const result = append(reduce([]), rawEvent(raw, { actor: model() }));

    expect(result.outcome).toBe('malformed');
    expect(result.outcome === 'malformed' && result.detail).toContain('carries an actor');
    expect(result.outcome === 'malformed' && result.detail).toContain('appendEvent');
  });

  it('leaves the state untouched, by reference, and spends nothing', () => {
    const before = reduce([event({ id: 'ev_0', at: at(1), actor: human(), ...seedObject() })]);
    const result = append(before, rawEvent({ nonsense: true }, { actor: model() }));

    expect(result.outcome).toBe('malformed');
    expect(result.state).toBe(before);
    expect(wasConsumed(result)).toBe(false);
    expect(before.consumedEventIds).toEqual(['ev_0']);
    expect(before.issues).toEqual([]);
  });

  it('folds the well-formed rows around a malformed one, and reports it', () => {
    const { state, outcomes } = foldEvents([
      rawEvent({ this: 'is not an event' }, { actor: model() }),
      event({ id: 'ev_0', at: at(1), actor: human(), ...seedObject() }),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['malformed', 'applied']);
    expect(Object.keys(state.objects)).toEqual(['obj_seed']);
    expect(state.consumedEventIds).toEqual(['ev_0']);
  });

  it('folds the parsed value, not the raw one — so schema defaults are real', () => {
    // A correction with no `patch`, `toType`, `provenance` or `note` key. Against
    // an unparsed fold `event.patch` is `undefined` and `Object.hasOwn(undefined,
    // …)` throws, which means r2's reducer was not total against the input it
    // actually accepted. Here it parses to `patch: {}` and lands as the no-op
    // amend it is.
    const state = reduce([
      event({ id: 'ev_0', at: at(1), actor: human(), ...seedObject() }),
      rawEvent(
        { id: 'ev_c', at: at(2), type: 'object_corrected', objectId: 'obj_seed', action: 'amend' },
        { actor: human() },
      ),
    ]);
    expect(state.issues[0]?.reason).toContain('changed nothing');
    expect(state.objects.obj_seed?.revision).toBe(0);
  });

  it('still coerces a raw pre-blessed proposal rather than parsing it away', () => {
    // Parsing must not become a second, quieter door: `status: 'accepted'` is a
    // valid `ProposalStatus`, so it parses — and the reducer's coercion is what
    // refuses it, exactly as before.
    const state = reduce([rawEvent(rawClaimProposal({ status: 'accepted' }), { actor: model() })]);
    expect(state.proposals.prop_1?.status).toBe('proposed');
    expect(state.issues[0]?.reason).toContain('forced to "proposed"');
  });

  it('accepts a raw row that is well-formed — the boundary is a check, not a wall', () => {
    const state = reduce([
      rawEvent(rawClaimProposal(), { actor: model() }),
      rawEvent(rawAcceptance(), { actor: model(), messages: WINDOW }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_1).toBeDefined();

    // …and the open-question form of the same row, which is the other type a
    // machine may mint. r7 checked that its middle draft had not quietly made
    // this test the only one exercising the fold.
    const asQuestion = reduce([
      rawEvent(rawQuestionProposal(), { actor: model() }),
      rawEvent(rawQuestionAcceptance(), { actor: model(), messages: WINDOW }),
    ]);
    expect(asQuestion.issues).toEqual([]);
    expect(asQuestion.objects.obj_1).toBeDefined();
  });
});

/** A human-accepted objective, for tests that need something in state. */
function seedObject() {
  return {
    type: 'object_accepted' as const,
    object: {
      id: 'obj_seed',
      roomId: ROOM,
      type: 'objective' as const,
      payload: { title: 'ship the narrowing fix this quarter' },
      provenance: { messageIds: ['msg_1'], proposalId: null },
      createdAt: at(1),
      updatedAt: at(1),
    },
  };
}

describe('absent or empty — the receipt inputs that are refused, not skipped', () => {
  const proposalEvent = event({
    id: 'ev_p',
    at: at(1),
    actor: model(),
    type: 'proposal_recorded',
    proposal: {
      id: 'prop_1',
      roomId: ROOM,
      type: 'claim',
      payload: { statement: CLAIM, claimant: ALICE },
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_1'],
      quote: CLAIM,
      createdAt: at(1),
    },
  });

  const acceptWith = (messages: readonly ProvenanceMessage[] | undefined) =>
    event({
      id: 'ev_a',
      at: at(2),
      actor: model(),
      ...(messages === undefined ? {} : { messages }),
      type: 'object_accepted',
      object: {
        id: 'obj_1',
        roomId: ROOM,
        type: 'claim',
        payload: { statement: CLAIM, claimant: ALICE },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_1' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    });

  it('refuses `messages: []` at the reducer, exactly as it refuses no messages', () => {
    const empty = reduce([proposalEvent, acceptWith([])]);
    const absent = reduce([proposalEvent, acceptWith(undefined)]);

    expect(empty.objects).toEqual({});
    expect(absent.objects).toEqual({});
    expect(empty.issues[0]?.reason).toContain('an empty message window supplied');
    expect(empty.issues[0]?.reason).toContain('never accepted on trust');
    expect(absent.issues[0]?.reason).toContain('no message window supplied');
    // Same refusal, said two ways: the difference is a diagnosis, not a verdict.
    expect(empty.proposals.prop_1?.status).toBe('proposed');
    expect(absent.proposals.prop_1?.status).toBe('proposed');
  });

  it('refuses `messages: []` at the engine, exactly as it refuses no messages', () => {
    const staged = modelProposal({});
    expect(decideAcceptance(staged, { messages: [] }).rule).toBe('missing_message_context');
    expect(decideAcceptance(staged, { messages: [] }).verdict).toBe('discard');
    expect(decideAcceptance(staged, { messages: [] }).reason).toContain('empty message window');
    expect(
      decideAcceptance(staged, { messages: undefined as unknown as ProvenanceMessage[] }).rule,
    ).toBe('missing_message_context');
  });

  it('refuses `messages: []` at the attention panel, with a receipt for the silence', () => {
    const state = reduce([
      event({
        id: 'ev_pc',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_c',
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: 'wire the flag into the server tomorrow', owner: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote: 'wire the flag into the server tomorrow',
          createdAt: at(1),
        },
      }),
    ]);

    const withEmpty = projectAttention(state, { now: at(5), messages: [] });
    const withNone = projectAttention(state, { now: at(5) });

    expect(withEmpty.items).toEqual([]);
    expect(withEmpty.refusals.map((refusal) => refusal.proposalId)).toEqual(['prop_c']);
    expect(withNone.refusals.map((refusal) => refusal.proposalId)).toEqual(['prop_c']);
  });

  it('re-requires a non-empty quote at the reducer, not one layer up', () => {
    /**
     * The reducer does not trust the schema above it. This is what that means in
     * practice: a state rehydrated from a store — a snapshot, a replica, #22's
     * `proposals` table — whose rows the schema never saw. Fold an acceptance
     * against it and the receipt gate has to hold on its own.
     */
    const rehydrated: CoreState = emptyState();
    rehydrated.proposals.prop_q = {
      proposal: {
        id: 'prop_q',
        roomId: ROOM,
        type: 'claim',
        payload: { statement: CLAIM, claimant: ALICE, verification: 'unverified' },
        confidence: 0.95,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: ['msg_1'],
        quote: '   ',
        interpretationId: null,
        createdAt: at(1),
      } as StoredProposal,
      // A rehydrated record carries the stager the ledger row recorded (#22 r9).
      // The model that staged it here, so this stays a test about the quote: the
      // acceptance below is by a model actor, which runs the receipt gates
      // whoever staged the proposal.
      stagedBy: { kind: 'model', model: 'test-model' },
      status: 'proposed',
      acceptedObjectId: null,
      rejectedReason: null,
      supersededByProposalId: null,
      supersededReason: null,
    };

    const state = reduce(
      [
        event({
          id: 'ev_a',
          at: at(2),
          actor: model(),
          messages: WINDOW,
          type: 'object_accepted',
          object: {
            id: 'obj_q',
            roomId: ROOM,
            type: 'claim',
            payload: { statement: CLAIM, claimant: ALICE },
            provenance: { messageIds: ['msg_1'], proposalId: 'prop_q' },
            createdAt: at(2),
            updatedAt: at(2),
          },
        }),
      ],
      rehydrated,
    );

    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('which quotes nothing');
  });

  it('names the missing-quote gate rather than folding it into the receipt', () => {
    // Straight at the predicate, because the gate is defence in depth: the parse
    // boundary above normally makes it unreachable, and a check that only holds
    // while another check holds is not a boundary.
    for (const quote of [null, '', '   ']) {
      const refusal = acceptanceReceiptRefusal({
        actor: model(),
        proposalId: 'prop_q',
        proposal: {
          id: 'prop_q',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: CLAIM, claimant: ALICE, verification: 'unverified' },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote,
          interpretationId: null,
          createdAt: at(1),
        } as StoredProposal,
        object: {
          id: 'obj_q',
          roomId: ROOM,
          objectiveId: null,
          type: 'claim',
          payload: { statement: CLAIM, claimant: ALICE, verification: 'unverified' },
          provenance: { messageIds: ['msg_1'], proposalId: 'prop_q', interpretationId: null },
          createdAt: at(2),
          updatedAt: at(2),
        } as AcceptedObject,
        messages: WINDOW,
      });
      expect(refusal?.gate).toBe('missing_quote');
    }
  });

  it('names that gate for every model-minted type, not only the two that name a person', () => {
    // Catches: `reducer_quote_gate_rescoped`. The scoped version is not a
    // fail-open on its own — the validator's own `missing_quote` still refuses
    // the acceptance one check later, as `receipt_failed`. That is precisely why
    // it needs its own test: **a boundary held up by another boundary is not
    // one**, and the ledger recorded this mutant as an escape until the gate was
    // asserted by name rather than by its effect.
    const payloads: Record<string, Record<string, unknown>> = {
      decision: { statement: CLAIM, decidedBy: null, status: 'active' },
      commitment: { statement: CLAIM, owner: ALICE, due: null, status: 'open' },
      open_question: { question: CLAIM, status: 'open' },
      claim: { statement: CLAIM, claimant: ALICE, verification: 'unverified' },
      objective: { title: CLAIM, status: 'open' },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      const refusal = acceptanceReceiptRefusal({
        actor: model(),
        proposalId: 'prop_q',
        proposal: {
          id: 'prop_q',
          roomId: ROOM,
          type,
          payload,
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_1'],
          quote: '​',
          interpretationId: null,
          createdAt: at(1),
        } as unknown as StoredProposal,
        object: {
          id: 'obj_q',
          roomId: ROOM,
          objectiveId: null,
          type,
          payload,
          provenance: { messageIds: ['msg_1'], proposalId: 'prop_q', interpretationId: null },
          createdAt: at(2),
          updatedAt: at(2),
        } as unknown as AcceptedObject,
        messages: WINDOW,
      });
      expect(refusal?.gate, `${type} must be refused by the missing-quote gate`).toBe(
        'missing_quote',
      );
    }
  });

  it('does not let a padded citation list plus an empty quote flip attribution', () => {
    /**
     * The reopened padding attack, stated as one case. Round 1 closed "the owner
     * authored *any* cited message"; round 2's delta found the closure was
     * conditional on there being a quote at all, because every quote check sat
     * behind `if (quote && …)` and the attribution fallback sat outside it.
     */
    const window: ProvenanceMessage[] = [
      { id: 'm_pad', authorId: BOB, body: 'morning all, the CI is green again on main' },
      { id: 'm_commit', authorId: ALICE, body: 'bob will land the narrowing fix on Friday' },
    ];
    const problems = validateProposalProvenance(
      {
        type: 'commitment',
        provenance: ['m_pad', 'm_commit'],
        quote: '',
        proposer: { kind: 'model' },
        attributedTo: BOB,
        statement: 'land the narrowing fix on Friday',
      },
      window,
    );

    const kinds = problems.map((problem) => problem.kind).sort();
    expect(kinds).toEqual(['attributed_person_not_author', 'missing_quote']);
    // The attribution finding is present and is *not* "self": BOB wrote a cited
    // message, and with no quote that fact supports nothing.
    expect(problems.find((problem) => problem.kind === 'missing_quote')?.severity).toBe('reject');
    expect(commitmentAttribution(BOB, ['m_pad', 'm_commit'], window, '')).toBe('third_party');
    expect(commitmentAttribution(BOB, ['m_pad', 'm_commit'], window, '   ')).toBe('third_party');
  });
});

/** A model claim proposal object, built rather than parsed. */
function modelProposal(overrides: {
  statement?: string;
  quote?: string | null;
  claimant?: string;
  provenance?: string[];
  confidence?: number;
}): Proposal {
  return {
    id: 'prop_1',
    roomId: ROOM,
    type: 'claim',
    payload: {
      statement: overrides.statement ?? CLAIM,
      claimant: overrides.claimant ?? ALICE,
      verification: 'unverified',
    },
    confidence: overrides.confidence ?? 0.95,
    proposer: { kind: 'model', model: 'test-model' },
    provenance: overrides.provenance ?? ['msg_1'],
    quote: overrides.quote === undefined ? CLAIM : overrides.quote,
    interpretationId: null,
    status: 'proposed',
    createdAt: at(1),
  } as Proposal;
}

describe('the quote is bound to the sentence it is a receipt for', () => {
  /**
   * Round 2's gauntlet, major 1, in one sentence: *any normalized substring
   * anywhere in a cited message satisfied it.* Cite the message where Bob wrote
   * "yes, that works for me", quote it verbatim, and mint "Bob will deploy the
   * service on Friday". Real quote, real author, real citation, invented
   * commitment — and every check r2 had passes it.
   */
  const AGREEMENT = 'yes, that works for me and I am happy with it';
  const bobAgrees: ProvenanceMessage[] = [{ id: 'msg_y', authorId: BOB, body: AGREEMENT }];

  it('refuses a verbatim, correctly attributed quote that carries a different sentence', () => {
    const decision = decideAcceptance(
      modelProposal({
        statement: 'Bob will deploy the service on Friday',
        claimant: BOB,
        quote: AGREEMENT,
        provenance: ['msg_y'],
      }),
      { messages: bobAgrees },
    );

    expect(decision.verdict).toBe('discard');
    expect(decision.rule).toBe('provenance_failed');
    expect(decision.reason).toContain('which the quote does not say');
    expect(decision.reason).toContain('somewhere that does not say this');
  });

  it('refuses the same thing at the reducer, where it is a trust boundary', () => {
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_y',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'Bob will deploy the service on Friday', claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_y'],
          quote: AGREEMENT,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages: bobAgrees,
        type: 'object_accepted',
        object: {
          id: 'obj_y',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'Bob will deploy the service on Friday', claimant: BOB },
          provenance: { messageIds: ['msg_y'], proposalId: 'prop_y' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);

    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('which the quote does not say');
  });

  it('accepts the same shape once the quote carries the sentence', () => {
    // The check is not "refuse commitments": with the right receipt this lands.
    // r4 narrowed what "the right receipt" means — the statement is the quoted
    // span, article-for-article, not a paraphrase of it.
    const promise = 'I will deploy the service on Friday afternoon';
    const decision = decideAcceptance(
      modelProposal({
        statement: 'I will deploy the service on Friday afternoon',
        claimant: BOB,
        quote: promise,
        provenance: ['msg_p'],
      }),
      { messages: room({ id: 'msg_p', authorId: BOB, body: promise }) },
    );
    // **r7: `type_not_certified`, and this is the fixture that made the round's
    // finding concrete.** *"I will deploy the service on Friday afternoon"* is a
    // commitment in every ordinary reading, and it was reaching `auto_accept` as
    // a *claim* because `type` is the proposal's own word. The receipt is
    // faultless; what is missing is any evidence of the kind of act.
    expect(decision.rule).toBe('type_not_certified');
  });

  it('refers a paraphrase of the quote to a person instead of accepting it', () => {
    // Catches: making `quote_carries_more_than_statement` a pass, or giving it
    // `reject` severity. The statement is every word of the quote in order, and
    // the quote says more — "afternoon", "I", "will". Those extra words are
    // harmless here and are "not" in r3's gauntlet, and nothing in a string
    // comparison distinguishes the two, so the honest answer is neither
    // "accepted" nor "discarded".
    const promise = 'I will deploy the service on Friday afternoon';
    const decision = decideAcceptance(
      modelProposal({
        statement: 'deploy the service on Friday',
        claimant: BOB,
        quote: promise,
        provenance: ['msg_p'],
      }),
      { messages: room({ id: 'msg_p', authorId: BOB, body: promise }) },
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.visibility).toBe('quiet');
    expect(decision.rule).toBe('receipt_not_certifiable');
    expect(decision.reason).toContain('a person has to read the quote');
  });

  it('enforces minQuoteLength on the acceptance path, not only on blockquotes', () => {
    // Bears the statement completely — one content word, present in the quote —
    // and is still refused, because a span this short names no sentence.
    const decision = decideAcceptance(
      modelProposal({
        statement: 'ship it',
        claimant: BOB,
        quote: 'ship it',
        provenance: ['msg_s'],
      }),
      { messages: [{ id: 'msg_s', authorId: BOB, body: 'ok, ship it whenever you like' }] },
    );

    expect(decision.verdict).toBe('discard');
    expect(decision.reason).toContain('below the 24 a receipt needs');
  });

  it('refuses as ambiguous when two cited authors both carry the quote', () => {
    const said = 'we should reset narrowing on mutating method calls';
    const both: ProvenanceMessage[] = [
      { id: 'm_a', authorId: ALICE, body: said },
      { id: 'm_b', authorId: BOB, body: said },
    ];
    const decision = decideAcceptance(
      modelProposal({ statement: said, claimant: ALICE, quote: said, provenance: ['m_a', 'm_b'] }),
      { messages: both },
    );

    expect(decision.verdict).toBe('discard');
    expect(decision.reason).toContain('written by different people');
    // Round 2's behaviour, pinned as the thing that changed: window order used
    // to decide, and ALICE is first.
    expect(decision.reason).not.toContain('m_a" was written by "user_alice');
  });

  it('does not refuse the same person saying it twice — the answer is determined', () => {
    const said = 'we should reset narrowing on mutating method calls';
    const twice: ProvenanceMessage[] = room(
      { id: 'm_a', authorId: ALICE, body: said },
      { id: 'm_a2', authorId: ALICE, body: said },
    );
    const decision = decideAcceptance(
      modelProposal({ statement: said, claimant: ALICE, quote: said, provenance: ['m_a', 'm_a2'] }),
      { messages: twice },
    );
    // Two messages by one person do not make "who said this" undetermined, which
    // is the whole point of scoping `ambiguous_quote` to two *authors*. An exact
    // restatement is agreement, so the later-revision scan passes over it too.
    expect(decision.verdict).toBe('auto_accept');
  });

  it('refers when the second telling adds words to the first', () => {
    // r5, and the cost of the later-revision rule stated where it is paid.
    // "as I said before: X" and "it is not true that X" are the same shape to a
    // string check — the statement, in order, with something in front of it —
    // and a machine may not decide which one it is looking at. The emphatic
    // repetition is referred rather than accepted, which is a person's glance,
    // and the alternative was accepting the retraction.
    const said = 'we should reset narrowing on mutating method calls';
    const twice: ProvenanceMessage[] = [
      { id: 'm_a', authorId: ALICE, body: said },
      { id: 'm_a2', authorId: ALICE, body: `as I said before: ${said}` },
    ];
    const decision = decideAcceptance(
      modelProposal({ statement: said, claimant: ALICE, quote: said, provenance: ['m_a', 'm_a2'] }),
      { messages: twice },
    );
    expect(decision.verdict).toBe('pending');
    expect(decision.rule).toBe('receipt_not_certifiable');
    expect(decision.reason).not.toContain('written by different people');
  });

  it('reports every bearing message, and names one only when one person wrote it', () => {
    const said = 'we should reset narrowing on mutating method calls';
    const alice = { id: 'm_a', authorId: ALICE, body: said };
    const bob = { id: 'm_b', authorId: BOB, body: said };
    const quoting = { id: 'm_q', authorId: BOB, body: `> ${said}\n\nagreed` };

    expect(bearingMessages(said, [alice, bob]).map((message) => message.id)).toEqual([
      'm_a',
      'm_b',
    ]);
    // A reply-blockquote is not bearing: that is the spike's worst error.
    expect(bearingMessages(said, [quoting])).toEqual([]);
    expect(bearingMessage(said, [alice])).toBe(alice);
    expect(bearingMessage(said, [alice, bob])).toBeNull();
    expect(bearingMessage('', [alice])).toBeNull();
  });

  it('reads an undetermined author as third-party, never as self', () => {
    const said = 'wire the flag into the server tomorrow afternoon';
    // BOB's message is **first**, deliberately. Under "take the first match in
    // window order" this reads as BOB's own sentence and the commitment
    // auto-accepts against him; the ordering has to be incapable of deciding it.
    const both: ProvenanceMessage[] = [
      { id: 'm_b', authorId: BOB, body: said },
      { id: 'm_a', authorId: ALICE, body: said },
    ];
    expect(commitmentAttribution(BOB, ['m_b', 'm_a'], both, said)).toBe('third_party');
    expect(commitmentAttribution(BOB, ['m_b'], [both[0] as ProvenanceMessage], said)).toBe('self');
  });
});

describe('the receipt minima are policy, and are pinned by value', () => {
  it('is exactly this table', () => {
    expect(RECEIPT_POLICY).toEqual({
      minQuoteLength: 24,
      maxAlignedTokens: 800,
      maxScannedSentences: 200,
      maxLaterMessagesScanned: 200,
      maxLaterMessagesCarried: 201,
    });
    // …and `droppableTokens` is not in it. Asserted as an absence, because a
    // field that was removed is a rule somebody will otherwise re-add: every
    // entry it ever held was broken by a reviewer, the last of them in r6.
    expect('droppableTokens' in RECEIPT_POLICY).toBe(false);
  });

  it('has the supplier stop strictly later than the checker reads', () => {
    // Catches: `receipt_policy_carried_equals_scanned`,
    // `receipt_policy_carried_below_scanned`.
    //
    // #86, and it is the one relation in this table rather than a value in it.
    // The window's supplier (`atrium_receipt_window`, drizzle/0011) stops at
    // `maxLaterMessagesCarried`; `laterRevision` reads at most
    // `maxLaterMessagesScanned`. If the first is not strictly greater than the
    // second, a window the room outgrew and a room that simply ended are the
    // same bytes to a check with no message table and no clock — and below it,
    // the check certifies "nothing corrects this" about messages it was never
    // handed.
    //
    // Written as the relation and not as `expect(201)`, because the pair above
    // already pins both values: a test that restated 201 here would pass on a
    // day somebody moved BOTH numbers to 500 and 500, which is exactly the
    // configuration this sentence forbids.
    expect(RECEIPT_POLICY.maxLaterMessagesCarried).toBeGreaterThan(
      RECEIPT_POLICY.maxLaterMessagesScanned,
    );
  });

  it('lets nothing at all differ between a quote and its statement', () => {
    // Catches: `receipt_policy_droppable_restored`, `ordered_tokens_drops_spaces`.
    //
    // **The title said "nothing but a full stop" until r6's cross-lineage pass,
    // and before that this test checked nine words somebody typed out.** Both
    // were the same defect at different depths. The word list pinned the evasions
    // somebody had thought of; the full stop pinned a licence whose justification
    // — *"a full stop terminates a sentence and carries no other meaning"* — was
    // a claim about context enforced by a `Set.has` over every `.` anywhere, so
    // ``Load `.env` before the deploy tonight.`` bore ``Load `env` …``.
    //
    // What is checked is the property in the title, over the tokens themselves:
    // take the sentence apart, and *every* single-token deletion and insertion
    // must be refused. The sentence carries a negation, a quantifier, an article,
    // a one-letter name, a contraction, a code literal with a double space in it,
    // a comma, an apostrophe-quoted term and a full stop — but the assertion does
    // not depend on that: it is every token, whatever they turn out to be.
    const quote =
      "A maintainer will not deploy 2 of the 'production' boxes on Friday, and `a  b` won't change that.";
    const tokens = orderedTokens(quote);
    expect(tokens.length).toBeGreaterThan(30);

    for (const [index, token] of tokens.entries()) {
      const dropped = [...tokens.slice(0, index), ...tokens.slice(index + 1)].join('');
      expect(
        statementBearing(quote, dropped).borne,
        `dropping ${JSON.stringify(token)} at ${index} must be refused`,
      ).toBe(false);
      expect(
        statementBearing(dropped, quote).borne,
        `dropping ${JSON.stringify(token)} from the quote must be refused`,
      ).toBe(false);
    }

    for (const inserted of ['not', "'", '?', '`', '.']) {
      const statement = [...tokens.slice(0, 6), inserted, ...tokens.slice(6)].join('');
      expect(
        statementBearing(quote, statement).borne,
        `inserting ${JSON.stringify(inserted)} must be refused`,
      ).toBe(false);
    }

    // What *is* still admitted is `normalizeForReceipt`'s allowlist, and only
    // that: a run of prose whitespace, a character with no rendering, and a
    // typographic apostrophe. Those are differences the fold erases before this
    // comparison ever sees them, so they are not differences at all.
    expect(statementBearing(quote, quote.replace('will not', 'will  not')).borne).toBe(true);
    expect(statementBearing(quote, quote.replace('will', 'wi​ll')).borne).toBe(true);
    expect(statementBearing(quote, quote.replace("won't", 'won’t')).borne).toBe(true);
    // …and inside a code literal even the whitespace is content.
    expect(statementBearing(quote, quote.replace('`a  b`', '`a b`')).borne).toBe(false);

    // The trailing full stop is the cost of emptying the set, stated as a
    // disposition: it is refused, and refused as a *referral* rather than a
    // discard, so the reading reaches a person rather than the bin.
    expect(statementBearing('ship the flag.', 'ship the flag').borne).toBe(false);
    expect(statementBearing('ship the flag', 'ship the flag.').borne).toBe(false);
    expect(statementBearing('ship the flag?', 'ship the flag').borne).toBe(false);
  });

  it('is the number the escalation config quotes by, not a second one', () => {
    // r2's write-up claimed a single θ table while `minQuoteLength` and the dedup
    // threshold lived elsewhere. They live here now, and this is what "single
    // source" has to mean to be worth saying.
    expect(defaultEscalationConfig.minQuoteLength).toBe(24);
    expect(defaultEscalationConfig.minQuoteLength).toBe(RECEIPT_POLICY.minQuoteLength);
  });

  it('discards only a re-proposal of the same sentence', () => {
    const claimOf = (statement: string) =>
      ({ statement, claimant: ALICE, verification: 'unverified' }) as const;
    const claimRef = (objectId: string, statement: string): AcceptedObjectRef => ({
      objectId,
      type: 'claim',
      payload: claimOf(statement),
      messageIds: ['msg_1'],
      retractedAt: null,
      supersededById: null,
    });
    const accepted = [claimRef('obj_1', 'the migration is reversible and safe.')];
    // The same sentence again, from the same message: a re-proposal.
    //
    // r9: this line read `'The migration is reversible and safe.'` against an
    // accepted `'the migration is …'`, and passed on the dedup case fold rather
    // than on the property it is named for. The fold is gone (see `matching.ts`),
    // and the fixture now differs from the accepted text in nothing at all,
    // which is what "the same sentence again" was always supposed to mean. The
    // assertion's coverage is unchanged: it fails if `findDuplicate` stops
    // matching an exact re-proposal, which is the mutation that would make the
    // whole deduplicator dead code.
    expect(
      findDuplicate('claim', claimOf('the migration is reversible and safe.'), ['msg_1'], accepted)
        ?.objectId,
    ).toBe('obj_1');
    // One word added — an aside, or a qualifier, and nothing here can tell.
    expect(
      findDuplicate(
        'claim',
        claimOf('the migration is reversible and safe enough'),
        ['msg_1'],
        accepted,
      ),
    ).toBeNull();
    // Reordered. r5: this scored 1.0 under the old set-similarity and was
    // discarded, which is the same blindness that makes "A blocks B" and "B
    // blocks A" one reading.
    expect(
      findDuplicate('claim', claimOf('the migration is safe and reversible'), ['msg_1'], accepted),
    ).toBeNull();
  });

  it('does not discard a reading that says the opposite of the accepted one', () => {
    /**
     * **The audit's own find, and it was on nobody's defect list.**
     * `escalation.ts` says of its stopword table, in bold, that it "has not
     * decided whether a reading becomes a fact since r4, and it must never do so
     * again". It still did, here: `findDuplicate` scored similarity over
     * `contentTokens`, which drops `not`, `all` and `some` as stopwords — so a
     * reading that contradicted an accepted object drawn from the same message
     * scored 1.0 and was **discarded**, with the thing it contradicted left
     * standing. r3's gauntlet finding, surviving in the one path nobody re-read,
     * and worse here than there: not referred, not refused, destroyed.
     */
    const claimOf = (statement: string) =>
      ({ statement, claimant: ALICE, verification: 'unverified' }) as const;
    const claimRef = (objectId: string, statement: string): AcceptedObjectRef => ({
      objectId,
      type: 'claim',
      payload: claimOf(statement),
      messageIds: ['msg_1'],
      retractedAt: null,
      supersededById: null,
    });
    const accepted = [
      claimRef('obj_1', 'The migration is reversible'),
      claimRef('obj_2', 'All services restart cleanly'),
    ];
    expect(
      findDuplicate('claim', claimOf('The migration is not reversible'), ['msg_1'], accepted),
    ).toBeNull();
    expect(
      findDuplicate('claim', claimOf('Some services restart cleanly'), ['msg_1'], accepted),
    ).toBeNull();
  });
});

describe('TrustedContext cannot be assembled by accident', () => {
  const seeded = event({ id: 'ev_0', at: at(1), actor: human(), ...seedObject() });

  it('is produced by `trustedContext`, and that is what appendEvent takes', () => {
    const result = appendEvent(reduce([]), seeded.event, trustedContext({ actor: human() }));
    expect(result.outcome).toBe('applied');
  });

  it('carries the window through, so a branded context is not a narrower one', () => {
    const trusted = trustedContext({ actor: model(), messages: WINDOW });
    expect(trusted.actor).toEqual(model());
    expect(trusted.messages).toEqual(WINDOW);
  });

  it('refuses a bare object literal at compile time', () => {
    // The whole point of the brand: this is the shape three layers down that
    // assembled a trusted context out of whatever was to hand, and it no longer
    // type-checks. Runtime behaviour is deliberately unchanged — core cannot
    // tell an authenticated actor from an invented one, which is exactly what
    // `TrustedContext`'s doc comment says it cannot do, and the brand is a
    // discipline rather than a check.
    const state = reduce([]);
    // @ts-expect-error — a plain `{ actor }` is not a TrustedContext
    const result = appendEvent(state, seeded.event, { actor: human() });
    expect(result.outcome).toBe('applied');
  });
});
