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

import type { MessageAttachmentRecord } from '../model/quotation';
import { systemText } from '../model/quotation';
import type { AttentionClass, TimelineEntry } from '../model/records';
import { classCounts } from '../model/records';
import type { Maybe } from '../model/text';
import { plural } from '../model/text';
import { RoutineCollapse } from './RoutineCollapse';
import { SinceYouLeftDivider } from './SinceYouLeftDivider';
import { SystemRow } from './SystemRow';
import type { RowAction } from './TimelineRow';
import { TimelineRow } from './TimelineRow';
import styles from './timeline.module.css';

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  /**
   * WHICH CLASS IS LIFTED, not merely THAT something is — round 10, D3.
   *
   * It was `filtered: boolean` beside entries whose `matchesFilter` a caller had
   * already decided, which is two registers for one fact: `/gallery`'s filtered
   * frame passed `filter: 'need'` to the entry builder and `filtered: true` here,
   * and nothing obliged them to name the same class. A filter LIFTS matching
   * rows; it never removes or fades the rest.
   */
  readonly filter: Maybe<AttentionClass>;
  readonly label?: string;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onTogglePeek?: (entryId: string) => void;
  /** one handler for every row action; the row and the action both arrive */
  readonly onRowAction?: (entryId: string, actionId: string) => void;
  readonly onOpenTag?: (entryId: string) => void;
  readonly onOpenAttachment?: (messageId: string, attachment: MessageAttachmentRecord) => void;
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
  filter,
  label = 'Conversation',
  onFilter,
  onTogglePeek,
  onRowAction,
  onOpenTag,
  onOpenAttachment,
  onMarkSeen,
  onUnmarkSeen,
  rowActions = ROW_ACTIONS,
}: TimelineProps) {
  /* THE LIFT IS SAID IN WORDS, NOT ONLY IN A BACKGROUND — round 10, D3.
     What a filter did was carried by `--bg3` and a 2px inset stripe: nothing in
     `textContent`, `aria-label` or `title` reported it, so the one surface whose
     job is "here is what you asked for" was structurally invisible to every
     instrument in this repo and to a screen reader. The number is
     `classCounts` — the same derivation the chip's own number comes from, so the
     chip cannot promise 8 and the feed report 3. */
  const scopedEntries = entries.filter(
    (entry) => entry.type === 'since-you-left' || entry.filterScoped !== false,
  );
  const counts = classCounts(scopedEntries);
  const lifted = filter === null ? 0 : counts[filter];
  const total = counts.need + counts.change + counts.discussion + counts.routine;
  return (
    <section
      aria-label={systemText(label, 'Timeline label')}
      className={[styles.feed, 'atr-scroll', filter === null ? null : styles.feedFiltered]
        .filter(Boolean)
        .join(' ')}
      data-region="conversation"
    >
      {filter === null ? null : (
        <p
          className={`${styles.filterNote} atr-meta`}
          data-filter-note={filter}
          data-voice="system"
        >
          filtered to {filter} — {plural(lifted, 'row')} lifted of {total}; the rest are still here,
          at full contrast, without their row actions
        </p>
      )}
      {entries.map((entry) => {
        if (entry.type === 'message') {
          const actions = rowActions.map((action) => ({
            ...action,
            onSelect:
              onRowAction === undefined
                ? undefined
                : /* The row hands back the message it RESOLVED, not the id it was
                     handed — see RowAction.onSelect. */
                  (messageId: string) => onRowAction(messageId, action.id),
          }));
          return (
            <TimelineRow
              actions={actions}
              entry={entry}
              key={entry.id}
              onOpenAttachment={onOpenAttachment}
              onOpenTag={onOpenTag}
            />
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
