import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/index.js';
import { reduce } from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM } from './fixtures.js';

/**
 * #95's HUMAN relation matrix, enforced in the reducer by #102. Authority over a
 * certified object keys on the actor's *relation* to it, not only on its kind:
 * `authority.ts`'s `HumanOnlyGate`s answer *may this species certify at all*, and
 * these three rules answer *may this actor certify THIS object*.
 *
 * Every case is flip-the-input: the same command, moved by one relation, lands or
 * is refused. The disinterested/owner/verbatim path stays open; the self-, non-
 * owner, and amended-third-party paths are refused. Each is driven through
 * `reduce`, so deleting a gate in `reduce.ts` fails a case here — a UNIT test, not
 * an integration-only one (#96's lesson: a layered guard can hide a missing one).
 *
 * `#68` (H2, self-verification), `#67` (owner-confirm), `#81` (H3, amended
 * acceptance). The non-human halves are #96's and are not re-tested here.
 */

const CARL = 'user_carl';
const DANA = 'user_dana';
const CLAIM_TEXT = 'the deploy went out clean at noon';
const COMMIT_TEXT = 'ship the flag on friday';

function proposerOf(
  stager: Actor,
): { kind: 'model'; model: string } | { kind: 'human'; userId: string } {
  if (stager.kind === 'model') return { kind: 'model', model: stager.model };
  if (stager.kind === 'human') return { kind: 'human', userId: stager.userId };
  throw new Error('only model/human stagers in these fixtures');
}

function stageClaim(
  id: string,
  claimant: string,
  opts: { stager?: Actor; verification?: 'unverified' | 'verified'; statement?: string } = {},
) {
  const stager = opts.stager ?? model();
  const statement = opts.statement ?? CLAIM_TEXT;
  return event({
    id: `stage_${id}`,
    at: at(1),
    actor: stager,
    type: 'proposal_recorded',
    proposal: {
      id: `prop_${id}`,
      roomId: ROOM,
      type: 'claim',
      payload: { statement, claimant, verification: opts.verification ?? 'unverified' },
      confidence: 0.95,
      proposer: proposerOf(stager),
      provenance: ['m1'],
      quote: statement,
      createdAt: at(1),
    },
  } as Parameters<typeof event>[0]);
}

function acceptClaim(
  id: string,
  propId: string,
  actor: Actor,
  payload: { claimant: string; verification?: 'unverified' | 'verified'; statement?: string },
) {
  return event({
    id: `acc_${id}`,
    at: at(2),
    actor,
    type: 'object_accepted',
    object: {
      id: `obj_${id}`,
      roomId: ROOM,
      type: 'claim',
      payload: {
        statement: payload.statement ?? CLAIM_TEXT,
        claimant: payload.claimant,
        verification: payload.verification ?? 'unverified',
      },
      provenance: { messageIds: ['m1'], proposalId: propId },
      createdAt: at(2),
      updatedAt: at(2),
    },
  } as Parameters<typeof event>[0]);
}

function stageCommitment(id: string, owner: string, stager: Actor = model()) {
  return event({
    id: `stage_${id}`,
    at: at(1),
    actor: stager,
    type: 'proposal_recorded',
    proposal: {
      id: `prop_${id}`,
      roomId: ROOM,
      type: 'commitment',
      payload: { statement: COMMIT_TEXT, owner },
      confidence: 0.95,
      proposer: proposerOf(stager),
      provenance: ['m1'],
      quote: COMMIT_TEXT,
      createdAt: at(1),
    },
  } as Parameters<typeof event>[0]);
}

function acceptCommitment(id: string, propId: string, actor: Actor, owner: string) {
  return event({
    id: `acc_${id}`,
    at: at(2),
    actor,
    type: 'object_accepted',
    object: {
      id: `obj_${id}`,
      roomId: ROOM,
      type: 'commitment',
      payload: { statement: COMMIT_TEXT, owner },
      provenance: { messageIds: ['m1'], proposalId: propId },
      createdAt: at(2),
      updatedAt: at(2),
    },
  } as Parameters<typeof event>[0]);
}

function amendVerified(id: string, objectId: string, actor: Actor) {
  return event({
    id,
    at: at(3),
    actor,
    type: 'object_corrected',
    objectId,
    action: 'amend',
    patch: { verification: 'verified' },
  } as Parameters<typeof event>[0]);
}

const reasonOf = (state: ReturnType<typeof reduce>, eventId: string) =>
  state.issues.find((issue) => issue.eventId === eventId)?.reason ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — verify a claim (#68 / H2): a second pair of eyes.
// ─────────────────────────────────────────────────────────────────────────────

describe('#95 relation — verify a claim (#68/H2)', () => {
  it('refuses the claimant verifying their own claim at acceptance', () => {
    // BOB stages nothing; a model stages a born-verified claim about BOB, and BOB
    // accepts it — the sentence agreeing with itself.
    const state = reduce([
      stageClaim('v1', BOB, { verification: 'verified' }),
      acceptClaim('v1', 'prop_v1', human(BOB), { claimant: BOB, verification: 'verified' }),
    ]);
    expect(state.objects.obj_v1).toBeUndefined();
    expect(reasonOf(state, 'acc_v1')).toContain('names them as its claimant');
  });

  it('refuses the stager verifying the reading they staged (via a later amend)', () => {
    // BOB stages a claim about CARL; ALICE (disinterested) confirms it verbatim;
    // then BOB — the stager — tries to verify it. #95 forbids the stager too.
    const state = reduce([
      stageClaim('v2', CARL, { stager: human(BOB) }),
      acceptClaim('v2', 'prop_v2', human(ALICE), { claimant: CARL }),
      amendVerified('ev_v2_verify', 'obj_v2', human(BOB)),
    ]);
    const claim = state.objects.obj_v2?.object;
    expect(claim?.type === 'claim' && claim.payload.verification).toBe('unverified');
    expect(reasonOf(state, 'ev_v2_verify')).toContain('staged the reading of');
  });

  it('refuses the claimant self-verifying via a later amend', () => {
    const state = reduce([
      stageClaim('v3', BOB),
      acceptClaim('v3', 'prop_v3', human(ALICE), { claimant: BOB }),
      amendVerified('ev_v3_verify', 'obj_v3', human(BOB)),
    ]);
    const claim = state.objects.obj_v3?.object;
    expect(claim?.type === 'claim' && claim.payload.verification).toBe('unverified');
    expect(reasonOf(state, 'ev_v3_verify')).toContain('names them as its claimant');
  });

  it('lets a disinterested member verify — at acceptance and via amend', () => {
    // The legitimate path #68 protects: "X says this claim of BOB's checks out."
    const atAcceptance = reduce([
      stageClaim('v4', BOB, { verification: 'verified' }),
      acceptClaim('v4', 'prop_v4', human(ALICE), { claimant: BOB, verification: 'verified' }),
    ]);
    const born = atAcceptance.objects.obj_v4?.object;
    expect(born?.type === 'claim' && born.payload.verification).toBe('verified');
    expect(atAcceptance.issues).toEqual([]);

    const byAmend = reduce([
      stageClaim('v5', BOB),
      acceptClaim('v5', 'prop_v5', human(ALICE), { claimant: BOB }),
      amendVerified('ev_v5_verify', 'obj_v5', human(CARL)),
    ]);
    const verified = byAmend.objects.obj_v5?.object;
    expect(verified?.type === 'claim' && verified.payload.verification).toBe('verified');
    expect(byAmend.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 — confirm a commitment (#67): the owner, not any member.
// ─────────────────────────────────────────────────────────────────────────────

describe('#95 relation — confirm a commitment (#67)', () => {
  it('refuses a non-owner confirming a third party’s commitment', () => {
    const state = reduce([
      stageCommitment('c1', BOB),
      acceptCommitment('c1', 'prop_c1', human(ALICE), BOB),
    ]);
    expect(state.objects.obj_c1).toBeUndefined();
    expect(reasonOf(state, 'acc_c1')).toContain(
      'a third-party commitment is confirmed by the person it names',
    );
  });

  it('lets the named owner confirm their own commitment', () => {
    const state = reduce([
      stageCommitment('c2', BOB),
      acceptCommitment('c2', 'prop_c2', human(BOB), BOB),
    ]);
    const commitment = state.objects.obj_c2?.object;
    expect(commitment?.type === 'commitment' && commitment.payload.owner).toBe(BOB);
    expect(state.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — amended acceptance (#81 / H3): lands under the accepter's name.
// ─────────────────────────────────────────────────────────────────────────────

describe('#95 relation — amended acceptance (#81/H3)', () => {
  it('refuses an accepter rewording a sentence that stands under a third party’s name', () => {
    const state = reduce([
      stageClaim('a1', BOB, { statement: 'the build is green on main' }),
      acceptClaim('a1', 'prop_a1', human(ALICE), {
        claimant: BOB,
        statement: 'I have been taking kickbacks from the vendor',
      }),
    ]);
    expect(state.objects.obj_a1).toBeUndefined();
    expect(reasonOf(state, 'acc_a1')).toContain('restating a sentence that stands under');
  });

  it('refuses an accepter adding a third party’s name that the reading did not carry', () => {
    // The staged reading names ALICE (the accepter); the minted one swaps the
    // claimant to CARL — a name arriving at acceptance.
    const state = reduce([
      stageClaim('a2', ALICE),
      acceptClaim('a2', 'prop_a2', human(ALICE), { claimant: CARL }),
    ]);
    expect(state.objects.obj_a2).toBeUndefined();
    expect(reasonOf(state, 'acc_a2')).toContain('a sentence the staged reading did not carry');
  });

  it('lets a member confirm a third party’s claim verbatim', () => {
    // Acceptance is a second pair of eyes; an *unchanged* third-party claim is the
    // legitimate case — only an amended sentence under a third party's name is not.
    const state = reduce([
      stageClaim('a3', BOB),
      acceptClaim('a3', 'prop_a3', human(ALICE), { claimant: BOB }),
    ]);
    const claim = state.objects.obj_a3?.object;
    expect(claim?.type === 'claim' && claim.payload.claimant).toBe(BOB);
    expect(state.issues).toEqual([]);
  });

  it('lets an accepter reword a reading that names nobody but themselves', () => {
    const state = reduce([
      stageClaim('a4', DANA, { stager: model() }),
      acceptClaim('a4', 'prop_a4', human(DANA), {
        claimant: DANA,
        statement: 'the migration ran clean, I checked the row counts',
      }),
    ]);
    const claim = state.objects.obj_a4?.object;
    expect(claim?.type === 'claim' && claim.payload.claimant).toBe(DANA);
    expect(state.issues).toEqual([]);
  });
});
