import { epistemicStateFromAcceptance } from '@atrium/core';
import type { StateObject } from '../src/components';

export type ReplayCorrectionTransition =
  | {
      readonly id: string;
      readonly action: 'retype';
      readonly objectId: string;
      readonly at: string;
      readonly before: StateObject;
      readonly after: StateObject;
    }
  | {
      readonly id: string;
      readonly action: 'reopen';
      readonly objectId: string;
      readonly at: string;
      readonly before: StateObject;
      readonly after: StateObject;
      readonly priorAnswerRelationIds: readonly string[];
    };

/**
 * The only replay door for decision → claim. The adjacent before/after pair is
 * recorded at the act, then both Current state and the receipt read this same
 * transition. No renderer is allowed to reconstruct the correction later.
 */
export function retypeAsClaim(
  object: StateObject,
  at: string,
): Extract<ReplayCorrectionTransition, { readonly action: 'retype' }> {
  if (object.kind !== 'decision' || object.state.verification !== 'accepted') {
    throw new Error('replay retype: only an accepted decision can be retyped as a claim');
  }
  return {
    id: `${object.id}:retype:${at}`,
    action: 'retype',
    objectId: object.id,
    at,
    before: object,
    after: {
      ...object,
      kind: 'claim',
      state: {
        kind: 'claim',
        /*
         * A retype is a HUMAN correction: a person has now read this and taken
         * responsibility for it, so it is CERTIFIED (`✓`) — the same split the
         * persisted `stateForObject` makes. Certification and claim-truth are
         * separate axes: the tick is "a person took this reading", NOT "something
         * fact-checked the claim". The truth stays unverified, and it stays
         * honestly visible — in the fact below, and in the dotted underline
         * `ClaimText` keeps on a certified-but-unverified claim.
         *
         * ROUND 4 (#98): the tick is DERIVED from `epistemicStateFromAcceptance`
         * — the one predicate — rather than the literal `'accepted'` this used to
         * hand-set. A human correction is a human acceptance, so the predicate
         * returns `confirmed`; routing it here means a mutation of
         * `epistemicStateOf` moves this optimistic glyph the same way it moves
         * the persisted one, closing the last hand-set tick (was #110's purity
         * gap). Truth is the separate `self_reported` axis until something checks
         * it, so a de-certified predicate falls back to that, never a stray `✓`.
         */
        verification:
          epistemicStateFromAcceptance('human', at) === 'confirmed' ? 'accepted' : 'self_reported',
        owedToViewer: false,
        irreversible: false,
      },
      facts: [...object.facts, 'claim truth remains unverified'],
    },
  };
}

/** The only replay door for answered question → open again. */
export function reopenQuestion(
  object: StateObject,
  at: string,
  priorAnswerRelationIds: readonly string[],
): Extract<ReplayCorrectionTransition, { readonly action: 'reopen' }> {
  if (object.kind !== 'question' || object.state.verification !== 'accepted') {
    throw new Error('replay reopen: only an answered question can be reopened');
  }
  if (priorAnswerRelationIds.length === 0) {
    throw new Error('replay reopen: the prior answer relation must stay on the record');
  }
  const reopenedFact = 'reopened with the prior answer preserved';
  return {
    id: `${object.id}:reopen:${at}`,
    action: 'reopen',
    objectId: object.id,
    at,
    before: object,
    after: {
      ...object,
      state: {
        kind: 'question',
        verification: 'open',
        owedToViewer: true,
        irreversible: false,
      },
      facts: object.facts.includes(reopenedFact) ? object.facts : [...object.facts, reopenedFact],
    },
    priorAnswerRelationIds: [...priorAnswerRelationIds],
  };
}

export function applyReplayTransitions(
  objects: readonly StateObject[],
  transitions: readonly ReplayCorrectionTransition[],
): readonly StateObject[] {
  const latest = new Map(transitions.map((transition) => [transition.objectId, transition]));
  return objects.map((object) => latest.get(object.id)?.after ?? object);
}
