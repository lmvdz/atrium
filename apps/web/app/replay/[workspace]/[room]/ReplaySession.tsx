'use client';

import { useMemo, useState } from 'react';
import type { ReplayData } from '../../../../lib/replay-data';
import { replayAt, replayView } from '../../../../lib/replay-view';
import type { AttentionClass, ObjectiveRecord, SurfaceId } from '../../../../src/components';
import { needsViewer, withFilter } from '../../../../src/components';
import { RoomFrame } from '../../../gallery/RoomFrame';
import styles from './replay.module.css';

export function ReplaySession({ data, viewerId }: { data: ReplayData; viewerId?: string }) {
  const [cursor, setCursor] = useState(data.messages.length);
  const snapshot = useMemo(() => replayAt(data, cursor), [cursor, data]);
  const view = useMemo(() => replayView(snapshot, viewerId), [snapshot, viewerId]);
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

  return (
    <main className={styles.replay}>
      <RoomFrame
        attention={view.attention}
        binding={{ mode: 'free' }}
        boxed={false}
        entries={withFilter(view.entries, filter)}
        filter={filter}
        focused={focused}
        handlers={{
          onFocusSurface: setFocused,
          onFilter: (next) => setFilter((current) => (current === next ? null : next)),
          onOpenAttention: setOpenAttentionId,
          onToggleObjective: (objectiveId) =>
            setOpenObjectives((current) => ({
              ...current,
              [objectiveId]: !(current[objectiveId] ?? true),
            })),
        }}
        humans={view.humans}
        label="replay"
        lastCheck={view.updatedAt}
        messages={view.records}
        objectives={objectives}
        objects={view.objects}
        openAttentionId={openAttentionId}
        room={view.room}
        rooms={view.rooms}
        trailer={view.trailer}
        updatedAt={view.updatedAt}
        viewer={view.viewer}
        viewerNote={`replay · ${view.attention.length} owed to you`}
      />
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
    </main>
  );
}
