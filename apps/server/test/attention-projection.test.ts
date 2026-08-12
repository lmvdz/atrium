import { emptyState, Proposal, projectAttention, storeProposal } from '@atrium/core';
import { describe, expect, it } from 'vitest';

const roomId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const proposalId = '77777777-7777-4777-8777-777777777777';
const messageId = '33333333-3333-4333-8333-333333333333';
const author = '55555555-5555-4555-8555-555555555555';
const mentionedUser = '44444444-4444-4444-8444-444444444444';
const at = '2026-08-03T00:00:00.000Z';

/**
 * A mention becomes attention in ONE place, and this worker is not it.
 *
 * `reconcileStoredAttention` calls `projectAttention` with **no `mentions`
 * feed**: the live reference path in `projections.ts` writes the one
 * `mention`-class item (subject the message) the instant a `human`/`agent`
 * `message_reference` lands, and decision #92 collapsed the old
 * `messages.mention_user_ids` column that a now-removed `mentionSignals` helper
 * used to read. Reviving that helper against the reference register — the literal
 * reading of #92/#100 — double-counts every mention (the same @name would raise
 * both the live message-subject item and a worker proposal/object-subject item),
 * which the destination multiplayer scenario's own acceptance assertion catches.
 *
 * These pin the retirement at the projection layer: even when a proposal and an
 * object both derive from a message that NAMED a room member, the worker's
 * projection raises no `mention`-class item, because no mention signal is fed.
 * Re-adding a worker mention producer — the second projection this ticket
 * removed — makes a `mention` item appear here and fails.
 */
describe('the worker projection does not manufacture mentions', () => {
  function stateFromMentioningMessage() {
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
    state.proposals[proposalId] = {
      proposal: storeProposal(
        Proposal.parse({
          id: proposalId,
          roomId,
          type: 'open_question',
          payload: { question: 'Which trace?', status: 'open' },
          confidence: 0.9,
          proposer: { kind: 'model', model: 'test' },
          provenance: [messageId],
          quote: 'Open question: Which trace?',
          createdAt: at,
        }),
      ),
      stagedBy: { kind: 'model', model: 'test' },
      status: 'proposed',
      acceptedObjectId: null,
      rejectedReason: null,
      supersededByProposalId: null,
      supersededReason: null,
    };
    return state;
  }

  // The message named `mentionedUser`; the worker is handed the messages exactly
  // as `reconcileStoredAttention` hands them over — id, author, body, and NOTHING
  // about who was named, because that is not the worker's register.
  const messages = [{ id: messageId, authorId: author, body: 'Open question: Which trace?' }];

  it('raises no mention item for a subject derived from a message that named a member', () => {
    const projection = projectAttention(stateFromMentioningMessage(), {
      now: at,
      members: { [roomId]: [mentionedUser, author] },
      messages,
      // No `mentions` feed — the retirement. See the block comment.
    });
    // `mention` is the one class this worker used to manufacture from the retired
    // column; it produces none now, whatever proposals or objects a mentioning
    // message spawned.
    expect(projection.items.filter((item) => item.class === 'mention')).toEqual([]);
  });
});
