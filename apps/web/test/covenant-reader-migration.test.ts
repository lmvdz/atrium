import { describe, expect, it } from 'vitest';
import type { ReplayData } from '../lib/replay-data';
import { retypeAsClaim } from '../lib/replay-transitions';
import { locallyAcceptedState, replayView } from '../lib/replay-view';
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
