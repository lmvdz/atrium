import { describe, expect, it } from 'vitest';
import {
  ATTENTION_PRIORITY,
  AttentionClass,
  type AttentionContext,
  AttentionItem,
  type ComputedAttentionItem,
  type CoreEvent,
  computeAttention,
  dismissAttention,
  rationaleFor,
  reconcileAttention,
  reduce,
  resolveAttention,
  sinceCursorCounts,
  sortAttention,
  transitionAttention,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM, sampleLog } from './fixtures.js';

/**
 * #6's attention projection: four classes, hardest-first, and a rationale that
 * names the person and the reason on every single item.
 */

const CAROL = 'user_carol';
const MEMBERS = { [ROOM]: [ALICE, BOB, CAROL] };

/** A staged decision proposal, which is what `needs_decision` waits on. */
function decisionProposal(overrides: {
  id: string;
  at: string;
  decidedBy?: string | null;
}): CoreEvent {
  return event({
    id: `ev_${overrides.id}`,
    at: overrides.at,
    actor: model(),
    type: 'proposal_recorded',
    proposal: {
      id: overrides.id,
      roomId: ROOM,
      type: 'decision',
      payload: {
        statement: 'Reset narrowing on mutating method calls',
        ...(overrides.decidedBy ? { decidedBy: overrides.decidedBy } : {}),
      },
      confidence: 0.9,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_1'],
      createdAt: overrides.at,
    },
  });
}

/** A staged commitment proposal naming somebody who wrote none of the messages. */
function thirdPartyCommitment(overrides: { id: string; at: string; owner: string }): CoreEvent {
  return event({
    id: `ev_${overrides.id}`,
    at: overrides.at,
    actor: model(),
    type: 'proposal_recorded',
    proposal: {
      id: overrides.id,
      roomId: ROOM,
      type: 'commitment',
      payload: { statement: 'Land the narrowing fix', owner: overrides.owner },
      confidence: 0.9,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['msg_bob'],
      createdAt: overrides.at,
    },
  });
}

const classesOf = (items: readonly ComputedAttentionItem[]) => items.map((entry) => entry.class);

describe('every generated item has a rationale that names the person', () => {
  it('is required by the schema — an empty one cannot exist', () => {
    const base = {
      id: 'attn_1',
      roomId: ROOM,
      userId: ALICE,
      objectId: 'obj_1',
      class: 'owned_commitment',
      createdAt: at(1),
    };
    expect(AttentionItem.safeParse({ ...base, rationale: '' }).success).toBe(false);
    expect(AttentionItem.safeParse(base).success).toBe(false);
  });

  it('is produced by exactly one function, which takes the person as an argument', () => {
    // The type-level half: `rationaleFor` is the only producer of the branded
    // `Rationale` that the item builder accepts, and its first parameter is the
    // user id. "Why you specifically" is a constructor argument, not a habit.
    const rationale = rationaleFor(BOB, { kind: 'mention', request: 'can you take a look?' });
    expect(rationale).toContain(`@${BOB}`);
    expect(rationale).toContain('can you take a look?');
  });

  it('holds across every item of a fully-populated room', () => {
    const state = reduce([
      ...sampleLog(),
      decisionProposal({ id: 'prop_d', at: at(9) }),
      thirdPartyCommitment({ id: 'prop_c', at: at(10), owner: CAROL }),
    ]);
    const items = computeAttention(state, {
      now: at(20),
      members: MEMBERS,
      mentions: [{ roomId: ROOM, objectId: 'obj_decision_2', userId: ALICE, request: 'thoughts?' }],
    });

    expect(items.length).toBeGreaterThan(0);
    for (const entry of items) {
      expect(entry.rationale.length).toBeGreaterThan(0);
      // Names the person…
      expect(entry.rationale).toContain(`@${entry.userId}`);
      // …and gives a reason, not just a label.
      expect(entry.rationale.length).toBeGreaterThan(`@${entry.userId} — `.length + 10);
      // …and every item parses as the schema requires.
      expect(AttentionItem.safeParse(entry).success).toBe(true);
    }
  });
});

describe('class 1 — needs_decision', () => {
  it('routes a named decision to the person named', () => {
    const state = reduce([
      ...sampleLog(),
      decisionProposal({ id: 'prop_d', at: at(9), decidedBy: BOB }),
    ]);
    const items = computeAttention(state, { now: at(20), members: MEMBERS }).filter(
      (entry) => entry.class === 'needs_decision',
    );
    expect(items.map((entry) => entry.userId)).toEqual([BOB]);
    expect(items[0]?.rationale).toContain('you are named as the one to decide this');
    expect(items[0]?.subjectKind).toBe('proposal');
    expect(items[0]?.objectId).toBe('prop_d');
  });

  it('fans an unassigned decision out to every member — "or any-member when unassigned"', () => {
    const state = reduce([...sampleLog(), decisionProposal({ id: 'prop_d', at: at(9) })]);
    const items = computeAttention(state, { now: at(20), members: MEMBERS }).filter(
      (entry) => entry.class === 'needs_decision',
    );
    expect(items.map((entry) => entry.userId)).toEqual([ALICE, BOB, CAROL]);
    expect(items[0]?.rationale).toContain('nobody is named on this decision');
  });

  it('produces nothing when membership is unknown, rather than guessing', () => {
    const state = reduce([...sampleLog(), decisionProposal({ id: 'prop_d', at: at(9) })]);
    expect(computeAttention(state, at(20)).filter((e) => e.class === 'needs_decision')).toEqual([]);
  });

  it('stops once the decision is accepted', () => {
    const state = reduce([
      ...sampleLog(),
      decisionProposal({ id: 'prop_d', at: at(9), decidedBy: BOB }),
      event({
        id: 'ev_accept_d',
        at: at(10),
        actor: human(BOB),
        type: 'object_accepted',
        object: {
          id: 'obj_accepted_d',
          roomId: ROOM,
          type: 'decision',
          payload: { statement: 'Reset narrowing on mutating method calls', decidedBy: BOB },
          provenance: { messageIds: ['msg_1'], proposalId: 'prop_d' },
          createdAt: at(10),
          updatedAt: at(10),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(
      computeAttention(state, { now: at(20), members: MEMBERS }).filter(
        (e) => e.class === 'needs_decision',
      ),
    ).toEqual([]);
  });
});

describe('class 2 — owned_commitment', () => {
  it('routes an open commitment to its owner', () => {
    const items = computeAttention(reduce(sampleLog()), at(20));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      userId: BOB,
      objectId: 'obj_commitment_1',
      class: 'owned_commitment',
      status: 'pending',
      subjectKind: 'object',
    });
    expect(items[0]?.rationale).toContain('you own this commitment');
  });

  it('ranks an overdue commitment above an on-time one, and says it is late', () => {
    // sampleLog's commitment is due at minute 9.
    const late = computeAttention(reduce(sampleLog()), at(20))[0];
    const early = computeAttention(reduce(sampleLog()), at(5))[0];
    expect(late?.priority).toBe(ATTENTION_PRIORITY.commitment_overdue);
    expect(early?.priority).toBe(ATTENTION_PRIORITY.commitment_open);
    expect(late?.rationale).toContain('which has passed');
  });

  it('asks the named owner to confirm a third-party commitment', () => {
    const state = reduce([
      ...sampleLog(),
      thirdPartyCommitment({ id: 'prop_c', at: at(9), owner: CAROL }),
    ]);
    const confirm = computeAttention(state, {
      now: at(20),
      members: MEMBERS,
      messageAuthors: { msg_bob: BOB },
    }).find((entry) => entry.objectId === 'prop_c');

    expect(confirm?.userId).toBe(CAROL);
    expect(confirm?.class).toBe('owned_commitment');
    expect(confirm?.priority).toBe(ATTENTION_PRIORITY.commitment_confirm);
    expect(confirm?.rationale).toContain('nobody gets committed by someone else');
  });

  it('does not ask anybody to confirm their own words', () => {
    const state = reduce([
      ...sampleLog(),
      thirdPartyCommitment({ id: 'prop_c', at: at(9), owner: BOB }),
    ]);
    const items = computeAttention(state, {
      now: at(20),
      members: MEMBERS,
      // BOB wrote the message, so this is a self-statement, not an imposition.
      messageAuthors: { msg_bob: BOB },
    });
    expect(items.find((entry) => entry.objectId === 'prop_c')).toBeUndefined();
  });

  it('drops attention for a retracted commitment', () => {
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
});

describe('class 3 — blocking_question', () => {
  function blockingLog(blocked: string): CoreEvent[] {
    return [
      ...sampleLog(),
      event({
        id: 'ev_q_open',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_blocker_q',
          roomId: ROOM,
          type: 'open_question',
          payload: { question: 'Which migration order do we run?' },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
      event({
        id: 'ev_obj',
        at: at(10),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_objective_1',
          roomId: ROOM,
          type: 'objective',
          payload: { title: 'Ship the narrowing fix' },
          createdAt: at(10),
          updatedAt: at(10),
        },
      }),
      event({
        id: 'ev_blocks',
        at: at(11),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_blocks',
          roomId: ROOM,
          kind: 'blocks',
          fromObjectId: 'obj_blocker_q',
          to: { kind: 'object', objectId: blocked },
          createdAt: at(11),
        },
      }),
    ];
  }

  it('routes a question blocking a commitment to that commitment’s owner', () => {
    const state = reduce(blockingLog('obj_commitment_1'));
    expect(state.issues).toEqual([]);
    const item = computeAttention(state, { now: at(20), members: MEMBERS }).find(
      (entry) => entry.class === 'blocking_question',
    );
    expect(item?.userId).toBe(BOB);
    expect(item?.rationale).toContain('you own the commitment this open question blocks');
  });

  it('fans a question blocking an objective out to the room — objectives have no owner', () => {
    const state = reduce(blockingLog('obj_objective_1'));
    const items = computeAttention(state, { now: at(20), members: MEMBERS }).filter(
      (entry) => entry.class === 'blocking_question',
    );
    expect(items.map((entry) => entry.userId)).toEqual([ALICE, BOB, CAROL]);
    expect(items[0]?.rationale).toContain('blocks the objective');
  });

  it('routes a question that names you, whatever it blocks', () => {
    const state = reduce(blockingLog('obj_commitment_1'));
    const items = computeAttention(state, {
      now: at(20),
      members: MEMBERS,
      questionMentions: [{ questionObjectId: 'obj_blocker_q', userId: CAROL }],
    }).filter((entry) => entry.class === 'blocking_question');
    expect(items.map((entry) => entry.userId).sort()).toEqual([BOB, CAROL]);
    expect(items.find((entry) => entry.userId === CAROL)?.rationale).toContain('names you');
  });

  it('stops once the question is answered, and returns when it is reopened', () => {
    const answered = [
      ...blockingLog('obj_commitment_1'),
      event({
        id: 'ev_answers',
        at: at(12),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_ans',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_blocker_q',
          to: { kind: 'object', objectId: 'obj_decision_2' },
          createdAt: at(12),
        },
      }),
    ];
    const context: AttentionContext = { now: at(20), members: MEMBERS };
    expect(
      computeAttention(reduce(answered), context).filter((e) => e.class === 'blocking_question'),
    ).toEqual([]);

    const reopened = reduce([
      ...answered,
      event({
        id: 'ev_reopen',
        at: at(13),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_blocker_q',
        action: 'reopen',
      }),
    ]);
    expect(
      computeAttention(reopened, context).filter((e) => e.class === 'blocking_question'),
    ).toHaveLength(1);
  });

  it('does not raise one for a question blocking a retracted commitment', () => {
    const state = reduce([
      ...blockingLog('obj_commitment_1'),
      event({
        id: 'ev_kill',
        at: at(12),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'retract',
      }),
    ]);
    expect(computeAttention(state, { now: at(20), members: MEMBERS })).toEqual([]);
  });
});

describe('class 4 — mention', () => {
  it('routes an upstream mention signal, quoting what was asked', () => {
    const items = computeAttention(reduce(sampleLog()), {
      now: at(20),
      mentions: [
        {
          roomId: ROOM,
          objectId: 'obj_decision_2',
          userId: CAROL,
          request: 'can you sanity-check this?',
        },
      ],
    });
    const mention = items.find((entry) => entry.class === 'mention');
    expect(mention?.userId).toBe(CAROL);
    expect(mention?.rationale).toContain('can you sanity-check this?');
    expect(mention?.priority).toBe(ATTENTION_PRIORITY.mention);
  });

  it('produces none without a signal — core never sees message bodies', () => {
    expect(computeAttention(reduce(sampleLog()), at(20)).some((e) => e.class === 'mention')).toBe(
      false,
    );
  });
});

describe('the sort — owed attention above everything', () => {
  it('follows #6’s order exactly', () => {
    const state = reduce([
      ...sampleLog(),
      decisionProposal({ id: 'prop_d', at: at(9), decidedBy: ALICE }),
      thirdPartyCommitment({ id: 'prop_c', at: at(10), owner: ALICE }),
    ]);
    const items = computeAttention(state, {
      now: at(20),
      members: MEMBERS,
      messageAuthors: { msg_bob: BOB },
      mentions: [{ roomId: ROOM, objectId: 'obj_decision_2', userId: ALICE, request: 'thoughts?' }],
    });

    expect(classesOf(items)).toEqual([
      'needs_decision', // 0
      'owned_commitment', // 1 — overdue
      'owned_commitment', // 3 — awaiting confirm
      'mention', // 5
    ]);
    expect(items.map((entry) => entry.priority)).toEqual([
      ATTENTION_PRIORITY.needs_decision,
      ATTENTION_PRIORITY.commitment_overdue,
      ATTENTION_PRIORITY.commitment_confirm,
      ATTENTION_PRIORITY.mention,
    ]);
  });

  it('breaks ties deterministically, so two nodes agree', () => {
    const state = reduce([...sampleLog(), decisionProposal({ id: 'prop_d', at: at(9) })]);
    const context: AttentionContext = { now: at(20), members: MEMBERS };
    expect(JSON.stringify(computeAttention(state, context))).toBe(
      JSON.stringify(computeAttention(state, context)),
    );
    const users = computeAttention(state, context)
      .filter((entry) => entry.class === 'needs_decision')
      .map((entry) => entry.userId);
    expect(users).toEqual([...users].sort());
  });

  it('sorts stored items that carry no priority, by class', () => {
    const stored = [
      { class: 'mention' as const, id: 'c', createdAt: at(1), userId: ALICE },
      { class: 'needs_decision' as const, id: 'a', createdAt: at(1), userId: ALICE },
      { class: 'blocking_question' as const, id: 'b', createdAt: at(1), userId: ALICE },
    ].map((partial) => ({
      ...partial,
      roomId: ROOM,
      objectId: 'obj',
      subjectKind: 'object' as const,
      rationale: 'because',
      status: 'pending' as const,
    }));
    expect(sortAttention(stored).map((entry) => entry.class)).toEqual([
      'needs_decision',
      'blocking_question',
      'mention',
    ]);
  });

  it('gives every class a tier, and every tier a distinct rank', () => {
    // Six tiers for four classes, because `owned_commitment` splits three ways
    // in #6's sentence. Spelled out so a new class cannot arrive without a rank
    // and a new tier cannot arrive without a class.
    const tiersByClass: Record<AttentionClass, (keyof typeof ATTENTION_PRIORITY)[]> = {
      needs_decision: ['needs_decision'],
      owned_commitment: ['commitment_overdue', 'commitment_confirm', 'commitment_open'],
      blocking_question: ['blocking_question'],
      mention: ['mention'],
    };
    expect(Object.keys(tiersByClass).sort()).toEqual([...AttentionClass.options].sort());
    expect(Object.values(tiersByClass).flat().sort()).toEqual(
      Object.keys(ATTENTION_PRIORITY).sort(),
    );
    expect(new Set(Object.values(ATTENTION_PRIORITY)).size).toBe(6);

    // …and the ranks are in #6's stated order.
    expect(Object.values(ATTENTION_PRIORITY)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ATTENTION_PRIORITY.needs_decision).toBeLessThan(ATTENTION_PRIORITY.commitment_overdue);
    expect(ATTENTION_PRIORITY.commitment_overdue).toBeLessThan(
      ATTENTION_PRIORITY.blocking_question,
    );
    expect(ATTENTION_PRIORITY.blocking_question).toBeLessThan(
      ATTENTION_PRIORITY.commitment_confirm,
    );
    expect(ATTENTION_PRIORITY.commitment_confirm).toBeLessThan(ATTENTION_PRIORITY.mention);
  });
});

describe('transitions', () => {
  const pending = AttentionItem.parse({
    id: 'attn_1',
    roomId: ROOM,
    userId: ALICE,
    objectId: 'obj_1',
    class: 'owned_commitment',
    rationale: 'because you own it',
    createdAt: at(1),
  });

  it('allows pending → resolved and pending → dismissed', () => {
    const resolved = resolveAttention(pending);
    expect(resolved.ok && resolved.item.status).toBe('resolved');
    const dismissed = dismissAttention(pending);
    expect(dismissed.ok && dismissed.item.status).toBe('dismissed');
  });

  it('refuses to bring a settled item back to the panel', () => {
    const dismissed = dismissAttention(pending);
    if (!dismissed.ok) throw new Error('unreachable');
    const back = transitionAttention(dismissed.item, 'pending');
    expect(back.ok).toBe(false);
    expect(back.ok === false && back.refusal).toContain('never returns to the panel');
  });

  it('refuses to resolve something already dismissed', () => {
    const dismissed = dismissAttention(pending);
    if (!dismissed.ok) throw new Error('unreachable');
    expect(resolveAttention(dismissed.item).ok).toBe(false);
  });

  it('treats a no-op transition as a no-op, not an error', () => {
    const same = transitionAttention(pending, 'pending');
    expect(same.ok && same.item).toBe(pending);
  });

  it('never mutates the item it is given', () => {
    resolveAttention(pending);
    expect(pending.status).toBe('pending');
  });
});

describe('reconciliation — resolution happens by acting on the object', () => {
  const state = reduce(sampleLog());
  const computed = computeAttention(state, at(20));

  it('resolves a pending item whose object no longer generates it', () => {
    const closed = reduce([
      ...sampleLog(),
      event({
        id: 'ev_done',
        at: at(9),
        actor: human(BOB),
        type: 'object_corrected',
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { status: 'done' },
      }),
    ]);
    // Nobody clicked anything; the commitment closed and the item is done.
    const reconciled = reconcileAttention(computed, computeAttention(closed, at(20)));
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe('resolved');
  });

  it('keeps a dismissed item dismissed across a recompute', () => {
    const dismissed = dismissAttention(computed[0] as AttentionItem);
    if (!dismissed.ok) throw new Error('unreachable');
    const reconciled = reconcileAttention([dismissed.item], computed);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe('dismissed');
  });

  it('leaves a brand-new item pending', () => {
    expect(reconcileAttention([], computed).map((entry) => entry.status)).toEqual(['pending']);
  });
});

describe('since-you-left counts', () => {
  const state = reduce(sampleLog());
  const items = computeAttention(state, at(20));

  it('counts everything for somebody who has never been here', () => {
    const counts = sinceCursorCounts(state, {
      userId: BOB,
      roomId: ROOM,
      seenAt: null,
      items,
    });
    expect(counts.attention).toBe(1);
    expect(counts.byClass.owned_commitment).toBe(1);
    // 4 objects accepted + 1 correction + 2 relations.
    expect(counts.changes).toBe(7);
    expect(counts.quiet).toBe(false);
  });

  it('counts nothing once the cursor is past everything', () => {
    const counts = sinceCursorCounts(state, {
      userId: BOB,
      roomId: ROOM,
      seenAt: at(30),
      items,
    });
    expect(counts).toMatchObject({ attention: 0, changes: 0, quiet: true });
  });

  it('counts each change event, not each changed object', () => {
    // An object accepted and then corrected while you were away is two things
    // that happened, and the correction is the interesting one.
    const counts = sinceCursorCounts(state, { userId: BOB, roomId: ROOM, seenAt: at(3), items });
    expect(counts.changes).toBe(6);
  });

  it('is scoped to one user and one room', () => {
    expect(
      sinceCursorCounts(state, { userId: ALICE, roomId: ROOM, seenAt: null, items }).attention,
    ).toBe(0);
    expect(
      sinceCursorCounts(state, { userId: BOB, roomId: 'room_2', seenAt: null, items }).changes,
    ).toBe(0);
  });

  it('ignores items that are no longer pending', () => {
    const dismissed = dismissAttention(items[0] as AttentionItem);
    if (!dismissed.ok) throw new Error('unreachable');
    const counts = sinceCursorCounts(state, {
      userId: BOB,
      roomId: ROOM,
      seenAt: null,
      items: [dismissed.item],
    });
    expect(counts.attention).toBe(0);
  });
});
