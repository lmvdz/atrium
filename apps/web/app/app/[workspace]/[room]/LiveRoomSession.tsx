'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { liveRoomView } from '@/lib/live-room-view';
import type { ReplayData } from '@/lib/replay-data';
import { activeAnswerMatchesClientMessage, replayReceipt } from '@/lib/replay-view';
import type { AttentionClass, ComposerBinding, SurfaceId } from '@/src/components';
import { boundTo, needsViewer, withFilter } from '@/src/components';
import { quotationFrom } from '@/src/components/model/quotation';
import {
  attachmentDownloadUrl,
  type UploadedAttachment,
  uploadAttachment,
} from '@/src/lib/attachments';
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
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [attachmentNote, setAttachmentNote] = useState<string>();
  const pendingUploads = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [binding, setBinding] = useState<ComposerBinding>({ mode: 'free' });
  const [boundSubmission, setBoundSubmission] = useState<{
    clientMessageId: string;
    questionId: string;
  } | null>(null);
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
  const subjectByAttention = new Map(data.attention.map((item) => [item.id, item.subjectId]));
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

  useEffect(() => {
    if (!boundSubmission) return;
    const pending = live.pending.find(
      (candidate) => candidate.clientMessageId === boundSubmission.clientMessageId,
    );
    if (pending?.status === 'failed') {
      // CATCHES: erasing a person's bound draft and provenance after the server
      // refused it. The failed optimistic row remains visible and the composer
      // is re-enabled with the exact words, attachment and binding intact.
      setBoundSubmission(null);
      return;
    }
    if (
      !activeAnswerMatchesClientMessage(
        data,
        boundSubmission.questionId,
        boundSubmission.clientMessageId,
      )
    ) {
      return;
    }
    // A bound answer is complete only once the canonical semantic projection,
    // not its command ack, says the question was answered.
    setDraft('');
    setAttachments([]);
    setAttachmentNote(undefined);
    setBinding({ mode: 'free' });
    setBoundSubmission(null);
    setError(null);
  }, [boundSubmission, data, live.pending]);

  const jumpToMessage = (messageId: string) => {
    setReceiptId(null);
    setFocused('conversation');
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (candidate) => candidate.dataset.messageId === messageId,
      );
      if (!row) return;
      row.tabIndex = -1;
      row.scrollIntoView({ block: 'center' });
      row.focus({ preventScroll: true });
    });
  };

  return (
    <main className={styles.live} data-room-id={roomId}>
      <RoomFrame
        attention={view.attention}
        binding={binding}
        boxed={false}
        composerEnabled={subscribed && !uploading && boundSubmission === null}
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
            if (!body || !subscribed || pendingUploads.current > 0) return;
            if (binding.mode === 'bound') {
              const questionId =
                subjectByAttention.get(binding.itemId) ??
                (binding.itemId.startsWith('live-direct:')
                  ? binding.itemId.slice('live-direct:'.length)
                  : null);
              if (!questionId) {
                setError('the question behind this answer is no longer on the record');
                return;
              }
              const clientMessageId = clientRef.current?.answerMessage(
                roomId,
                questionId,
                body,
                attachments,
              );
              if (!clientMessageId) return;
              setError(null);
              setBoundSubmission({ clientMessageId, questionId });
            } else {
              clientRef.current?.sendMessage(roomId, body, {
                attachments,
                replyToId: binding.mode === 'replying' ? binding.to.messageId : null,
              });
              setDraft('');
              setAttachments([]);
              setAttachmentNote(undefined);
              setBinding({ mode: 'free' });
            }
            clientRef.current?.setTyping(roomId, false);
          },
          onAttach: (file) => {
            pendingUploads.current += 1;
            setUploading(true);
            setAttachmentNote(`uploading ${file.name} directly to object storage`);
            void uploadAttachment(roomId, file)
              .then((uploaded) => {
                setAttachments((current) => [...current, uploaded]);
                setAttachmentNote(`${uploaded.name} attached · ${uploaded.size} bytes`);
              })
              .catch((failure: unknown) => {
                setAttachmentNote(undefined);
                setError(failure instanceof Error ? failure.message : String(failure));
              })
              .finally(() => {
                pendingUploads.current -= 1;
                setUploading(pendingUploads.current > 0);
              });
          },
          attachmentNote,
          onCancelBinding: () => {
            if (boundSubmission === null) setBinding({ mode: 'free' });
          },
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onMarkSeen: () => clientRef.current?.advanceSeen(roomId, live.lastSeq),
          onOpenReceipt: setReceiptId,
          onCloseReceipt: () => setReceiptId(null),
          onJumpToMessage: jumpToMessage,
          onJumpToSource: (_itemId, messageId) => jumpToMessage(messageId),
          onOpenAttachment: (_messageId, attachment) => {
            void attachmentDownloadUrl(roomId, attachment)
              .then((url) => window.open(url, '_blank', 'noopener'))
              .catch((failure: unknown) =>
                setError(failure instanceof Error ? failure.message : String(failure)),
              );
          },
          onRowAction: (messageId, actionId) => {
            const record = view.records.find((candidate) => candidate.id === messageId);
            if (!record || record.id.startsWith('pending:')) return;
            if (actionId === 'reply') {
              const quotation = quotationFrom(record);
              if (!quotation) return;
              setBinding({ mode: 'replying', to: quotation });
              return;
            }
            if (actionId === 'quote') {
              void navigator.clipboard.writeText(record.text).then(() => {
                setAttachmentNote(
                  'exact message text copied · attribution remains on its source row',
                );
              });
              return;
            }
            if (actionId === 'link') {
              const hash = `#message=${encodeURIComponent(record.id)}`;
              window.history.replaceState(null, '', hash);
              void navigator.clipboard.writeText(window.location.href).then(() => {
                setAttachmentNote('message link copied');
              });
              jumpToMessage(record.id);
            }
          },
          onAcceptReceipt: (proposalId) => clientRef.current?.acceptProposal(roomId, proposalId),
          onRetypeToClaim: (objectId) =>
            clientRef.current?.correctObject(roomId, objectId, 'retype', { toType: 'claim' }),
          onReopen: (objectId) => clientRef.current?.correctObject(roomId, objectId, 'reopen'),
          onAnswerReceipt: (objectId) => {
            const object = view.objects.find((candidate) => candidate.id === objectId);
            if (!object) return;
            setBinding({
              mode: 'bound',
              itemId: `live-direct:${object.id}`,
              itemLabel: object.text,
              objective: data.room.name,
              state: object.state,
            });
            setFocused('conversation');
          },
          onAct: (attentionId, actionId) => {
            const item = view.attention.find((candidate) => candidate.id === attentionId);
            const subjectId = subjectByAttention.get(attentionId);
            if (!item || !subjectId) return;
            if (actionId === 'confirm') {
              clientRef.current?.acceptProposal(roomId, subjectId);
              return;
            }
            if (actionId === 'decline') {
              clientRef.current?.rejectProposal(roomId, subjectId);
              return;
            }
            if (actionId === 'answer') {
              const subject = view.objects.find((candidate) => candidate.id === subjectId);
              if (subject?.kind !== 'question') {
                setReceiptId(subjectId);
                setFocused('current-state');
                return;
              }
              setBinding(boundTo(item, data.room.name));
              setFocused('conversation');
              return;
            }
            if (actionId === 'open' && item.source) jumpToMessage(item.source.messageId);
          },
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
