import { emptyState } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { mentionSignals } from '../src/attention-projection.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const mentionedUser = '44444444-4444-4444-8444-444444444444';
const at = '2026-08-03T00:00:00.000Z';

describe('live mention projection', () => {
  /**
   * Mutation: scan bare names, route a mention to a non-member, or attach it
   * to an unrelated object. Only an explicit marker borne by that object's
   * provenance may become owed attention.
   */
  it('routes an explicit authored request to its member and accepted object', () => {
    const state = emptyState();
    state.objects[objectId] = {
      object: {
        id: objectId,
        roomId,
        type: 'open_question',
        payload: { question: 'Which trace?', status: 'open' },
        objectiveId: null,
        provenance: { messageIds: [messageId], proposalId: null, interpretationId: null },
        createdAt: at,
        updatedAt: at,
      },
      acceptedAt: at,
      updatedAt: at,
      acceptedBy: { kind: 'model', model: 'test' },
      humanTouchedAt: null,
      revision: 0,
      retractedAt: null,
      supersededById: null,
      reopenedFromAnswers: [],
    };

    const messages = [
      {
        id: messageId,
        authorId: '55555555-5555-4555-8555-555555555555',
        body: `Mention for ${mentionedUser}: Open question: Which trace?`,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        authorId: mentionedUser,
        body: 'I mentioned a name without making a request.',
      },
    ];

    expect(mentionSignals(state, roomId, messages, [mentionedUser])).toEqual([
      {
        roomId,
        objectId,
        userId: mentionedUser,
        request: 'Open question: Which trace?',
      },
    ]);
    expect(mentionSignals(state, roomId, messages, [])).toEqual([]);
  });
});
