'use client';

import { parseSemanticCommand, payloadText } from '@atrium/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { authoredBody } from '@/lib/authored-body';
import { type LiveUnreadWindow, liveRoomView, shouldRefreshLiveRoute } from '@/lib/live-room-view';
import {
  type PendingSupersession,
  retainedSupersessionKey,
  supersessionReachedFold,
} from '@/lib/live-supersession';
import type { ReplayData } from '@/lib/replay-data';
import {
  activeAnswerMatchesClientMessage,
  replayReceipt,
  replayReceiptSubject,
} from '@/lib/replay-view';
import type { AttentionClass, ComposerBinding, SurfaceId } from '@/src/components';
import { AttachmentPreview, boundTo, withFilter } from '@/src/components';
import type { MessageAttachmentRecord } from '@/src/components/model/quotation';
import { quotationFrom } from '@/src/components/model/quotation';
import {
  attachmentDownloadUrl,
  downloadAttachment,
  type UploadedAttachment,
  uploadAttachment,
} from '@/src/lib/attachments';
import {
  createRealtimeClient,
  localStorageJournal,
  type RealtimeClient,
  type RoomView,
} from '@/src/lib/realtime';
import { mentionCandidateTargets, type ReferenceTarget } from '@/src/lib/typed-references';
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
  const [attachments, setAttachments] = useState<
    Array<UploadedAttachment & { readonly previewUrl?: string }>
  >([]);
  const attachmentPreviewUrls = useRef(new Set<string>());
  const [attachmentNote, setAttachmentNote] = useState<string>();
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachmentRecord | null>(null);
  const pendingUploads = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [binding, setBinding] = useState<ComposerBinding>({ mode: 'free' });
  const [boundSubmission, setBoundSubmission] = useState<{
    clientMessageId: string;
    questionId: string;
  } | null>(null);

  useEffect(
    () => () => {
      for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
      attachmentPreviewUrls.current.clear();
    },
    [],
  );

  const [focused, setFocused] = useState<SurfaceId>('conversation');
  const [filter, setFilter] = useState<AttentionClass | null>(null);
  const [unreadWindow, setUnreadWindow] = useState<
    (LiveUnreadWindow & { readonly roomId: string }) | null
  >(null);
  const unreadWindowRef = useRef<(LiveUnreadWindow & { readonly roomId: string }) | null>(null);
  const [openAttentionId, setOpenAttentionId] = useState<string>();
  const [openObjectives, setOpenObjectives] = useState<Readonly<Record<string, boolean>>>({});
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [pendingSupersession, setPendingSupersession] = useState<PendingSupersession | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLeaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlight = useRef(false);
  const scheduleRefreshRef = useRef<(delayMs?: number) => void>(() => {});
  const messageThrough = Math.max(
    0,
    ...(data.messagePositions ?? []).map((position) => position.roomSeq),
  );
  const persistedThrough = data.loadedThrough ?? messageThrough;
  const refreshedThrough = useRef(persistedThrough);
  const refreshTarget = useRef(persistedThrough);
  const refreshAttempts = useRef(0);
  const projectionRefreshRemaining = useRef(0);
  const semanticStageAttempts = useRef(new Set<string>());
  const refreshRoom = useRef(roomId);

  useEffect(() => {
    if (refreshRoom.current !== roomId) {
      refreshRoom.current = roomId;
      refreshTarget.current = persistedThrough;
      refreshAttempts.current = 0;
      projectionRefreshRemaining.current = 0;
      refreshInFlight.current = false;
      if (refreshLeaseTimer.current !== null) clearTimeout(refreshLeaseTimer.current);
      refreshLeaseTimer.current = null;
    }
    // This cursor describes what the Server Component props actually contain,
    // not what a refresh request hoped they would contain. Advancing it before
    // `router.refresh()` commits lets an overlapping refresh swallow a later
    // reconnect catch-up while the rendered projection remains behind.
    const advanced = persistedThrough > refreshedThrough.current;
    refreshedThrough.current = persistedThrough;
    if (advanced || persistedThrough >= refreshTarget.current) refreshAttempts.current = 0;
  }, [persistedThrough, roomId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the opaque receipt is intentionally the completed-load signal, not data read by the callback.
  useEffect(() => {
    // A new load receipt is minted only by a completed Server Component read.
    // It is the serialization edge for the next bounded refresh attempt.
    refreshInFlight.current = false;
    if (refreshLeaseTimer.current !== null) clearTimeout(refreshLeaseTimer.current);
    refreshLeaseTimer.current = null;
    scheduleRefreshRef.current(75);
  }, [data.loadReceipt]);

  useEffect(() => {
    unreadWindowRef.current = null;
    setUnreadWindow(null);
    const client = createRealtimeClient({
      userId: viewerId,
      journal: localStorageJournal(viewerId),
      onError: setError,
    });
    clientRef.current = client;
    setLive(copyRoom(client.room(roomId)));
    const scheduleRefresh = (delayMs = 75) => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        if (refreshInFlight.current) return;
        const cursorBehind = refreshTarget.current > refreshedThrough.current;
        if (!cursorBehind && projectionRefreshRemaining.current === 0) {
          refreshAttempts.current = 0;
          return;
        }
        if (refreshAttempts.current >= 12) {
          setError(
            `the live route did not reach room position ${refreshTarget.current} after 12 refreshes`,
          );
          return;
        }
        refreshInFlight.current = true;
        router.refresh();
        refreshLeaseTimer.current = setTimeout(() => {
          // Next can cancel/coalesce a refresh without committing a receipt.
          // Release only that vanished request; ordinary responses clear this
          // lease in the load-receipt effect before another refresh can start.
          refreshLeaseTimer.current = null;
          refreshInFlight.current = false;
          scheduleRefreshRef.current(75);
        }, 5_000);
        projectionRefreshRemaining.current = Math.max(0, projectionRefreshRemaining.current - 1);
        refreshAttempts.current += 1;
      }, delayMs);
    };
    scheduleRefreshRef.current = scheduleRefresh;
    const stopChanges = client.onChange((changedRoomId, room, reason) => {
      if (changedRoomId !== roomId) return;
      if (room.subscribed && unreadWindowRef.current === null) {
        // Capture the authorized subscribed frame itself. A passive effect can
        // run after catch-up or new traffic has already raised `head`, silently
        // expanding the historical group beyond the join boundary.
        const window = { roomId, afterSeq: room.seenSeq, throughSeq: room.head };
        unreadWindowRef.current = window;
        setUnreadWindow(window);
      }
      setLive(copyRoom(room));
      const previousTarget = refreshTarget.current;
      refreshTarget.current = Math.max(refreshTarget.current, room.lastSeq);
      if (room.lastSeq > previousTarget) refreshAttempts.current = 0;
      // Unlike ledger entries, projection invalidations have no durable
      // revision/ack loop (protocol.ts documents that boundary). Two completed,
      // serialized rereads survive an older in-flight refresh without treating
      // changed array identity as proof of freshness. Invalidations arriving
      // inside the same batch do not reset its budget into a refresh storm.
      if (reason === 'projection' && projectionRefreshRemaining.current === 0) {
        projectionRefreshRemaining.current = 2;
      }
      if (
        !shouldRefreshLiveRoute(reason, room.lastSeq, refreshedThrough.current) ||
        refreshTimer.current !== null ||
        refreshInFlight.current
      ) {
        return;
      }
      scheduleRefresh();
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
      if (refreshLeaseTimer.current !== null) clearTimeout(refreshLeaseTimer.current);
      scheduleRefreshRef.current = () => {};
      client.setPresence(roomId, 'offline');
      client.leave(roomId);
      client.close();
      clientRef.current = null;
    };
  }, [roomId, router, viewerId]);

  const frozenUnreadWindow = unreadWindow?.roomId === roomId ? unreadWindow : undefined;
  const view = liveRoomView(data, viewerId, live, frozenUnreadWindow);
  const contextualAttentionIds = new Set(
    view.referenceAttention.map((reference) => reference.attentionId),
  );
  const actionableAttention = view.attention.filter((item) => !contextualAttentionIds.has(item.id));
  const subjectByAttention = new Map(data.attention.map((item) => [item.id, item.subjectId]));
  const objectives = view.objectives.map((objective) => ({
    ...objective,
    open: openObjectives[objective.id] ?? objective.open,
  }));
  const receiptObject = replayReceiptSubject(data, view.objects, receiptId);
  const receipt = receiptObject
    ? // Live receipts are derived only from the refreshed persisted projection.
      // No semantic command is rendered optimistically.
      replayReceipt(data, view.records, receiptObject)
    : undefined;
  const acceptedActiveIds = new Set(
    data.objects
      .filter((object) => object.retractedAt === null && object.supersededById === null)
      .map((object) => object.id),
  );
  const supersessionCandidates =
    receiptObject && receiptObject.kind !== 'objective'
      ? view.objects.filter(
          (object) => object.id !== receiptObject.id && acceptedActiveIds.has(object.id),
        )
      : [];
  const acceptObjectives = objectives
    .filter((objective) => objective.status !== 'proposed')
    .map((objective) => ({ id: objective.id, label: objective.title }));
  const referenceTargets: readonly ReferenceTarget[] = [
    // A mention candidate is any NAMEABLE participant — a person or an agent
    // (#100). `mentionCandidateTargets` is the one definition of that allowlist
    // (see typed-references.ts): it allowlists the two identity kinds rather than
    // denylisting the item kinds, so `'unknown'` — the fail-closed rendering of a
    // participant whose kind could not be read (records.ts) — is never offered as
    // a mention target and never becomes an attention row from a name it should
    // not carry. Each candidate keeps its own kind, so the reference that lands
    // records whether a person or an agent was named.
    ...mentionCandidateTargets(view.participants),
    ...attachments.map((attachment) => ({
      kind: 'attachment' as const,
      id: attachment.id,
      label: attachment.name,
      detail: 'attached to this message',
    })),
    ...data.proposals.map((proposal) => ({
      kind: 'proposal' as const,
      id: proposal.id,
      label: payloadText(proposal.type, proposal.payload),
      detail: proposal.status,
    })),
    ...data.objects.map((object) => ({
      kind: 'object' as const,
      id: object.id,
      label: payloadText(object.type, object.payload),
      detail:
        object.retractedAt !== null
          ? 'retracted'
          : object.supersededById !== null
            ? 'superseded'
            : 'accepted',
    })),
  ];
  const subscribed = live.subscribed && connection === 'open';
  const unreadFilterScope = view.entries.find((entry) => entry.type === 'since-you-left')?.entryIds;

  useEffect(() => {
    if (!subscribed) return;
    const sourcedMessageIds = new Set(data.proposalSources.map((source) => source.messageId));
    for (const message of data.messages) {
      if (
        message.authorId !== viewerId ||
        !message.clientMessageId?.startsWith('semantic:') ||
        sourcedMessageIds.has(message.id) ||
        semanticStageAttempts.current.has(message.id) ||
        !parseSemanticCommand(message.body, viewerId)
      ) {
        continue;
      }
      semanticStageAttempts.current.add(message.id);
      clientRef.current?.stageSemanticCommand(roomId, message.id);
    }
  }, [data.messages, data.proposalSources, roomId, subscribed, viewerId]);

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
    for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
    attachmentPreviewUrls.current.clear();
    setAttachments([]);
    setAttachmentNote(undefined);
    setBinding({ mode: 'free' });
    setBoundSubmission(null);
    setError(null);
  }, [boundSubmission, data, live.pending]);

  useEffect(() => {
    if (!supersessionReachedFold(data.objects, pendingSupersession)) return;
    setPendingSupersession(null);
    setReceiptId(null);
  }, [data.objects, pendingSupersession]);

  const jumpToMessage = (messageId: string) => {
    setReceiptId(null);
    setFocused('conversation');
    setTargetMessageId(messageId);
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
    <main
      className={styles.live}
      data-live-through={live.lastSeq}
      data-persisted-through={persistedThrough}
      data-room-id={roomId}
    >
      <RoomFrame
        acceptObjectives={acceptObjectives}
        attention={actionableAttention}
        binding={binding}
        boxed={false}
        composerEnabled={subscribed && !uploading && boundSubmission === null}
        composerNote={
          error ??
          (subscribed
            ? `${live.typing.length} typing · ordered through ${live.lastSeq}`
            : `${connection} · waiting for an authorized room subscription`)
        }
        entries={withFilter(view.entries, filter, unreadFilterScope ?? []).map((entry) =>
          entry.type === 'message' ? { ...entry, targeted: entry.id === targetMessageId } : entry,
        )}
        filter={filter}
        focused={focused}
        handlers={{
          loadAttachmentPreviewUrl: (_messageId, attachment) =>
            attachmentDownloadUrl(roomId, attachment),
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            previewUrl: attachment.previewUrl,
          })),
          composerValue: draft,
          onComposerChange: (next) => {
            setDraft(next);
            clientRef.current?.setTyping(roomId, next.trim().length > 0);
          },
          onSend: (text, references) => {
            const body = authoredBody(text);
            if (body === null || !subscribed || pendingUploads.current > 0) return;
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
              const semantic = parseSemanticCommand(body, viewerId) !== null;
              clientRef.current?.sendMessage(roomId, body, {
                attachments,
                replyToId: binding.mode === 'replying' ? binding.to.messageId : null,
                references: [...references],
                semantic,
              });
              setDraft('');
              for (const url of attachmentPreviewUrls.current) URL.revokeObjectURL(url);
              attachmentPreviewUrls.current.clear();
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
                const previewUrl = file.type.startsWith('image/')
                  ? URL.createObjectURL(file)
                  : undefined;
                if (previewUrl !== undefined) attachmentPreviewUrls.current.add(previewUrl);
                setAttachments((current) => [...current, { ...uploaded, previewUrl }]);
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
          onRemoveAttachment: (id) =>
            setAttachments((current) => {
              const removed = current.find((attachment) => attachment.id === id);
              if (removed?.previewUrl !== undefined) {
                URL.revokeObjectURL(removed.previewUrl);
                attachmentPreviewUrls.current.delete(removed.previewUrl);
              }
              return current.filter((attachment) => attachment.id !== id);
            }),
          attachmentNote,
          onCancelBinding: () => {
            if (boundSubmission === null) setBinding({ mode: 'free' });
          },
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onOpenReferences: (attentionIds, messageId) => {
            for (const attentionId of attentionIds) {
              clientRef.current?.resolveAttention(roomId, attentionId, 'resolved');
            }
            jumpToMessage(messageId);
          },
          onMarkSeen: () =>
            clientRef.current?.advanceSeen(roomId, frozenUnreadWindow?.throughSeq ?? live.head),
          onOpenReceipt: setReceiptId,
          onCloseReceipt: () => setReceiptId(null),
          onJumpToMessage: jumpToMessage,
          onJumpToSource: (_itemId, messageId) => jumpToMessage(messageId),
          onOpenAttachment: (_messageId, attachment) => setPreviewAttachment(attachment),
          onDownloadAttachment: (_messageId, attachment) => {
            void downloadAttachment(roomId, attachment).catch((failure: unknown) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            );
          },
          onOpenTag: (messageId) => {
            if (messageId.startsWith('pending:')) {
              const retried = clientRef.current?.retryMessage(
                roomId,
                messageId.slice('pending:'.length),
              );
              if (retried) setError(null);
              return;
            }
            const message = data.messages.find((candidate) => candidate.id === messageId);
            if (
              message?.authorId === viewerId &&
              message.clientMessageId?.startsWith('semantic:') &&
              parseSemanticCommand(message.body, viewerId)
            ) {
              semanticStageAttempts.current.add(messageId);
              clientRef.current?.stageSemanticCommand(roomId, messageId);
              setError(null);
            }
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
          onAcceptReceipt: (proposalId, objectiveId) => {
            const proposal = data.proposals.find((candidate) => candidate.id === proposalId);
            clientRef.current?.acceptProposal(
              roomId,
              proposalId,
              proposal?.type === 'objective' ? null : objectiveId,
            );
          },
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
          onSupersedeReceipt: (retiredObjectId, replacementObjectId) => {
            const held = retainedSupersessionKey(
              pendingSupersession,
              retiredObjectId,
              replacementObjectId,
            );
            const request = clientRef.current?.supersedeObject(
              roomId,
              replacementObjectId,
              retiredObjectId,
              { clientSupersessionId: held },
            );
            if (!request) return;
            setPendingSupersession({
              retiredObjectId,
              replacementObjectId,
              clientSupersessionId: request.clientSupersessionId,
            });
          },
          onAct: (attentionId, actionId) => {
            const item = view.attention.find((candidate) => candidate.id === attentionId);
            const subjectId = subjectByAttention.get(attentionId);
            if (!item || !subjectId) return;
            if (actionId === 'confirm') {
              const proposal = data.proposals.find((candidate) => candidate.id === subjectId);
              if (proposal?.type === 'objective') {
                clientRef.current?.acceptProposal(roomId, subjectId);
              } else {
                // A temporary view with no accepted objective options must not
                // turn confirmation into an unfiled acceptance. Open the
                // persisted proposal receipt; a projection refresh can add the
                // filing choices without changing the person's action.
                setReceiptId(subjectId);
                setFocused('current-state');
              }
              return;
            }
            if (actionId === 'decline') {
              clientRef.current?.rejectProposal(roomId, subjectId);
              return;
            }
            if (actionId === 'dismiss') {
              clientRef.current?.resolveAttention(roomId, attentionId, 'dismissed');
              return;
            }
            if (actionId === 'answer') {
              const proposal = data.proposals.find((candidate) => candidate.id === subjectId);
              if (proposal?.type === 'objective') {
                clientRef.current?.acceptProposal(roomId, subjectId);
                return;
              }
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
        participants={view.participants}
        hideEmptyAttention
        label="live"
        lastCheck={view.updatedAt}
        messages={view.records}
        referenceAttention={view.referenceAttention}
        referenceTargets={referenceTargets}
        objectives={objectives}
        objects={view.objects}
        openAttentionId={openAttentionId}
        receipt={receipt}
        supersessionCandidates={supersessionCandidates}
        pendingReplacementId={
          pendingSupersession?.retiredObjectId === receiptId
            ? pendingSupersession.replacementObjectId
            : undefined
        }
        room={view.room}
        rooms={view.rooms}
        trailer={view.trailer}
        updatedAt={view.updatedAt}
        viewer={view.viewer}
      />
      {previewAttachment === null ? null : (
        <AttachmentPreview
          attachment={previewAttachment}
          loadUrl={(attachment) => attachmentDownloadUrl(roomId, attachment)}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </main>
  );
}
