import { describe, expect, it } from 'vitest';
import {
  type AuthoredEvent,
  type CoreEvent,
  type CoreState,
  confirmedAt,
  correctionChain,
  correctionChains,
  correctionCounterexamples,
  correctionRateByType,
  epistemicGlyph,
  epistemicStateOf,
  formatCounterexamples,
  objectHistory,
  reduce,
  serializeState,
  tombstoned,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM, room, sampleLog, shuffle } from './fixtures.js';

/**
 * #5's correction verbs, on top of the scaffold's three.
 *
 * The properties that matter are the same for every verb and are asserted for
 * every verb: nothing is erased, the chain stays reachable, and a replay of the
 * log reproduces the result exactly — including after an arbitrary chain of
 * corrections, which is the acceptance test on the ticket.
 */

const corrected = (
  overrides: Partial<Extract<CoreEvent, { type: 'object_corrected' }>> & {
    id: string;
    at: string;
    objectId: string;
    action: 'amend' | 'retract' | 'restore' | 'retype' | 'reattribute' | 'reopen';
  },
): AuthoredEvent =>
  event({
    actor: human(),
    type: 'object_corrected',
    ...overrides,
  } as Parameters<typeof event>[0]);

/** A claim accepted by a model, through its own proposal — so it starts at `~`. */
/**
 * A model-accepted object, which is what `epistemicStateOf` calls `unconfirmed`.
 *
 * **An open question since r7, and the rename is the finding.** This was a
 * model-accepted *claim* until r7 found that `type` is a model-supplied field
 * which selected the rule that judged the proposal — so a model may no longer
 * land a claim at all (`typeCertifiableFromText`) and the fixture stopped
 * producing an object. `open_question` is the one type the text certifies, so
 * it is the one that still reaches `~`.
 */
function modelAcceptedClaim(): AuthoredEvent[] {
  const question = 'do we keep the flag after launch?';
  const messages = room(
    { id: 'msg_1', authorId: BOB, body: question },
    { id: 'msg_2', authorId: ALICE, body: 'good question, adding it to the agenda' },
  );
  return [
    event({
      id: 'ev_mp',
      at: at(1),
      actor: model(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_m',
        roomId: ROOM,
        type: 'open_question',
        payload: { question },
        confidence: 0.9,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: ['msg_1'],
        quote: question,
        createdAt: at(1),
      },
    }),
    event({
      id: 'ev_ma',
      at: at(2),
      actor: model(),
      messages,
      type: 'object_accepted',
      object: {
        id: 'obj_model_claim',
        roomId: ROOM,
        type: 'open_question',
        payload: { question },
        provenance: { messageIds: ['msg_1'], proposalId: 'prop_m' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    }),
  ];
}

describe('retype — #5’s canonical fix', () => {
  /**
   * `obj_decision_2` answers `obj_question_1` in the sample log, and since r8 a
   * retype may not leave an `answers` edge pointing at a type that edge could
   * never have been created against (`retypeStructuralRefusal`). Retyping to a
   * `claim` is fine — a claim is a legal answer — and retyping to anything else
   * needs the question reopened first, which is exactly what the refusal says to
   * do and is what this event does. The edge stays on the record; `reopen` moves
   * it onto `reopenedFromAnswers`, which is what makes it history rather than a
   * live constraint.
   */
  const reopenTheQuestion = corrected({
    id: 'ev_reopen_first',
    at: at(8),
    objectId: 'obj_question_1',
    action: 'reopen',
    note: 'not settled after all',
  });

  const retypeToClaim = corrected({
    id: 'ev_retype',
    at: at(9),
    objectId: 'obj_decision_2',
    action: 'retype',
    toType: 'claim',
    patch: { claimant: ALICE },
    note: 'that was only a suggestion, not a decision',
    provenance: { messageIds: ['msg_correction'], proposalId: null, interpretationId: null },
  });

  it('turns a decision into a claim, carrying the sentence and the provenance', () => {
    const state = reduce([...sampleLog(), retypeToClaim]);
    expect(state.issues).toEqual([]);

    const record = state.objects.obj_decision_2;
    expect(record?.object.type).toBe('claim');
    expect(record?.object.type === 'claim' && record.object.payload.statement).toBe(
      'Drop the flag; ship it on',
    );
    expect(record?.object.type === 'claim' && record.object.payload.claimant).toBe(ALICE);
    // Provenance is untouched: retyping says how it was *read*, not where it came from.
    expect(record?.object.provenance.messageIds).toEqual(['msg_5']);
    expect(record?.object.id).toBe('obj_decision_2');
    expect(record?.object.createdAt).toBe(at(6));
    expect(record?.revision).toBe(1);
  });

  it('defaults the new type’s own fields and records the before/after', () => {
    const state = reduce([...sampleLog(), retypeToClaim]);
    const correction = state.corrections.at(-1);
    expect(correction).toMatchObject({
      action: 'retype',
      objectId: 'obj_decision_2',
      // The type as it *was* — the counterexample extractor depends on this.
      objectType: 'decision',
      note: 'that was only a suggestion, not a decision',
    });
    expect(correction?.before).toMatchObject({ type: 'decision' });
    expect(correction?.after).toMatchObject({ type: 'claim' });
    expect(correction?.provenance).toEqual({
      messageIds: ['msg_correction'],
      proposalId: null,
      interpretationId: null,
    });
    // A retyped claim is unverified until somebody says otherwise.
    const record = state.objects.obj_decision_2;
    expect(record?.object.type === 'claim' && record.object.payload.verification).toBe(
      'unverified',
    );
  });

  it('carries the text across differently-named fields', () => {
    const state = reduce([
      ...sampleLog(),
      reopenTheQuestion,
      corrected({
        id: 'ev_retype_q',
        at: at(9),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'open_question',
      }),
    ]);
    expect(state.issues).toEqual([]);
    const record = state.objects.obj_decision_2;
    expect(record?.object.type === 'open_question' && record.object.payload.question).toBe(
      'Drop the flag; ship it on',
    );
  });

  it('refuses a retype that would produce an invalid object', () => {
    // A commitment needs an owner and an open question has nobody on it. (It
    // used to be the decision here, which since r8 carries its `decidedBy` onto
    // the commitment's `owner` and is therefore valid without a patch — see
    // `retypeCarryOver`.)
    const state = reduce([
      ...sampleLog(),
      reopenTheQuestion,
      corrected({
        id: 'ev_retype_bad',
        at: at(9),
        objectId: 'obj_question_1',
        action: 'retype',
        toType: 'commitment',
      }),
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('cannot retype');
    expect(state.issues[0]?.reason).toContain('owner');
    expect(state.objects.obj_question_1?.object.type).toBe('open_question');
    expect(state.corrections.some((c) => c.action === 'retype')).toBe(false);
  });

  it('accepts the same retype once the patch supplies what the new type needs', () => {
    const state = reduce([
      ...sampleLog(),
      reopenTheQuestion,
      corrected({
        id: 'ev_retype_ok',
        at: at(9),
        objectId: 'obj_question_1',
        action: 'retype',
        toType: 'commitment',
        patch: { owner: BOB },
      }),
    ]);
    expect(state.issues).toEqual([]);
    const record = state.objects.obj_question_1;
    expect(record?.object.type === 'commitment' && record.object.payload.owner).toBe(BOB);
  });

  it('refuses a retype with no target type, and one to the same type', () => {
    const missing = reduce([
      ...sampleLog(),
      corrected({ id: 'ev_r1', at: at(9), objectId: 'obj_decision_2', action: 'retype' }),
    ]);
    expect(missing.issues[0]?.reason).toContain('did not say what to retype it to');

    const same = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_r2',
        at: at(9),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'decision',
      }),
    ]);
    expect(same.issues[0]?.reason).toContain('is already a decision');
  });

  it('refuses a retype from a model, like every other correction verb', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_r3',
        at: at(9),
        actor: model(),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: ALICE },
      } as never),
    ]);
    expect(state.issues[0]?.reason).toContain('corrections (amend, retract, restore)');
    expect(state.objects.obj_decision_2?.object.type).toBe('decision');
  });

  it('refuses a retype of a retracted object', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({ id: 'ev_rt', at: at(9), objectId: 'obj_decision_2', action: 'retract' }),
      corrected({
        id: 'ev_r4',
        at: at(10),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: ALICE },
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('restore it before applying "retype"');
  });
});

describe('reattribute — the verb split that keeps the log readable', () => {
  it('moves a commitment onto another person and records it as its own verb', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_reattr',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'reattribute',
        patch: { owner: ALICE },
        note: 'bob was estimating, not committing',
      }),
    ]);
    expect(state.issues).toEqual([]);
    const record = state.objects.obj_commitment_1;
    expect(record?.object.type === 'commitment' && record.object.payload.owner).toBe(ALICE);
    expect(state.corrections.at(-1)).toMatchObject({
      action: 'reattribute',
      objectType: 'commitment',
    });
  });

  it('refuses an amend that would move the obligation instead', () => {
    // The point of the split: "who took this off me" must be answerable by verb.
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_sneaky',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { owner: ALICE, statement: 'Wire the flag in' },
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('may not change "owner"');
    expect(state.issues[0]?.reason).toContain('reattribute');
    const record = state.objects.obj_commitment_1;
    expect(record?.object.type === 'commitment' && record.object.payload.owner).toBe(BOB);
  });

  it('refuses a reattribute that changes anything else', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_wide',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'reattribute',
        patch: { owner: ALICE, statement: 'and while we are here' },
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('may only change "owner"');
  });

  it('refuses a reattribute that changes nothing', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({ id: 'ev_empty', at: at(9), objectId: 'obj_commitment_1', action: 'reattribute' }),
    ]);
    expect(state.issues[0]?.reason).toContain('changed nothing');
  });

  it('refuses a reattribute on a type that names nobody', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_noattr',
        at: at(9),
        objectId: 'obj_question_1',
        action: 'reattribute',
        patch: { status: 'open' },
      }),
    ]);
    expect(state.issues[0]?.reason).toContain('has no attribution field');
  });

  it('still lets amend change everything that is not the attribution field', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_ok',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { statement: 'Wire the flag into the server, behind the env var' },
      }),
    ]);
    expect(state.issues).toEqual([]);
  });
});

describe('reopen — the prior answer stays on the record', () => {
  const reopen = corrected({
    id: 'ev_reopen',
    at: at(9),
    objectId: 'obj_question_1',
    action: 'reopen',
    note: 'that did not actually settle it',
  });

  it('returns an answered question to open', () => {
    const state = reduce([...sampleLog(), reopen]);
    expect(state.issues).toEqual([]);
    const question = state.objects.obj_question_1?.object;
    expect(question?.type === 'open_question' && question.payload.status).toBe('open');
  });

  it('preserves the answer it had — the v6 affordance, literally', () => {
    const state = reduce([...sampleLog(), reopen]);
    const record = state.objects.obj_question_1;
    // The `answers` edge is not removed: the relation log is append-only.
    expect(state.relations.map((r) => r.id)).toContain('rel_2');
    // …and the record says which edges had settled it, so an answered-then-
    // reopened question is distinguishable from one never answered.
    expect(record?.reopenedFromAnswers).toEqual(['rel_2']);
    expect(state.corrections.at(-1)?.before).toMatchObject({
      status: 'answered',
      answeredBy: ['rel_2'],
    });
    expect(objectHistory(state, 'obj_question_1')?.priorAnswers).toEqual(['rel_2']);
  });

  it('refuses to reopen a question that is already open', () => {
    const state = reduce([
      ...sampleLog(),
      reopen,
      { ...reopen, event: { ...reopen.event, id: 'ev_again', at: at(10) } },
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('already open');
  });

  it('reopens a closed commitment', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_done',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { status: 'done' },
      }),
      corrected({ id: 'ev_ro', at: at(10), objectId: 'obj_commitment_1', action: 'reopen' }),
    ]);
    expect(state.issues).toEqual([]);
    const record = state.objects.obj_commitment_1?.object;
    expect(record?.type === 'commitment' && record.payload.status).toBe('open');
  });

  it('refuses to reopen a decision, and says what to do instead', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({ id: 'ev_rd', at: at(9), objectId: 'obj_decision_1', action: 'reopen' }),
    ]);
    expect(state.issues[0]?.reason).toContain('cannot be reopened');
    expect(state.issues[0]?.reason).toContain('retracting the decision that replaced it');
  });
});

describe('replay after an arbitrary correction chain', () => {
  /** Every verb, in an order that exercises each one against a live object. */
  function chainedLog(): AuthoredEvent[] {
    return [
      ...sampleLog(),
      corrected({
        id: 'ev_c1',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'reattribute',
        patch: { owner: ALICE },
      }),
      corrected({
        id: 'ev_c2',
        at: at(10),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { statement: 'Wire the flag in, behind the env var' },
      }),
      corrected({ id: 'ev_c3', at: at(11), objectId: 'obj_question_1', action: 'reopen' }),
      corrected({
        id: 'ev_c4',
        at: at(12),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: ALICE },
      }),
      corrected({ id: 'ev_c5', at: at(13), objectId: 'obj_commitment_1', action: 'retract' }),
      corrected({ id: 'ev_c6', at: at(14), objectId: 'obj_commitment_1', action: 'restore' }),
      corrected({
        id: 'ev_c7',
        at: at(15),
        objectId: 'obj_decision_2',
        action: 'amend',
        patch: { verification: 'verified' },
      }),
    ];
  }

  it('reproduces the same state from any input order', () => {
    const canonical = serializeState(reduce(chainedLog()));
    for (const seed of [1, 7, 42, 1337, 90210, 5150]) {
      expect(serializeState(reduce(shuffle(chainedLog(), seed)))).toBe(canonical);
    }
  });

  it('leaves every corrected object still reachable, with its whole chain', () => {
    const state = reduce(chainedLog());
    expect(state.issues).toEqual([]);
    const chain = correctionChain(state, 'obj_commitment_1');
    expect(chain.map((c) => c.action)).toEqual(['reattribute', 'amend', 'retract', 'restore']);
    for (const correction of chain) {
      expect(correction.actor).toEqual({ kind: 'human', userId: ALICE });
      expect(correction.at).toMatch(/^2026-/);
      expect(correction.objectType).toBe('commitment');
    }
    expect(Object.keys(correctionChains(state)).sort()).toEqual([
      'obj_commitment_1',
      'obj_decision_1',
      'obj_decision_2',
      'obj_question_1',
    ]);
  });

  it('keeps a tombstoned object in history rather than deleting it', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({ id: 'ev_kill', at: at(9), objectId: 'obj_commitment_1', action: 'retract' }),
    ]);
    expect(state.objects.obj_commitment_1).toBeDefined();
    expect(tombstoned(state).map((record) => record.object.id)).toEqual(['obj_commitment_1']);
    expect(objectHistory(state, 'obj_commitment_1')?.retractedAt).toBe(at(9));
  });

  it('reports nothing for an object that never existed', () => {
    expect(objectHistory(reduce(sampleLog()), 'nope')).toBeNull();
  });
});

describe('epistemic state — `~` until a person touches it', () => {
  it('is unconfirmed for a model-accepted object', () => {
    const state = reduce(modelAcceptedClaim());
    const record = state.objects.obj_model_claim;
    if (!record) throw new Error('fixture changed');
    expect(epistemicStateOf(record)).toBe('unconfirmed');
    expect(epistemicGlyph(record)).toBe('~');
  });

  it('is confirmed the moment a person corrects it', () => {
    const state = reduce([
      ...modelAcceptedClaim(),
      corrected({
        id: 'ev_touch',
        at: at(3),
        objectId: 'obj_model_claim',
        action: 'amend',
        patch: { question: 'do we keep the flag after launch, or after the retro?' },
      }),
    ]);
    const record = state.objects.obj_model_claim;
    if (!record) throw new Error('fixture changed');
    expect(epistemicStateOf(record)).toBe('confirmed');
    expect(epistemicGlyph(record)).toBe('✓');
    expect(record.humanTouchedAt).toBe(at(3));
  });

  it('is confirmed from birth for a human-accepted object', () => {
    const state = reduce(sampleLog());
    const record = state.objects.obj_decision_1;
    if (!record) throw new Error('fixture changed');
    expect(epistemicGlyph(record)).toBe('✓');
    expect(record.acceptedBy).toEqual({ kind: 'human', userId: ALICE });
  });

  it('says when it became a fact, or that it is not one yet', () => {
    // `confirmedAt` was untested in round 1 and named in the gauntlet's polish
    // list. Three cases, and the middle one is the interesting one: an object a
    // machine read and a person later corrected becomes a fact at the
    // *correction*, not at the acceptance.
    const staged = reduce(modelAcceptedClaim());
    const stagedRecord = staged.objects.obj_model_claim;
    if (!stagedRecord) throw new Error('fixture changed');
    expect(confirmedAt(stagedRecord)).toBeNull();

    const touched = reduce([
      ...modelAcceptedClaim(),
      corrected({
        id: 'ev_touch2',
        at: at(4),
        objectId: 'obj_model_claim',
        action: 'amend',
        patch: { question: 'do we keep the flag after launch, or after the retro?' },
      }),
    ]);
    const touchedRecord = touched.objects.obj_model_claim;
    if (!touchedRecord) throw new Error('fixture changed');
    expect(confirmedAt(touchedRecord)).toBe(at(4));
    expect(touchedRecord.acceptedAt).toBe(at(2));

    // A human acceptance is a fact from the moment it was accepted, and stays
    // dated there even after later corrections move `updatedAt`.
    const direct = reduce(sampleLog()).objects.obj_decision_1;
    if (!direct) throw new Error('fixture changed');
    expect(confirmedAt(direct)).toBe(at(2));
    expect(direct.updatedAt).toBe(at(7));
  });

  it('keeps `verification` on a separate axis from `~`/`✓`', () => {
    // "✓ unverified" is a real and important state: we are sure somebody said
    // it, not that it is true.
    const state = reduce(sampleLog());
    const claim = reduce([
      ...sampleLog(),
      event({
        id: 'ev_hclaim',
        at: at(9),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_hclaim',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'the flag defaults off', claimant: BOB },
          createdAt: at(9),
          updatedAt: at(9),
        },
      }),
    ]).objects.obj_hclaim;
    if (!claim) throw new Error('fixture changed');
    expect(epistemicGlyph(claim)).toBe('✓');
    expect(claim.object.type === 'claim' && claim.object.payload.verification).toBe('unverified');
    expect(state.issues).toEqual([]);
  });
});

describe('counterexamples for the interpretation prompt', () => {
  function correctedState(): CoreState {
    return reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_x1',
        at: at(9),
        objectId: 'obj_decision_2',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: ALICE },
        note: 'that was only a suggestion',
      }),
      corrected({
        id: 'ev_x2',
        at: at(10),
        objectId: 'obj_commitment_1',
        action: 'reattribute',
        patch: { owner: ALICE },
        note: 'bob was estimating',
      }),
      corrected({
        id: 'ev_x3',
        at: at(11),
        objectId: 'obj_commitment_1',
        action: 'retract',
        note: 'not a commitment at all',
      }),
      corrected({ id: 'ev_x4', at: at(12), objectId: 'obj_commitment_1', action: 'restore' }),
    ]);
  }

  it('returns the newest corrections first', () => {
    const examples = correctionCounterexamples(correctedState(), { limit: 3 });
    expect(examples.map((example) => example.action)).toEqual(['retract', 'reattribute', 'retype']);
  });

  it('excludes `restore`, which teaches the wrong lesson', () => {
    // "That earlier correction was wrong" as a few-shot example teaches the
    // model to be *less* careful.
    const actions = correctionCounterexamples(correctedState(), { limit: 20 }).map((e) => e.action);
    expect(actions).not.toContain('restore');
  });

  it('filters by the type as it was read, not the type it became', () => {
    // The retype turned a decision into a claim. Asking for decision
    // counterexamples must still find it — that is the whole lesson.
    const asDecision = correctionCounterexamples(correctedState(), { types: ['decision'] });
    expect(asDecision.map((e) => e.action)).toContain('retype');
    const asClaim = correctionCounterexamples(correctedState(), { types: ['claim'] });
    expect(asClaim).toEqual([]);
  });

  it('names what was read and what it should have been', () => {
    const [retract, reattribute, retype] = correctionCounterexamples(correctedState(), {
      limit: 3,
    });
    expect(retype?.text).toContain('Read as a decision, but it was a claim');
    expect(reattribute?.text).toContain(`Attributed the commitment to "${BOB}"`);
    expect(reattribute?.text).toContain(`belonged to "${ALICE}"`);
    expect(retract?.text).toContain('was not one, and it was withdrawn');
  });

  it('formats a block ready to inject, quoting the note as a note', () => {
    const block = formatCounterexamples(correctedState(), { limit: 2 });
    expect(block).toContain('do not repeat their shape');
    // "the room said" narrated a speech act nobody performed — a note typed into
    // a correction form is not a sentence the room uttered, and CONVENTIONS is
    // explicit that the system never synthesizes speech.
    expect(block).toContain('correction note: "not a commitment at all"');
    expect(block).not.toContain('the room said');
    expect(block.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('returns an empty string when there is nothing to teach', () => {
    // Not an empty heading: "recent corrections: (none)" reads as "the room has
    // never corrected us", which is a different and wrong statement.
    expect(formatCounterexamples(reduce([]))).toBe('');
  });

  it('is a pure function of the log, whatever order the log arrived in', () => {
    // The block is part of the prompt, so a nondeterministic one makes every
    // interpretation unreproducible and leaves #24's eval unable to tell a
    // prompt change from a model change.
    const canonical = formatCounterexamples(correctedState(), { limit: 4 });
    expect(formatCounterexamples(correctedState(), { limit: 4 })).toBe(canonical);
    for (const seed of [3, 11, 29]) {
      const events = [
        ...sampleLog(),
        corrected({
          id: 'ev_x1',
          at: at(9),
          objectId: 'obj_decision_2',
          action: 'retype',
          toType: 'claim',
          patch: { claimant: ALICE },
          note: 'that was only a suggestion',
        }),
        corrected({
          id: 'ev_x2',
          at: at(10),
          objectId: 'obj_commitment_1',
          action: 'reattribute',
          patch: { owner: ALICE },
          note: 'bob was estimating',
        }),
        corrected({
          id: 'ev_x3',
          at: at(11),
          objectId: 'obj_commitment_1',
          action: 'retract',
          note: 'not a commitment at all',
        }),
        corrected({ id: 'ev_x4', at: at(12), objectId: 'obj_commitment_1', action: 'restore' }),
      ];
      expect(formatCounterexamples(reduce(shuffle(events, seed)), { limit: 4 })).toBe(canonical);
    }
  });
});

describe('correctionRateByType — #5’s live quality metric', () => {
  it('counts objects corrected, not corrections', () => {
    const state = reduce([
      ...sampleLog(),
      corrected({
        id: 'ev_m1',
        at: at(9),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { statement: 'one' },
      }),
      corrected({
        id: 'ev_m2',
        at: at(10),
        objectId: 'obj_commitment_1',
        action: 'amend',
        patch: { statement: 'two' },
      }),
    ]);
    const rates = correctionRateByType(state);
    // Three amendments to one badly-read commitment is one thing read badly.
    expect(rates.commitment).toEqual({ accepted: 1, corrected: 1, rate: 1 });
    expect(rates.open_question.corrected).toBe(0);
    expect(rates.open_question.rate).toBe(0);
  });

  it('reports zero rather than NaN for a type nothing was accepted of', () => {
    expect(correctionRateByType(reduce([])).claim).toEqual({ accepted: 0, corrected: 0, rate: 0 });
  });
});
