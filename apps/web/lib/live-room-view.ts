import type { HumanSummary, MessageRecord, TimelineEntry } from '../src/components';
import { messageEntry, sinceYouLeft, systemStatement } from '../src/components';
import type { RoomView } from '../src/lib/realtime';
import type { ReplayData } from './replay-data';
import { mentionBody, replayView, typedReferenceBody } from './replay-view';

const TALK = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
} as const;

function presenceFor(state: string | undefined): HumanSummary['presence'] {
  if (state === 'online') return 'here';
  if (state === 'away') return 'idle';
  return 'away';
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Join the persisted semantic projection to the realtime client's volatile
 * state. Persisted rows remain the authority for history and semantic state;
 * the only optimistic rows are the viewer's own pending messages.
 */
export interface LiveUnreadWindow {
  readonly afterSeq: number;
  readonly throughSeq: number;
}

/** A projection invalidation bypasses the durable event-sequence guard. */
export function shouldRefreshLiveRoute(
  reason: 'state' | 'projection',
  lastSeq: number,
  refreshedThrough: number,
): boolean {
  return reason === 'projection' || lastSeq > refreshedThrough;
}

export function liveRoomView(
  data: ReplayData,
  viewerId: string,
  live: RoomView,
  unreadWindow?: LiveUnreadWindow,
) {
  const base = replayView(data, viewerId);
  const participantName = new Map(base.humans.map((human) => [human.id, human.name]));
  const pendingRecords: MessageRecord[] = live.pending.map((pending) => ({
    id: `pending:${pending.clientMessageId}`,
    at: clock(pending.at),
    actor: base.viewer.name,
    text: pending.body,
    origin: 'typed',
    room: base.room.name,
    // Upload capabilities authorize a retry but are not product metadata and
    // must never enter the rendered attribution register.
    attachments: pending.attachments.map(({ key, name, contentType, size }) => ({
      key,
      name,
      contentType,
      size,
    })),
  }));
  const pendingEntries = pendingRecords.map((record, index) => {
    const pending = live.pending[index];
    return messageEntry(record, {
      state: TALK,
      body:
        pending?.commandName === 'send_message'
          ? pending.references.length > 0
            ? typedReferenceBody(pending.body, pending.references, (kind, targetId) => {
                if (kind === 'human') {
                  const label = participantName.get(targetId);
                  return label === undefined ? undefined : { kind, targetId, label };
                }
                return { kind, targetId, label: kind };
              })
            : mentionBody(pending.body, pending.mentionUserIds, participantName)
          : undefined,
      viewer: base.viewer.name,
      tag:
        pending?.status === 'failed' && pending.retryable === true
          ? { label: 'retry exact send', tone: 'neutral' }
          : null,
      note:
        pending?.status === 'failed'
          ? systemStatement(pending.error ?? 'the send did not complete')
          : pending?.commandName === 'send_message' &&
              pending.mentionUserIds.length > 0 &&
              pending.references.length === 0
            ? systemStatement('legacy mention metadata has no verified authored span')
            : null,
    });
  });
  const humans = base.humans.map((human) => ({
    ...human,
    presence: presenceFor(live.presence[human.id]),
  }));
  const viewer = humans.find((human) => human.id === viewerId) ?? base.viewer;
  const sourcedMessageIds = new Set(data.proposalSources.map((source) => source.messageId));
  const semanticRetryIds = new Set(
    data.messages.flatMap((message) =>
      message.authorId === viewerId &&
      message.clientMessageId?.startsWith('semantic:') &&
      !sourcedMessageIds.has(message.id)
        ? [message.id]
        : [],
    ),
  );
  const messageEntries = base.entries
    .filter((entry) => entry.type === 'message')
    .map((entry) =>
      semanticRetryIds.has(entry.id)
        ? {
            ...entry,
            tag: { label: 'retry semantic staging', tone: 'neutral' as const },
            note: systemStatement(
              'the message is saved; its semantic proposal has not been staged',
            ),
          }
        : entry,
    );
  const positionByMessage = new Map(
    (data.messagePositions ?? []).map((position) => [position.messageId, position.roomSeq]),
  );
  const afterSeq = unreadWindow?.afterSeq ?? live.seenSeq;
  const throughSeq = unreadWindow?.throughSeq ?? live.head;
  const currentUnreadIndices = live.subscribed
    ? data.messages.flatMap((message, index) =>
        (positionByMessage.get(message.id) ?? 0) > live.seenSeq && message.authorId !== viewerId
          ? [index]
          : [],
      )
    : [];
  const unreadIndices = live.subscribed
    ? data.messages.flatMap((message, index) =>
        (positionByMessage.get(message.id) ?? 0) > afterSeq &&
        (positionByMessage.get(message.id) ?? 0) <= throughSeq &&
        message.authorId !== viewerId
          ? [index]
          : [],
      )
    : [];
  const firstUnread = unreadIndices[0] ?? -1;
  const entries: TimelineEntry[] = [...messageEntries];
  if (firstUnread >= 0) {
    const unread = unreadIndices.flatMap((index) => {
      const entry = messageEntries[index];
      return entry ? [entry] : [];
    });
    const first = data.messages[firstUnread];
    const last = data.messages[unreadIndices.at(-1) ?? firstUnread];
    entries.splice(
      firstUnread,
      0,
      sinceYouLeft({
        id: `live-unread:${afterSeq}:${throughSeq}`,
        label: 'SINCE YOU LEFT',
        window: `${clock(first?.createdAt.toISOString() ?? '')} → ${clock(last?.createdAt.toISOString() ?? '')}`,
        entries: unread,
        seen: live.seenSeq >= throughSeq,
        seenAt: null,
        activeFilter: null,
      }),
    );
  }

  return {
    ...base,
    records: [...base.records, ...pendingRecords],
    entries: [...entries, ...pendingEntries],
    humans,
    viewer,
    rooms: base.rooms.map((room) => ({
      ...room,
      unseen: currentUnreadIndices.length,
    })),
  };
}
