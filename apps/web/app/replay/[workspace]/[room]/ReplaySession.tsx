'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { authoredBody } from '@/lib/authored-body';
import type { ReplayData } from '../../../../lib/replay-data';
import {
  applyReplayTransitions,
  type ReplayCorrectionTransition,
  reopenQuestion,
  retypeAsClaim,
} from '../../../../lib/replay-transitions';
import { replayAt, replayReceipt, replayView } from '../../../../lib/replay-view';
import type {
  AttentionClass,
  AttentionItem,
  ComposerBinding,
  MessageRecord,
  ObjectiveRecord,
  SurfaceId,
} from '../../../../src/components';
import {
  boundTo,
  citationFrom,
  messageEntry,
  needsViewer,
  rationale,
  withFilter,
} from '../../../../src/components';
import { RoomFrame } from '../../../gallery/RoomFrame';
import styles from './replay.module.css';

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ReplaySession({ data, viewerId }: { data: ReplayData; viewerId?: string }) {
  const [cursor, setCursor] = useState(data.messages.length);
  const snapshot = useMemo(() => replayAt(data, cursor), [cursor, data]);
  const view = useMemo(() => replayView(snapshot, viewerId), [snapshot, viewerId]);
  const [binding, setBinding] = useState<ComposerBinding>({ mode: 'free' });
  const [draft, setDraft] = useState('');
  const [actedOn, setActedOn] = useState<readonly string[]>([]);
  const [acceptedSubjects, setAcceptedSubjects] = useState<readonly string[]>([]);
  const [answerBySubject, setAnswerBySubject] = useState<Readonly<Record<string, string>>>({});
  const [corrections, setCorrections] = useState<readonly ReplayCorrectionTransition[]>([]);
  const [localRecords, setLocalRecords] = useState<readonly MessageRecord[]>([]);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const localSequence = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState<SurfaceId>('conversation');
  const [filter, setFilter] = useState<AttentionClass | null>(null);
  const [openAttentionId, setOpenAttentionId] = useState(
    view.attention.find((item) => needsViewer(item.state))?.id,
  );
  const [openObjectives, setOpenObjectives] = useState<Readonly<Record<string, boolean>>>({});
  useEffect(() => {
    if (binding.mode !== 'bound') return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [binding]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const feed = document.querySelector<HTMLElement>('[data-region="conversation"]');
      const visibleMessages = feed?.querySelectorAll<HTMLElement>('[data-message-id]');
      const anchor =
        feed?.querySelector<HTMLElement>('[data-row="since-you-left"]') ??
        visibleMessages?.[Math.min(cursor, visibleMessages.length) - 1];
      anchor?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [cursor]);
  const objectives: readonly ObjectiveRecord[] = view.objectives.map((objective) => ({
    ...objective,
    open: openObjectives[objective.id] ?? objective.open,
  }));
  const correctedObjects = applyReplayTransitions(view.objects, corrections);
  const objects = correctedObjects.map((object) => {
    const accepted =
      acceptedSubjects.includes(object.id) && object.kind !== 'claim'
        ? {
            ...object,
            state: {
              ...object.state,
              verification: 'accepted' as const,
              owedToViewer: false,
            },
            objectives:
              object.objectives.length === 0
                ? view.objectives.map((objective) => objective.id)
                : object.objectives,
          }
        : object;
    return accepted;
  });
  const records = [...view.records, ...localRecords];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const restoredAttention: AttentionItem[] = corrections.flatMap((correction) => {
    if (correction.action !== 'reopen') return [];
    const sourceId = data.objectSources.find(
      (source) => source.objectId === correction.objectId,
    )?.messageId;
    const source = sourceId ? recordById.get(sourceId) : undefined;
    return [
      {
        id: `replay-attention:${correction.id}`,
        state: correction.after.state,
        title: correction.after.text,
        rationale: rationale('this question is open again and needs an answer'),
        facts: ['reopened with the prior answer preserved'],
        source: source ? citationFrom(source) : null,
        actions: [{ id: 'answer', label: 'answer', emphasis: 'primary', statement: null }],
      },
    ];
  });
  const attention = [...view.attention, ...restoredAttention].filter(
    (item) => !actedOn.includes(item.id),
  );
  const attentionSubjects = new Map([
    ...data.attention.map((item) => [item.id, item.subjectId] as const),
    ...corrections.flatMap((correction) =>
      correction.action === 'reopen'
        ? [[`replay-attention:${correction.id}`, correction.objectId] as const]
        : [],
    ),
  ]);
  const receiptObject = objects.find((object) => object.id === receiptId);
  const receiptCorrection = corrections.findLast(
    (correction) => correction.objectId === receiptObject?.id,
  );
  const receipt = receiptObject
    ? replayReceipt(data, records, receiptObject, {
        answerMessageId: answerBySubject[receiptObject.id],
        correction: receiptCorrection,
      })
    : undefined;
  const localEntries = localRecords.map((record) =>
    messageEntry(record, {
      state: {
        kind: 'event',
        verification: 'routine',
        owedToViewer: false,
        irreversible: false,
      },
      viewer: view.viewer.name,
    }),
  );
  const entries = [...view.entries, ...localEntries].map((entry) => {
    if (entry.type === 'since-you-left') return { ...entry, activeFilter: filter };
    if (entry.type === 'message') return { ...entry, targeted: entry.id === targetMessageId };
    return entry;
  });

  const jumpToMessage = (messageId: string) => {
    setReceiptId(null);
    setFocused('conversation');
    setTargetMessageId(messageId);
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (candidate) => candidate.dataset.messageId === messageId,
      );
      if (row) {
        row.tabIndex = -1;
        row.scrollIntoView({ block: 'center' });
        row.focus({ preventScroll: true });
      }
    });
  };

  const focusReceipt = () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-receipt-id]')?.focus();
    });
  };

  const send = (text: string) => {
    if (binding.mode !== 'bound') return;
    const body = authoredBody(text);
    if (body === null) return;
    localSequence.current += 1;
    const record: MessageRecord = {
      id: `replay-answer-${localSequence.current}`,
      at: clockNow(),
      actor: view.viewer.name,
      text: body,
      origin: 'typed',
      room: view.room.name,
    };
    setLocalRecords((current) => [...current, record]);
    if (binding.mode === 'bound') {
      const subjectId =
        attentionSubjects.get(binding.itemId) ??
        (binding.itemId.startsWith('replay-direct:')
          ? binding.itemId.slice('replay-direct:'.length)
          : undefined);
      if (subjectId) {
        setAcceptedSubjects((current) => [...current, subjectId]);
        setAnswerBySubject((current) => ({ ...current, [subjectId]: record.id }));
        setReceiptId(subjectId);
        setActedOn((current) => [
          ...new Set([
            ...current,
            binding.itemId,
            ...[...attentionSubjects.entries()]
              .filter(([, candidateSubjectId]) => candidateSubjectId === subjectId)
              .map(([itemId]) => itemId),
          ]),
        ]);
      }
      if (!subjectId) setActedOn((current) => [...current, binding.itemId]);
      setOpenAttentionId(
        view.attention.find((item) => item.id !== binding.itemId && !actedOn.includes(item.id))?.id,
      );
    }
    setBinding({ mode: 'free' });
    setDraft('');
    setTargetMessageId(null);
  };

  const seek = (next: number) => {
    setCursor(Math.max(0, Math.min(data.messages.length, Math.trunc(next))));
    /* Local replay acts describe the terminal snapshot. Carrying them into an
       earlier prefix would put an answer before the words it answered. */
    setBinding({ mode: 'free' });
    setDraft('');
    setActedOn([]);
    setAcceptedSubjects([]);
    setAnswerBySubject({});
    setCorrections([]);
    setLocalRecords([]);
    setReceiptId(null);
    setTargetMessageId(null);
  };

  return (
    <main className={styles.replay}>
      <RoomFrame
        attention={attention}
        binding={binding}
        boxed={false}
        composerEnabled={binding.mode === 'bound'}
        composerNote={
          binding.mode === 'bound'
            ? 'this answer is recorded verbatim in the local replay'
            : 'replay is read-only · choose an answer action to exercise answer binding'
        }
        entries={withFilter(entries, filter)}
        filter={filter}
        focused={focused}
        handlers={{
          composerValue: draft,
          composerRef,
          onComposerChange: setDraft,
          onSend: send,
          onCancelBinding: () => setBinding({ mode: 'free' }),
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onOpenReceipt: (objectId) => {
            setTargetMessageId(null);
            setReceiptId(objectId);
          },
          onAcceptReceipt: (objectId) => {
            setAcceptedSubjects((current) =>
              current.includes(objectId) ? current : [...current, objectId],
            );
            focusReceipt();
          },
          onAnswerReceipt: (objectId) => {
            const object = objects.find((candidate) => candidate.id === objectId);
            if (!object) return;
            setBinding({
              mode: 'bound',
              itemId: `replay-direct:${object.id}`,
              itemLabel: object.text,
              objective: data.room.name,
              state: object.state,
            });
            setFocused('conversation');
          },
          onCloseReceipt: () => setReceiptId(null),
          onJumpToMessage: jumpToMessage,
          onJumpToSource: (_itemId, messageId) => jumpToMessage(messageId),
          onRetypeToClaim: (objectId) => {
            const object = objects.find((candidate) => candidate.id === objectId);
            if (object)
              setCorrections((current) => [
                ...current.filter((transition) => transition.objectId !== objectId),
                retypeAsClaim(object, clockNow()),
              ]);
            focusReceipt();
          },
          onReopen: (objectId) => {
            const object = objects.find((candidate) => candidate.id === objectId);
            const relationIds = data.relations
              .filter(
                (relation) => relation.kind === 'answers' && relation.fromObjectId === objectId,
              )
              .map((relation) => relation.id);
            const localAnswer = answerBySubject[objectId];
            if (localAnswer) relationIds.push(`replay-local-answer:${localAnswer}`);
            if (object) {
              setActedOn((current) =>
                current.filter(
                  (itemId) =>
                    !itemId.startsWith('replay-attention:') ||
                    attentionSubjects.get(itemId) !== objectId,
                ),
              );
              setAcceptedSubjects((current) => current.filter((id) => id !== objectId));
              setCorrections((current) => [
                ...current.filter((transition) => transition.objectId !== objectId),
                reopenQuestion(object, clockNow(), relationIds),
              ]);
              focusReceipt();
            }
          },
          onAct: (itemId, actionId) => {
            const item = attention.find((candidate) => candidate.id === itemId);
            if (!item) return;
            if (actionId === 'answer') {
              setBinding(boundTo(item, data.room.name));
              setFocused('conversation');
              return;
            }
            if (actionId === 'open' && item.source) {
              jumpToMessage(item.source.messageId);
              return;
            }
            setActedOn((current) => [...current, itemId]);
          },
          onToggleObjective: (objectiveId) =>
            setOpenObjectives((current) => ({
              ...current,
              [objectiveId]: !(current[objectiveId] ?? true),
            })),
        }}
        humans={view.humans}
        label="replay"
        lastCheck={view.updatedAt}
        messages={records}
        objectives={objectives}
        objects={objects}
        openAttentionId={openAttentionId}
        receipt={receipt}
        room={view.room}
        rooms={view.rooms}
        trailer={view.trailer}
        updatedAt={view.updatedAt}
        viewer={view.viewer}
      />
      {binding.mode === 'free' ? (
        <nav aria-label="Replay controls" className={styles.controls}>
          <span className={styles.controlLabel}>REPLAY POSITION</span>
          <button
            aria-label="Previous message"
            disabled={cursor === 0}
            onClick={() => seek(cursor - 1)}
            type="button"
          >
            ← previous
          </button>
          <input
            aria-label="Replay position"
            max={data.messages.length}
            min="0"
            onChange={(event) => seek(Number(event.currentTarget.value))}
            type="range"
            value={cursor}
          />
          <button
            aria-label="Next message"
            disabled={cursor === data.messages.length}
            onClick={() => seek(cursor + 1)}
            type="button"
          >
            next →
          </button>
          <output aria-live="polite" className={styles.position}>
            {cursor === data.messages.length
              ? `all ${cursor} messages shown · machine read through ${cursor}`
              : `first ${cursor} of ${data.messages.length} shown`}
          </output>
        </nav>
      ) : null}
    </main>
  );
}
