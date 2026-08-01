'use client';

/* ---------------------------------------------------------------------------
 * The feed. Dispatches on the entry union; holds nothing.
 *
 * Round 1: this component exposed `onFilter` and `onTogglePeek` and nothing
 * else. `ROW_ACTIONS` was a module constant whose entries had no `onSelect`, so
 * 24 row buttons were decorative; `onOpenTag`, `onMarkSeen` and `onUnmarkSeen`
 * existed on the child components and were never forwarded. That is the literal
 * "forces #25 to fork a component" case — a consumer wanting a working reply
 * button had no prop to pass and would have had to copy this file.
 *
 * Every handler a child accepts is now reachable from here.
 * ------------------------------------------------------------------------- */

import type { AttentionClass, TimelineEntry } from '../model/records';
import { RoutineCollapse } from './RoutineCollapse';
import { SinceYouLeftDivider } from './SinceYouLeftDivider';
import { SystemRow } from './SystemRow';
import type { RowAction } from './TimelineRow';
import { TimelineRow } from './TimelineRow';
import styles from './timeline.module.css';

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  /** a filter LIFTS matching rows; it never removes or fades the rest */
  readonly filtered: boolean;
  readonly label?: string;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onTogglePeek?: (entryId: string) => void;
  /** one handler for every row action; the row and the action both arrive */
  readonly onRowAction?: (entryId: string, actionId: string) => void;
  readonly onOpenTag?: (entryId: string) => void;
  readonly onMarkSeen?: (entryId: string) => void;
  readonly onUnmarkSeen?: (entryId: string) => void;
  /** replace the default reply/quote/link set without forking this component */
  readonly rowActions?: readonly Omit<RowAction, 'onSelect'>[];
}

const ROW_ACTIONS: readonly Omit<RowAction, 'onSelect'>[] = [
  { id: 'reply', label: 'reply' },
  { id: 'quote', label: 'quote' },
  { id: 'link', label: 'link' },
];

export function Timeline({
  entries,
  filtered,
  label = 'Conversation',
  onFilter,
  onTogglePeek,
  onRowAction,
  onOpenTag,
  onMarkSeen,
  onUnmarkSeen,
  rowActions = ROW_ACTIONS,
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
          const actions = rowActions.map((action) => ({
            ...action,
            onSelect:
              onRowAction === undefined ? undefined : () => onRowAction(entry.id, action.id),
          }));
          return (
            <TimelineRow actions={actions} entry={entry} key={entry.id} onOpenTag={onOpenTag} />
          );
        }
        if (entry.type === 'system') {
          return <SystemRow entry={entry} key={entry.id} />;
        }
        if (entry.type === 'since-you-left') {
          return (
            <SinceYouLeftDivider
              entry={entry}
              key={entry.id}
              onFilter={onFilter}
              onMarkSeen={onMarkSeen === undefined ? undefined : () => onMarkSeen(entry.id)}
              onUnmarkSeen={onUnmarkSeen === undefined ? undefined : () => onUnmarkSeen(entry.id)}
            />
          );
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
