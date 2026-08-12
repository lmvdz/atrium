import { describe, expect, it } from 'vitest';
import {
  type AuthoredEvent,
  DEFAULT_ACCEPTANCE_RULES,
  decideAcceptance,
  foldEvents,
  MODEL_ACCEPTANCE_FLOOR,
  Proposal,
  type ProvenanceMessage,
  proposalWithStatus,
  reduce,
  serializeState,
  wasConsumed,
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
  shuffle,
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
  /**
   * The identified non-human (drizzle/0017). It holds a `users` row, so unlike
   * `model` and `system` it is a kind that can actually *send* a frame over an
   * authenticated socket — which is why #96's findings are about this kind even
   * though the gates they exercise are older than it.
   */
  | { kind: 'agent'; userId: string }
  | { kind: 'model'; model: string }
  | { kind: 'system' };

/** A `users` row that is not a person. Distinct from ALICE and BOB on purpose. */
const SCRIBE = '11111111-2222-4333-8444-555555555555';

/** The claim these fixtures quote, and the person who wrote it. */
const CLAIM_TEXT = 'the build is green on main';
/**
 * …and the decision they quote. r4 requires a quote from a model proposal of
 * every type, not only the two that name a person, so ALICE's message has to
 * contain both sentences — a decision fixture that quotes nothing no longer
 * parses.
 */
const DECISION_TEXT = 'adopt the watermark contract';
/**
 * **One sentence per message.** r5: a certifiable quote is the whole of what its
 * author wrote in the bearing message, because a neighbouring sentence can
 * reverse the one being quoted and nothing about the quoted span can see that.
 * These two sentences used to share a body, which made every acceptance here a
 * referral and hid the gate each test is about.
 */
/**
 * …and the open question. **r7.** A model may no longer land a claim — see
 * `typeCertifiableFromText` — so `open_question` is the one type left that a
 * machine may accept, and the tests about the route that stays open have to run
 * on it or they assert nothing.
 */
const QUESTION_TEXT = 'do we keep the flag after launch?';
/**
 * …and the r7 case: an assertion whose words are equally an undertaking. The
 * receipt is perfect and the record still cannot say whether Jordan was
 * reporting a schedule or taking something on.
 */
const COMMITMENT_SHAPED_TEXT = 'we will deploy the narrowing fix on Friday afternoon';
const MSG_9: ProvenanceMessage[] = [
  { id: 'msg_9', authorId: ALICE, body: CLAIM_TEXT },
  { id: 'msg_10', authorId: ALICE, body: DECISION_TEXT },
  { id: 'msg_11', authorId: ALICE, body: QUESTION_TEXT },
  { id: 'msg_13', authorId: ALICE, body: COMMITMENT_SHAPED_TEXT },
  // Nobody cites this one: `laterRevision` refuses a window that stops at the
  // newest citation, so without a tail every acceptance here is a referral.
  { id: 'msg_12', authorId: BOB, body: 'thanks, watching the dashboard now' },
];
type FixtureType = 'decision' | 'claim' | 'open_question';
/** Which of them carries the sentence a proposal of this type is read out of. */
const citedFor = (type: FixtureType, commitmentShaped = false): string[] => [
  commitmentShaped
    ? 'msg_13'
    : { claim: 'msg_9', decision: 'msg_10', open_question: 'msg_11' }[type],
];
const textFor = (type: FixtureType, commitmentShaped = false): string =>
  commitmentShaped
    ? COMMITMENT_SHAPED_TEXT
    : { claim: CLAIM_TEXT, decision: DECISION_TEXT, open_question: QUESTION_TEXT }[type];

function proposalEvent(
  overrides: {
    id?: string;
    proposalId?: string;
    at?: string;
    roomId?: string;
    status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
    type?: FixtureType;
    confidence?: number;
    proposer?: { kind: 'model'; model: string } | { kind: 'human'; userId: string };
    /** Who recorded it — drawn independently of who is named as proposer. */
    recordedBy?: TestActor;
    /** r7: quote text whose words could be an undertaking as easily as a claim. */
    commitmentShaped?: boolean;
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
          ? { statement: textFor(type, overrides.commitmentShaped), claimant: ALICE }
          : type === 'open_question'
            ? { question: QUESTION_TEXT }
            : { statement: DECISION_TEXT },
      confidence: overrides.confidence ?? 0.9,
      proposer: overrides.proposer ?? { kind: 'model', model: 'test-model' },
      provenance: citedFor(type, overrides.commitmentShaped),
      quote: textFor(type, overrides.commitmentShaped),
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
    type?: FixtureType;
    actor?: TestActor;
    /** The receipt window. `null` supplies none at all, which is a refusal. */
    messages?: ProvenanceMessage[] | null;
    /** Mint a payload other than the one that was staged. */
    statement?: string;
    citing?: string[];
    /** r7: see `proposalEvent`. */
    commitmentShaped?: boolean;
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
          ? {
              statement: overrides.statement ?? textFor(type, overrides.commitmentShaped),
              claimant: ALICE,
            }
          : type === 'open_question'
            ? { question: overrides.statement ?? QUESTION_TEXT }
            : {
                statement: overrides.statement ?? 'Adopt the watermark contract',
                decidedBy: ALICE,
              },
      provenance: {
        messageIds: overrides.citing ?? citedFor(type, overrides.commitmentShaped),
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

  it('refuses a proposal-less acceptance that puts somebody else on the hook', () => {
    /**
     * #22 r10: the fifth route to "a member puts an obligation on another
     * member's name", and the one the r10 brief did not name.
     *
     * r9 closed the acceptance path by refusing a *self-staged* reading that
     * names a third party — and that gate lived inside `if (proposalId !== null)`.
     * An acceptance citing no proposal has no stager but the accepter, so it is
     * the same shape with the second party removed rather than merely absent,
     * and it walked past. One command, one member, one durable commitment
     * against a colleague.
     *
     * Unreachable from today's command layer (`objectFromProposal` always names
     * a proposal) and *not* dead code: this is the documented "a person writing
     * a fact outright" route, human-only by `humanOnlyRefusal`. The reducer is
     * the boundary, so it is closed here rather than left to the command layer
     * continuing not to expose it.
     *
     * Mutation this catches: move the `selfStagedReadingRefusal` call back
     * inside the `if (proposalId !== null)` block. Every r9 test still passes.
     */
    const state = reduce([
      acceptEvent({ proposalId: null, at: at(1), type: 'claim', actor: human(BOB) }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('accepted no proposal');
    expect(state.issues[0]?.reason).toContain('which they staged themselves');
    expect(state.issues[0]?.reason).toContain(`puts user "${ALICE}"'s name on it`);
  });

  it('allows the same acceptance when the name on it is the accepter’s own', () => {
    // The capability survives; only the part that spoke for somebody else is
    // gone. Mutation: refuse every proposal-less acceptance that names anybody,
    // and this fails — a gate that is too strong is caught as loudly as one that
    // is too weak.
    const state = reduce([
      acceptEvent({ proposalId: null, at: at(1), type: 'claim', actor: human(ALICE) }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });

  it('refuses a self-staged decision that names somebody else as the decider', () => {
    /**
     * #22 r10, D2. Two commands: stage a decision whose `decidedBy` is a
     * colleague, accept it yourself. Both acked with `issues: []` under r9, and
     * the room's record then said the colleague made the decision — with no
     * correction verb and no second party anywhere in it.
     *
     * It survived because `payloadAttributedTo` — the function the acceptance
     * gate read — resolved `claim → claimant`, `commitment → owner` and `null`
     * for everything else, while `ATTRIBUTION_FIELD` in the same package had
     * always said `decision → decidedBy`. One question, two answers, and the
     * narrower one sat on the path deciding whether the guard ran.
     *
     * Mutation this catches: restore `payloadAttributedTo`'s old body, or
     * reclassify `decidedBy` as `detail` in `attribution.ts`.
     */
    const state = reduce([
      proposalEvent({
        type: 'decision',
        proposer: { kind: 'human', userId: ALICE },
        recordedBy: human(ALICE),
      }),
      event({
        id: 'ev_accept',
        at: at(2),
        actor: human(ALICE),
        messages: MSG_9,
        type: 'object_accepted',
        object: {
          id: 'obj_x',
          roomId: ROOM,
          type: 'decision',
          payload: { statement: 'We are cancelling the audit', decidedBy: BOB },
          provenance: { messageIds: ['msg_9'], proposalId: 'prop_x' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      } as Parameters<typeof event>[0]),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain(`puts user "${BOB}"'s name on it`);
    expect(state.proposals.prop_x?.status).toBe('proposed');
  });

  it('lets a different person accept that same decision — the second party is the point', () => {
    // The design position r9 recorded and r10 does not touch: any human other
    // than the stager may accept a reading that names a third party. What is
    // refused is one person doing both, and this is the other half of that
    // partition.
    const state = reduce([
      proposalEvent({
        type: 'decision',
        proposer: { kind: 'human', userId: ALICE },
        recordedBy: human(ALICE),
      }),
      event({
        id: 'ev_accept',
        at: at(2),
        actor: human(BOB),
        messages: MSG_9,
        type: 'object_accepted',
        object: {
          id: 'obj_x',
          roomId: ROOM,
          type: 'decision',
          payload: { statement: 'We are cancelling the audit', decidedBy: BOB },
          provenance: { messageIds: ['msg_9'], proposalId: 'prop_x' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      } as Parameters<typeof event>[0]),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
  });

  it('lets a model actor accept its own claim proposal — the route that stays open', () => {
    // #4's auto-accept path, and the one this whole floor must not break: the
    // cost asymmetry favours recall, so a model may close the loop on its own
    // proposal — and only on the types #4 says it may.
    //
    // **r7's middle draft closed this and its third reopened it.** That draft
    // refused every model claim on the ground that nothing proves a claim was a
    // claim — true of the type, and it deleted the path this test is named
    // after. `CLAIM_TEXT` is "the build is green on main", an unambiguous
    // assertion; the r7 rule refuses only text that could be an undertaking, and
    // the test below this one is that half.
    const state = reduce([
      proposalEvent({ type: 'claim' }),
      acceptEvent({ type: 'claim', actor: model() }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_x).toBeDefined();
    expect(state.proposals.prop_x?.status).toBe('accepted');
  });

  it('refuses a model landing a claim whose words could be an undertaking', () => {
    // r7's finding at the trust boundary. Nothing is wrong with the reading: the
    // quote is real, the author is real, the confidence is high. What is missing
    // is any evidence that *"@dhlolo will land the fix on Friday"* was a claim
    // rather than a commitment — and `type` is the proposal's own word.
    const state = reduce([
      proposalEvent({ type: 'claim', commitmentShaped: true }),
      acceptEvent({ type: 'claim', actor: model(), commitmentShaped: true }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain(
      'read as something somebody is undertaking to do',
    );
    // …and a person accepting exactly the same reading still lands it, so this
    // is a rule about what a machine may settle, not about the reading.
    const byHuman = reduce([
      proposalEvent({ type: 'claim', commitmentShaped: true }),
      acceptEvent({ type: 'claim', actor: human(), commitmentShaped: true }),
    ]);
    expect(byHuman.issues).toEqual([]);
    expect(byHuman.objects.obj_x).toBeDefined();
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

describe('the guards can see the engine, which until r8 they could not', () => {
  /**
   * **r8's scoping finding.** Gutting `decideAcceptance` to an unconditional
   * `auto_accept` left this file green, and `replay.test.ts` too. The wider
   * suite caught it, so this was never a hole — but a file named *guards* that
   * cannot see the engine boundary measures half of what its name claims, and
   * the reducer half of every rule here has an engine twin whose disagreement is
   * exactly what `policy.ts` exists to prevent.
   *
   * The property, stated once: **anything the reducer refuses to fold, the
   * engine refuses to emit.** The engine may be stricter and may never be
   * looser, and neither may quietly become a no-op.
   */
  it('never emits an acceptance the reducer would refuse to fold', () => {
    const body = 'We will deploy production Friday afternoon as planned.';
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body },
      { id: 'm2', authorId: BOB, body: 'noted' },
      { id: 'm3', authorId: BOB, body: 'anything else for standup?' },
    ];
    // One body, and every type the proposal could pick for it. Not one may come
    // back `auto_accept`: three never auto-accept at any confidence, and the
    // fourth reads as an undertaking.
    for (const type of ['decision', 'commitment', 'objective', 'claim'] as const) {
      const payload =
        type === 'claim'
          ? { statement: body, claimant: ALICE }
          : type === 'commitment'
            ? { statement: body, owner: ALICE }
            : type === 'decision'
              ? { statement: body, decidedBy: ALICE }
              : { title: body };
      const decision = decideAcceptance(
        Proposal.parse({
          id: 'prop_guard',
          roomId: ROOM,
          type,
          payload,
          confidence: 0.99,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: body,
          createdAt: at(1),
        }),
        { messages },
      );
      expect(decision.verdict, type).not.toBe('auto_accept');
      // …and the reducer agrees, on the same input, at the same confidence.
      const state = reduce([
        event({
          id: 'ev_gp',
          at: at(1),
          actor: model(),
          type: 'proposal_recorded',
          proposal: {
            id: 'prop_guard',
            roomId: ROOM,
            type,
            payload,
            confidence: 0.99,
            proposer: { kind: 'model', model: 'test-model' },
            provenance: ['m1'],
            quote: body,
            createdAt: at(1),
          },
        } as Parameters<typeof event>[0]),
        event({
          id: 'ev_ga',
          at: at(2),
          actor: model(),
          messages,
          type: 'object_accepted',
          object: {
            id: 'obj_guard',
            roomId: ROOM,
            type,
            payload,
            provenance: { messageIds: ['m1'], proposalId: 'prop_guard' },
            createdAt: at(2),
            updatedAt: at(2),
          },
        } as Parameters<typeof event>[0]),
      ]);
      expect(state.objects, type).toEqual({});
    }
  });

  it('discards a reading the table says to discard rather than surfacing it', () => {
    // The other direction, and the one r7 measured a bad implementation by: a
    // claim below θ_min is *discarded*, not referred. An engine collapsed to one
    // verdict fails here whichever verdict it collapsed to.
    const body = 'The backfill completed with 4,218,904 rows and no retries.';
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body },
      { id: 'm2', authorId: BOB, body: 'thanks' },
    ];
    const claim = (confidence: number) =>
      decideAcceptance(
        Proposal.parse({
          id: 'prop_band',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: body, claimant: ALICE },
          confidence,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: body,
          createdAt: at(1),
        }),
        { messages },
      );
    expect(claim(0.4).verdict).toBe('discard');
    expect(claim(0.6).verdict).toBe('pending');
    expect(claim(0.6).visibility).toBe('quiet');
    expect(claim(0.95).verdict).toBe('auto_accept');
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
    // **Named, since r8.** This asserted only that the reason said "system
    // actor", which is true of the *confidence floor* refusal as well — so
    // deleting this gate left the test green while the room was told a decision
    // was refused for being under-confident rather than for being a decision.
    // Its sibling above pins the specific sentence and this one did not, which
    // is the whole of r7's lesson about a test that spans two enforcement
    // points measuring whichever is left.
    const state = reduce([proposalEvent(), acceptEvent({ actor: { kind: 'system' } })]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('system actor');
    expect(state.issues[0]?.reason).toContain('a decision never auto-accepts');
    expect(state.issues[0]?.reason).toContain('only a human may accept it');
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
      // BOB, because BOB is the claimant. Since #22 r10 a direct acceptance may
      // only put the accepter's own name on something, so ALICE minting a claim
      // by BOB is refused before gate 3 is reached at all — and gate 3 is what
      // these cases are about.
      actor: overrides.actor ?? human(BOB),
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
    // **The path r7's middle draft deleted and its third kept.** A model
    // accepting an unambiguous claim as unverified, rendering as "~" and never
    // as a fact, is #4's auto-accept loop; refusing every claim would have taken
    // it away for the sake of the commitment-shaped minority.
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

  it('refuses the claimant minting their own claim verified — self-verification (#68/#95)', () => {
    // BOB is the claimant, so BOB verifying BOB's own claim is the sentence
    // agreeing with itself. #95 keys verification on the relation, not only the
    // kind: a claim reaches ✓ verified only through a human who is neither its
    // claimant nor its stager (#102). **This fixture was the false-green that
    // pinned the #68 hole open** — it asserted this exact self-mint was `allowed`
    // until #102 corrected the oracle. The disinterested-human path stays open:
    // the authority matrix accepts a model-staged verified claim about BOB as
    // ALICE, and the amend-to-verified test below verifies through a third party.
    const state = reduce([claimEvent({ verification: 'verified' })]);
    expect(state.objects).toEqual({});
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('names them as its claimant');
    expect(state.issues[0]?.reason).toContain('second pair of eyes');
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

  /**
   * A model-accepted open question: `~`, nobody has touched it.
   *
   * Two events rather than the one-line `question` fixture above, and the
   * difference is the entire point of the pair of cases below. `question` is
   * minted by `human()`, so it is **confirmed** — and this test used to retire
   * that one and call the result "#4 auto-accepts that one". #4 does say a
   * machine may retire an open question; it does not say a machine may unmake a
   * person's acceptance of one, and until #96 r2 the reducer read the first
   * sentence as though it were the second.
   */
  const stagedQuestion = proposalEvent({
    id: 'ev_z1prop',
    proposalId: 'prop_q_unconfirmed',
    type: 'open_question',
    at: at(9),
  });
  const modelAcceptedQuestion = acceptEvent({
    id: 'ev_z2acc',
    objectId: 'obj_question_3',
    type: 'open_question',
    proposalId: 'prop_q_unconfirmed',
    actor: model(),
    at: at(9),
  });

  it('refuses a model retiring an UNCONFIRMED open question — #96 r3, and this test used to assert the opposite', () => {
    // **The `~` half of #95, which #96 r2 left open and its blind critic found.**
    // `obj_question_3` is a model's own unconfirmed reading — but retiring it is
    // still a `supersedes` relation on a *standing accepted* object, not the
    // `proposal_superseded` dedup of a pending proposal (the route that stays
    // open, exercised where proposals are staged, not here). #95 reserves every
    // such retirement to a person: an agent owns no proposal, so every
    // unconfirmed accepted object a machine reaches was accepted by another
    // machine, and unmaking one is not a machine's to do. The open route is to
    // draft a fresh `~`, never to retire the standing one.
    const state = reduce([
      ...sampleLog(),
      stagedQuestion,
      modelAcceptedQuestion,
      supersede(model(), 'obj_question_3', 'ev_ms'),
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('may never retire a standing accepted object');
    expect(state.issues[0]?.reason).toContain('even an unconfirmed reading');
    expect(state.issues[0]?.reason).toContain('model actor');
    // The fold, not the verdict: the reading is still standing.
    expect(state.objects.obj_question_3?.supersededById).toBeNull();
  });

  it('refuses a model retiring a CONFIRMED open question — #95, and this test used to assert the opposite', () => {
    // **The exact cell #96's two blind critics found, and the exact test that
    // pinned it as correct.** `question` is human-accepted, so it is a `✓` — and
    // #4's auto-accept row is about how cheap a *reading* is to replace, not
    // about whether a machine may delete a person's judgement. #95: a non-human
    // may never retire anything confirmed, whatever the type table says.
    const state = reduce([...sampleLog(), question, supersede(model(), 'obj_question_2', 'ev_ms')]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('retires an object a person has already confirmed');
    expect(state.issues[0]?.reason).toContain('model actor');
    // The fold, not the verdict: the question is still standing.
    expect(state.objects.obj_question_2?.supersededById).toBeNull();
  });

  it('lets a human retire the confirmed one — the route that stays open', () => {
    // The refusal above is not "this cannot be retired", it is "not on a
    // machine's word". A cell proving the door is still there, so a later round
    // cannot satisfy the rule by closing supersession altogether.
    const state = reduce([...sampleLog(), question, supersede(human(), 'obj_question_2', 'ev_hs')]);
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
      // **Literal, since r8.** This read `toEqual(reduce(base).corrections)` —
      // the expected value computed by the code under test, so a reducer that
      // recorded a correction for every refused verb would satisfy it on both
      // sides. A refusal records nothing, and the number is written down.
      expect(state.corrections.map((entry) => entry.eventId)).toEqual(['ev_03']);
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
  // **On `open_question`, since r7.** These ran on a claim, whose floor is now
  // `+Infinity` — no confidence clears it, because nothing in the words
  // establishes that they were a claim rather than a commitment — so a claim
  // pair would show the same refusal on both sides and pin no threshold at all.
  // `open_question` is the type a machine may still mint, so it is the one that
  // has a threshold to be under and over.
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

  it('refuses a commitment-shaped claim at any confidence, above the floor included', () => {
    // r7. The type rule is not a threshold: clearing θ does not make the words
    // less ambiguous, so the refusal survives every confidence above the floor.
    for (const confidence of [0.7, 0.95, 1]) {
      const state = reduce([
        proposalEvent({ type: 'claim', confidence, commitmentShaped: true }),
        acceptEvent({ type: 'claim', actor: model(), commitmentShaped: true }),
      ]);
      expect(state.objects, String(confidence)).toEqual({});
      expect(state.issues.at(-1)?.reason, String(confidence)).toContain(
        'read as something somebody is undertaking to do',
      );
    }
  });

  it('reports the receipt fault rather than the confidence, when both hold', () => {
    // r5's ordering. Both refuse the fold, so nothing is at stake except which
    // reason the room is shown — and "the quote says something the statement
    // dropped" is evidence about the record, while "confidence 0.4 is below 0.7"
    // is a fact about the model's mood. r4 reported the mood and buried the
    // evidence.
    const window: ProvenanceMessage[] = [
      { id: 'msg_9', authorId: ALICE, body: `${CLAIM_TEXT} for now` },
    ];
    const state = reduce([
      event({
        id: 'ev_prop',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_x',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: CLAIM_TEXT, claimant: ALICE },
          confidence: 0.4,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_9'],
          quote: `${CLAIM_TEXT} for now`,
          createdAt: at(1),
        },
      }),
      acceptEvent({ type: 'claim', actor: model(), messages: window }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues[0]?.reason).toContain('declines to rule on');
    expect(state.issues[0]?.reason).not.toContain('below the floor');
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
    //
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
          payload: { statement: 'Bob will wire the flag in tomorrow', owner: BOB },
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
          payload: { statement: 'Bob will wire the flag in tomorrow', owner: BOB },
          provenance: { messageIds: ['msg_c'], proposalId: 'prop_c' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    // r5: it does not even reach the third-party check. A machine may not mint
    // a commitment at all, so the refusal names that rule instead.
    expect(state.issues.at(-1)?.reason).toContain('is a commitment accepted by a model actor');
    expect(state.issues.at(-1)?.reason).toContain('writes an obligation onto a named person');
  });

  it('refuses it even when the owner wrote the sentence himself', () => {
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
          payload: { statement: "I'll wire the flag in tomorrow", owner: BOB },
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
          payload: { statement: "I'll wire the flag in tomorrow", owner: BOB },
          provenance: { messageIds: ['msg_c'], proposalId: 'prop_c' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    // **#44's fact-check, as a test.** A model actor proposed and accepted a
    // commitment naming a human and it landed with zero issues: the quote was
    // real, the author was real, and the attribution rules read it as
    // self-stated because the bearing message's author id equalled the owner.
    // Every gate held and none of them was the gate that was missing — whether a
    // machine may write an obligation onto a person at all.
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('is a commitment accepted by a model actor');
  });

  it('lets a human accept the same commitment — the route that stays open', () => {
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
          payload: { statement: "I'll wire the flag in tomorrow", owner: BOB },
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
        actor: human(BOB),
        messages: window,
        type: 'object_accepted',
        object: {
          id: 'obj_c',
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: "I'll wire the flag in tomorrow", owner: BOB },
          provenance: { messageIds: ['msg_c'], proposalId: 'prop_c' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_c).toBeDefined();
  });

  it('refuses a model accepting an objective — the heading everything is filed under', () => {
    // r5, and the argument is the one `decideSupersession` already makes on the
    // way out: retiring an objective needs a person, so minting one does too, or
    // the gate is a front door with the back door open.
    const window: ProvenanceMessage[] = [
      { id: 'msg_o', authorId: BOB, body: 'Ship the narrowing fix this quarter.' },
    ];
    const state = reduce([
      event({
        id: 'ev_po',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_o',
          roomId: ROOM,
          type: 'objective',
          payload: { title: 'Ship the narrowing fix this quarter' },
          confidence: 0.99,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['msg_o'],
          quote: 'Ship the narrowing fix this quarter.',
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_ao',
        at: at(2),
        actor: model(),
        messages: window,
        type: 'object_accepted',
        object: {
          id: 'obj_o',
          roomId: ROOM,
          type: 'objective',
          payload: { title: 'Ship the narrowing fix this quarter' },
          provenance: { messageIds: ['msg_o'], proposalId: 'prop_o' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('is an objective accepted by a model actor');
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
      // BOB owns and claims these, so BOB mints them (#22 r10): the case under
      // test is who may *retire* an object, not who may name one.
      actor: human(BOB),
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

  it('refuses a model retiring an UNCONFIRMED claim — #96 r3, and this test used to assert the opposite', () => {
    // Staged by a model and accepted by one: a `~` claim, which #4 calls cheap
    // to correct — but "correct" is drafting a *newer* reading, not retiring the
    // standing one on a machine's word. This is a `supersedes` relation on an
    // accepted object, and #95 reserves it to a person, confirmed or not: an
    // agent owns no proposal, so the accepter (`model()`) is another machine and
    // the retirement is foreign. The pending-proposal dedup a worker actually
    // runs is `proposal_superseded`, a different event, and stays open.
    const state = reduce([
      ...sampleLog(),
      proposalEvent({
        id: 'ev_p1prop',
        proposalId: 'prop_c_unconfirmed',
        type: 'claim',
        at: at(10),
      }),
      acceptEvent({
        id: 'ev_p2acc',
        objectId: 'obj_claim_old',
        type: 'claim',
        proposalId: 'prop_c_unconfirmed',
        actor: model(),
        at: at(10),
      }),
      newer('claim'),
      retire('obj_claim_old', model(), 'ev_r'),
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('may never retire a standing accepted object');
    expect(state.issues[0]?.reason).toContain('even an unconfirmed reading');
    expect(state.issues[0]?.reason).toContain('model actor');
    // The fold, not the verdict: the reading is still standing.
    expect(state.objects.obj_claim_old?.supersededById).toBeNull();
  });

  it('refuses a model retiring a claim a PERSON accepted — #95, and this test used to assert the opposite', () => {
    // **The breach, in the file that pinned it.** Same log as the case above
    // except for who accepted the claim being retired: BOB did, so it carries
    // BOB's judgement, and #4's auto-accept row does not license a machine to
    // unmake one. `epistemicStateOf` is the predicate — the same one the `✓` on
    // screen is rendered from, so the gate and the glyph cannot disagree.
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_claim_old',
        at: at(10),
        // BOB is the claimant, so BOB mints it (#22 r10).
        actor: human(BOB),
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
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('retires an object a person has already confirmed');
    expect(state.objects.obj_claim_old?.supersededById).toBeNull();
  });

  it('refuses an AGENT retiring a human-accepted claim — the session #96 actually hands out', () => {
    // The same cell as the one above, driven by the kind that made it reachable
    // from a socket. An agent holds an account, a room membership and a session,
    // so unlike `model()` it is a thing that can send this frame; that is the
    // whole reason #95's rule had to land in this ticket rather than in #102.
    const state = reduce([
      ...sampleLog(),
      event({
        id: 'ev_claim_old',
        at: at(10),
        actor: human(BOB),
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
      retire('obj_claim_old', { kind: 'agent', userId: SCRIBE }, 'ev_r'),
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('retires an object a person has already confirmed');
    expect(state.issues[0]?.reason).toContain('agent actor');
    expect(state.objects.obj_claim_old?.supersededById).toBeNull();
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
      // BOB names himself: see `claimEvent` above (#22 r10).
      actor: human(BOB),
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
    // The retract that precedes this is the object's only correction, so the
    // revision is 1 and the log holds one entry. Written down rather than
    // recomputed: `reduce(base).x` on the right of an assertion is the code
    // under test grading its own paper.
    expect(record?.revision).toBe(1);
    expect(record?.object.type === 'commitment' && record.object.payload.statement).toBe(
      'Wire the flag into the server',
    );
    expect(state.corrections).toHaveLength(2);
  });

  it('treats an empty amend patch as a no-op — and says so rather than reporting success', () => {
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

    // Nothing about the object moves… and the values are literal, r8: three of
    // these read `before.<same path>`, which passes for any reducer that treats
    // the two logs alike, including one that applies the no-op to both.
    expect(after.objects.obj_decision_1?.revision).toBe(1);
    expect(after.objects.obj_decision_1?.updatedAt).toBe(at(7));
    expect(after.corrections).toHaveLength(1);
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
    expect(after.objects.obj_decision_1?.revision).toBe(1);
    expect(after.corrections).toHaveLength(1);
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
      // `obj_question_1` is already answered by `obj_decision_2` in the sample
      // log, and since r8 the reducer repeats `answerBindingRefusal`'s
      // already-answered check — two `answers` edges on one question is round
      // 1's gauntlet finding, and it was still reachable through a raw
      // `relation_added`. Reopen it first: that is the route the refusal names.
      event({
        id: 'ev_reopen_q',
        at: at(8),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_question_1',
        action: 'reopen',
        note: 'the decision was withdrawn; this is open again',
      }),
      event({
        id: 'ev_claim',
        at: at(9),
        // BOB is the claimant, so BOB mints it (#22 r10).
        actor: human(BOB),
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

  it('folds an out-of-order arrival to a replay of what it consumed', () => {
    // **r8: this used to fold `sampleLog()` in its own canonical order**, so the
    // cursor gate it is named after never fired, and the ledger measured it
    // killing none of 85 mutations. The contract in `appendEvent`'s docblock is
    // about arrival order — *"whatever order those events arrived in,
    // serializeState(state) === serializeState(reduce(L))"*, where `L` is the
    // rows the state actually consumed — so the arrival order has to be wrong
    // for the assertion to be about anything.
    for (const seed of [1, 7, 42]) {
      const arrival = shuffle(sampleLog(), seed);
      const consumed: AuthoredEvent[] = [];
      let live = reduce([]);
      for (const next of arrival) {
        const result = append(live, next);
        if (wasConsumed(result)) consumed.push(next);
        live = result.state;
      }
      expect(serializeState(live), `seed ${seed}`).toBe(serializeState(reduce(consumed)));
      // …and the gate did something. A test whose premise is "some rows were
      // refused" has to say so, or a gate that stopped refusing reads as a pass.
      expect(consumed.length, `seed ${seed}`).toBeLessThan(arrival.length);
    }
  });
});
