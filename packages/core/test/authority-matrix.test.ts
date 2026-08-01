import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectType,
  type CoreEvent,
  CoreEvent as CoreEventSchema,
  type CoreState,
  type CorrectionAction,
  type RelationKind,
  reduce,
  serializeState,
} from '../src/index.js';
import { ALICE, BOB } from './fixtures.js';

/**
 * The authority matrix, checked against an **independent oracle** rather than
 * example by example.
 *
 * r4's delta routed this: the actor floor was pinned by hand-written cases, one
 * per gate, which proves the gates that were thought of and says nothing about
 * the ones that were not. Here the case space is enumerated — every event type
 * against every kind of actor, and for the types that have sub-shapes (five
 * object types, six correction verbs, five relation kinds, cited-or-direct
 * proposals, above-or-below the confidence floor) every one of those too — and
 * a table written from #4 and `authority.ts`'s doc comment says what each cell
 * should do.
 *
 * **The oracle imports nothing from `../src` except types.** It does not call
 * `isHuman`, `actorMatchesProposer`, or `MODEL_ACCEPTANCE_FLOOR`; it restates
 * them. A shared predicate would make the two sides agree by construction, which
 * is exactly the defect the replay suite's own oracle exists to avoid.
 */

const ROOM = 'room_1';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

/** The four kinds of actor the matrix ranges over. */
type ActorKind = 'human' | 'model_proposer' | 'model_other' | 'system';
const ACTOR_KINDS: ActorKind[] = ['human', 'model_proposer', 'model_other', 'system'];

function actorOf(kind: ActorKind) {
  switch (kind) {
    case 'human':
      return { kind: 'human', userId: ALICE } as const;
    case 'model_proposer':
      return { kind: 'model', model: MODEL_A } as const;
    case 'model_other':
      return { kind: 'model', model: MODEL_B } as const;
    case 'system':
      return { kind: 'system' } as const;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Restated from the specification, not imported from the source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every refusal the matrix can produce, and the text a room is shown for it.
 *
 * The markers are what makes the oracle checkable: the reducer says *why* it
 * refused, and a table that only checked "something was refused" would pass on
 * a reducer that refused everything for the wrong reason.
 */
const GATES = {
  decision_acceptance: 'never auto-accepts',
  claim_verification: 'would become a verified claim',
  direct_acceptance: 'only a human may accept an object directly',
  decision_supersession: 'retires an accepted decision',
  correction: 'corrections (amend, retract, restore)',
  acceptance_binding: 'may only accept its own reading',
  rejection_binding: 'may only withdraw its own reading',
  supersession_binding: 'may only retire its own reading',
  confidence_floor: 'below the floor',
} as const;
type Gate = keyof typeof GATES;

/** #4's floor, restated. Decisions are human-only, so the row is unreachable. */
const FLOOR: Record<AcceptedObjectType, number> = {
  decision: Number.POSITIVE_INFINITY,
  commitment: 0.5,
  open_question: 0.4,
  claim: 0.5,
  objective: 0.5,
};

const isHumanKind = (kind: ActorKind) => kind === 'human';

/** "A model may act only on its own proposals; a human on any; the system on none." */
function ownsProposal(kind: ActorKind, proposer: 'model_a' | 'human'): boolean {
  if (kind === 'human') return true;
  if (kind === 'model_proposer') return proposer === 'model_a';
  return false;
}

interface AcceptanceCase {
  kind: 'object_accepted';
  actor: ActorKind;
  type: AcceptedObjectType;
  /** Cited proposal, or none at all (the answer-binding shape). */
  cited: 'model_a' | 'human' | 'none';
  /** Whether the cited proposal clears this type's floor. */
  confidence: 'above' | 'below';
  /** Only meaningful for a claim. */
  verified: boolean;
}

/**
 * The acceptance row of the matrix, in the order the rules bind.
 *
 * Order is part of the specification, not an implementation detail: a model
 * accepting a decision must be told that decisions are human-only, not sent to
 * fix its provenance first, because fixing the provenance would not help.
 */
function expectedForAcceptance(testCase: AcceptanceCase): Gate | 'allowed' {
  const human = isHumanKind(testCase.actor);
  if (testCase.type === 'decision' && !human) return 'decision_acceptance';
  if (testCase.type === 'claim' && testCase.verified && !human) return 'claim_verification';
  if (testCase.cited === 'none' && !human) return 'direct_acceptance';
  if (testCase.cited !== 'none' && !ownsProposal(testCase.actor, testCase.cited)) {
    return 'acceptance_binding';
  }
  if (testCase.cited !== 'none' && !human && testCase.confidence === 'below') {
    return 'confidence_floor';
  }
  return 'allowed';
}

function expectedForCorrection(actor: ActorKind): Gate | 'allowed' {
  return isHumanKind(actor) ? 'allowed' : 'correction';
}

function expectedForRelation(
  actor: ActorKind,
  kind: RelationKind,
  retires: AcceptedObjectType | null,
) {
  if (kind === 'supersedes' && retires === 'decision' && !isHumanKind(actor)) {
    return 'decision_supersession' as const;
  }
  return 'allowed' as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Log construction. Each case is a self-contained log, so nothing but the rule
// under test can refuse it.
// ─────────────────────────────────────────────────────────────────────────────

let clock = 0;
function nextAt(): string {
  clock += 1;
  return `2026-07-31T${String(10 + Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}:00.000Z`;
}

const parse = (input: unknown): CoreEvent => CoreEventSchema.parse(input);

function payloadFor(type: AcceptedObjectType, verified = false): Record<string, unknown> {
  switch (type) {
    case 'decision':
      return { statement: 'a decision', decidedBy: ALICE };
    case 'commitment':
      return { statement: 'a commitment', owner: BOB };
    case 'open_question':
      return { question: 'a question?' };
    case 'claim':
      return {
        statement: 'a claim',
        claimant: BOB,
        ...(verified ? { verification: 'verified' } : {}),
      };
    case 'objective':
      return { title: 'an objective' };
  }
}

function proposalEvent(input: {
  id: string;
  type: AcceptedObjectType;
  proposer: 'model_a' | 'human';
  confidence: number;
  verified?: boolean;
}): CoreEvent {
  const at = nextAt();
  return parse({
    id: `ev_${input.id}`,
    at,
    actor: input.proposer === 'model_a' ? actorOf('model_proposer') : actorOf('human'),
    type: 'proposal_recorded',
    proposal: {
      id: input.id,
      roomId: ROOM,
      type: input.type,
      payload: payloadFor(input.type, input.verified),
      confidence: input.confidence,
      proposer:
        input.proposer === 'model_a'
          ? { kind: 'model', model: MODEL_A }
          : { kind: 'human', userId: ALICE },
      provenance: ['msg_1'],
      createdAt: at,
    },
  });
}

function acceptEvent(input: {
  id: string;
  objectId: string;
  type: AcceptedObjectType;
  actor: ActorKind;
  proposalId: string | null;
  verified?: boolean;
}): CoreEvent {
  const at = nextAt();
  return parse({
    id: `ev_${input.id}`,
    at,
    actor: actorOf(input.actor),
    type: 'object_accepted',
    object: {
      id: input.objectId,
      roomId: ROOM,
      type: input.type,
      payload: payloadFor(input.type, input.verified),
      provenance: { messageIds: ['msg_1'], proposalId: input.proposalId },
      createdAt: at,
      updatedAt: at,
    },
  });
}

/** Did the reducer refuse, and with which gate? */
function verdictOf(state: CoreState, eventId: string): Gate | 'allowed' {
  const issue = state.issues.find((entry) => entry.eventId === eventId);
  if (!issue) return 'allowed';
  for (const [gate, marker] of Object.entries(GATES)) {
    if (issue.reason.includes(marker)) return gate as Gate;
  }
  throw new Error(`refusal did not match any known gate: ${issue.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The cases
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_TYPES: AcceptedObjectType[] = [
  'decision',
  'commitment',
  'open_question',
  'claim',
  'objective',
];

const acceptanceCases: AcceptanceCase[] = [];
for (const actor of ACTOR_KINDS) {
  for (const type of OBJECT_TYPES) {
    for (const cited of ['model_a', 'human', 'none'] as const) {
      for (const confidence of ['above', 'below'] as const) {
        // Confidence is a property of the cited proposal; with none cited there
        // is nothing to be above or below, so that half of the cross-product is
        // not a cell, it is the same cell twice.
        if (cited === 'none' && confidence === 'below') continue;
        const verifiedVariants = type === 'claim' ? [false, true] : [false];
        for (const verified of verifiedVariants) {
          acceptanceCases.push({
            kind: 'object_accepted',
            actor,
            type,
            cited,
            confidence,
            verified,
          });
        }
      }
    }
  }
}

describe('authority matrix — object_accepted, every actor × type × citation × confidence', () => {
  for (const testCase of acceptanceCases) {
    const label = `${testCase.actor} accepts ${testCase.type}${testCase.verified ? ' (verified)' : ''} via ${testCase.cited}${testCase.cited === 'none' ? '' : ` @${testCase.confidence} floor`}`;
    it(label, () => {
      const suffix = `${acceptanceCases.indexOf(testCase)}`;
      const events: CoreEvent[] = [];
      let proposalId: string | null = null;

      if (testCase.cited !== 'none') {
        proposalId = `prop_${suffix}`;
        const floor = FLOOR[testCase.type];
        // Below the floor means below it; above means comfortably over. For a
        // decision the floor is unreachable, so "above" is just a high number —
        // the decision gate returns before the floor is consulted.
        const confidence =
          testCase.confidence === 'below'
            ? Number.isFinite(floor)
              ? Math.max(0, floor - 0.1)
              : 0.4
            : 0.95;
        events.push(
          proposalEvent({
            id: proposalId,
            type: testCase.type,
            proposer: testCase.cited,
            confidence,
            verified: testCase.verified,
          }),
        );
      }

      const acceptId = `acc_${suffix}`;
      events.push(
        acceptEvent({
          id: acceptId,
          objectId: `obj_${suffix}`,
          type: testCase.type,
          actor: testCase.actor,
          proposalId,
          verified: testCase.verified,
        }),
      );

      const state = reduce(events);
      const expected = expectedForAcceptance(testCase);
      expect(verdictOf(state, `ev_${acceptId}`)).toBe(expected);
      // The gate is not decorative: a refusal means no object.
      expect(Object.keys(state.objects)).toEqual(expected === 'allowed' ? [`obj_${suffix}`] : []);
    });
  }
});

describe('authority matrix — proposal lifecycle, every actor × proposer', () => {
  for (const actor of ACTOR_KINDS) {
    for (const proposer of ['model_a', 'human'] as const) {
      it(`${actor} records a ${proposer} proposal`, () => {
        // Recording a reading is not accepting it, so no actor is gated here —
        // that is the whole shape of the trust model and it must stay open.
        const state = reduce([
          proposalEvent({
            id: `p_rec_${actor}_${proposer}`,
            type: 'claim',
            proposer,
            confidence: 0.9,
          }),
        ]);
        expect(state.issues).toEqual([]);
      });

      it(`${actor} rejects a ${proposer} proposal`, () => {
        const id = `p_rej_${actor}_${proposer}`;
        const state = reduce([
          proposalEvent({ id, type: 'claim', proposer, confidence: 0.9 }),
          parse({
            id: `ev_rej_${id}`,
            at: nextAt(),
            actor: actorOf(actor),
            type: 'proposal_rejected',
            proposalId: id,
            reason: 'on reflection, no',
          }),
        ]);
        const expected = ownsProposal(actor, proposer) ? 'allowed' : 'rejection_binding';
        expect(verdictOf(state, `ev_rej_${id}`)).toBe(expected);
        expect(state.proposals[id]?.status).toBe(expected === 'allowed' ? 'rejected' : 'proposed');
      });

      it(`${actor} supersedes a ${proposer} proposal`, () => {
        const id = `p_sup_${actor}_${proposer}`;
        const state = reduce([
          proposalEvent({ id, type: 'claim', proposer, confidence: 0.9 }),
          parse({
            id: `ev_sup_${id}`,
            at: nextAt(),
            actor: actorOf(actor),
            type: 'proposal_superseded',
            proposalId: id,
            reason: 're-read at a bumped interpretation version',
          }),
        ]);
        const expected = ownsProposal(actor, proposer) ? 'allowed' : 'supersession_binding';
        expect(verdictOf(state, `ev_sup_${id}`)).toBe(expected);
        expect(state.proposals[id]?.status).toBe(
          expected === 'allowed' ? 'superseded' : 'proposed',
        );
      });
    }
  }
});

describe('authority matrix — object_corrected, every actor × verb', () => {
  const VERBS: CorrectionAction[] = [
    'amend',
    'retract',
    'restore',
    'retype',
    'reattribute',
    'reopen',
  ];

  /** A log that leaves one object in the state each verb can legally act on. */
  function setupFor(
    verb: CorrectionAction,
    suffix: string,
  ): { events: CoreEvent[]; objectId: string } {
    const objectId = `obj_c_${suffix}`;
    const events: CoreEvent[] = [];

    if (verb === 'reopen') {
      // An answered question: accept a question and a decision, then answer it.
      const answerId = `obj_ans_${suffix}`;
      events.push(
        acceptEvent({
          id: `q_${suffix}`,
          objectId,
          type: 'open_question',
          actor: 'human',
          proposalId: null,
        }),
        acceptEvent({
          id: `a_${suffix}`,
          objectId: answerId,
          type: 'decision',
          actor: 'human',
          proposalId: null,
        }),
        parse({
          id: `ev_ans_${suffix}`,
          at: nextAt(),
          actor: actorOf('human'),
          type: 'relation_added',
          relation: {
            id: `rel_ans_${suffix}`,
            roomId: ROOM,
            kind: 'answers',
            fromObjectId: objectId,
            to: { kind: 'object', objectId: answerId },
            createdAt: nextAt(),
          },
        }),
      );
      return { events, objectId };
    }

    // Everything else acts on a commitment: it has both a text field and an
    // attribution field, so `amend`, `reattribute` and `retype` all apply.
    events.push(
      acceptEvent({
        id: `c_${suffix}`,
        objectId,
        type: 'commitment',
        actor: 'human',
        proposalId: null,
      }),
    );
    if (verb === 'restore') {
      events.push(
        parse({
          id: `ev_pre_${suffix}`,
          at: nextAt(),
          actor: actorOf('human'),
          type: 'object_corrected',
          objectId,
          action: 'retract',
        }),
      );
    }
    return { events, objectId };
  }

  function patchFor(verb: CorrectionAction): Record<string, unknown> {
    if (verb === 'amend') return { statement: 'reworded' };
    if (verb === 'reattribute') return { owner: ALICE };
    if (verb === 'retype') return { claimant: ALICE };
    return {};
  }

  for (const actor of ACTOR_KINDS) {
    for (const verb of VERBS) {
      it(`${actor} performs "${verb}"`, () => {
        const suffix = `${actor}_${verb}`;
        const { events, objectId } = setupFor(verb, suffix);
        const correctionId = `ev_corr_${suffix}`;
        events.push(
          parse({
            id: correctionId,
            at: nextAt(),
            actor: actorOf(actor),
            type: 'object_corrected',
            objectId,
            action: verb,
            ...(verb === 'retype' ? { toType: 'claim' } : {}),
            patch: patchFor(verb),
          }),
        );

        const state = reduce(events);
        const expected = expectedForCorrection(actor);
        expect(verdictOf(state, correctionId)).toBe(expected);
        // A refused correction leaves the object exactly as it was.
        expect(state.corrections.some((entry) => entry.eventId === correctionId)).toBe(
          expected === 'allowed',
        );
      });
    }
  }

  it('names the verification rule when a model’s correction would produce a ✓', () => {
    // Doubly closed — corrections are human-only *and* verification is — and the
    // reported reason must be the specific one, so the room is told the rule
    // that would still apply if the other were ever relaxed.
    const objectId = 'obj_verify_probe';
    const state = reduce([
      acceptEvent({ id: 'vp_setup', objectId, type: 'claim', actor: 'human', proposalId: null }),
      parse({
        id: 'ev_vp',
        at: nextAt(),
        actor: actorOf('model_other'),
        type: 'object_corrected',
        objectId,
        action: 'amend',
        patch: { verification: 'verified' },
      }),
    ]);
    expect(verdictOf(state, 'ev_vp')).toBe('claim_verification');
  });
});

describe('authority matrix — relation_added, every actor × kind × retired type', () => {
  const KINDS: RelationKind[] = ['supersedes', 'depends_on', 'blocks', 'answers', 'evidence'];

  for (const actor of ACTOR_KINDS) {
    for (const kind of KINDS) {
      // `supersedes` is the only kind whose authority depends on what it points
      // at, so it is the only one enumerated over the target's type.
      const targets: AcceptedObjectType[] =
        kind === 'supersedes' ? ['decision', 'claim', 'open_question'] : ['decision'];

      for (const target of targets) {
        it(`${actor} adds "${kind}"${kind === 'supersedes' ? ` retiring a ${target}` : ''}`, () => {
          const suffix = `${actor}_${kind}_${target}`;
          const fromType: AcceptedObjectType = kind === 'answers' ? 'open_question' : target;
          const toType: AcceptedObjectType = kind === 'answers' ? 'decision' : target;
          const fromId = `obj_from_${suffix}`;
          const toId = `obj_to_${suffix}`;

          const events: CoreEvent[] = [
            acceptEvent({
              id: `f_${suffix}`,
              objectId: fromId,
              type: fromType,
              actor: 'human',
              proposalId: null,
            }),
            acceptEvent({
              id: `t_${suffix}`,
              objectId: toId,
              type: toType,
              actor: 'human',
              proposalId: null,
            }),
            parse({
              id: `ev_rel_${suffix}`,
              at: nextAt(),
              actor: actorOf(actor),
              type: 'relation_added',
              relation: {
                id: `rel_${suffix}`,
                roomId: ROOM,
                kind,
                fromObjectId: fromId,
                to:
                  kind === 'evidence'
                    ? { kind: 'message', messageId: 'msg_1' }
                    : { kind: 'object', objectId: toId },
                createdAt: nextAt(),
              },
            }),
          ];

          const state = reduce(events);
          const expected = expectedForRelation(actor, kind, kind === 'supersedes' ? target : null);
          expect(verdictOf(state, `ev_rel_${suffix}`)).toBe(expected);
          expect(state.relations.map((relation) => relation.id)).toEqual(
            expected === 'allowed' ? [`rel_${suffix}`] : [],
          );
        });
      }
    }
  }
});

describe('the matrix as a whole', () => {
  it('enumerates every cell it claims to — 4 actors × 5 types × 5 citation/confidence shapes', () => {
    // Per actor, per type: two cited proposals × two confidence bands, plus the
    // one direct shape (with nothing cited there is no band) = 5. Five types, of
    // which `claim` is doubled for verified/unverified: 4×5 + 5×2 = 30.
    expect(acceptanceCases).toHaveLength(4 * (4 * 5 + 5 * 2));
    const distinct = new Set(
      acceptanceCases.map(
        (entry) =>
          `${entry.actor}|${entry.type}|${entry.cited}|${entry.confidence}|${entry.verified}`,
      ),
    );
    expect(distinct.size).toBe(acceptanceCases.length);
  });

  it('reaches every gate in the table, so no marker is dead', () => {
    const reached = new Set<Gate | 'allowed'>();
    for (const testCase of acceptanceCases) reached.add(expectedForAcceptance(testCase));
    for (const actor of ACTOR_KINDS) {
      reached.add(expectedForCorrection(actor));
      reached.add(expectedForRelation(actor, 'supersedes', 'decision'));
      for (const proposer of ['model_a', 'human'] as const) {
        reached.add(ownsProposal(actor, proposer) ? 'allowed' : 'rejection_binding');
        reached.add(ownsProposal(actor, proposer) ? 'allowed' : 'supersession_binding');
      }
    }
    expect([...reached].sort()).toEqual([...Object.keys(GATES), 'allowed'].sort());
  });

  it('is not vacuous — the oracle refuses a substantial share of the space', () => {
    const refused = acceptanceCases.filter(
      (entry) => expectedForAcceptance(entry) !== 'allowed',
    ).length;
    expect(refused).toBeGreaterThan(acceptanceCases.length / 3);
    expect(refused).toBeLessThan(acceptanceCases.length);
  });

  it('leaves the human row entirely open — the floor gates machines, not people', () => {
    for (const testCase of acceptanceCases.filter((entry) => entry.actor === 'human')) {
      expect(expectedForAcceptance(testCase)).toBe('allowed');
    }
  });

  it('folds identically however the cases are ordered', () => {
    // The matrix is about authority, and authority must not depend on arrival
    // order any more than anything else in the reducer does.
    const events = [
      proposalEvent({ id: 'ord_p', type: 'claim', proposer: 'model_a', confidence: 0.9 }),
      acceptEvent({
        id: 'ord_a',
        objectId: 'obj_ord',
        type: 'claim',
        actor: 'model_other',
        proposalId: 'ord_p',
      }),
    ];
    expect(serializeState(reduce(events))).toBe(serializeState(reduce([...events].reverse())));
  });
});
