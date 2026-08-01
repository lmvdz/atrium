import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  type CoreEvent,
  foldEvents,
  proposalWithStatus,
  reduce,
  serializeState,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM, sampleLog } from './fixtures.js';

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
    actor?:
      | { kind: 'human'; userId: string }
      | { kind: 'model'; model: string }
      | { kind: 'system' };
  } = {},
): CoreEvent {
  const minute = overrides.at ?? at(2);
  const type = overrides.type ?? 'decision';
  return event({
    id: overrides.id ?? 'ev_accept',
    at: minute,
    actor: overrides.actor ?? human(),
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

describe('the actor gate — a model may not mint a fact without a human', () => {
  /**
   * The proposal boundary only means something if going around it is closed
   * too. An interpreter that cannot hand itself a pre-accepted proposal can
   * otherwise just skip the proposal: emit `object_accepted` with
   * `proposalId: null` and the fact is in the room, unaccepted by anyone.
   */
  it('refuses a proposal-less acceptance from a model actor', () => {
    const state = reduce([acceptEvent({ proposalId: null, at: at(1), actor: model() })]);

    expect(state.objects).toEqual({});
    expect(state.appliedEventIds).toEqual([]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.eventId).toBe('ev_accept');
    expect(state.issues[0]?.reason).toContain('only a human may accept an object directly');
    expect(state.issues[0]?.reason).toContain('model actor');
  });

  it('refuses a proposal-less acceptance from a system actor too', () => {
    const state = reduce([acceptEvent({ proposalId: null, at: at(1), actor: { kind: 'system' } })]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('system actor');
  });

  it('allows a proposal-less acceptance from a human — the answer-binding path', () => {
    const state = reduce([acceptEvent({ proposalId: null, at: at(1) })]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x?.object.provenance.proposalId).toBeNull();
    expect(state.appliedEventIds).toEqual(['ev_accept']);
  });

  it('lets a model actor accept through a proposal — the route that stays open', () => {
    // The event's actor is the model, but the object cites a proposal a human
    // path staged; the gate is about proposal-less minting, not about which
    // process happens to emit the acceptance event.
    const state = reduce([proposalEvent(), acceptEvent({ actor: model() })]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
    expect(state.proposals.prop_x?.status).toBe('accepted');
  });

  it('gates on the acceptance actor, not on who proposed', () => {
    // A human-proposed reading still cannot be self-accepted by a model with no
    // proposal cited: the citation is the whole check.
    const state = reduce([
      proposalEvent({ id: 'ev_prop_human', proposalId: 'prop_h' }),
      acceptEvent({ id: 'ev_a', objectId: 'obj_a', proposalId: null, at: at(3), actor: model() }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('must record a proposal');
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
    // Deliberate: `issues`, `corrections` and `appliedEventIds` are global
    // ordered lists, so a per-room gate would let two rooms interleave them one
    // way live and another way on replay. The gate is the log position.
    const live = reduce(sampleLog());
    const result = appendEvent(live, objective('other_late', at(2), OTHER_ROOM));

    expect(result.outcome).toBe('rejected');
    expect(result.state).toBe(live);
  });

  it('rejects an event that sorts before the cursor, changing nothing at all', () => {
    const live = reduce(sampleLog());
    const result = appendEvent(live, late);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('out_of_order');
    expect(result.detail).toContain('sorts before the consumed position');

    // Total: not the same *values*, the same object. Nothing was cloned and
    // nothing was written — no issue, no watermark move, no applied id.
    expect(result.state).toBe(live);
    expect(live.issues).toEqual([]);
    expect(live.objects.obj_late).toBeUndefined();
    expect(serializeState(result.state)).toBe(serializeState(reduce(sampleLog())));
  });

  it('rejects a redelivered event as a duplicate, also without a trace', () => {
    const events = sampleLog();
    const live = reduce(events);
    const replayed = events.at(-1);
    if (!replayed) throw new Error('fixture changed');

    const result = appendEvent(live, replayed);
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('duplicate');
    expect(result.state).toBe(live);
    expect(live.issues).toEqual([]);
  });

  it('breaks a tie on event id, not just timestamp', () => {
    const first = reduce([objective('b', at(1))]);
    const result = appendEvent(first, objective('a', at(1)));

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('out_of_order');
    expect(result.state.objects.obj_a).toBeUndefined();
    expect(result.state.issues).toEqual([]);
  });

  it('consumes an equal-cursor event rather than rejecting it', () => {
    // `<` not `<=`: an event at exactly the consumed position is the next
    // event, not a stale one. Only a repeated *id* is a redelivery.
    const first = reduce([objective('a', at(1))]);
    const result = appendEvent(first, objective('b', at(1)));
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
    const byId = new Map(outcomes.map((o) => [o.event.id, o.outcome]));
    expect(byId.get('ev_01')).toBe('applied');
    expect(byId.get('ev_coerced')).toBe('applied_with_issue');
    // `late` sorts into position 3 of the batch, so in a full replay it is in
    // order and applies; nothing in a sorted fold is ever out of order.
    expect(byId.get('ev_late')).toBe('applied');
  });

  it('still folds the sample log incrementally to the full-replay state', () => {
    const events = sampleLog();
    const incremental = events.reduce((state, next) => appendEvent(state, next).state, reduce([]));
    expect(serializeState(incremental)).toBe(serializeState(reduce(events)));
  });
});
