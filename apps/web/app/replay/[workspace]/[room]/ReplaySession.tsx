'use client';

import { useMemo, useRef, useState } from 'react';
import type { ReplayData } from '../../../../lib/replay-data';
import { replayAt, replayReceipt, replayView } from '../../../../lib/replay-view';
import type {
  AttentionClass,
  ComposerBinding,
  MessageRecord,
  ObjectiveRecord,
  SurfaceId,
} from '../../../../src/components';
import {
  boundTo,
  messageEntry,
  needsViewer,
  settledForViewer,
  withFilter,
} from '../../../../src/components';
import { RoomFrame } from '../../../gallery/RoomFrame';
import styles from './replay.module.css';

export function ReplaySession({ data, viewerId }: { data: ReplayData; viewerId?: string }) {
  const [cursor, setCursor] = useState(data.messages.length);
  const snapshot = useMemo(() => replayAt(data, cursor), [cursor, data]);
  const view = useMemo(() => replayView(snapshot, viewerId), [snapshot, viewerId]);
  const [binding, setBinding] = useState<ComposerBinding>({ mode: 'free' });
  const [draft, setDraft] = useState('');
  const [actedOn, setActedOn] = useState<readonly string[]>([]);
  const [acceptedSubjects, setAcceptedSubjects] = useState<readonly string[]>([]);
  const [localRecords, setLocalRecords] = useState<readonly MessageRecord[]>([]);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const localSequence = useRef(0);
  const [focused, setFocused] = useState<SurfaceId>('conversation');
  const [filter, setFilter] = useState<AttentionClass | null>(null);
  const [openAttentionId, setOpenAttentionId] = useState(
    view.attention.find((item) => needsViewer(item.state))?.id,
  );
  const [openObjectives, setOpenObjectives] = useState<Readonly<Record<string, boolean>>>({});
  const objectives: readonly ObjectiveRecord[] = view.objectives.map((objective) => ({
    ...objective,
    open: openObjectives[objective.id] ?? objective.open,
  }));
  const attention = view.attention.map((item) =>
    actedOn.includes(item.id) ? { ...item, state: settledForViewer(item.state) } : item,
  );
  const objects = view.objects.map((object) =>
    acceptedSubjects.includes(object.id)
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
      : object,
  );
  const records = [...view.records, ...localRecords];
  const receiptObject = objects.find((object) => object.id === receiptId);
  const receipt = receiptObject ? replayReceipt(data, records, receiptObject) : undefined;
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
  const entries = [...view.entries, ...localEntries].map((entry) =>
    entry.type === 'since-you-left' ? { ...entry, activeFilter: filter } : entry,
  );

  const send = (text: string) => {
    const body = text.trim();
    if (!body) return;
    localSequence.current += 1;
    const record: MessageRecord = {
      id: `replay-answer-${localSequence.current}`,
      at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      actor: view.viewer.name,
      text: body,
      origin: 'typed',
      room: view.room.name,
    };
    setLocalRecords((current) => [...current, record]);
    if (binding.mode === 'bound') {
      const stored = data.attention.find((item) => item.id === binding.itemId);
      if (stored) {
        setAcceptedSubjects((current) => [...current, stored.subjectId]);
        setReceiptId(stored.subjectId);
      }
      setActedOn((current) => [...current, binding.itemId]);
      setOpenAttentionId(
        view.attention.find((item) => item.id !== binding.itemId && !actedOn.includes(item.id))?.id,
      );
    }
    setBinding({ mode: 'free' });
    setDraft('');
  };

  return (
    <main className={styles.replay}>
      <RoomFrame
        attention={attention}
        binding={binding}
        boxed={false}
        entries={withFilter(entries, filter)}
        filter={filter}
        focused={focused}
        handlers={{
          composerValue: draft,
          onComposerChange: setDraft,
          onSend: send,
          onCancelBinding: () => setBinding({ mode: 'free' }),
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onOpenReceipt: setReceiptId,
          onCloseReceipt: () => setReceiptId(null),
          onAct: (itemId, actionId) => {
            const item = attention.find((candidate) => candidate.id === itemId);
            if (!item) return;
            if (actionId === 'answer') {
              setBinding(boundTo(item, data.room.name));
              setFocused('conversation');
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
        viewerNote={`replay · ${attention.length} owed to you`}
      />
      {binding.mode === 'free' ? (
        <nav aria-label="Replay controls" className={styles.controls}>
          <button
            aria-label="Previous message"
            disabled={cursor === 0}
            onClick={() => setCursor((value) => Math.max(0, value - 1))}
            type="button"
          >
            ←
          </button>
          <input
            aria-label="Replay position"
            max={data.messages.length}
            min="0"
            onChange={(event) => setCursor(Number(event.currentTarget.value))}
            type="range"
            value={cursor}
          />
          <button
            aria-label="Next message"
            disabled={cursor === data.messages.length}
            onClick={() => setCursor((value) => Math.min(data.messages.length, value + 1))}
            type="button"
          >
            →
          </button>
          <output aria-live="polite" className={styles.position}>
            {cursor === data.messages.length
              ? `interpreted · ${cursor} / ${data.messages.length}`
              : `message ${cursor} / ${data.messages.length}`}
          </output>
        </nav>
      ) : null}
    </main>
  );
}
