'use client';

/* ---------------------------------------------------------------------------
 * SinceYouLeftDivider — BRIEF concept 1, the reorientation thesis rendered as a
 * component.
 *
 * Three things the corpus settled and this component keeps:
 *   - the counts are counted, never asserted. They arrive as a record of
 *     per-class totals and the chips render exactly those numbers.
 *   - a chip that counts nothing filters nothing: it is disabled, not a
 *     clickable no-op.
 *   - marking a group seen MUTES the divider. It does not delete it. The
 *     window, the counts and the chips stay where they were, and unmark sits on
 *     the same line that reports the mark. No fake mark-all-read lie.
 * ------------------------------------------------------------------------- */

import { systemText } from '../model/quotation';
import type { AttentionClass, SinceYouLeftEntry } from '../model/records';
import { plural, text } from '../model/text';
import styles from './timeline.module.css';

export interface SinceYouLeftDividerProps {
  readonly entry: SinceYouLeftEntry;
  readonly onFilter?: (attentionClass: AttentionClass) => void;
  readonly onMarkSeen?: () => void;
  readonly onUnmarkSeen?: () => void;
}

const CLASS_ORDER: readonly AttentionClass[] = ['need', 'change', 'discussion', 'routine'];

const CLASS_LABEL: Readonly<Record<AttentionClass, string>> = {
  need: 'NEED YOU',
  change: 'CHANGES',
  discussion: 'DISCUSSION',
  routine: 'ROUTINE',
};

const CLASS_MEANING: Readonly<Record<AttentionClass, string>> = {
  need: 'linked to something that needs you — the pin counts the items, this counts the rows',
  change: 'meaningful changes to what the group understands',
  discussion: 'people talking, nothing settled',
  routine: 'no state change, no claim, no cost spike',
};

export function SinceYouLeftDivider({
  entry,
  onFilter,
  onMarkSeen,
  onUnmarkSeen,
}: SinceYouLeftDividerProps) {
  const window =
    text(entry.window) === null
      ? null
      : systemText(entry.window ?? '', 'SinceYouLeftDivider window');
  const seenAt =
    text(entry.seenAt) === null
      ? null
      : systemText(entry.seenAt ?? '', 'SinceYouLeftDivider seenAt');
  const label = systemText(entry.label, 'SinceYouLeftDivider label');
  return (
    <div
      className={[styles.syl, entry.seen ? styles.sylSeen : null].filter(Boolean).join(' ')}
      data-row="since-you-left"
      data-seen={entry.seen ? 'true' : 'false'}
    >
      <div className={styles.sylBar}>
        <span className={`${styles.sylLabel} atr-lbl`}>{label}</span>
        <div className={styles.sylCounts}>
          {CLASS_ORDER.map((attentionClass) => {
            const n = entry.counts[attentionClass];
            const active = entry.activeFilter === attentionClass;
            return (
              <button
                aria-pressed={active}
                className={[styles.cnt, attentionClass === 'need' && n > 0 ? styles.cntNeed : null]
                  .filter(Boolean)
                  .join(' ')}
                data-count-class={attentionClass}
                disabled={n === 0}
                key={attentionClass}
                onClick={
                  onFilter === undefined || n === 0 ? undefined : () => onFilter(attentionClass)
                }
                title={
                  n === 0
                    ? `no ${CLASS_LABEL[attentionClass].toLowerCase()} messages in this group — nothing to filter to`
                    : `${plural(n, 'message')} in this group are ${CLASS_MEANING[attentionClass]}`
                }
                type="button"
              >
                {n} {CLASS_LABEL[attentionClass]}
              </button>
            );
          })}
        </div>
        <span className={styles.sylRule} />
      </div>

      <div className={styles.sylWhen}>
        {window === null ? null : <span>{window}</span>}
        <span aria-hidden="true">·</span>
        <span>{plural(entry.total, 'message')}</span>
        {entry.ownRows > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.sylOwn}>
              {entry.ownRows} row{entry.ownRows === 1 ? ' here is yours' : 's here are yours'} —
              your own activity is never counted back to you as unseen
            </span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        {entry.seen ? (
          <>
            <span>
              marked seen{seenAt === null ? '' : ` ${seenAt}`} · the group stays here, muted
            </span>
            <span aria-hidden="true">·</span>
            <button className={styles.sylMark} onClick={onUnmarkSeen} type="button">
              unmark
            </button>
          </>
        ) : (
          <button className={styles.sylMark} onClick={onMarkSeen} type="button">
            mark this group seen
          </button>
        )}
      </div>
    </div>
  );
}
