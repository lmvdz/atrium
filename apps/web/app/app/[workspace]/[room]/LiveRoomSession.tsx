'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { liveRoomView } from '@/lib/live-room-view';
import type { ReplayData } from '@/lib/replay-data';
import { replayReceipt } from '@/lib/replay-view';
import type { AttentionClass, SurfaceId } from '@/src/components';
import { needsViewer, withFilter } from '@/src/components';
import {
  createRealtimeClient,
  localStorageJournal,
  type RealtimeClient,
  type RoomView,
} from '@/src/lib/realtime';
import { RoomFrame } from '../../../gallery/RoomFrame';
import styles from './live-room.module.css';

function copyRoom(room: RoomView): RoomView {
  return {
    ...room,
    events: [...room.events],
    pending: room.pending.map((pending) => ({ ...pending })),
    presence: { ...room.presence },
    typing: [...room.typing],
  };
}

function emptyRoom(roomId: string): RoomView {
  return {
    roomId,
    lastSeq: 0,
    head: 0,
    seenSeq: 0,
    events: [],
    pending: [],
    presence: {},
    typing: [],
    subscribed: false,
  };
}

export function LiveRoomSession({ data, viewerId }: { data: ReplayData; viewerId: string }) {
  const router = useRouter();
  const roomId = data.room.id;
  const clientRef = useRef<RealtimeClient | null>(null);
  const [live, setLive] = useState<RoomView>(() => emptyRoom(roomId));
  const [connection, setConnection] = useState<
    'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState<SurfaceId>('conversation');
  const [filter, setFilter] = useState<AttentionClass | null>(null);
  const [openAttentionId, setOpenAttentionId] = useState<string>();
  const [openObjectives, setOpenObjectives] = useState<Readonly<Record<string, boolean>>>({});
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshedThrough = useRef(0);

  useEffect(() => {
    const client = createRealtimeClient({
      userId: viewerId,
      journal: localStorageJournal(viewerId),
      onError: setError,
    });
    clientRef.current = client;
    setLive(copyRoom(client.room(roomId)));
    const stopChanges = client.onChange((changedRoomId, room) => {
      if (changedRoomId !== roomId) return;
      setLive(copyRoom(room));
      if (room.lastSeq <= refreshedThrough.current || refreshTimer.current !== null) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        refreshedThrough.current = client.lastSeq(roomId);
        router.refresh();
      }, 75);
    });
    const stopStatus = client.onStatus((status) => {
      setConnection(status);
      if (status === 'open') {
        client.setPresence(roomId, 'online');
      }
    });
    void client.connect();

    return () => {
      stopChanges();
      stopStatus();
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
      client.setPresence(roomId, 'offline');
      client.leave(roomId);
      client.close();
      clientRef.current = null;
    };
  }, [roomId, router, viewerId]);

  const view = liveRoomView(data, viewerId, live);
  const objectives = view.objectives.map((objective) => ({
    ...objective,
    open: openObjectives[objective.id] ?? objective.open,
  }));
  const receiptObject = view.objects.find((object) => object.id === receiptId);
  const receipt = receiptObject
    ? // Live receipts are derived only from the refreshed persisted projection.
      // No semantic command is rendered optimistically.
      replayReceipt(data, view.records, receiptObject)
    : undefined;
  const owed = view.attention.filter((item) => needsViewer(item.state)).length;
  const subscribed = live.subscribed && connection === 'open';

  return (
    <main className={styles.live}>
      <RoomFrame
        attention={view.attention}
        binding={{ mode: 'free' }}
        boxed={false}
        composerEnabled={subscribed}
        composerNote={
          error ??
          (subscribed
            ? `${live.typing.length} typing · ordered through ${live.lastSeq}`
            : `${connection} · waiting for an authorized room subscription`)
        }
        entries={withFilter(view.entries, filter)}
        filter={filter}
        focused={focused}
        handlers={{
          composerValue: draft,
          onComposerChange: (next) => {
            setDraft(next);
            clientRef.current?.setTyping(roomId, next.trim().length > 0);
          },
          onSend: (text) => {
            const body = text.trim();
            if (!body || !subscribed) return;
            clientRef.current?.sendMessage(roomId, body);
            clientRef.current?.setTyping(roomId, false);
            setDraft('');
          },
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onMarkSeen: () => clientRef.current?.advanceSeen(roomId, live.lastSeq),
          onOpenReceipt: setReceiptId,
          onCloseReceipt: () => setReceiptId(null),
          onToggleObjective: (objectiveId) =>
            setOpenObjectives((current) => ({
              ...current,
              [objectiveId]: !(current[objectiveId] ?? true),
            })),
        }}
        humans={view.humans}
        label="live"
        lastCheck={view.updatedAt}
        messages={view.records}
        objectives={objectives}
        objects={view.objects}
        openAttentionId={openAttentionId}
        receipt={receipt}
        room={view.room}
        rooms={view.rooms}
        trailer={view.trailer}
        updatedAt={view.updatedAt}
        viewer={view.viewer}
        viewerNote={`${subscribed ? 'here' : connection} · ${owed} owed to you`}
      />
    </main>
  );
}
