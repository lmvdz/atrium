import { describe, expect, it } from 'vitest';
import { applyReplayTransitions, reopenQuestion, retypeAsClaim } from '../lib/replay-transitions';
import type { StateObject } from '../src/components';

const decision: StateObject = {
  id: 'decision',
  kind: 'decision',
  state: {
    kind: 'decision',
    verification: 'accepted',
    owedToViewer: false,
    irreversible: false,
  },
  text: 'Use the blocking fallback.',
  facts: [],
  objectives: ['objective'],
};

const question: StateObject = {
  id: 'question',
  kind: 'question',
  state: {
    kind: 'question',
    verification: 'accepted',
    owedToViewer: false,
    irreversible: false,
  },
  text: 'Will it work?',
  facts: [],
  objectives: ['objective'],
};

describe('replay correction transitions', () => {
  /**
   * Mutation: relabel a rendered decision without recording its adjacent
   * before/after objects, or mint a replacement id. The transition and applied
   * view can no longer agree on identity and kind.
   */
  it('records decision → claim once and derives the view from that record', () => {
    const transition = retypeAsClaim(decision, '12:00');
    expect(transition).toMatchObject({
      action: 'retype',
      objectId: decision.id,
      before: { id: decision.id, kind: 'decision' },
      after: { id: decision.id, kind: 'claim', state: { verification: 'unverified' } },
    });
    expect(applyReplayTransitions([decision], [transition])[0]).toBe(transition.after);
  });

  /**
   * Mutation: reopen without an answer relation or clear owedToViewer. The
   * factory either accepts an erasing transition or produces no pending work.
   */
  it('refuses to reopen without history and restores an owed open question', () => {
    expect(() => reopenQuestion(question, '12:01', [])).toThrow('prior answer relation');
    const transition = reopenQuestion(question, '12:01', ['answers-1']);
    expect(transition.priorAnswerRelationIds).toEqual(['answers-1']);
    expect(transition.after.state).toMatchObject({
      kind: 'question',
      verification: 'open',
      owedToViewer: true,
    });
  });

  /**
   * Mutation: append the reopen fact every time a locally answered question is
   * reopened. React then receives duplicate fact keys and the receipt repeats
   * one event as though it happened twice in the same transition.
   */
  it('keeps the reopen fact singular across repeated local answer cycles', () => {
    const first = reopenQuestion(question, '12:01', ['answers-1']);
    const answeredAgain: StateObject = {
      ...first.after,
      state: { ...first.after.state, verification: 'accepted', owedToViewer: false },
    };
    const second = reopenQuestion(answeredAgain, '12:02', ['answers-2']);
    expect(
      second.after.facts.filter((fact) => fact === 'reopened with the prior answer preserved'),
    ).toHaveLength(1);
  });
});
