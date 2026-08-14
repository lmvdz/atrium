import type { MessageRecord, ParticipantSummary, TimelineEntry } from '../src/components';
import { messageEntry, sinceYouLeft, systemStatement } from '../src/components';
import type { RoomView } from '../src/lib/realtime';
import type { ReplayData } from './replay-data';
import { replayView, typedReferenceBody } from './replay-view';

const TALK = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
} as const;

function presenceFor(state: string | undefined): ParticipantSummary['presence'] {
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
  const participantName = new Map(base.participants.map((person) => [person.id, person.name]));
  /**
   * The committed row claims its own echo, here, in the same render.
   *
   * #136. The two halves of a send arrive on two unsynchronised channels: the
   * durable row reaches `data` when `router.refresh()` re-reads the route from
   * the database, and the optimistic echo leaves `live.pending` when the
   * socket's own `message_posted` event is applied (`reconcilePending`). Each
   * half is correct; nothing related them. So any refresh whose *server* render
   * postdates the commit but whose *client* commit predates the event renders
   * both — the same message twice, once as `data-origin="seeded"` with its real
   * id and once as `data-origin="typed"` with `pending:…`.
   *
   * That window is normally a few milliseconds, which is why it read as a
   * flake. A socket drop across the commit stretches it to a whole reconnect:
   * the event is delayed until the resubscribe's catch-up, while
   * `projection_changed` (which `shouldRefreshLiveRoute` deliberately lets
   * bypass the event-sequence guard) and the post-load refresh chain keep
   * pulling the committed row in from the database meanwhile.
   *
   * Relating them cannot be done on either channel alone — each one only ever
   * sees its own half. It can be done here, because this is the one place that
   * holds both at once: an echo whose durable row is already in this very
   * projection is not pending, it is delivered. Dropping it in the same
   * expression that renders the durable row makes the swap atomic by
   * construction — there is no frame in which both exist, whichever signal wins
   * the race, and no reachable state in which a stuck echo outlives its own
   * message.
   *
   * Matched on `clientMessageId` *and* on the row being the viewer's own, for
   * the reason `reconcilePending` gives: the key is client-chosen, and claiming
   * an echo against somebody else's row would erase the viewer's message.
   */
  const committedClientMessageIds = new Set(
    data.messages.flatMap((message) =>
      message.authorId === viewerId && typeof message.clientMessageId === 'string'
        ? [message.clientMessageId]
        : [],
    ),
  );
  const unclaimedPending = live.pending.filter(
    (pending) => !committedClientMessageIds.has(pending.clientMessageId),
  );
  const pendingRecords: MessageRecord[] = unclaimedPending.map((pending) => ({
    id: `pending:${pending.clientMessageId}`,
    at: clock(pending.at),
    actor: base.viewer.name,
    text: pending.body,
    origin: 'typed',
    // A pending row is the viewer's own optimistic send, so its author kind is
    // the viewer's — an agent driving its session sees its own words in the
    // agent register the instant it sends, before the server round-trips (#101).
    authorKind: base.viewer.kind,
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
    const pending = unclaimedPending[index];
    return messageEntry(record, {
      state: TALK,
      body:
        pending?.commandName === 'send_message'
          ? pending.references.length > 0
            ? typedReferenceBody(pending.body, pending.references, (kind, targetId) => {
                // Person or agent: both resolve to a participant name off the same
                // map, keeping their kind. Item kinds fall through to `label: kind`.
                if (kind === 'human' || kind === 'agent') {
                  const label = participantName.get(targetId);
                  return label === undefined ? undefined : { kind, targetId, label };
                }
                return { kind, targetId, label: kind };
              })
            : undefined
          : undefined,
      viewer: base.viewer.name,
      tag:
        pending?.status === 'failed' && pending.retryable === true
          ? { label: 'retry exact send', tone: 'neutral' }
          : null,
      note:
        pending?.status === 'failed'
          ? systemStatement(pending.error ?? 'the send did not complete')
          : null,
    });
  });
  const participants = base.participants.map((person) => ({
    ...person,
    presence: presenceFor(live.presence[person.id]),
  }));
  const viewer = participants.find((person) => person.id === viewerId) ?? base.viewer;
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
    participants,
    viewer,
    rooms: base.rooms.map((room) => ({
      ...room,
      unseen: currentUnreadIndices.length,
    })),
  };
}
