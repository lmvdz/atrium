import { describe, expect, it } from 'vitest';
import { type CoreEvent, type CoreState, reduce, serializeState } from '../src/index.js';
import { ALICE, at, BOB, event, human, ROOM, sampleLog } from './fixtures.js';

/**
 * The trust boundary, pinned. Every case here is one a reducer that "mostly
 * works" would wave through: a proposal that arrives pre-accepted, an
 * acceptance citing a proposal that was already rejected or already spent, an
 * amendment to something the room retracted, two decisions superseding each
 * other into a loop. None of them may change state; all of them must be
 * visible in `state.issues`.
 */

const OTHER_ROOM = 'room_2';

function proposalEvent(
  overrides: {
    id?: string;
    proposalId?: string;
    at?: string;
    roomId?: string;
    status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
    type?: 'decision' | 'claim';
  } = {},
): CoreEvent {
  const minute = overrides.at ?? at(1);
  return event({
    id: overrides.id ?? 'ev_prop',
    at: minute,
    actor: { kind: 'model', model: 'test-model' },
    type: 'proposal_recorded',
    proposal: {
      id: overrides.proposalId ?? 'prop_x',
      roomId: overrides.roomId ?? ROOM,
      type: overrides.type ?? 'decision',
      payload:
        (overrides.type ?? 'decision') === 'claim'
          ? { statement: 'the build is green', claimant: ALICE }
          : { statement: 'Adopt the watermark contract' },
      confidence: 0.9,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_9'],
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
  } = {},
): CoreEvent {
  const minute = overrides.at ?? at(2);
  const type = overrides.type ?? 'decision';
  return event({
    id: overrides.id ?? 'ev_accept',
    at: minute,
    actor: human(),
    type: 'object_accepted',
    object: {
      id: overrides.objectId ?? 'obj_x',
      roomId: overrides.roomId ?? ROOM,
      type,
      payload:
        type === 'claim'
          ? { statement: 'the build is green', claimant: ALICE }
          : { statement: 'Adopt the watermark contract', decidedBy: ALICE },
      provenance: {
        messageIds: ['msg_9'],
        proposalId: overrides.proposalId === undefined ? 'prop_x' : overrides.proposalId,
      },
      createdAt: minute,
      updatedAt: minute,
    },
  } as Parameters<typeof event>[0]);
}

/** The parts of a state that must be untouched when an event is refused. */
function materialState(state: CoreState) {
  return serializeState({ ...state, issues: [], appliedEventIds: [] });
}

describe('proposal lifecycle — a proposal may never arrive pre-blessed', () => {
  it('forces a pre-accepted proposal back to "proposed" and records the coercion', () => {
    const state = reduce([proposalEvent({ status: 'accepted' })]);

    expect(state.proposals.prop_x?.status).toBe('proposed');
    expect(state.proposals.prop_x?.proposal.status).toBe('proposed');
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
    expect(state.appliedEventIds).toEqual([]);
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
    expect(state.appliedEventIds).toEqual(['ev_accept']);
  });

  it('accepts normally when the proposal is live and matching', () => {
    const state = reduce([proposalEvent(), acceptEvent()]);
    expect(state.issues).toEqual([]);
    expect(state.proposals.prop_x?.status).toBe('accepted');
    expect(state.proposals.prop_x?.acceptedObjectId).toBe('obj_x');
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

  it('treats an empty amend patch as a no-op — no correction, no revision bump', () => {
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

    expect(after.issues).toEqual([]);
    expect(after.objects.obj_decision_1?.revision).toBe(before.objects.obj_decision_1?.revision);
    expect(after.objects.obj_decision_1?.updatedAt).toBe(before.objects.obj_decision_1?.updatedAt);
    expect(after.corrections).toHaveLength(before.corrections.length);
    expect(after.appliedEventIds).toContain('ev_empty');
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

    expect(after.issues).toEqual([]);
    expect(after.objects.obj_decision_1?.revision).toBe(before.objects.obj_decision_1?.revision);
    expect(after.corrections).toHaveLength(before.corrections.length);
  });

  it('records retract and restore in appliedEventIds like every other event', () => {
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
    expect(state.appliedEventIds).toContain('ev_retract');
    expect(state.appliedEventIds).toContain('ev_restore');
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

describe('the room watermark — a live fold can never diverge from a replay', () => {
  const late = event({
    id: 'ev_late',
    at: at(3),
    actor: human(),
    type: 'object_accepted',
    object: {
      id: 'obj_late',
      roomId: ROOM,
      type: 'objective',
      payload: { title: 'Arrived after the fact' },
      createdAt: at(3),
      updatedAt: at(3),
    },
  });

  it('tracks the last consumed position per room', () => {
    const state = reduce(sampleLog());
    expect(state.watermarks[ROOM]).toEqual({ at: at(8), id: 'ev_08' });
  });

  it('keeps rooms independent', () => {
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_other_room',
        at: at(2),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_other_room',
          roomId: OTHER_ROOM,
          type: 'objective',
          payload: { title: 'A different room entirely' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.watermarks[ROOM]).toEqual({ at: at(8), id: 'ev_08' });
    expect(state.watermarks[OTHER_ROOM]).toEqual({ at: at(2), id: 'ev_other_room' });
  });

  it('refuses an incremental event that sorts before the watermark, and holds', () => {
    const live = reduce(sampleLog());
    const after = reduce([late], live);

    expect(after.issues).toHaveLength(1);
    expect(after.issues[0]?.eventId).toBe('ev_late');
    expect(after.issues[0]?.reason).toContain('precedes the watermark');
    expect(after.objects.obj_late).toBeUndefined();
    expect(after.appliedEventIds).toEqual(live.appliedEventIds);
    expect(after.watermarks[ROOM]).toEqual({ at: at(8), id: 'ev_08' });

    // The refusal is total: nothing but `issues` moved, so the live fold still
    // equals a replay of exactly the sequence it accepted.
    expect(materialState(after)).toBe(materialState(reduce(sampleLog())));
  });

  it('breaks a tie on event id, not just timestamp', () => {
    const first = reduce([
      event({
        id: 'ev_b',
        at: at(1),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_b',
          roomId: ROOM,
          type: 'objective',
          payload: { title: 'b' },
          createdAt: at(1),
          updatedAt: at(1),
        },
      }),
    ]);
    const after = reduce(
      [
        event({
          id: 'ev_a',
          at: at(1),
          actor: human(),
          type: 'object_accepted',
          object: {
            id: 'obj_a',
            roomId: ROOM,
            type: 'objective',
            payload: { title: 'a' },
            createdAt: at(1),
            updatedAt: at(1),
          },
        }),
      ],
      first,
    );

    expect(after.objects.obj_a).toBeUndefined();
    expect(after.issues[0]?.reason).toContain('precedes the watermark');
  });

  it('accepts the same late event in a full replay, where it is in order', () => {
    // The contract is about *incremental* application. Handed the whole log at
    // once, `reduce` sorts it and the event applies exactly where it belongs.
    const replay = reduce([...sampleLog(), late]);
    expect(replay.issues).toEqual([]);
    expect(replay.objects.obj_late).toBeDefined();
  });

  it('advances the watermark even when an event is refused', () => {
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
    expect(state.issues).toHaveLength(1);
    expect(state.watermarks[ROOM]).toEqual({ at: at(9), id: 'ev_refused' });
  });

  it('still folds the sample log incrementally to the full-replay state', () => {
    const events = sampleLog();
    const incremental = events.reduce((state, next) => reduce([next], state), reduce([]));
    expect(serializeState(incremental)).toBe(serializeState(reduce(events)));
  });
});
