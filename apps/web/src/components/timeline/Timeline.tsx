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

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Compact metadata columns for the docked WIRE conversation pane. */
  readonly compact?: boolean;
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
  readonly onDownloadAttachment?: (messageId: string, attachment: MessageAttachmentRecord) => void;
  readonly attachmentPreviewUrl?: (
    messageId: string,
    attachment: MessageAttachmentRecord,
  ) => string | undefined;
  readonly loadAttachmentPreviewUrl?: (
    messageId: string,
    attachment: MessageAttachmentRecord,
  ) => Promise<string>;
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
  compact = false,
  filter,
  label = 'Conversation',
  onFilter,
  onTogglePeek,
  onRowAction,
  onOpenTag,
  onOpenAttachment,
  onDownloadAttachment,
  attachmentPreviewUrl,
  loadAttachmentPreviewUrl,
  onMarkSeen,
  onUnmarkSeen,
  rowActions = ROW_ACTIONS,
}: TimelineProps) {
  const feedRef = useRef<HTMLElement>(null);
  const previousMessageIdsRef = useRef<readonly string[] | null>(null);
  const followingRef = useRef(true);
  const automaticScrollRef = useRef(false);
  const automaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unread, setUnread] = useState<{
    readonly oldestId: string;
    readonly count: number;
  } | null>(null);
  const messageIds = useMemo(
    () => entries.filter((entry) => entry.type === 'message').map((entry) => entry.id),
    [entries],
  );

  useEffect(() => {
    const feed = feedRef.current;
    const previousMessageIds = previousMessageIdsRef.current;
    previousMessageIdsRef.current = messageIds;
    if (feed === null) return;

    if (previousMessageIds === null) {
      feed.scrollTop = feed.scrollHeight;
      return;
    }

    const previousIds = new Set(previousMessageIds);
    const lastRetainedIndex = messageIds.reduce(
      (last, id, index) => (previousIds.has(id) ? index : last),
      -1,
    );
    const appendedIds = messageIds.filter(
      (id, index) => index > lastRetainedIndex && !previousIds.has(id),
    );
    const firstAppendedId = appendedIds[0];
    if (firstAppendedId === undefined) return;

    if (followingRef.current) {
      automaticScrollRef.current = true;
      requestAnimationFrame(() => scrollMessageIntoView(feed, firstAppendedId));
      if (automaticScrollTimerRef.current !== null) clearTimeout(automaticScrollTimerRef.current);
      automaticScrollTimerRef.current = setTimeout(() => {
        automaticScrollRef.current = false;
      }, 400);
    } else {
      setUnread((current) => ({
        oldestId: current?.oldestId ?? firstAppendedId,
        count: (current?.count ?? 0) + appendedIds.length,
      }));
    }
  }, [messageIds]);

  useEffect(
    () => () => {
      if (automaticScrollTimerRef.current !== null) clearTimeout(automaticScrollTimerRef.current);
    },
    [],
  );

  function handleScroll(): void {
    const feed = feedRef.current;
    if (feed === null) return;
    if (automaticScrollRef.current) return;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 12;
    followingRef.current = atBottom;
    if (atBottom) setUnread(null);
  }

  function scrollToOldestUnread(): void {
    const feed = feedRef.current;
    if (feed === null || unread === null) return;
    scrollMessageIntoView(feed, unread.oldestId);
    setUnread(null);
  }

  function stopAutomaticFollowing(): void {
    automaticScrollRef.current = false;
    followingRef.current = false;
  }

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
      className={[
        styles.feed,
        'atr-scroll',
        compact ? styles.feedCompact : null,
        filter === null ? null : styles.feedFiltered,
      ]
        .filter(Boolean)
        .join(' ')}
      data-compact={compact ? 'true' : undefined}
      data-region="conversation"
      onScroll={handleScroll}
      onTouchStart={stopAutomaticFollowing}
      onWheel={stopAutomaticFollowing}
      ref={feedRef}
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
            <Fragment key={entry.id}>
              {unread?.oldestId === entry.id ? (
                <div className={styles.unreadDivider} data-unread-divider={unread.count}>
                  {plural(unread.count, 'new message')}
                </div>
              ) : null}
              <TimelineRow
                actions={actions}
                attachmentPreviewUrl={attachmentPreviewUrl}
                loadAttachmentPreviewUrl={loadAttachmentPreviewUrl}
                entry={entry}
                onOpenAttachment={onOpenAttachment}
                onDownloadAttachment={onDownloadAttachment}
                onOpenTag={onOpenTag}
              />
            </Fragment>
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
      {unread === null ? null : (
        <button className={styles.newMessages} onClick={scrollToOldestUnread} type="button">
          ↓ {plural(unread.count, 'new message')}
        </button>
      )}
    </section>
  );
}

function scrollMessageIntoView(feed: HTMLElement, messageId: string): void {
  const row = Array.from(feed.children).find(
    (child) => child.getAttribute('data-message-id') === messageId,
  );
  if (!(row instanceof HTMLElement)) return;
  const furthestDown = Math.max(0, feed.scrollHeight - feed.clientHeight);
  const firstUnreadAtTop = Math.max(0, row.offsetTop);
  const target = Math.min(furthestDown, firstUnreadAtTop);
  if (typeof feed.scrollTo === 'function') {
    feed.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    feed.scrollTop = target;
  }
}
