import type { HumanSummary, MessageRecord, TimelineEntry } from '../src/components';
import { messageEntry, sinceYouLeft } from '../src/components';
import type { RoomView } from '../src/lib/realtime';
import type { ReplayData } from './replay-data';
import { replayView } from './replay-view';

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
export function liveRoomView(data: ReplayData, viewerId: string, live: RoomView) {
  const base = replayView(data, viewerId);
  const pendingRecords: MessageRecord[] = live.pending.map((pending) => ({
    id: `pending:${pending.clientMessageId}`,
    at: clock(pending.at),
    actor: base.viewer.name,
    text: pending.body,
    origin: 'typed',
    room: base.room.name,
    attachments: pending.attachments,
  }));
  const pendingEntries = pendingRecords.map((record) =>
    messageEntry(record, { state: TALK, viewer: base.viewer.name }),
  );
  const humans = base.humans.map((human) => ({
    ...human,
    presence: presenceFor(live.presence[human.id]),
  }));
  const viewer = humans.find((human) => human.id === viewerId) ?? base.viewer;
  const messageEntries = base.entries.filter((entry) => entry.type === 'message');
  const positionByMessage = new Map(
    (data.messagePositions ?? []).map((position) => [position.messageId, position.roomSeq]),
  );
  const unreadIndices = live.subscribed
    ? data.messages.flatMap((message, index) =>
        (positionByMessage.get(message.id) ?? 0) > live.seenSeq && message.authorId !== viewerId
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
    const last = data.messages.at(-1);
    entries.splice(
      firstUnread,
      0,
      sinceYouLeft({
        id: `live-unread:${live.seenSeq}`,
        label: 'SINCE YOU LEFT',
        window: `${clock(first?.createdAt.toISOString() ?? '')} → ${clock(last?.createdAt.toISOString() ?? '')}`,
        entries: unread,
        seen: false,
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
      unseen: unreadIndices.length,
    })),
  };
}
