'use client';

/* The feed. Dispatches on the entry union; holds nothing. */

import type { AttentionClass, TimelineEntry } from '../model/records';
import { RoutineCollapse } from './RoutineCollapse';
import { SinceYouLeftDivider } from './SinceYouLeftDivider';
import { SystemRow } from './SystemRow';
import { TimelineRow } from './TimelineRow';
import styles from './timeline.module.css';

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  /** a filter DIMS non-matching rows; it never removes them */
  readonly filtered: boolean;
  readonly label?: string;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onTogglePeek?: (entryId: string) => void;
}

const ROW_ACTIONS = [
  { id: 'reply', label: 'reply' },
  { id: 'quote', label: 'quote' },
  { id: 'link', label: 'link' },
] as const;

export function Timeline({
  entries,
  filtered,
  label = 'Conversation',
  onFilter,
  onTogglePeek,
}: TimelineProps) {
  return (
    <section
      aria-label={label}
      className={[styles.feed, 'atr-scroll', filtered ? styles.feedFiltered : null]
        .filter(Boolean)
        .join(' ')}
      data-region="conversation"
    >
      {entries.map((entry) => {
        if (entry.type === 'message') {
          return <TimelineRow actions={ROW_ACTIONS} entry={entry} key={entry.id} />;
        }
        if (entry.type === 'system') {
          return <SystemRow entry={entry} key={entry.id} />;
        }
        if (entry.type === 'since-you-left') {
          return <SinceYouLeftDivider entry={entry} key={entry.id} onFilter={onFilter} />;
        }
        return (
          <RoutineCollapse
            entry={entry}
            key={entry.id}
            onTogglePeek={onTogglePeek === undefined ? undefined : () => onTogglePeek(entry.id)}
          />
        );
      })}
    </section>
  );
}
