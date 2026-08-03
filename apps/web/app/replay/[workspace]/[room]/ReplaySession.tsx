'use client';

import { useMemo, useState } from 'react';
import type { AttentionClass, ObjectiveRecord, SurfaceId } from '../../../../src/components';
import { needsViewer, withFilter } from '../../../../src/components';
import type { ReplayData } from '../../../../lib/replay-data';
import { replayView } from '../../../../lib/replay-view';
import { RoomFrame } from '../../../gallery/RoomFrame';

export function ReplaySession({ data, viewerId }: { data: ReplayData; viewerId?: string }) {
  const view = useMemo(() => replayView(data, viewerId), [data, viewerId]);
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
  );
}
