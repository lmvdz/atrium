import { describe, expect, it } from 'vitest';
import {
  type AcceptedObject,
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
  type Proposal,
  type ProvenanceMessage,
  projectAttention,
  RECEIPT_POLICY,
  reduce,
  type StoredProposal,
  trustedContext,
  validateProposalProvenance,
  wasConsumed,
} from '../src/index.js';
import { ALICE, append, at, BOB, event, human, model, ROOM, rawEvent } from './fixtures.js';

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
const WINDOW: ProvenanceMessage[] = [{ id: 'msg_1', authorId: ALICE, body: CLAIM }];

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
    expect(decision.reason).toContain('not the sentence being asserted');
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
    expect(state.issues[0]?.reason).toContain('not the sentence being asserted');
  });

  it('accepts the same shape once the quote carries the sentence', () => {
    // The check is not "refuse commitments": with the right receipt this lands.
    const promise = 'I will deploy the service on Friday afternoon';
    const decision = decideAcceptance(
      modelProposal({
        statement: 'deploy the service on Friday',
        claimant: BOB,
        quote: promise,
        provenance: ['msg_p'],
      }),
      { messages: [{ id: 'msg_p', authorId: BOB, body: promise }] },
    );
    expect(decision.verdict).toBe('auto_accept');
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
    const twice: ProvenanceMessage[] = [
      { id: 'm_a', authorId: ALICE, body: said },
      { id: 'm_a2', authorId: ALICE, body: `as I said before: ${said}` },
    ];
    const decision = decideAcceptance(
      modelProposal({ statement: said, claimant: ALICE, quote: said, provenance: ['m_a', 'm_a2'] }),
      { messages: twice },
    );
    expect(decision.verdict).toBe('auto_accept');
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
      minStatementSupport: 0.6,
      duplicateThreshold: 0.8,
    });
  });

  it('is the number the escalation config quotes by, not a second one', () => {
    // r2's write-up claimed a single θ table while `minQuoteLength` and the dedup
    // threshold lived elsewhere. They live here now, and this is what "single
    // source" has to mean to be worth saying.
    expect(defaultEscalationConfig.minQuoteLength).toBe(24);
    expect(defaultEscalationConfig.minQuoteLength).toBe(RECEIPT_POLICY.minQuoteLength);
  });

  it('is the number `findDuplicate` discards on', () => {
    const accepted = [
      {
        objectId: 'obj_1',
        type: 'claim' as const,
        text: 'the migration is reversible and safe',
        messageIds: ['msg_1'],
      },
    ];
    // 3 of 4 content words shared → 0.75, under 0.8: not a duplicate.
    expect(
      findDuplicate('claim', 'the migration is reversible and safe enough', ['msg_1'], accepted),
    ).toBeNull();
    // All four → 1.0.
    expect(
      findDuplicate('claim', 'the migration is safe and reversible', ['msg_1'], accepted)?.objectId,
    ).toBe('obj_1');
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
