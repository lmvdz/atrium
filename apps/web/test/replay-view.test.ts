import { describe, expect, it } from 'vitest';
import type { ReplayData } from '../lib/replay-data';
import { reopenQuestion } from '../lib/replay-transitions';
import { replayAt, replayReceipt, replayView } from '../lib/replay-view';

const at = new Date('2026-08-02T12:00:00.000Z');

function data(): ReplayData {
  return {
    room: {
      id: 'room',
      name: 'isr-rfc',
      slug: 'nextjs-isr',
      workspaceId: 'workspace',
      workspaceName: 'Atrium replay',
      workspaceSlug: 'replay',
    },
    participants: [{ id: 'alice', name: 'alice', avatarUrl: null }],
    messages: [
      {
        id: 'm1',
        seq: 1,
        authorId: 'alice',
        author: 'alice',
        body: 'Should regeneration happen in the background?',
        replyToId: null,
        attachments: [],
        createdAt: at,
      },
      {
        id: 'm2',
        seq: 2,
        authorId: 'alice',
        author: 'alice',
        body: 'Yes, while the previous page remains available.',
        replyToId: 'm1',
        attachments: [],
        createdAt: new Date('2026-08-02T12:01:00.000Z'),
      },
    ],
    interpretations: [],
    proposals: [],
    proposalSources: [],
    objects: [],
    objectSources: [],
    relations: [],
    attention: [],
    corrections: [],
  };
}

describe('persisted replay view', () => {
  /**
   * Mutation: retain final worker rows while scrubbing an earlier message
   * prefix. The replay then presents a conclusion before its source was read.
   */
  it('withholds the worker result until the complete imported corpus is visible', () => {
    const snapshot = data();
    expect(replayAt(snapshot, 0).messages).toEqual([]);
    expect(replayAt(snapshot, 0).objects).toEqual([]);
    expect(replayAt(snapshot, snapshot.messages.length)).toBe(snapshot);
  });

  /**
   * Mutation: source the feed from gallery fixtures or truncate the persisted
   * messages. The two database records no longer produce exactly two message
   * rows beneath the derived replay divider.
   * Mutation: carry reply text separately instead of deriving it from m1. The
   * reply citation no longer names the record whose words it displays.
   * Mutation: hand-write the divider's class totals. Its discussion count no
   * longer follows the two persisted human-authored rows.
   */
  it('derives every conversation row and reply citation from persisted messages', () => {
    const view = replayView(data(), 'alice');
    expect(view.records.map((record) => record.text)).toEqual([
      'Should regeneration happen in the background?',
      'Yes, while the previous page remains available.',
    ]);
    expect(view.entries).toHaveLength(3);
    expect(view.entries[0]).toMatchObject({
      type: 'since-you-left',
      counts: { need: 0, change: 0, discussion: 2, routine: 0 },
      total: 2,
    });
    expect(view.entries[2]?.type).toBe('message');
    if (view.entries[2]?.type !== 'message') throw new Error('third row is not a message');
    expect(view.entries[2].replyTo?.messageId).toBe('m1');
    expect(view.room.members).toEqual(['alice']);
  });

  /**
   * Mutation: resolve the first answer edge or the first claim source rather
   * than the exact relation retained by the reopen transition. The receipt
   * quotes m2 instead of the answer selected by relation-good.
   */
  it('resolves a reopened question through its retained answer relation', () => {
    const snapshot = data();
    snapshot.messages.push({
      id: 'm3',
      seq: 3,
      authorId: 'alice',
      author: 'alice',
      body: 'The retained answer is the background regeneration claim.',
      replyToId: 'm1',
      attachments: [],
      createdAt: new Date('2026-08-02T12:02:00.000Z'),
    });
    snapshot.objects.push(
      {
        id: 'question',
        roomId: 'room',
        type: 'open_question',
        payload: { question: 'Should regeneration happen in the background?', status: 'answered' },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        createdAt: at,
        updatedAt: at,
      },
      ...(['wrong-answer', 'retained-answer'] as const).map((id, index) => ({
        id,
        roomId: 'room',
        type: 'claim' as const,
        payload: {
          statement:
            index === 0
              ? 'Yes, while the previous page remains available.'
              : 'The retained answer is the background regeneration claim.',
          claimant: 'alice',
          verification: 'unverified' as const,
        },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        createdAt: at,
        updatedAt: at,
      })),
    );
    const objectSources = snapshot.objectSources as unknown as Array<{
      roomId: string;
      objectId: string;
      messageId: string;
    }>;
    objectSources.push(
      { roomId: 'room', objectId: 'question', messageId: 'm1' },
      { roomId: 'room', objectId: 'wrong-answer', messageId: 'm2' },
      { roomId: 'room', objectId: 'retained-answer', messageId: 'm3' },
    );
    snapshot.relations.push(
      {
        id: 'relation-wrong',
        roomId: 'room',
        kind: 'answers',
        fromObjectId: 'question',
        toObjectId: 'wrong-answer',
        toMessageId: null,
        toUrl: null,
        toFileKey: null,
        note: null,
        createdBy: 'alice',
        createdAt: at,
      },
      {
        id: 'relation-good',
        roomId: 'room',
        kind: 'answers',
        fromObjectId: 'question',
        toObjectId: 'retained-answer',
        toMessageId: null,
        toUrl: null,
        toFileKey: null,
        note: null,
        createdBy: 'alice',
        createdAt: at,
      },
    );

    const view = replayView(snapshot, 'alice');
    const question = view.objects.find((object) => object.id === 'question');
    if (!question) throw new Error('question view missing');
    const correction = reopenQuestion(question, '12:03', ['relation-good']);
    const receipt = replayReceipt(snapshot, view.records, correction.after, { correction });

    expect(receipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual(['m1', 'm3']);
    expect(receipt.provenance.map((entry) => entry.excerpt.messageId)).not.toContain('m2');
  });

  /**
   * Mutation: ignore persisted correction rows, trust arbitrary before/after
   * text, or narrate the uncited participant note. Only the allowlisted typed
   * transition appears, and its free-form note remains absent.
   */
  it('renders only typed persisted correction history in system voice', () => {
    const snapshot = data();
    snapshot.corrections.push(
      {
        id: 'valid',
        roomId: 'room',
        objectId: 'decision',
        action: 'retype',
        before: { type: 'decision' },
        after: { type: 'claim' },
        byUserId: 'alice',
        note: 'Alice supposedly said these uncited words',
        eventId: 'event-valid',
        createdAt: at,
      },
      {
        id: 'invalid',
        roomId: 'room',
        objectId: 'decision',
        action: 'retype',
        before: { type: 'invented' },
        after: { type: 'claim' },
        byUserId: 'alice',
        note: 'Another uncited sentence',
        eventId: 'event-invalid',
        createdAt: at,
      },
    );
    const object = {
      id: 'decision',
      kind: 'decision' as const,
      state: {
        kind: 'decision' as const,
        verification: 'accepted' as const,
        owedToViewer: false,
        irreversible: false,
      },
      text: 'Regenerate in the background.',
      facts: [],
      objectives: [],
    };

    const receipt = replayReceipt(snapshot, replayView(snapshot, 'alice').records, object);
    expect(receipt.corrections).toHaveLength(1);
    expect(receipt.corrections[0]?.heading.text).toBe('RECORDED · DECISION → CLAIM');
    expect(JSON.stringify(receipt)).not.toContain('supposedly');
    expect(JSON.stringify(receipt)).not.toContain('Another uncited');
  });

  /**
   * Mutation: turn a nullable author join into a named human. The adapter then
   * invents an identity that is absent from the persisted message record.
   */
  it('labels a missing attribution as unavailable instead of inventing a participant', () => {
    const snapshot = data();
    const first = snapshot.messages[0];
    if (!first) throw new Error('fixture message missing');
    snapshot.messages[0] = { ...first, author: null };

    const view = replayView(snapshot, 'alice');
    expect(view.records[0]?.actor).toBe('author unavailable');
    expect(view.room.members).toEqual(['alice']);
  });

  /**
   * Mutation: render a superseded row, drop either direction of a persisted
   * blocker edge, or derive the room timestamp from only the last message.
   */
  it('projects supersession, relation direction, and the latest semantic timestamp', () => {
    const snapshot = data();
    const changedAt = new Date('2026-08-02T13:05:00.000Z');
    snapshot.objects.push(
      {
        id: 'old-decision',
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Use the old path.', decidedBy: 'alice', status: 'superseded' },
        objectiveId: null,
        proposalId: null,
        revision: 1,
        retractedAt: null,
        supersededById: 'decision',
        acceptedBy: 'alice',
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'decision',
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Use the current path.', decidedBy: 'alice', status: 'active' },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        createdAt: at,
        updatedAt: changedAt,
      },
      {
        id: 'claim',
        roomId: 'room',
        type: 'claim',
        payload: {
          statement: 'The migration is safe.',
          claimant: 'alice',
          verification: 'unverified',
        },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        createdAt: at,
        updatedAt: at,
      },
    );
    snapshot.relations.push({
      id: 'blocker',
      roomId: 'room',
      kind: 'blocks',
      fromObjectId: 'decision',
      toObjectId: 'claim',
      toMessageId: null,
      toUrl: null,
      toFileKey: null,
      note: null,
      createdBy: 'alice',
      createdAt: at,
    });

    const view = replayView(snapshot, 'alice');
    expect(view.objects.find((object) => object.id === 'old-decision')).toBeUndefined();
    expect(view.objects.find((object) => object.id === 'decision')?.facts).toContain(
      'blocks: The migration is safe.',
    );
    expect(view.objects.find((object) => object.id === 'claim')?.facts).toContain(
      'blocked by: Use the current path.',
    );
    expect(view.updatedAt).toBe('13:05');
  });

  /**
   * Mutation: replace the structured reason with a class-level generic, or
   * offer an open-source action when no persisted provenance edge exists.
   */
  it('derives attention rationale and actions from the stored reason and source', () => {
    const snapshot = data();
    snapshot.attention.push({
      id: 'confirm',
      roomId: 'room',
      userId: 'alice',
      subjectKind: 'object',
      subjectId: 'missing-commitment',
      subjectObjectId: 'missing-commitment',
      subjectProposalId: null,
      class: 'owned_commitment',
      reason: { kind: 'commitment_confirm', statement: 'Ship the migration.' },
      status: 'pending',
      createdAt: at,
      resolvedAt: null,
    });

    const [item] = replayView(snapshot).attention;
    expect(item?.rationale).toContain('named as owner by somebody else');
    expect(item?.actions.map((action) => action.id)).toEqual(['confirm', 'decline']);
    expect(item?.actions.map((action) => action.id)).not.toContain('open');
  });
});
