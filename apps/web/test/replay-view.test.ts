import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveRoomView, shouldRefreshLiveRoute } from '../lib/live-room-view';
import type { ReplayData } from '../lib/replay-data';
import { reopenQuestion } from '../lib/replay-transitions';
import {
  activeAnswerMatchesClientMessage,
  activeAnswerMessageId,
  replayAt,
  replayReceipt,
  replayView,
} from '../lib/replay-view';
import { withFilter } from '../src/components';
import type { RoomView } from '../src/lib/realtime';

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
        clientMessageId: 'client-answer-a',
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
   * Mutation: copy an accepted object's epistemic state onto its entire source
   * message. A mixed or long human post then appears wholly certified even
   * though the persisted edge proves only the extracted semantic sentence.
   */
  it('keeps a semantic source message as ordinary conversation', () => {
    const snapshot = data();
    snapshot.objects.push({
      id: 'decision',
      roomId: 'room',
      type: 'decision',
      payload: { statement: 'Regenerate in the background.', decidedBy: 'alice', status: 'active' },
      objectiveId: null,
      proposalId: null,
      revision: 0,
      retractedAt: null,
      supersededById: null,
      acceptedBy: 'alice',
      createdAt: at,
      updatedAt: at,
    });
    const objectSources = snapshot.objectSources as unknown as Array<{
      roomId: string;
      objectId: string;
      messageId: string;
    }>;
    objectSources.push({ roomId: 'room', objectId: 'decision', messageId: 'm1' });

    const sourceRow = replayView(snapshot, 'alice').entries[1];
    if (sourceRow?.type !== 'message') throw new Error('source row is not a message');
    expect(sourceRow.state).toEqual({
      kind: 'event',
      verification: 'routine',
      owedToViewer: false,
      irreversible: false,
    });
  });

  /**
   * Mutation: omit staged objectives or present a model proposal as accepted.
   * A corpus with no human certification then either loses its Current-state
   * grouping or paints a machine reading with settled authority.
   */
  it('groups persisted drafts under a proposed objective without certifying them', () => {
    const snapshot = data();
    const proposal = (
      id: string,
      type: 'objective' | 'decision',
      payload: ReplayData['proposals'][number]['payload'],
      quote: string,
    ): ReplayData['proposals'][number] => ({
      id,
      roomId: 'room',
      interpretationId: null,
      type,
      payload,
      confidence: 0.95,
      proposerKind: 'model',
      proposerModel: 'replay/precomputed-v1',
      proposerUserId: null,
      stagedByKind: 'model',
      stagedById: 'replay/precomputed-v1',
      quote,
      status: 'proposed',
      decidedBy: null,
      decidedAt: null,
      rejectedReason: null,
      createdAt: at,
    });
    snapshot.proposals.push(
      proposal(
        'objective-draft',
        'objective',
        {
          title: 'Choose a regeneration strategy.',
          status: 'open',
        } as unknown as ReplayData['proposals'][number]['payload'],
        'Choose a regeneration strategy.',
      ),
      proposal(
        'decision-draft',
        'decision',
        {
          statement: 'Regenerate in the background.',
          decidedBy: null,
          status: 'active',
        } as ReplayData['proposals'][number]['payload'],
        'Regenerate in the background.',
      ),
    );

    const view = replayView(snapshot, 'alice');
    expect(view.objectives).toContainEqual({
      id: 'objective-draft',
      title: 'Choose a regeneration strategy.',
      status: 'proposed',
      open: true,
    });
    const decisionDraft = view.objects.find((object) => object.id === 'decision-draft');
    expect(decisionDraft).toMatchObject({
      state: { verification: 'proposed' },
      objectives: ['objective-draft'],
    });
    if (!decisionDraft) throw new Error('decision draft missing');
    expect(replayReceipt(snapshot, view.records, decisionDraft).acceptable).toBe(true);
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
      clientMessageId: 'client-answer-b',
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
    /** CATCHES: marking a question answered while omitting the accepted answer's exact source. */
    const answeredReceipt = replayReceipt(snapshot, view.records, question);
    expect(answeredReceipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual([
      'm1',
      'm3',
    ]);
    expect(answeredReceipt.provenance[1]?.note?.text).toBe(
      'accepted answer linked to this question',
    );
    snapshot.corrections.push({
      id: 'persisted-reopen',
      roomId: 'room',
      objectId: 'question',
      action: 'reopen',
      before: { status: 'answered', answeredBy: ['relation-wrong'] },
      after: { status: 'open', priorAnswers: ['relation-wrong'] },
      byUserId: 'alice',
      note: null,
      eventId: 'event-reopen',
      createdAt: at,
    });
    /** CATCHES: showing the oldest historical answer after reopen then re-answer. */
    const reansweredReceipt = replayReceipt(snapshot, view.records, question);
    expect(reansweredReceipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual([
      'm1',
      'm3',
    ]);
    expect(activeAnswerMessageId(snapshot, 'question')).toBe('m3');
    /** CATCHES: clearing a losing concurrent answer because somebody else answered first. */
    expect(activeAnswerMatchesClientMessage(snapshot, 'question', 'client-answer-a')).toBe(false);
    expect(activeAnswerMatchesClientMessage(snapshot, 'question', 'client-answer-b')).toBe(true);
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

describe('live room view', () => {
  /**
   * Mutation: apply the durable-sequence guard to projection invalidations, or
   * ignore the onChange reason in LiveRoomSession. With an unchanged cursor the
   * authenticated route then never rereads post-worker attention.
   */
  it('refreshes the live route for projection changes at an unchanged cursor', () => {
    expect(shouldRefreshLiveRoute('state', 8, 8)).toBe(false);
    expect(shouldRefreshLiveRoute('state', 9, 8)).toBe(true);
    expect(shouldRefreshLiveRoute('projection', 8, 8)).toBe(true);

    const session = readFileSync('app/app/[workspace]/[room]/LiveRoomSession.tsx', 'utf8');
    expect(session).toContain(
      '!shouldRefreshLiveRoute(reason, room.lastSeq, refreshedThrough.current)',
    );
  });

  /**
   * Mutation: compare the membership cursor with `messages.seq` (a global
   * sequence) or put the divider at the start of the room. The participant who
   * saw m1 but missed m2 is then told they missed the wrong transcript slice.
   */
  it('places the unread divider from persisted room_seq positions', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: data().messages.map((message) =>
        message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
      ),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: { alice: 'online' },
      typing: [],
      subscribed: true,
    });

    expect(view.entries.map((entry) => entry.type)).toEqual([
      'message',
      'since-you-left',
      'message',
    ]);
    expect(view.entries[1]).toMatchObject({
      type: 'since-you-left',
      label: 'SINCE YOU LEFT',
      total: 1,
      counts: { need: 0, change: 0, discussion: 1, routine: 0 },
      entryIds: ['m2'],
    });
    expect(view.rooms[0]?.unseen).toBe(1);
    expect(view.humans[0]?.presence).toBe('here');
  });

  /**
   * Mutation: apply a SINCE YOU LEFT chip to every row in the room instead of
   * the divider's persisted unread membership. An older discussion row then
   * claims to be one of the single missed rows the chip counted.
   */
  it('scopes a live divider filter to the exact unread rows it counted', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: data().messages.map((message) =>
        message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
      ),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    const divider = view.entries.find((entry) => entry.type === 'since-you-left');
    expect(divider?.entryIds).toEqual(['m2']);

    const filtered = withFilter(view.entries, 'discussion', divider?.entryIds);
    const rows = filtered.filter((entry) => entry.type === 'message');
    expect(rows.map((entry) => [entry.id, entry.filterScoped, entry.matchesFilter])).toEqual([
      ['m1', false, false],
      ['m2', true, true],
    ]);
  });

  /**
   * Mutation: recompute the live divider from the newly advanced seen cursor.
   * Marking its one-row window seen would delete the divider (and turn its
   * selected chip into a room-wide filter) instead of preserving it muted.
   */
  it('keeps a frozen unread window after its durable cursor advances', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: [
        ...data().messages.map((message) =>
          message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
        ),
        {
          id: 'm3',
          seq: 3,
          authorId: 'bob',
          author: 'bob',
          body: 'This arrived after the frozen missed window.',
          clientMessageId: null,
          replyToId: null,
          attachments: [],
          createdAt: new Date('2026-08-02T12:02:00.000Z'),
        },
      ],
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
        { messageId: 'm3', roomSeq: 5 },
      ],
    };
    const live: RoomView = {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 4,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    };

    const view = liveRoomView(snapshot, 'alice', live, { afterSeq: 1, throughSeq: 4 });
    expect(view.entries.find((entry) => entry.type === 'since-you-left')).toMatchObject({
      seen: true,
      total: 1,
      entryIds: ['m2'],
    });
    // The preserved group is seen, while later traffic remains independently unread.
    expect(view.rooms[0]?.unseen).toBe(1);
  });

  /**
   * Mutation: count every room row after seen_seq without removing messages
   * authored by the viewer. The divider then contradicts its own promise that
   * a person’s activity is never counted back to them as unseen.
   */
  it('does not count the viewer’s own later messages as unseen', () => {
    const snapshot: ReplayData = {
      ...data(),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    expect(view.entries.some((entry) => entry.type === 'since-you-left')).toBe(false);
    expect(view.rooms[0]?.unseen).toBe(0);
  });
});
