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
  /**
   * The scroll position this component last PLACED, so a scroll event can be
   * told from a scroll gesture. See `handleScroll` for the measurement.
   */
  const placedRef = useRef(0);
  /** the feed's shape as of the last scroll event, so a reshape is detectable */
  const geometryRef = useRef({ scrollHeight: 0, clientHeight: 0 });
  const scrollFrameRef = useRef<number | null>(null);
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
      /* Read back rather than remember what we asked for: the assignment is
         clamped to `scrollHeight - clientHeight`, so the position we PLACED is
         the clamped one and comparing against the request would never match. */
      placedRef.current = feed.scrollTop;
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
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = requestAnimationFrame(() =>
        scrollMessageIntoView(feed, firstAppendedId, scrollFrameRef, placedRef),
      );
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
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  /* A SCROLL EVENT IS NOT A SCROLL GESTURE, AND THE GEOMETRY IT ARRIVES WITH IS
     NOT THE GEOMETRY IT HAPPENED IN.

     Measured at 1280×500 on `/`, with every write to this element recorded:

       t=669  the first-render branch above pins the feed to the bottom —
              writes 480, clamped to 424, with clientHeight 56
       t=758  the resulting scroll event is DELIVERED — and by now the composer
              has grown to hold a 19-line draft, so clientHeight is 22

     A scroll event is dispatched at the next rendering opportunity, not at the
     moment the position changed. This handler read `clientHeight` at delivery
     and computed 480 − 424 − 22 = 34 > 12: "the reader scrolled away". The
     reader had not touched anything. The position was one this component set,
     and the 34px came entirely from the composer growing underneath it.

     Follow then stayed off, the viewer's own sent message was filed as unread,
     and the pane never moved — the defect the user had been reporting by eye,
     and the 70px `conversation-follow.spec.ts` measures: 494 (where the row
     ended up once the unread divider was inserted above it) − 424 (where the
     first-render pin left the pane). It reproduces whenever typing begins
     within ~100ms of hydration, which is why a spec that types immediately sees
     it every run and a human who pauses first usually does not.

     `scrollTop` is the one quantity the reader actually controls. If it has not
     moved from the position this component placed, no gesture happened and
     following is not the reader's to lose. The test derives its expectation
     from the same write this compares against, so there is no list of layout
     causes to keep up to date. */
  function handleScroll(): void {
    const feed = feedRef.current;
    if (feed === null) return;
    if (automaticScrollRef.current) return;
    const position = feed.scrollTop;
    const scrollHeight = feed.scrollHeight;
    const clientHeight = feed.clientHeight;
    /* DID THE BOX CHANGE SHAPE SINCE WE LAST LOOKED?
       If it did, the position moving is the layout moving, not the reader. This
       is the whole defect, and it is why comparing positions alone was not
       enough: Firefox delivers the scroll event BEFORE the ResizeObserver
       callback — measured t=860 vs t=861 — so by the time anything could
       re-pin the feed, this handler had already called it a gesture. The
       geometry is the evidence that arrives WITH the event. */
    const reshaped =
      scrollHeight !== geometryRef.current.scrollHeight ||
      clientHeight !== geometryRef.current.clientHeight;
    geometryRef.current = { scrollHeight, clientHeight };
    const moved = position !== placedRef.current;
    placedRef.current = position;
    /* A reshape can put us back on the live edge but never take us off it: the
       reader has not asked for anything.

       A ResizeObserver re-pinning the feed to the bottom on every reshape was
       tried here and removed: it also fights a route that legitimately places
       the feed somewhere else. The persisted replay opens AT its since-you-left
       boundary, and the re-pin dragged it to the live edge — `replay.spec.ts`
       caught it immediately with viewport ratio 0 on the divider. Refusing to
       draw a conclusion is enough on both engines; restoring the edge as well
       was doing something no one asked for. */
    if (reshaped && followingRef.current) return;
    if (!moved && !reshaped) return;
    const atBottom = scrollHeight - position - clientHeight <= 12;
    followingRef.current = atBottom;
    if (atBottom) setUnread(null);
  }

  function scrollToOldestUnread(): void {
    const feed = feedRef.current;
    if (feed === null || unread === null) return;
    scrollMessageIntoView(feed, unread.oldestId, scrollFrameRef, placedRef);
    setUnread(null);
  }

  function stopAutomaticFollowing(): void {
    automaticScrollRef.current = false;
    followingRef.current = false;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
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

function scrollMessageIntoView(
  feed: HTMLElement,
  messageId: string,
  frameRef: { current: number | null },
  /* Every position this animation places, recorded as this component's own —
     so the scroll events it generates are never mistaken for the reader
     scrolling away. `automaticScrollRef` already covers this window with a
     400ms timer; a timer is a guess about how long the animation takes, and
     this is the fact. */
  placedRef: { current: number },
): void {
  if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  const startedAt = performance.now();
  const startedFrom = feed.scrollTop;
  const durationMs = 160;

  const move = () => {
    const row = Array.from(feed.children).find(
      (child) => child.getAttribute('data-message-id') === messageId,
    );
    if (!(row instanceof HTMLElement)) {
      frameRef.current = null;
      return;
    }
    const furthestDown = Math.max(0, feed.scrollHeight - feed.clientHeight);
    const firstUnreadAtTop = Math.max(0, row.offsetTop);
    const target = Math.min(furthestDown, firstUnreadAtTop);
    const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
    const eased = 1 - (1 - progress) ** 3;
    feed.scrollTop = startedFrom + (target - startedFrom) * eased;
    placedRef.current = feed.scrollTop;
    if (progress < 1) {
      frameRef.current = requestAnimationFrame(move);
    } else {
      feed.scrollTop = target;
      placedRef.current = feed.scrollTop;
      frameRef.current = null;
    }
  };

  frameRef.current = requestAnimationFrame(move);
}
