import { describe, expect, it } from 'vitest';
import { answerClientMessageId, type ConductorContext, classify } from '../src/conductor.js';

/**
 * The deterministic run-zero conductor (#148, #124 trichotomy). One turn per
 * message → exactly one arm. Each rule has a disjoint witness, and each witness
 * flips: change the deciding field and the arm changes.
 */

const OWN = 'agent-self';
const HUMAN = 'human-owner';

function context(overrides: Partial<ConductorContext> = {}): ConductorContext {
  return {
    ownUserId: OWN,
    runningSessionForGoal: () => null,
    ...overrides,
  };
}

describe('classify — the #124 trichotomy', () => {
  it('routes a ticket-naming goal to open-work, carrying the ticket', () => {
    const route = classify(
      { messageId: 'm1', body: 'please build #148 today', replyToId: null, authorUserId: HUMAN },
      context(),
    );
    expect(route).toEqual({ kind: 'open_work', ticket: '148' });
  });

  it('routes a reply to a RUNNING session to a steer against that session', () => {
    const route = classify(
      {
        messageId: 'm2',
        body: 'focus on the crash path',
        replyToId: 'goal-1',
        authorUserId: HUMAN,
      },
      context({ runningSessionForGoal: (goal) => (goal === 'goal-1' ? 'sess-9' : null) }),
    );
    expect(route).toEqual({ kind: 'steer', sessionId: 'sess-9' });
  });

  it('does NOT steer a reply whose goal has no running session — it falls through', () => {
    const route = classify(
      { messageId: 'm3', body: 'thanks, all good', replyToId: 'goal-cold', authorUserId: HUMAN },
      context({ runningSessionForGoal: () => null }),
    );
    expect(route).toEqual({ kind: 'ignore' });
  });

  it('routes a question to an answer', () => {
    const route = classify(
      { messageId: 'm4', body: 'are you there?', replyToId: null, authorUserId: HUMAN },
      context(),
    );
    expect(route).toEqual({ kind: 'answer' });
  });

  it('ignores a plain statement that is neither goal, steer, nor question', () => {
    const route = classify(
      { messageId: 'm5', body: 'good morning everyone', replyToId: null, authorUserId: HUMAN },
      context(),
    );
    expect(route).toEqual({ kind: 'ignore' });
  });

  it('NEVER routes the loop’s own output (rule 0 wins over a ticket in its own post)', () => {
    // A daemon post that itself names a ticket must not re-open work — the flip
    // that would otherwise make the loop answer/act on itself forever.
    const route = classify(
      { messageId: 'm6', body: 'opened a plan for #148', replyToId: null, authorUserId: OWN },
      context(),
    );
    expect(route).toEqual({ kind: 'ignore' });
  });

  it('precedence: a ticket-naming reply to a running session steers rather than opens (steer wins)', () => {
    const route = classify(
      {
        messageId: 'm7',
        body: 'also look at #200 while in here',
        replyToId: 'goal-1',
        authorUserId: HUMAN,
      },
      context({ runningSessionForGoal: (g) => (g === 'goal-1' ? 'sess-1' : null) }),
    );
    expect(route).toEqual({ kind: 'steer', sessionId: 'sess-1' });
  });
});

describe('answerClientMessageId — deterministic dedupe key', () => {
  it('is a pure function of the cause (a replay derives the same key)', () => {
    expect(answerClientMessageId('cause-abc')).toBe(answerClientMessageId('cause-abc'));
  });
  it('is distinct per cause', () => {
    expect(answerClientMessageId('cause-a')).not.toBe(answerClientMessageId('cause-b'));
  });
});
