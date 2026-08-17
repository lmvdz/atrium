import { describe, expect, it } from 'vitest';
import type { CovenantReadStatus } from '../lib/covenant-read';
import type { ReplayData } from '../lib/replay-data';
import { applyReplayTransitions, retypeAsClaim } from '../lib/replay-transitions';
import { locallyAcceptedState, replayReceipt, replayView } from '../lib/replay-view';
import type { EpistemicState, StateObject } from '../src/components';
import { glyphFor } from '../src/components/model';
import { glyphResolver } from './support/glyph-resolver';

/**
 * SL-6 (#181 / #193) READER-MIGRATION — the cross-surface invariant.
 *
 * Three display readers emit an object's `~`/`✓`: the durable replay glyph
 * (`replayView` → `certified`), the optimistic accept overlay
 * (`locallyAcceptedState`), and the optimistic retype tick (`retypeAsClaim`). All
 * three now source the glyph from the ONE covenant read authority. This proves the
 * acceptance bar directly: the SAME object under the SAME authority verdict renders
 * the IDENTICAL glyph at every surface, and every surface fails CLOSED to `~` on a
 * drifted or pending anchor — never a stale `✓` off provenance alone.
 */

const AT = '2026-08-05T12:00:00.000Z';
const OBJECT_ID = 'decision-1';

/** A human-accepted decision — on BASE this rendered `✓` off `human_touched_at` alone. */
function humanAcceptedReplayData(): ReplayData {
  return {
    room: {
      id: 'room',
      name: 'general',
      slug: 'general',
      workspaceId: 'workspace',
      workspaceName: 'Atrium',
      workspaceSlug: 'atrium',
    },
    participants: [{ id: 'alice', name: 'alice', avatarUrl: null, principalKind: 'human' }],
    messages: [],
    interpretations: [],
    proposals: [],
    proposalSources: [],
    objects: [
      {
        id: OBJECT_ID,
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Ship the migration.', decidedBy: 'alice', status: 'active' },
        objectiveId: null,
        proposalId: null,
        sessionId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: new Date(AT),
        createdAt: new Date(AT),
        updatedAt: new Date(AT),
      },
    ],
    objectSources: [],
    relations: [],
    attention: [],
    corrections: [],
  } as ReplayData;
}

/** The durable replay glyph for the migrated object. */
function durableGlyph(resolverStatus: 'ok' | 'drift' | 'unresolved') {
  const view = replayView(humanAcceptedReplayData(), 'alice', glyphResolver(resolverStatus));
  const object = view.objects.find((candidate) => candidate.id === OBJECT_ID);
  if (!object) throw new Error('decision must render');
  return glyphFor(object.state);
}

/** The base decision object the overlay reader receives (a fresh machine reading). */
const decision: StateObject = {
  id: OBJECT_ID,
  kind: 'decision',
  state: {
    kind: 'decision',
    verification: 'proposed',
    owedToViewer: false,
    irreversible: false,
  },
  text: 'Ship the migration.',
  facts: [],
  objectives: [],
};

/** `retypeAsClaim` only accepts an already-accepted decision (its own guard). */
const acceptedDecision: StateObject = {
  ...decision,
  state: { ...decision.state, verification: 'accepted' },
};

function overlayGlyph(resolverStatus: 'ok' | 'drift' | 'unresolved') {
  const state: EpistemicState = locallyAcceptedState(
    decision.state,
    OBJECT_ID,
    glyphResolver(resolverStatus),
  );
  return glyphFor(state);
}

function retypeGlyph(resolverStatus: 'ok' | 'drift' | 'unresolved') {
  const transition = retypeAsClaim(acceptedDecision, AT, glyphResolver(resolverStatus));
  return glyphFor(transition.after.state);
}

describe('SL-6 reader migration — one object, identical glyph at every surface', () => {
  it('resolves ✓ at replay, optimistic-accept, and optimistic-retype when the anchor RESOLVES', () => {
    expect(durableGlyph('ok')).toBe('✓');
    expect(overlayGlyph('ok')).toBe('✓');
    expect(retypeGlyph('ok')).toBe('✓');
  });

  it('FLIP-THE-INPUT: a DRIFTED anchor is ~ at every surface (base would show ✓)', () => {
    // The human acceptance is unchanged; only the authority's verdict flipped.
    // Every migrated surface must agree on `~`, never a stale provenance `✓`.
    expect(durableGlyph('drift')).toBe('~');
    expect(overlayGlyph('drift')).toBe('~');
    expect(retypeGlyph('drift')).toBe('~');
  });

  it('a PENDING/stalled resolve is ~ at every surface (never blocks on a stale ✓)', () => {
    expect(durableGlyph('unresolved')).toBe('~');
    expect(overlayGlyph('unresolved')).toBe('~');
    expect(retypeGlyph('unresolved')).toBe('~');
  });

  it('no authority wired ⇒ ~ everywhere (provenance alone never mints ✓)', () => {
    // The durable and optimistic readers with an undefined resolver fail closed.
    const view = replayView(humanAcceptedReplayData(), 'alice');
    const object = view.objects.find((candidate) => candidate.id === OBJECT_ID);
    expect(object && glyphFor(object.state)).toBe('~');
    expect(glyphFor(locallyAcceptedState(decision.state, OBJECT_ID, undefined))).toBe('~');
    expect(glyphFor(retypeAsClaim(acceptedDecision, AT).after.state)).toBe('~');
  });
});

/**
 * SL-6 FIX (#193, CRITICAL) — the optimistic layer must FAIL CLOSED across a
 * STATE FLIP. The prior tests only ever fed a fresh (`proposed`) input, so a base
 * that merely `preserve`d the input already read `~`. The stale-`✓` breach is a
 * STATEFUL one: an overlay/retype that was `✓` under `ok`, whose SAME object then
 * drifts, must demote — not replay the settled tick. These fail on base 2e5cbf3.
 */
describe('SL-6 fix — stale ✓ is unreachable when a settled object drifts', () => {
  it('the RETAINED optimistic-accept overlay demotes ✓→~ when its authority flips to drift', () => {
    let status: CovenantReadStatus = 'ok';
    const resolver = glyphResolver(() => status);
    // Establish the overlay at `✓` while the anchor resolves.
    const settled = locallyAcceptedState(decision.state, OBJECT_ID, resolver);
    expect(glyphFor(settled)).toBe('✓');
    expect(settled.verification).toBe('accepted');
    // The SAME object drifts; re-reading the retained (now-settled) overlay must
    // NOT preserve the prior `✓`. Base kept `state.verification` ⇒ stale `✓`.
    status = 'drift';
    const reread = locallyAcceptedState(settled, OBJECT_ID, resolver);
    expect(glyphFor(reread)).toBe('~');
  });

  it('the retype tick re-derives ✓→~ through applyReplayTransitions when the object drifts', () => {
    let status: CovenantReadStatus = 'ok';
    const resolver = glyphResolver(() => status);
    // The correction is recorded while the anchor resolves — `after` captures `✓`.
    const transition = retypeAsClaim(acceptedDecision, AT, resolver);
    expect(transition.after.state.verification).toBe('accepted');
    // The object drifts AFTER the correction was stored. Applying the transition
    // must re-read the live verdict, not replay the baked-in `accepted`. Base
    // replayed `after` verbatim ⇒ stale `✓`.
    status = 'drift';
    const applied = applyReplayTransitions([acceptedDecision], [transition], resolver)[0];
    if (!applied) throw new Error('the retyped object must survive applyReplayTransitions');
    expect(glyphFor(applied.state)).toBe('~');
  });
});

/**
 * SL-6 FIX (#193, HIGH) — the fail-closed DISPLAY glyph must NOT move the
 * certify/remove ELIGIBILITY, which is a PROVENANCE concern (SL-5's KEEP
 * partition). With the resolver unwired (the state TODAY), a human-certified
 * claim's content glyph fails closed to `~` — correct — but the live receipt must
 * still NOT offer to Certify/Remove a reading a person already certified. On base
 * 2e5cbf3 the receipt keyed those acts on the migrated `verification` field, so it
 * (wrongly) offered both.
 */
const CLAIM_ID = 'claim-1';
function humanCertifiedClaimData(): ReplayData {
  return {
    room: {
      id: 'room',
      name: 'general',
      slug: 'general',
      workspaceId: 'workspace',
      workspaceName: 'Atrium',
      workspaceSlug: 'atrium',
    },
    participants: [
      { id: 'alice', name: 'alice', avatarUrl: null, principalKind: 'human' },
      { id: 'bob', name: 'bob', avatarUrl: null, principalKind: 'human' },
    ],
    messages: [],
    interpretations: [],
    proposals: [],
    proposalSources: [],
    objects: [
      {
        id: CLAIM_ID,
        roomId: 'room',
        type: 'claim',
        // The claim's OWN truth axis is `unverified`; a HUMAN (`bob`, not the
        // claimant) accepted it — provenance says a person took responsibility.
        payload: { statement: 'staging is green.', claimant: 'alice', verification: 'unverified' },
        objectiveId: null,
        proposalId: null,
        sessionId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'bob',
        acceptedByKind: 'human',
        humanTouchedAt: new Date(AT),
        createdAt: new Date(AT),
        updatedAt: new Date(AT),
      },
    ],
    objectSources: [],
    relations: [],
    attention: [],
    corrections: [],
  } as ReplayData;
}

describe('SL-6 fix — certify/remove eligibility stays on provenance, not the drift glyph', () => {
  it('a human-certified claim with an UNWIRED resolver is ~ on screen but NOT certify/removable', () => {
    // Resolver unwired: the migrated CONTENT glyph fails closed to `~` (by design,
    // until #182/#194 wires a live doc).
    const view = replayView(humanCertifiedClaimData(), 'carol');
    const object = view.objects.find((candidate) => candidate.id === CLAIM_ID);
    if (!object) throw new Error('claim must render');
    expect(glyphFor(object.state)).toBe('~');

    // …but eligibility reads PROVENANCE: a person already certified this reading,
    // so the live receipt must offer neither act. Base offered both (it keyed on
    // the fail-closed `verification === 'self_reported'`).
    const receipt = replayReceipt(humanCertifiedClaimData(), view.records, object, {
      viewer: { id: 'carol', kind: 'human' },
    });
    expect(receipt.certifiable).toBe(false);
    expect(receipt.removable).toBe(false);
  });

  it('a MACHINE-accepted claim is still certify/removable (the gate is not disabled)', () => {
    // Flip only the provenance: same content, accepted by a model, no human touch.
    const data = humanCertifiedClaimData();
    const machineData: ReplayData = {
      ...data,
      objects: data.objects.map((object) => ({
        ...object,
        acceptedBy: 'atrium',
        acceptedByKind: 'model',
        humanTouchedAt: null,
      })),
    };
    const view = replayView(machineData, 'carol');
    const object = view.objects.find((candidate) => candidate.id === CLAIM_ID);
    if (!object) throw new Error('claim must render');
    const receipt = replayReceipt(machineData, view.records, object, {
      viewer: { id: 'carol', kind: 'human' },
    });
    expect(receipt.certifiable).toBe(true);
    expect(receipt.removable).toBe(true);
  });
});
