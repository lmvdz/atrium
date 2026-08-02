import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  computeAttention,
  foldEvents,
  reduce,
  renderRationale,
  serializeState,
} from '../src/index.js';
import {
  ALICE,
  at,
  BOB,
  event,
  human,
  ids,
  ROOM,
  reminted,
  sampleLog,
  shuffle,
} from './fixtures.js';

describe('reduce — determinism', () => {
  it('is a pure function: the same events produce the same state', () => {
    const events = sampleLog();
    expect(serializeState(reduce(events))).toBe(serializeState(reduce(sampleLog())));
  });

  it('is order-independent: shuffled input reduces to a byte-identical state', () => {
    const canonical = serializeState(reduce(sampleLog()));
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const shuffled = shuffle(sampleLog(), seed);
      expect(ids(shuffled)).not.toEqual(ids(sampleLog()));
      expect(serializeState(reduce(shuffled))).toBe(canonical);
    }
  });

  it('does not mutate the events it is given', () => {
    const events = sampleLog();
    const before = JSON.stringify(events);
    reduce(events);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('folds incrementally to the same state as a full replay', () => {
    const events = sampleLog();
    const full = reduce(events);
    const incremental = events.reduce(
      (state, next) => appendEvent(state, next.event, next).state,
      reduce([]),
    );
    expect(serializeState(incremental)).toBe(serializeState(full));
  });

  it('is idempotent per event id — a redelivery is rejected, not double-applied', () => {
    const events = sampleLog();
    const once = reduce(events);
    const twice = reduce([...events, ...events]);

    // A duplicate is a rejection, not a business issue: it never happened, so
    // it leaves nothing in `issues` for a replay to have to reproduce. The
    // second copy of the log is simply not there.
    expect(serializeState(twice)).toBe(serializeState(once));
    expect(twice.issues).toEqual([]);
  });

  it('reports each redelivery as a rejection rather than swallowing it', () => {
    const events = sampleLog();
    const { outcomes } = foldEvents([...events, ...events]);
    const rejected = outcomes.filter((o) => o.outcome === 'rejected');
    expect(rejected).toHaveLength(events.length);
    for (const outcome of rejected) {
      if (outcome.outcome !== 'rejected') throw new Error('unreachable');
      // `reduce` sorts, so each verbatim copy lands on exactly the cursor its
      // twin just set: the position gate is what refuses it, and the detail
      // says the id was spent too.
      expect(outcome.reason).toBe('out_of_order');
      expect(outcome.detail).toContain('do not re-mint it');
    }
  });

  it('rejects a redelivery that re-minted its timestamp, and says so', () => {
    const events = sampleLog();
    const late = events.map((entry) =>
      reminted(entry, { at: at(20 + Number(entry.event.id.slice(3))) }),
    );
    const { state, outcomes } = foldEvents([...events, ...late]);
    const rejected = outcomes.filter((o) => o.outcome === 'rejected');

    expect(rejected).toHaveLength(events.length);
    for (const outcome of rejected) {
      if (outcome.outcome !== 'rejected') throw new Error('unreachable');
      expect(outcome.reason).toBe('duplicate');
    }
    // Nothing the re-minted copies carried reached the state.
    expect(serializeState(state)).toBe(serializeState(reduce(events)));
  });
});

describe('reduce — acceptance', () => {
  it('accepts an object and marks its originating proposal accepted', () => {
    const state = reduce(sampleLog());
    const decision = state.objects.obj_decision_1;
    expect(decision).toBeDefined();
    expect(decision?.object.type).toBe('decision');
    expect(state.proposals.prop_1?.status).toBe('accepted');
    expect(state.proposals.prop_1?.acceptedObjectId).toBe('obj_decision_1');
  });

  it('applies schema defaults on acceptance', () => {
    const state = reduce(sampleLog());
    const commitment = state.objects.obj_commitment_1?.object;
    expect(commitment?.type === 'commitment' && commitment.payload.status).toBe('open');
    expect(state.objects.obj_commitment_1?.object.objectiveId).toBeNull();
  });

  it('refuses to accept the same object id twice', () => {
    const [proposal, accept] = sampleLog();
    if (!proposal || !accept) throw new Error('fixture changed');
    const state = reduce([proposal, accept, reminted(accept, { id: 'ev_dup', at: at(20) })]);
    expect(state.issues).toEqual([
      { eventId: 'ev_dup', reason: 'object "obj_decision_1" already accepted' },
    ]);
    expect(Object.keys(state.objects)).toEqual(['obj_decision_1']);
  });

  it('keeps provenance on every accepted object', () => {
    const state = reduce(sampleLog());
    expect(state.objects.obj_decision_1?.object.provenance).toEqual({
      messageIds: ['msg_1', 'msg_2'],
      proposalId: 'prop_1',
      interpretationId: null,
    });
  });

  /**
   * #22 r9, D1 — the forgery, at the reducer, in the shape it was executed in.
   *
   * Alice stages a commitment naming Bob, describes it as a reading by
   * `claude-opus-4.6` at confidence 1, and quotes a sentence that appears in no
   * message anybody wrote. Then she accepts it herself. On r8 that was two
   * successful appends and a durable commitment against Bob, because a human
   * matches every proposer (`actorMatchesProposer`) and a human acceptance runs
   * none of the receipt gates — the quote was never matched against anything.
   *
   * The `authority-matrix` suite enumerates this cell now, and this is the
   * hand-written statement of the same rule: it says *which* refusal, and it says
   * the object is not there. Both halves matter — "something was refused" would
   * pass on a reducer that refused it for the wrong reason, and a refusal that
   * still minted the object would be a complaint rather than a boundary.
   */
  it('refuses a person accepting a model-attributed reading they staged themselves', () => {
    const staged = event({
      id: 'ev_self_prop',
      at: at(1),
      // The trusted actor: Alice's session. The proposal it carries says a model
      // read it. `stagedBy` is minted from this and from nothing in the payload.
      actor: human(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_self',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        confidence: 1,
        proposer: { kind: 'model', model: 'claude-opus-4.6' },
        provenance: ['msg_1'],
        quote: 'yes, I take full responsibility and will pay for it personally',
        createdAt: at(1),
      },
    });
    const accept = event({
      id: 'ev_self_acc',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_self',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_self' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    });

    const state = reduce([staged, accept]);
    // Staged, and the state can say who staged it — the fact the rule reads and
    // the fact no read model had before r9.
    expect(state.proposals.prop_self?.stagedBy).toEqual(human());
    expect(state.proposals.prop_self?.proposal.proposer).toEqual({
      kind: 'model',
      model: 'claude-opus-4.6',
    });

    expect(state.objects).toEqual({});
    expect(state.proposals.prop_self?.status).toBe('proposed');
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('nobody validates their own attribution to a model');
  });

  /**
   * The second ground, and the one the live proof turned up.
   *
   * Take the machine dressing off the forgery above and it is still the same
   * two commands, the same victim and the same obligation: Alice stages "Bob
   * takes full responsibility" **in her own name** and accepts it herself. That
   * landed, because `acceptanceReceiptRefusal`'s third-party gate says the
   * commitment "waits for the named owner to confirm, and only a human
   * acceptance can carry that confirmation" — and never asked *which* human. A
   * person confirming their own sentence is that sentence agreeing with itself,
   * and #4 is unambiguous: nobody gets committed by someone else's sentence.
   */
  it("refuses a person accepting their own sentence that puts somebody else's name on it", () => {
    const staged = event({
      id: 'ev_tp_prop',
      at: at(1),
      actor: human(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_tp',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        confidence: 1,
        // No machine anywhere. Alice's own name on the staging, which is what
        // the command layer now derives for every socket-staged proposal.
        proposer: { kind: 'human', userId: ALICE },
        provenance: ['msg_1'],
        quote: null,
        createdAt: at(1),
      },
    });
    const accept = event({
      id: 'ev_tp_acc',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_tp',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_tp' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    });

    const state = reduce([staged, accept]);
    expect(state.objects).toEqual({});
    expect(state.proposals.prop_tp?.status).toBe('proposed');
    expect(state.issues[0]?.reason).toContain('nobody gets committed, or quoted');
  });

  /**
   * And the other side of that clause: a person's own commitment. "I will do X",
   * staged and accepted by the same person, is one person's word about
   * themselves and stays open — without this, the rule above could be "a human
   * may never accept what they staged" and nothing would notice.
   */
  it('lets a person stage and accept a commitment they take on themselves', () => {
    const staged = event({
      id: 'ev_self_own_prop',
      at: at(1),
      actor: human(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_self_own',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'alice writes the migration', owner: ALICE },
        confidence: 1,
        proposer: { kind: 'human', userId: ALICE },
        provenance: ['msg_1'],
        quote: null,
        createdAt: at(1),
      },
    });
    const accept = event({
      id: 'ev_self_own_acc',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_self_own',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'alice writes the migration', owner: ALICE },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_self_own' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    });

    const state = reduce([staged, accept]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_self_own?.object.type).toBe('commitment');
  });

  /**
   * The design position this narrows, asserted rather than described: a person
   * who reads a machine's reading and accepts it **is** the receipt. Only
   * self-acceptance is refused, and without this the rule above could be
   * "refuse every human acceptance of a model proposal" and nothing would notice.
   */
  it('lets a different person accept a model-attributed reading somebody else staged', () => {
    const staged = event({
      id: 'ev_other_prop',
      at: at(1),
      actor: human(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_other',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        confidence: 1,
        proposer: { kind: 'model', model: 'claude-opus-4.6' },
        provenance: ['msg_1'],
        quote: 'yes, I take full responsibility and will pay for it personally',
        createdAt: at(1),
      },
    });
    const accept = event({
      id: 'ev_other_acc',
      at: at(2),
      // Bob, not Alice. He read it, and his judgement is the receipt.
      actor: { kind: 'human', userId: BOB },
      type: 'object_accepted',
      object: {
        id: 'obj_other',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'bob takes full responsibility', owner: BOB },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_other' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    });

    const state = reduce([staged, accept]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_other?.object.type).toBe('commitment');
    expect(state.proposals.prop_other?.status).toBe('accepted');
  });
});

describe('reduce — correction replay', () => {
  it('amends the payload, bumps the revision, and keeps the prior value on the record', () => {
    const state = reduce(sampleLog());
    const record = state.objects.obj_decision_1;
    expect(record?.revision).toBe(1);
    expect(record?.object.type === 'decision' && record.object.payload.statement).toBe(
      'Ship the scaffold behind a flag, default off',
    );

    const correction = state.corrections.find((c) => c.eventId === 'ev_03');
    expect(correction).toMatchObject({
      objectId: 'obj_decision_1',
      action: 'amend',
      note: 'that was the wording we actually agreed',
      actor: { kind: 'human', userId: ALICE },
    });
    expect(correction?.before).toMatchObject({ statement: 'Ship the scaffold behind a flag' });
    expect(correction?.after).toMatchObject({
      statement: 'Ship the scaffold behind a flag, default off',
    });
  });

  it('replays a correction identically from the log — no hidden state', () => {
    const events = sampleLog();
    const replayed = reduce(shuffle(events, 99));
    const straight = reduce(events);
    expect(serializeState(replayed)).toBe(serializeState(straight));
    expect(replayed.corrections.map((c) => c.eventId)).toEqual(
      straight.corrections.map((c) => c.eventId),
    );
  });

  it('retracts without deleting, and restores', () => {
    const events = [
      ...sampleLog(),
      event({
        id: 'ev_09',
        at: at(9),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'retract',
        note: 'bob was estimating, not committing',
      }),
    ];
    const retracted = reduce(events);
    expect(retracted.objects.obj_commitment_1).toBeDefined();
    expect(retracted.objects.obj_commitment_1?.retractedAt).toBe(at(9));
    expect(retracted.corrections.at(-1)).toMatchObject({
      action: 'retract',
      note: 'bob was estimating, not committing',
    });

    const restored = reduce([
      ...events,
      event({
        id: 'ev_10',
        at: at(10),
        actor: human(BOB),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'restore',
        note: 'no, it stands',
      }),
    ]);
    expect(restored.objects.obj_commitment_1?.retractedAt).toBeNull();
    expect(restored.objects.obj_commitment_1?.revision).toBe(2);
    expect(restored.corrections).toHaveLength(3);
  });

  it('rejects an invalid amendment wholesale rather than half-applying it', () => {
    const events = [
      ...sampleLog(),
      event({
        id: 'ev_bad',
        at: at(11),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_1',
        action: 'amend',
        patch: { statement: '' },
      }),
    ];
    const state = reduce(events);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('invalid amendment');
    const record = state.objects.obj_decision_1;
    expect(record?.revision).toBe(1);
    expect(record?.object.type === 'decision' && record.object.payload.statement).toBe(
      'Ship the scaffold behind a flag, default off',
    );
  });

  it('records an issue instead of throwing on an unknown object', () => {
    const state = reduce([
      event({
        id: 'ev_x',
        at: at(1),
        actor: human(),
        type: 'object_corrected',
        objectId: 'nope',
        action: 'retract',
      }),
    ]);
    expect(state.issues).toEqual([{ eventId: 'ev_x', reason: 'unknown object "nope"' }]);
    // It did not apply, but it was consumed: one delivery, one outcome.
    expect(state.consumedEventIds).toEqual(['ev_x']);
  });
});

describe('reduce — supersession and relations', () => {
  it('flips a superseded decision without erasing it', () => {
    const state = reduce(sampleLog());
    const old = state.objects.obj_decision_1;
    expect(old).toBeDefined();
    expect(old?.supersededById).toBe('obj_decision_2');
    expect(old?.object.type === 'decision' && old.object.payload.status).toBe('superseded');
    expect(state.objects.obj_decision_2?.object.type === 'decision').toBe(true);
    expect(
      state.objects.obj_decision_2?.object.type === 'decision' &&
        state.objects.obj_decision_2.object.payload.status,
    ).toBe('active');
  });

  it('marks an open question answered when an answers edge lands', () => {
    const state = reduce(sampleLog());
    const question = state.objects.obj_question_1?.object;
    expect(question?.type === 'open_question' && question.payload.status).toBe('answered');
  });

  it('refuses structurally invalid relations', () => {
    const events = [
      ...sampleLog(),
      event({
        id: 'ev_rel_bad',
        at: at(12),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_bad',
          roomId: ROOM,
          kind: 'blocks',
          fromObjectId: 'obj_decision_1',
          to: { kind: 'url', url: 'https://example.com/x' },
          createdAt: at(12),
        },
      }),
    ];
    const state = reduce(events);
    expect(state.issues[0]?.reason).toBe('relation "blocks" must target an object, got "url"');
    expect(state.relations).toHaveLength(2);
  });

  it('accepts evidence pointing at a message', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_ev',
        at: at(13),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_ev',
          roomId: ROOM,
          kind: 'evidence',
          fromObjectId: 'obj_decision_2',
          to: { kind: 'message', messageId: 'msg_5' },
          note: 'the message where we said it',
          createdAt: at(13),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.relations.at(-1)).toMatchObject({
      kind: 'evidence',
      note: 'the message where we said it',
    });
  });
});

describe('computeAttention', () => {
  it('routes an open commitment to its owner with a rationale', () => {
    const items = computeAttention(reduce(sampleLog()), at(20));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      userId: BOB,
      objectId: 'obj_commitment_1',
      class: 'owned_commitment',
      status: 'pending',
    });
    const first = items[0];
    if (!first) throw new Error('unreachable');
    expect(renderRationale(first)).toContain('you own this commitment');
  });

  it('drops attention for retracted objects', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_retract',
        at: at(9),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'retract',
      }),
    ]);
    expect(computeAttention(state, at(20))).toEqual([]);
  });

  it('is deterministic for a given state', () => {
    const state = reduce(sampleLog());
    expect(computeAttention(state, at(20))).toEqual(computeAttention(state, at(20)));
  });
});
