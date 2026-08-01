import { describe, expect, it } from 'vitest';
import {
  type AuthoredEvent,
  DEFAULT_ACCEPTANCE_RULES,
  foldEvents,
  MODEL_ACCEPTANCE_FLOOR,
  type ProvenanceMessage,
  proposalWithStatus,
  reduce,
  serializeState,
} from '../src/index.js';
import {
  ALICE,
  append,
  at,
  BOB,
  event,
  human,
  model,
  ROOM,
  reminted,
  sampleLog,
} from './fixtures.js';

/**
 * The trust boundary, pinned. Every case here is one a reducer that "mostly
 * works" would wave through: a proposal that arrives pre-accepted, an
 * acceptance citing a proposal that was already rejected or already spent, an
 * amendment to something the room retracted, two decisions superseding each
 * other into a loop. None of them may change state; all of them must be
 * visible in `state.issues`.
 */

const OTHER_ROOM = 'room_2';

type TestActor =
  | { kind: 'human'; userId: string }
  | { kind: 'model'; model: string }
  | { kind: 'system' };

/** The claim these fixtures quote, and the person who wrote it. */
const CLAIM_TEXT = 'the build is green on main';
const MSG_9: ProvenanceMessage[] = [{ id: 'msg_9', authorId: ALICE, body: CLAIM_TEXT }];

function proposalEvent(
  overrides: {
    id?: string;
    proposalId?: string;
    at?: string;
    roomId?: string;
    status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
    type?: 'decision' | 'claim';
    confidence?: number;
    proposer?: { kind: 'model'; model: string } | { kind: 'human'; userId: string };
    /** Who recorded it — drawn independently of who is named as proposer. */
    recordedBy?: TestActor;
  } = {},
): AuthoredEvent {
  const minute = overrides.at ?? at(1);
  const type = overrides.type ?? 'decision';
  return event({
    id: overrides.id ?? 'ev_prop',
    at: minute,
    actor: overrides.recordedBy ?? { kind: 'model', model: 'test-model' },
    type: 'proposal_recorded',
    proposal: {
      id: overrides.proposalId ?? 'prop_x',
      roomId: overrides.roomId ?? ROOM,
      type,
      payload:
        type === 'claim'
          ? { statement: CLAIM_TEXT, claimant: ALICE }
          : { statement: 'Adopt the watermark contract' },
      confidence: overrides.confidence ?? 0.9,
      proposer: overrides.proposer ?? { kind: 'model', model: 'test-model' },
      provenance: ['msg_9'],
      ...(type === 'claim' ? { quote: CLAIM_TEXT } : {}),
      createdAt: minute,
      ...(overrides.status ? { status: overrides.status } : {}),
    },
  } as Parameters<typeof event>[0]);
}

function acceptEvent(
  overrides: {
    id?: string;
    objectId?: string;
    at?: string;
    roomId?: string;
    proposalId?: string | null;
    type?: 'decision' | 'claim';
    actor?: TestActor;
    /** The receipt window. `null` supplies none at all, which is a refusal. */
    messages?: ProvenanceMessage[] | null;
    /** Mint a payload other than the one that was staged. */
    statement?: string;
    citing?: string[];
  } = {},
): AuthoredEvent {
  const minute = overrides.at ?? at(2);
  const type = overrides.type ?? 'decision';
  const messages = overrides.messages === undefined ? MSG_9 : overrides.messages;
  return event({
    id: overrides.id ?? 'ev_accept',
    at: minute,
    actor: overrides.actor ?? human(),
    ...(messages === null ? {} : { messages }),
    type: 'object_accepted',
    object: {
      id: overrides.objectId ?? 'obj_x',
      roomId: overrides.roomId ?? ROOM,
      type,
      payload:
        type === 'claim'
          ? { statement: overrides.statement ?? CLAIM_TEXT, claimant: ALICE }
          : { statement: overrides.statement ?? 'Adopt the watermark contract', decidedBy: ALICE },
      provenance: {
        messageIds: overrides.citing ?? ['msg_9'],
        proposalId: overrides.proposalId === undefined ? 'prop_x' : overrides.proposalId,
      },
      createdAt: minute,
      updatedAt: minute,
    },
  } as Parameters<typeof event>[0]);
}

describe('proposal lifecycle — a proposal may never arrive pre-blessed', () => {
  it('forces a pre-accepted proposal back to "proposed" and records the coercion', () => {
    const state = reduce([proposalEvent({ status: 'accepted' })]);

    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.proposals.prop_x?.acceptedObjectId).toBeNull();
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ eventId: 'ev_prop' });
    expect(state.issues[0]?.reason).toContain('forced to "proposed"');
    expect(Object.keys(state.objects)).toEqual([]);
  });

  it('records a normally-proposed proposal without an issue', () => {
    const state = reduce([proposalEvent()]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.status).toBe('proposed');
  });

  it('stores no second copy of the status — the record is the only holder', () => {
    const state = reduce([proposalEvent()]);
    const record = state.proposals.prop_x;
    expect(record).toBeDefined();
    // Not "the nested copy agrees": there is no nested copy to disagree.
    expect(record?.proposal).not.toHaveProperty('status');
    expect(Object.keys(record?.proposal ?? {})).not.toContain('status');
  });

  it('reports the accepted status through every reader, with nothing left stale', () => {
    const state = reduce([proposalEvent(), acceptEvent()]);
    const record = state.proposals.prop_x;
    if (!record) throw new Error('proposal missing');

    expect(record.status).toBe('accepted');
    expect(record.acceptedObjectId).toBe('obj_x');
    expect(proposalWithStatus(record).status).toBe('accepted');
    // The whole-proposal view is the record's fields plus the record's status.
    expect(proposalWithStatus(record)).toMatchObject({ id: 'prop_x', roomId: ROOM });
  });

  it('reports the rejected status through the same reader', () => {
    const state = reduce([
      proposalEvent(),
      event({
        id: 'ev_r',
        at: at(2),
        actor: human(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
        reason: 'not what was said',
      }),
    ]);
    const record = state.proposals.prop_x;
    if (!record) throw new Error('proposal missing');
    expect(proposalWithStatus(record).status).toBe('rejected');
    expect(record.rejectedReason).toBe('not what was said');
  });

  it('refuses a second rejection of the same proposal', () => {
    const reject = (id: string, minute: string) =>
      event({
        id,
        at: minute,
        actor: human(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
        reason: 'not what was said',
      });
    const state = reduce([proposalEvent(), reject('ev_r1', at(2)), reject('ev_r2', at(3))]);
    expect(state.proposals.prop_x?.status).toBe('rejected');
    expect(state.issues).toEqual([
      { eventId: 'ev_r2', reason: 'proposal "prop_x" was already rejected' },
    ]);
  });
});

describe('acceptance — an accepted object may only cite a live, matching proposal', () => {
  it('refuses an acceptance citing a proposal that does not exist', () => {
    const state = reduce([acceptEvent({ at: at(1) })]);
    expect(state.objects).toEqual({});
    expect(state.issues).toEqual([
      { eventId: 'ev_accept', reason: 'object "obj_x" cites unknown proposal "prop_x"' },
    ]);
    // Consumed, not applied. The event took its position in the log and spent
    // its id there; refusing it on business grounds does not hand it back.
    expect(state.consumedEventIds).toEqual(['ev_accept']);
  });

  it('refuses an acceptance of an already-rejected proposal', () => {
    const state = reduce([
      proposalEvent(),
      event({
        id: 'ev_reject',
        at: at(2),
        actor: human(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
        reason: 'that is not what she said',
      }),
      acceptEvent({ at: at(3) }),
    ]);

    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('rejected');
    expect(state.proposals.prop_x?.acceptedObjectId).toBeNull();
    expect(state.issues).toEqual([
      { eventId: 'ev_accept', reason: 'proposal "prop_x" was already rejected' },
    ]);
  });

  it('refuses a second object accepted from one proposal', () => {
    const state = reduce([
      proposalEvent(),
      acceptEvent({ id: 'ev_a1', objectId: 'obj_first', at: at(2) }),
      acceptEvent({ id: 'ev_a2', objectId: 'obj_second', at: at(3) }),
    ]);

    expect(Object.keys(state.objects)).toEqual(['obj_first']);
    expect(state.proposals.prop_x?.acceptedObjectId).toBe('obj_first');
    expect(state.issues).toEqual([
      {
        eventId: 'ev_a2',
        reason: 'proposal "prop_x" was already accepted as object "obj_first"',
      },
    ]);
  });

  it('refuses an acceptance whose type does not match its proposal', () => {
    const state = reduce([proposalEvent({ type: 'decision' }), acceptEvent({ type: 'claim' })]);

    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.issues).toEqual([
      {
        eventId: 'ev_accept',
        reason: 'proposal "prop_x" is a decision, cannot be accepted as a claim',
      },
    ]);
  });

  it('refuses an acceptance that drags a proposal across rooms', () => {
    const state = reduce([
      proposalEvent({ roomId: ROOM }),
      acceptEvent({ roomId: OTHER_ROOM, at: at(3) }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('belongs to room');
  });

  it('still accepts an object with no proposal at all — humans write facts directly', () => {
    const state = reduce([acceptEvent({ proposalId: null, at: at(1) })]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x?.object.provenance.proposalId).toBeNull();
    expect(state.consumedEventIds).toEqual(['ev_accept']);
  });

  it('accepts normally when the proposal is live and matching', () => {
    const state = reduce([proposalEvent(), acceptEvent()]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.status).toBe('accepted');
    expect(state.proposals.prop_x?.acceptedObjectId).toBe('obj_x');
  });
});

describe('the actor floor — gate 1: an acceptance with no proposal is human-only', () => {
  /**
   * The proposal boundary only means something if going around it is closed
   * too. An interpreter that cannot hand itself a pre-accepted proposal can
   * otherwise just skip the proposal: emit `object_accepted` with
   * `proposalId: null` and the fact is in the room, unaccepted by anyone.
   */
  it('refuses a proposal-less acceptance from a model actor', () => {
    const state = reduce([
      acceptEvent({ proposalId: null, at: at(1), type: 'claim', actor: model() }),
    ]);

    expect(state.objects).toEqual({});
    // Refused, but consumed: the id is spent whatever the outcome was.
    expect(state.consumedEventIds).toEqual(['ev_accept']);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.eventId).toBe('ev_accept');
    expect(state.issues[0]?.reason).toContain('only a human may accept an object directly');
    expect(state.issues[0]?.reason).toContain('model actor');
  });

  it('refuses a proposal-less acceptance from a system actor too', () => {
    const state = reduce([
      acceptEvent({ proposalId: null, at: at(1), type: 'claim', actor: { kind: 'system' } }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('system actor');
  });

  it('allows a proposal-less acceptance from a human — the answer-binding path', () => {
    const state = reduce([acceptEvent({ proposalId: null, at: at(1) })]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x?.object.provenance.proposalId).toBeNull();
    expect(state.consumedEventIds).toEqual(['ev_accept']);
  });

  it('lets a model actor accept its own claim proposal — the route that stays open', () => {
    // #4's auto-accept path, and the one this whole floor must not break: a
    // claim is inherently "X said Y", its truth status lives in `verification`,
    // and the cost asymmetry favours recall. So a model may close the loop on
    // its own claim proposal — and only on the types #4 says it may.
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
    expect(state.proposals.prop_x?.status).toBe('accepted');
  });

  it('gates on the acceptance actor, not on who proposed', () => {
    // A human-proposed reading still cannot be self-accepted by a model with no
    // proposal cited: the citation is the whole check.
    const state = reduce([
      proposalEvent({ id: 'ev_prop_human', proposalId: 'prop_h', type: 'claim' }),
      acceptEvent({
        id: 'ev_a',
        objectId: 'obj_a',
        proposalId: null,
        at: at(3),
        type: 'claim',
        actor: model(),
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('must record a proposal');
  });
});

describe('the actor floor — gate 2: a decision never auto-accepts', () => {
  /**
   * #4, verbatim: "Decisions — **never auto-accept.** Accepted only via (a)
   * answer-binding or (b) explicit accept from Needs-you/Current-state. This is
   * where 'that sounds good' ambiguity lives, so inference is banned at exactly
   * this point." The reducer holds that floor: a proposal the model wrote and
   * the model accepted is inference, however many events it took.
   */
  it('refuses a model actor accepting a decision through its own proposal', () => {
    const state = reduce([proposalEvent({ type: 'decision' }), acceptEvent({ actor: model() })]);

    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.proposals.prop_x?.acceptedObjectId).toBeNull();
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('is a decision accepted by a model actor');
    expect(state.issues[0]?.reason).toContain('never auto-accepts');
    expect(state.consumedEventIds).toEqual(['ev_prop', 'ev_accept']);
  });

  it('refuses a system actor accepting a decision too', () => {
    const state = reduce([proposalEvent(), acceptEvent({ actor: { kind: 'system' } })]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('system actor');
  });

  it('allows a human to accept a decision through a proposal', () => {
    const state = reduce([proposalEvent(), acceptEvent()]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
    expect(state.proposals.prop_x?.status).toBe('accepted');
  });

  it('leaves the model free to propose the decision it may not accept', () => {
    const state = reduce([proposalEvent({ type: 'decision' })]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.status).toBe('proposed');
  });
});

describe('the actor floor — gate 3: only a human marks a claim verified', () => {
  const claimEvent = (overrides: {
    id?: string;
    objectId?: string;
    at?: string;
    verification?: 'unverified' | 'verified' | 'disputed';
    actor?: TestActor;
  }) => {
    const minute = overrides.at ?? at(1);
    return event({
      id: overrides.id ?? 'ev_claim',
      at: minute,
      actor: overrides.actor ?? human(),
      type: 'object_accepted',
      object: {
        id: overrides.objectId ?? 'obj_claim',
        roomId: ROOM,
        type: 'claim',
        payload: {
          statement: 'the migration ran clean',
          claimant: BOB,
          verification: overrides.verification ?? 'unverified',
        },
        createdAt: minute,
        updatedAt: minute,
      },
    } as Parameters<typeof event>[0]);
  };

  it('refuses a claim born verified on a model actor’s word', () => {
    const state = reduce([claimEvent({ verification: 'verified', actor: model() })]);
    expect(state.objects).toEqual({});
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('would become a verified claim');
    expect(state.issues[0]?.reason).toContain('unverified or disputed');
  });

  it('still lets a model accept the same claim unverified — the `~` path', () => {
    const state = reduce([claimEvent({ verification: 'unverified', actor: model() })]);
    // Proposal-less, so gate 1 catches it; through a proposal it is legal.
    expect(state.issues[0]?.reason).toContain('only a human may accept an object directly');

    const viaProposal = reduce([
      proposalEvent({ type: 'claim' }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(viaProposal.issues).toEqual([]);
    const accepted = viaProposal.objects.obj_x?.object;
    expect(accepted?.type === 'claim' && accepted.payload.verification).toBe('unverified');
  });

  it('lets a model accept a disputed claim — only ✓ is gated', () => {
    const state = reduce([
      claimEvent({ verification: 'disputed', actor: model(), objectId: 'obj_disputed' }),
    ]);
    // Gate 1, not gate 3: the refusal is about the missing proposal.
    expect(state.issues[0]?.reason).toContain('only a human may accept an object directly');
    expect(state.issues[0]?.reason).not.toContain('verified claim');
  });

  it('allows a human to accept a verified claim', () => {
    const state = reduce([claimEvent({ verification: 'verified' })]);
    expect(state.issues).toEqual([]);
    const accepted = state.objects.obj_claim?.object;
    expect(accepted?.type === 'claim' && accepted.payload.verification).toBe('verified');
  });

  it('refuses a model amending a claim to verified, naming the verification rule', () => {
    // Doubly closed: corrections are human-only (gate 5) *and* verification is
    // human-only (gate 3). The reported reason is the specific one.
    const state = reduce([
      claimEvent({}),
      event({
        id: 'ev_verify',
        at: at(2),
        actor: model(),
        type: 'object_corrected',
        objectId: 'obj_claim',
        action: 'amend',
        patch: { verification: 'verified' },
      }),
    ]);
    const claim = state.objects.obj_claim?.object;
    expect(claim?.type === 'claim' && claim.payload.verification).toBe('unverified');
    expect(state.corrections).toEqual([]);
    expect(state.issues.at(-1)?.reason).toContain('would become a verified claim');
  });

  it('allows a human to amend a claim to verified', () => {
    const state = reduce([
      claimEvent({}),
      event({
        id: 'ev_verify',
        at: at(2),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_claim',
        action: 'amend',
        patch: { verification: 'verified' },
      }),
    ]);
    expect(state.issues).toEqual([]);
    const claim = state.objects.obj_claim?.object;
    expect(claim?.type === 'claim' && claim.payload.verification).toBe('verified');
    expect(state.corrections).toHaveLength(1);
  });
});

describe('the actor floor — gate 4: superseding a decision is human-only', () => {
  const supersede = (actor: TestActor, targetId: string, id: string) =>
    event({
      id,
      at: at(10),
      actor,
      type: 'relation_added',
      relation: {
        id: `rel_${id}`,
        roomId: ROOM,
        kind: 'supersedes',
        fromObjectId: 'obj_decision_2',
        to: { kind: 'object', objectId: targetId },
        createdAt: at(10),
      },
    } as Parameters<typeof event>[0]);

  const question = event({
    id: 'ev_q2',
    at: at(9),
    actor: human(),
    type: 'object_accepted',
    object: {
      id: 'obj_question_2',
      roomId: ROOM,
      type: 'open_question',
      payload: { question: 'Is the flag still needed?' },
      createdAt: at(9),
      updatedAt: at(9),
    },
  } as Parameters<typeof event>[0]);

  it('refuses a model superseding an accepted decision', () => {
    // sampleLog's obj_decision_1 is already superseded, so target the live one.
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_d3',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_decision_3',
          roomId: ROOM,
          type: 'decision',
          payload: { statement: 'A newer reading', decidedBy: ALICE },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_model_super',
        at: at(10),
        actor: model(),
        type: 'relation_added',
        relation: {
          id: 'rel_model_super',
          roomId: ROOM,
          kind: 'supersedes',
          fromObjectId: 'obj_decision_3',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(10),
        },
      }),
    ]);

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('retires an accepted decision');
    expect(state.objects.obj_decision_2?.supersededById).toBeNull();
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });

  it('allows a model to supersede an open question — #4 auto-accepts that one', () => {
    const state = reduce([...sampleLog(), question, supersede(model(), 'obj_question_2', 'ev_ms')]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_question_2?.supersededById).toBe('obj_decision_2');
  });

  it('allows a human to supersede a decision', () => {
    const state = reduce(sampleLog());
    expect(state.objects.obj_decision_1?.supersededById).toBe('obj_decision_2');
    expect(state.issues).toEqual([]);
  });
});

describe('the actor floor — gate 5: every correction verb is human-only', () => {
  for (const action of ['amend', 'retract', 'restore'] as const) {
    it(`refuses a model "${action}"`, () => {
      const base = sampleLog();
      const state = reduce([
        ...base,
        event({
          id: `ev_${action}`,
          at: at(9),
          actor: model(),
          type: 'object_corrected',
          objectId: 'obj_decision_2',
          action,
          ...(action === 'amend' ? { patch: { statement: 'quietly reworded' } } : {}),
        }),
      ]);

      expect(state.issues).toHaveLength(1);
      expect(state.issues[0]?.reason).toContain('corrections (amend, retract, restore)');
      expect(state.issues[0]?.reason).toContain('model actor');
      expect(state.corrections).toEqual(reduce(base).corrections);
      expect(state.objects.obj_decision_2?.revision).toBe(0);
      expect(state.objects.obj_decision_2?.retractedAt).toBeNull();
      // Consumed, though: the refusal is history, and a redelivery gets nothing.
      expect(state.consumedEventIds).toContain(`ev_${action}`);
    });
  }

  it('refuses a system actor correction as well', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_sys',
        at: at(9),
        actor: { kind: 'system' },
        type: 'object_corrected',
        objectId: 'obj_decision_2',
        action: 'retract',
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('system actor');
    expect(state.objects.obj_decision_2?.retractedAt).toBeNull();
  });

  it('allows every verb from a human', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_h_amend',
        at: at(9),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_2',
        action: 'amend',
        patch: { statement: 'Drop the flag; ship it on, today' },
      }),
      event({
        id: 'ev_h_retract',
        at: at(10),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_2',
        action: 'retract',
      }),
      event({
        id: 'ev_h_restore',
        at: at(11),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_2',
        action: 'restore',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.corrections.map((c) => c.action)).toEqual([
      'amend',
      'amend',
      'retract',
      'restore',
    ]);
    expect(state.objects.obj_decision_2?.retractedAt).toBeNull();
  });

  it('leaves proposal_rejected open to a model — withdrawing its OWN reading is not a correction', () => {
    // Deliberate, and recorded in `authority.ts`: a rejected proposal stays in
    // state, visible; nothing accepted is touched. An interpreter retiring its
    // own low-confidence reading is a path #4 wants open. #21 narrows it to
    // "its own" — see the binding gates below.
    const state = reduce([
      proposalEvent(),
      event({
        id: 'ev_model_reject',
        at: at(3),
        actor: model(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
        reason: 'confidence fell below θ on re-read',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.status).toBe('rejected');
  });
});

describe('the actor floor — gate 6: a machine may only act on its own proposals', () => {
  /**
   * Routed out of #19's gauntlet. r4 left `proposal_rejected` open to any actor
   * because "withdrawing a staged reading destroys nothing". True of a model
   * withdrawing its own reading; false of one interpreter retiring another's —
   * or a human's — before anyone has seen it, which is a silent delete with no
   * correction chain, by the one kind of actor that may not correct anything.
   *
   * Two interpreters against one room is the design (#7's two tiers), not an
   * attack, so this fires in ordinary operation and not only under adversary.
   */
  const other = () => model('other-model');

  it('refuses a second model accepting the first model’s proposal', () => {
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      acceptEvent({ type: 'claim', actor: other() }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.issues[0]?.reason).toContain('may only accept its own reading');
    expect(state.issues[0]?.reason).toContain('minting their judgement');
  });

  it('refuses a model accepting a human’s proposal', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', proposer: { kind: 'human', userId: BOB } }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('may only accept its own reading');
    expect(state.issues[0]?.reason).toContain(`user "${BOB}"`);
  });

  it('refuses a system actor, which can never own a proposal', () => {
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      acceptEvent({ type: 'claim', actor: { kind: 'system' } }),
    ]);
    expect(state.issues[0]?.reason).toContain('the system actor');
  });

  it('lets a human accept anybody’s proposal — that is the product', () => {
    const state = reduce([proposalEvent({ type: 'claim' }), acceptEvent({ type: 'claim' })]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });

  it('refuses a second model rejecting or superseding another’s reading', () => {
    const rejected = reduce([
      proposalEvent({ type: 'claim' }),
      event({
        id: 'ev_rej',
        at: at(3),
        actor: other(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
        reason: 'not convinced',
      }),
    ]);
    expect(rejected.proposals.prop_x?.status).toBe('proposed');
    expect(rejected.issues[0]?.reason).toContain('may only withdraw its own reading');

    const superseded = reduce([
      proposalEvent({ type: 'claim' }),
      event({
        id: 'ev_sup',
        at: at(3),
        actor: other(),
        type: 'proposal_superseded',
        proposalId: 'prop_x',
        reason: 're-read',
      }),
    ]);
    expect(superseded.proposals.prop_x?.status).toBe('proposed');
    expect(superseded.issues[0]?.reason).toContain('may only retire its own reading');
  });

  it('refuses a model rejecting a human’s proposal, but lets a human reject a model’s', () => {
    const modelRejectingHuman = reduce([
      proposalEvent({ type: 'claim', proposer: { kind: 'human', userId: BOB } }),
      event({
        id: 'ev_r',
        at: at(3),
        actor: model(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
      }),
    ]);
    expect(modelRejectingHuman.issues[0]?.reason).toContain('only a human may reject another');

    const humanRejectingModel = reduce([
      proposalEvent({ type: 'claim' }),
      event({
        id: 'ev_r',
        at: at(3),
        actor: human(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
      }),
    ]);
    expect(humanRejectingModel.issues).toEqual([]);
  });
});

describe('the actor floor — gate 7: a machine may not accept below the confidence floor', () => {
  /**
   * Also routed out of #19's gauntlet, and it closes the last of the open write
   * surface. The type gates above close what a model may mint; without this one
   * a model may mint a claim, question, commitment or objective at *any*
   * confidence, including zero, because θ lived entirely in the layer that mints
   * the events — a policy that holds only while that layer is the only writer.
   */
  it('refuses a model accepting its own near-zero-confidence claim', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.01 }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.issues[0]?.reason).toContain('below the floor');
    expect(state.issues[0]?.reason).toContain('propose it and let a human accept');
  });

  it('lets the same acceptance through once it clears the floor', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.7 }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });

  it('does not gate a human on confidence — the floor is about machines', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0 }),
      acceptEvent({ type: 'claim', actor: human() }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });

  it('is the engine’s θ, not a second number under it', () => {
    // Round 1's gauntlet closed the gap this test used to pin open. A claim at
    // 0.55 cleared the old "malformed, not merely debatable" floor of 0.5 and
    // did not clear the engine's θ_auto of 0.7 — so the reducer folded an
    // acceptance the engine would never have emitted, and the only place θ was
    // enforced was the layer that mints events. One table now (`policy.ts`),
    // read by both, and the reducer is where it binds.
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.55 }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('below the floor of 0.7');
    // Both sides literal. Comparing the floor to `DEFAULT_ACCEPTANCE_RULES` —
    // which is what round 2 did here — asserts they are derived from each other
    // and nothing about what either of them is; move θ_auto to 0.6 and the
    // equality still holds while the product's behaviour has changed.
    expect(MODEL_ACCEPTANCE_FLOOR.claim).toBe(0.7);
    expect(DEFAULT_ACCEPTANCE_RULES.claim.thetaAuto).toBe(0.7);
  });
});

describe('the actor floor — gate 8: a machine may only accept the reading it staged', () => {
  /**
   * Round 1's gauntlet, major 3: proposal binding bound the *proposal*, not what
   * came out of it. A model could stage a modest self-owned commitment, cite it,
   * and mint something else entirely — the citation is what a person clicks to
   * check the reading, so a citation that does not lead to the reading is worse
   * than no citation at all.
   */
  it('refuses an acceptance whose payload is not the one that was staged', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: model(), statement: 'the build is on fire' }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.issues[0]?.reason).toContain('does not carry its payload');
  });

  it('refuses an acceptance that pads or drops cited messages on the way through', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: model(), citing: ['msg_9', 'msg_10'] }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('the receipt may not change on the way through');
  });

  it('lets a human accept a proposal with an edit — a person read it', () => {
    // The asymmetry is the product: a machine may only land what was staged,
    // and a person may fix the wording as they accept it.
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({
        type: 'claim',
        actor: human(),
        statement: 'the build is green, on main and on the release branch',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });
});

describe('the actor floor — gate 9: no receipt, no acceptance', () => {
  /**
   * Round 1's second blocking finding: provenance validation was opt-in, so a
   * caller that supplied no messages got an empty problem set and an
   * auto-acceptance. The check fails closed now, in the reducer, where the
   * caller cannot forget it.
   */
  it('refuses a model acceptance with no message window at all', () => {
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: model(), messages: null }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('no message window supplied');
    expect(state.issues[0]?.reason).toContain('never accepted on trust');
  });

  it('refuses one whose quote is only inside somebody else’s blockquote', () => {
    // The spike's worst error, at the reducer this time: BOB quoted ALICE, the
    // model cited BOB's message, and every field looks right.
    const quoting: ProvenanceMessage[] = [
      { id: 'msg_9', authorId: BOB, body: `> ${CLAIM_TEXT}\n\nis it though?` },
    ];
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: model(), messages: quoting }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('reply-blockquote');
  });

  it('refuses a claim whose claimant wrote nothing it cites', () => {
    const someoneElse: ProvenanceMessage[] = [{ id: 'msg_9', authorId: BOB, body: CLAIM_TEXT }];
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: model(), messages: someoneElse }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('does not support "X said Y"');
  });

  it('refuses a model accepting a commitment somebody else’s sentence named', () => {
    // #4's whole third-party flow, as a trust boundary: the named owner has to
    // confirm, and a confirm can only arrive as a human acceptance.
    const window: ProvenanceMessage[] = [
      { id: 'msg_c', authorId: ALICE, body: 'Bob will wire the flag in tomorrow.' },
    ];
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
          payload: { statement: 'Wire the flag in', owner: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_c'],
          quote: 'Bob will wire the flag in tomorrow.',
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_ac',
        at: at(2),
        actor: model(),
        messages: window,
        type: 'object_accepted',
        object: {
          id: 'obj_c',
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: 'Wire the flag in', owner: BOB },
          provenance: { messageIds: ['msg_c'], proposalId: 'prop_c' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('did not write it');
    expect(state.issues.at(-1)?.reason).toContain('waits for the named owner to confirm');
  });

  it('lets the same commitment through when the owner wrote the sentence', () => {
    const window: ProvenanceMessage[] = [
      { id: 'msg_c', authorId: BOB, body: "I'll wire the flag in tomorrow." },
    ];
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
          payload: { statement: 'Wire the flag in', owner: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_c'],
          quote: "I'll wire the flag in tomorrow.",
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_ac',
        at: at(2),
        actor: model(),
        messages: window,
        type: 'object_accepted',
        object: {
          id: 'obj_c',
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: 'Wire the flag in', owner: BOB },
          provenance: { messageIds: ['msg_c'], proposalId: 'prop_c' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_c).toBeDefined();
  });

  it('does not ask a human acceptance for any of it', () => {
    // A person accepting a reading has read it. Their judgement is the receipt,
    // and demanding a window from them would be theatre.
    const state = reduce([
      proposalEvent({ type: 'claim', confidence: 0.9 }),
      acceptEvent({ type: 'claim', actor: human(), messages: null }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });
});

describe('the actor floor — gate 10: only a human declares a question answered', () => {
  /**
   * Round 1's gauntlet, major 4: the `answers` edge was open to any actor, so a
   * model could close a person's open question by pointing an arbitrary claim at
   * it — flipping the question to `answered` and clearing it out of everybody's
   * Needs-you without anybody agreeing to anything.
   */
  it('refuses a model answering an open question', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_q3',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_question_3',
          roomId: ROOM,
          type: 'open_question',
          payload: { question: 'Do we cut the branch today?' },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_model_answers',
        at: at(10),
        actor: model(),
        type: 'relation_added',
        relation: {
          id: 'rel_model_answers',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_question_3',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(10),
        },
      }),
    ]);
    expect(state.issues.at(-1)?.reason).toContain('declares an open question answered');
    const question = state.objects.obj_question_3?.object;
    expect(question?.type === 'open_question' && question.payload.status).toBe('open');
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });

  it('lets a human answer it', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_q3',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_question_3',
          roomId: ROOM,
          type: 'open_question',
          payload: { question: 'Do we cut the branch today?' },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_human_answers',
        at: at(10),
        actor: human(BOB),
        type: 'relation_added',
        relation: {
          id: 'rel_human_answers',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_question_3',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(10),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    const question = state.objects.obj_question_3?.object;
    expect(question?.type === 'open_question' && question.payload.status).toBe('answered');
  });
});

describe('the actor floor — gate 11: supersession follows the policy, all of it', () => {
  /**
   * Round 1's gauntlet, major 6: `decideSupersession` reserved commitments and
   * objectives to people and the reducer gated decisions only, so a model could
   * retire a human-accepted commitment — and silence the attention item that
   * went with it — through the door the policy believed was shut.
   */
  const retire = (target: string, actor: TestActor, id: string) =>
    event({
      id,
      at: at(12),
      actor,
      type: 'relation_added',
      relation: {
        id: `rel_${id}`,
        roomId: ROOM,
        kind: 'supersedes',
        fromObjectId: 'obj_newer',
        to: { kind: 'object', objectId: target },
        createdAt: at(12),
      },
    } as Parameters<typeof event>[0]);

  const newer = (type: 'commitment' | 'objective' | 'claim') =>
    event({
      id: 'ev_newer',
      at: at(11),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_newer',
        roomId: ROOM,
        type,
        payload:
          type === 'commitment'
            ? { statement: 'a newer commitment', owner: BOB }
            : type === 'objective'
              ? { title: 'a newer objective' }
              : { statement: 'a newer claim', claimant: BOB },
        createdAt: at(11),
        updatedAt: at(11),
      },
    } as Parameters<typeof event>[0]);

  it('refuses a model retiring a commitment', () => {
    const state = reduce([
      ...sampleLog(),
      newer('commitment'),
      retire('obj_commitment_1', model(), 'ev_r'),
    ]);
    expect(state.issues.at(-1)?.reason).toContain('retires an accepted commitment');
    expect(state.issues.at(-1)?.reason).toContain('obligation with a name on it');
    expect(state.objects.obj_commitment_1?.supersededById).toBeNull();
  });

  it('refuses a model retiring an objective', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_obj',
        at: at(10),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_objective_x',
          roomId: ROOM,
          type: 'objective',
          payload: { title: 'Ship it' },
          createdAt: at(10),
          updatedAt: at(10),
        },
      }),
      newer('objective'),
      retire('obj_objective_x', model(), 'ev_r'),
    ]);
    expect(state.issues.at(-1)?.reason).toContain('retires an accepted objective');
    expect(state.objects.obj_objective_x?.supersededById).toBeNull();
  });

  it('still lets a model retire a claim — #4 puts that one in the auto-accept row', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_claim_old',
        at: at(10),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_claim_old',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'an older claim', claimant: BOB },
          createdAt: at(10),
          updatedAt: at(10),
        },
      }),
      newer('claim'),
      retire('obj_claim_old', model(), 'ev_r'),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_claim_old?.supersededById).toBe('obj_newer');
  });

  it('lets a human retire any of them', () => {
    const state = reduce([
      ...sampleLog(),
      newer('commitment'),
      retire('obj_commitment_1', human(), 'ev_r'),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_commitment_1?.supersededById).toBe('obj_newer');
  });
});

describe('objectiveId — a fact filed under a heading the room cannot open', () => {
  const filed = (objectiveId: string | null, id = 'ev_filed') =>
    event({
      id,
      at: at(9),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_filed',
        roomId: ROOM,
        objectiveId,
        type: 'claim',
        payload: { statement: 'belongs to something', claimant: BOB },
        createdAt: at(9),
        updatedAt: at(9),
      },
    } as Parameters<typeof event>[0]);

  const objective = (id: string, roomId = ROOM) =>
    event({
      id: `ev_${id}`,
      at: at(8),
      actor: human(),
      type: 'object_accepted',
      object: {
        id,
        roomId,
        type: 'objective',
        payload: { title: 'Ship it' },
        createdAt: at(8),
        updatedAt: at(8),
      },
    } as Parameters<typeof event>[0]);

  it('refuses an object whose objective does not exist', () => {
    const state = reduce([...sampleLog(), filed('obj_no_such')]);
    expect(state.objects.obj_filed).toBeUndefined();
    expect(state.issues).toEqual([
      {
        eventId: 'ev_filed',
        reason: 'object "obj_filed" belongs to objective "obj_no_such", which does not exist',
      },
    ]);
  });

  it('refuses an objectiveId pointing at something that is not an objective', () => {
    const state = reduce([...sampleLog(), filed('obj_decision_1')]);
    expect(state.issues[0]?.reason).toContain('which is a decision, not an objective');
  });

  it('refuses an objective in another room', () => {
    const state = reduce([...sampleLog(), objective('obj_far', OTHER_ROOM), filed('obj_far')]);
    expect(state.issues[0]?.reason).toContain('its objective "obj_far" is in room "room_2"');
  });

  it('accepts an object filed under a real objective in its own room', () => {
    const state = reduce([...sampleLog(), objective('obj_objective_1'), filed('obj_objective_1')]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_filed?.object.objectiveId).toBe('obj_objective_1');
  });

  it('accepts an object filed under nothing', () => {
    const state = reduce([...sampleLog(), filed(null)]);
    expect(state.issues).toEqual([]);
  });
});

describe('proposal supersession — wiring the status that used to be dead', () => {
  /**
   * #19's gauntlet: "proposal status `superseded` is currently dead enum — wire
   * or remove". Wired, because it is the only honest label for a reading that
   * was replaced by a re-read rather than judged: collapsing it into `rejected`
   * tells the room a person declined something no person ever saw.
   */
  const supersede = (overrides: { id?: string; at?: string; by?: string | null } = {}) =>
    event({
      id: overrides.id ?? 'ev_sup',
      at: overrides.at ?? at(3),
      actor: model(),
      type: 'proposal_superseded',
      proposalId: 'prop_x',
      supersededByProposalId: overrides.by ?? null,
      reason: 're-read at interpretation_version 2',
    } as Parameters<typeof event>[0]);

  it('retires a proposal without pretending anybody judged it', () => {
    const state = reduce([proposalEvent({ type: 'claim' }), supersede()]);
    expect(state.issues).toEqual([]);
    const record = state.proposals.prop_x;
    expect(record?.status).toBe('superseded');
    expect(record?.rejectedReason).toBeNull();
    expect(record?.supersededReason).toBe('re-read at interpretation_version 2');
    expect(record?.acceptedObjectId).toBeNull();
  });

  it('records which newer reading replaced it', () => {
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      proposalEvent({ id: 'ev_p2', proposalId: 'prop_new', at: at(2), type: 'claim' }),
      supersede({ at: at(4), by: 'prop_new' }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.supersededByProposalId).toBe('prop_new');
  });

  it('refuses a replacement that does not exist, or lives in another room', () => {
    const ghost = reduce([proposalEvent({ type: 'claim' }), supersede({ by: 'prop_ghost' })]);
    expect(ghost.issues[0]?.reason).toContain('superseded by unknown proposal');
    expect(ghost.proposals.prop_x?.status).toBe('proposed');

    const crossRoom = reduce([
      proposalEvent({ type: 'claim' }),
      proposalEvent({
        id: 'ev_p2',
        proposalId: 'prop_far',
        at: at(2),
        roomId: OTHER_ROOM,
        type: 'claim',
      }),
      supersede({ at: at(4), by: 'prop_far' }),
    ]);
    expect(crossRoom.issues[0]?.reason).toContain('a re-reading cannot cross rooms');
  });

  it('refuses a proposal superseding itself', () => {
    const state = reduce([proposalEvent({ type: 'claim' }), supersede({ by: 'prop_x' })]);
    expect(state.issues[0]?.reason).toContain('cannot supersede itself');
  });

  it('refuses superseding a proposal that is already settled, whichever way', () => {
    for (const [label, settle] of [
      ['accepted', [proposalEvent({ type: 'claim' }), acceptEvent({ type: 'claim', at: at(2) })]],
      [
        'rejected',
        [
          proposalEvent({ type: 'claim' }),
          event({
            id: 'ev_rej',
            at: at(2),
            actor: human(),
            type: 'proposal_rejected',
            proposalId: 'prop_x',
          }),
        ],
      ],
    ] as const) {
      const state = reduce([...settle, supersede({ at: at(4) })]);
      expect(state.issues.at(-1)?.reason).toContain(`was already ${label}`);
    }
  });

  it('refuses accepting a superseded proposal, and says what to accept instead', () => {
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      proposalEvent({ id: 'ev_p2', proposalId: 'prop_new', at: at(2), type: 'claim' }),
      supersede({ at: at(3), by: 'prop_new' }),
      acceptEvent({ type: 'claim', at: at(4) }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('was already superseded by "prop_new"');
    expect(state.issues.at(-1)?.reason).toContain('accept the reading that replaced it');
  });

  it('refuses rejecting a superseded proposal', () => {
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      supersede({ at: at(2) }),
      event({
        id: 'ev_rej',
        at: at(3),
        actor: human(),
        type: 'proposal_rejected',
        proposalId: 'prop_x',
      }),
    ]);
    expect(state.issues.at(-1)?.reason).toContain('was already superseded');
  });

  it('records an issue for an unknown proposal rather than throwing', () => {
    const state = reduce([supersede({ at: at(1) })]);
    expect(state.issues).toEqual([{ eventId: 'ev_sup', reason: 'unknown proposal "prop_x"' }]);
    expect(state.consumedEventIds).toEqual(['ev_sup']);
  });
});

describe('corrections — retraction is withdrawal, and a no-op is not history', () => {
  it('refuses to amend a retracted object', () => {
    const base = [
      ...sampleLog(),
      event({
        id: 'ev_retract',
        at: at(9),
        actor: human(BOB),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'retract',
        note: 'bob was estimating',
      }),
    ];
    const retracted = reduce(base);
    const state = reduce([
      ...base,
      event({
        id: 'ev_amend_dead',
        at: at(10),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { statement: 'quietly bring it back' },
      }),
    ]);

    expect(state.issues).toEqual([
      {
        eventId: 'ev_amend_dead',
        reason: 'object "obj_commitment_1" is retracted — restore it before amending',
      },
    ]);
    const record = state.objects.obj_commitment_1;
    expect(record?.revision).toBe(retracted.objects.obj_commitment_1?.revision);
    expect(record?.object.type === 'commitment' && record.object.payload.statement).toBe(
      'Wire the flag into the server',
    );
    expect(state.corrections).toHaveLength(retracted.corrections.length);
  });

  it('treats an empty amend patch as a no-op — and says so rather than reporting success', () => {
    const before = reduce(sampleLog());
    const after = reduce([
      ...sampleLog(),
      event({
        id: 'ev_empty',
        at: at(9),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_1',
        action: 'amend',
      }),
    ]);

    // Nothing about the object moves…
    expect(after.objects.obj_decision_1?.revision).toBe(before.objects.obj_decision_1?.revision);
    expect(after.objects.obj_decision_1?.updatedAt).toBe(before.objects.obj_decision_1?.updatedAt);
    expect(after.corrections).toHaveLength(before.corrections.length);
    expect(after.consumedEventIds).toContain('ev_empty');
    // …and the caller is told, because `applied` with nothing applied reads as
    // success to everything downstream of it.
    expect(after.issues).toEqual([
      {
        eventId: 'ev_empty',
        reason:
          '"amend" on object "obj_decision_1" changed nothing — no correction was recorded and the revision did not move; an edit that matches what is already there is a no-op, not history',
      },
    ]);
  });

  it('treats a patch that changes nothing as a no-op too', () => {
    const before = reduce(sampleLog());
    const after = reduce([
      ...sampleLog(),
      event({
        id: 'ev_same',
        at: at(9),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_decision_1',
        action: 'amend',
        patch: { statement: 'Ship the scaffold behind a flag, default off' },
      }),
    ]);

    expect(after.issues.map((issue) => issue.eventId)).toEqual(['ev_same']);
    expect(after.issues[0]?.reason).toContain('changed nothing');
    expect(after.objects.obj_decision_1?.revision).toBe(before.objects.obj_decision_1?.revision);
    expect(after.corrections).toHaveLength(before.corrections.length);
  });

  it('records retract and restore in consumedEventIds like every other event', () => {
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
      event({
        id: 'ev_restore',
        at: at(10),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'restore',
      }),
    ]);
    expect(state.consumedEventIds).toContain('ev_retract');
    expect(state.consumedEventIds).toContain('ev_restore');
  });
});

describe('relations — typed edges must actually type-check against their endpoints', () => {
  const decision3 = event({
    id: 'ev_d3',
    at: at(9),
    actor: human(),
    type: 'object_accepted',
    object: {
      id: 'obj_decision_3',
      roomId: ROOM,
      type: 'decision',
      payload: { statement: 'A third reading of the same call', decidedBy: ALICE },
      createdAt: at(9),
      updatedAt: at(9),
    },
  });

  it('refuses a supersession cycle', () => {
    // sampleLog already has obj_decision_2 supersedes obj_decision_1.
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_cycle',
        at: at(9),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_cycle',
          roomId: ROOM,
          kind: 'supersedes',
          fromObjectId: 'obj_decision_1',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(9),
        },
      }),
    ]);

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('cannot supersede');
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
    expect(state.objects.obj_decision_2?.supersededById).toBeNull();
    expect(state.objects.obj_decision_1?.supersededById).toBe('obj_decision_2');
  });

  it('refuses a second superseder rather than overwriting the first', () => {
    const state = reduce([
      ...sampleLog(),
      decision3,
      event({
        id: 'ev_second_super',
        at: at(10),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_second_super',
          roomId: ROOM,
          kind: 'supersedes',
          fromObjectId: 'obj_decision_3',
          to: { kind: 'object', objectId: 'obj_decision_1' },
          createdAt: at(10),
        },
      }),
    ]);

    expect(state.issues).toEqual([
      {
        eventId: 'ev_second_super',
        reason: 'object "obj_decision_1" is already superseded by "obj_decision_2"',
      },
    ]);
    expect(state.objects.obj_decision_1?.supersededById).toBe('obj_decision_2');
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });

  it('refuses an "answers" edge that does not start at an open question', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_bad_answers_from',
        at: at(9),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_bad_from',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_commitment_1',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(9),
        },
      }),
    ]);

    expect(state.issues).toEqual([
      {
        eventId: 'ev_bad_answers_from',
        reason: 'relation "answers" must originate from an open_question, got "commitment"',
      },
    ]);
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });

  it('refuses an "answers" edge that does not land on a decision or a claim', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_bad_answers_to',
        at: at(9),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_bad_to',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_question_1',
          to: { kind: 'object', objectId: 'obj_commitment_1' },
          createdAt: at(9),
        },
      }),
    ]);

    expect(state.issues).toEqual([
      {
        eventId: 'ev_bad_answers_to',
        reason: 'relation "answers" must target a decision or a claim, got "commitment"',
      },
    ]);
  });

  it('allows an "answers" edge onto a claim', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_claim',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_claim_1',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'the flag defaults off in prod', claimant: BOB },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_answers_claim',
        at: at(10),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_answers_claim',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_question_1',
          to: { kind: 'object', objectId: 'obj_claim_1' },
          createdAt: at(10),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.relations.map((r) => r.id)).toContain('rel_answers_claim');
  });

  it('refuses a relation whose target object lives in another room', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_far',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_elsewhere',
          roomId: OTHER_ROOM,
          type: 'decision',
          payload: { statement: 'Something another room decided', decidedBy: ALICE },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_cross_room',
        at: at(10),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_cross',
          roomId: ROOM,
          kind: 'depends_on',
          fromObjectId: 'obj_decision_2',
          to: { kind: 'object', objectId: 'obj_elsewhere' },
          createdAt: at(10),
        },
      }),
    ]);

    expect(state.issues).toEqual([
      {
        eventId: 'ev_cross_room',
        reason:
          'relation "rel_cross" is in room "room_1" but its target object "obj_elsewhere" is in room "room_2"',
      },
    ]);
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });

  it('refuses a relation whose own room disagrees with its source object', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_wrong_room',
        at: at(9),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_wrong_room',
          roomId: OTHER_ROOM,
          kind: 'depends_on',
          fromObjectId: 'obj_decision_2',
          to: { kind: 'object', objectId: 'obj_commitment_1' },
          createdAt: at(9),
        },
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('its source object');
    expect(state.relations.map((r) => r.id)).toEqual(['rel_1', 'rel_2']);
  });
});

describe('the ordering gate — an out-of-order event is rejected, not recorded', () => {
  const objective = (id: string, minute: string, roomId = ROOM) =>
    event({
      id: `ev_${id}`,
      at: minute,
      actor: human(),
      type: 'object_accepted',
      object: {
        id: `obj_${id}`,
        roomId,
        type: 'objective',
        payload: { title: id },
        createdAt: minute,
        updatedAt: minute,
      },
    });

  const late = objective('late', at(3));

  it('tracks the last consumed position per room', () => {
    const state = reduce(sampleLog());
    expect(state.watermarks[ROOM]).toEqual({ at: at(8), id: 'ev_08' });
    expect(state.cursor).toEqual({ at: at(8), id: 'ev_08' });
  });

  it('tracks each room separately while the gate stays global', () => {
    const state = reduce([...sampleLog(), objective('other', at(9), OTHER_ROOM)]);
    expect(state.issues).toEqual([]);
    expect(state.watermarks[ROOM]).toEqual({ at: at(8), id: 'ev_08' });
    expect(state.watermarks[OTHER_ROOM]).toEqual({ at: at(9), id: 'ev_other' });
    expect(state.cursor).toEqual({ at: at(9), id: 'ev_other' });
  });

  it('rejects a stale event from another room too — ordering is a log property', () => {
    // Deliberate: `issues`, `corrections` and `consumedEventIds` are global
    // ordered lists, so a per-room gate would let two rooms interleave them one
    // way live and another way on replay. The gate is the log position.
    const live = reduce(sampleLog());
    const result = append(live, objective('other_late', at(2), OTHER_ROOM));

    expect(result.outcome).toBe('rejected');
    expect(result.state).toBe(live);
  });

  it('rejects an event that sorts before the cursor, changing nothing at all', () => {
    const live = reduce(sampleLog());
    const result = append(live, late);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('out_of_order');
    expect(result.detail).toContain('does not sort strictly after the consumed position');

    // Total: not the same *values*, the same object. Nothing was cloned and
    // nothing was written — no issue, no watermark move, no applied id.
    expect(result.state).toBe(live);
    expect(live.issues).toEqual([]);
    expect(live.objects.obj_late).toBeUndefined();
    expect(serializeState(result.state)).toBe(serializeState(reduce(sampleLog())));
  });

  it('rejects a verbatim redelivery, also without a trace', () => {
    const events = sampleLog();
    const live = reduce(events);
    const replayed = events.at(-1);
    if (!replayed) throw new Error('fixture changed');

    const result = append(live, replayed);
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    // A verbatim redelivery lands on exactly the cursor, so the *position*
    // gate is what refuses it — and the detail says the id is spent too, so a
    // caller is never told to re-mint an event that is already in the log.
    expect(result.reason).toBe('out_of_order');
    expect(result.detail).toContain('do not re-mint it');
    expect(result.state).toBe(live);
    expect(live.issues).toEqual([]);
  });

  it('rejects a redelivery that re-minted its timestamp, as a duplicate', () => {
    // The case position cannot see: same id, a *later* `at`. It clears the
    // ordering gate and is caught by the id, which is why both checks exist.
    const events = sampleLog();
    const live = reduce(events);
    const original = events.at(-1);
    if (!original) throw new Error('fixture changed');

    const result = append(live, reminted(original, { at: at(30) }));
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('duplicate');
    expect(result.detail).toContain('whatever timestamp it now carries');
    expect(result.state).toBe(live);
  });

  it('spends the id of an event that was consumed but did not apply', () => {
    // The r3 hole: only *applied* events were recorded as spent, so an event
    // that failed its business checks could be redelivered at a later
    // timestamp and retried against a state that had moved on — the same id
    // flipping failure into success. Consumption spends the id, not success.
    const ghost = event({
      id: 'ev_ghost',
      at: at(1),
      actor: human(),
      type: 'object_corrected',
      objectId: 'obj_x',
      action: 'amend',
      patch: { statement: 'an amendment that arrived before its object' },
    });
    const first = reduce([ghost]);
    expect(first.issues).toEqual([{ eventId: 'ev_ghost', reason: 'unknown object "obj_x"' }]);
    expect(first.consumedEventIds).toEqual(['ev_ghost']);

    // The object arrives afterwards, so the amendment would now succeed…
    const withObject = append(first, acceptEvent({ proposalId: null, at: at(2) })).state;
    expect(withObject.objects.obj_x).toBeDefined();

    // …and the same id comes back carrying a fresh timestamp. Rejected.
    const retry = append(withObject, reminted(ghost, { at: at(30) }));
    expect(retry.outcome).toBe('rejected');
    if (retry.outcome !== 'rejected') throw new Error('unreachable');
    expect(retry.reason).toBe('duplicate');
    expect(retry.state).toBe(withObject);
    expect(withObject.corrections).toEqual([]);
  });

  it('breaks a tie on event id, not just timestamp', () => {
    const first = reduce([objective('b', at(1))]);
    const result = append(first, objective('a', at(1)));

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('out_of_order');
    expect(result.state.objects.obj_a).toBeUndefined();
    expect(result.state.issues).toEqual([]);
  });

  it('rejects an event that lands on exactly the cursor', () => {
    // `<=`, not `<`. `(at, id)` is a total order, so one position holds one
    // event; a second event claiming it is a redelivery or a forged id, and
    // admitting it would let two payloads share a place in the log.
    const first = reduce([objective('a', at(1))]);
    const result = append(first, objective('a', at(1)));

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('out_of_order');
    expect(result.state).toBe(first);
  });

  it('still consumes the next event at the same timestamp with a higher id', () => {
    // Strict inequality is about the whole key, not about `at`: same minute,
    // larger id, is forward motion and is consumed.
    const first = reduce([objective('a', at(1))]);
    const result = append(first, objective('b', at(1)));
    expect(result.outcome).toBe('applied');
    expect(result.state.objects.obj_b).toBeDefined();
  });

  it('accepts the same late event in a full replay, where it is in order', () => {
    // The gate is about *arrival*. Handed the whole log at once, `reduce` sorts
    // it and the event applies exactly where it belongs.
    const replay = reduce([...sampleLog(), late]);
    expect(replay.issues).toEqual([]);
    expect(replay.objects.obj_late).toBeDefined();
  });

  it('consumes — and advances — an event refused on business grounds', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_refused',
        at: at(9),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_refused',
          roomId: ROOM,
          kind: 'blocks',
          fromObjectId: 'obj_nonexistent',
          to: { kind: 'object', objectId: 'obj_decision_1' },
          createdAt: at(9),
        },
      }),
    ]);
    // A business refusal is history: it happened, in order, and a replay of the
    // log reproduces it. That is why it lands in `issues` and moves the cursor,
    // and why an out-of-order event does neither.
    expect(state.issues).toHaveLength(1);
    expect(state.watermarks[ROOM]).toEqual({ at: at(9), id: 'ev_refused' });
    expect(state.cursor).toEqual({ at: at(9), id: 'ev_refused' });
  });

  it('reports the outcome of every event in a fold', () => {
    const { outcomes } = foldEvents([
      ...sampleLog(),
      proposalEvent({ id: 'ev_coerced', proposalId: 'prop_c', at: at(9), status: 'accepted' }),
      late,
    ]);
    const byId = new Map(
      outcomes.map((o) => [o.outcome === 'malformed' ? '<malformed>' : o.event.id, o.outcome]),
    );
    expect(byId.get('ev_01')).toBe('applied');
    expect(byId.get('ev_coerced')).toBe('applied_with_issue');
    // `late` sorts into position 3 of the batch, so in a full replay it is in
    // order and applies; nothing in a sorted fold is ever out of order.
    expect(byId.get('ev_late')).toBe('applied');
  });

  it('still folds the sample log incrementally to the full-replay state', () => {
    const events = sampleLog();
    const incremental = events.reduce((state, next) => append(state, next).state, reduce([]));
    expect(serializeState(incremental)).toBe(serializeState(reduce(events)));
  });
});
