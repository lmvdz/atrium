'use client';

/* ---------------------------------------------------------------------------
 * Pin — BRIEF concept 3. What needs THIS person, above the feed.
 *
 * Three settled rules, all structural:
 *   - hardest first. The sort is derived from each item's glyph
 *     (`hardestFirst`), so failures outrank destructive decisions outrank
 *     reversible gates outrank open questions — no caller picks the order.
 *   - it FOLDS, it does not scroll. One item is open; the rest compress to
 *     rows that are still visible, still glyphed and still one click to act.
 *   - the empty state is a result, not an absence: "nothing needs you in this
 *     room" is an answer the reader wanted.
 * ------------------------------------------------------------------------- */

import type { AttentionItem, TrailerSummary } from '../model/records';
import { hardestFirst } from '../model/records';
import { plural } from '../model/text';
import { AttentionCard } from './AttentionCard';
import { AttentionCompact } from './AttentionCompact';
import styles from './attention.module.css';
import { Trailer } from './Trailer';

export interface PinProps {
  readonly items: readonly AttentionItem[];
  /** which item is open; the rest compress. Defaults to the hardest. */
  readonly openId?: string;
  readonly folded: boolean;
  readonly trailer: TrailerSummary;
  readonly lastCheck: string;
  readonly onFold?: () => void;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onJumpToSource?: (itemId: string) => void;
}

export function Pin({
  items,
  openId,
  folded,
  trailer,
  lastCheck,
  onFold,
  onOpen,
  onAct,
  onJumpToSource,
}: PinProps) {
  const sorted = hardestFirst(items);
  const open = sorted.find((item) => item.id === openId) ?? sorted[0];

  return (
    <section aria-label="Needs you" className={styles.pin} data-region="needs-you">
      <div className={styles.pinHead}>
        <span aria-hidden="true" className={styles.pinHeadGlyph}>
          ◆
        </span>
        <span className={`${styles.pinHeadLabel} atr-lbl`}>NEEDS YOU</span>
        <span className="atr-meta">
          {sorted.length === 0
            ? 'nothing owed'
            : `${plural(sorted.length, 'item')} · hardest first`}
        </span>
        <span className={styles.pinRule} />
        <button
          aria-pressed={folded}
          className={`${styles.fold} atr-lbl`}
          onClick={onFold}
          type="button"
        >
          {folded ? 'UNFOLD' : 'FOLD'}
        </button>
      </div>

      {folded ? null : (
        <>
          <div className={styles.pinList}>
            {sorted.length === 0 ? (
              <p className={`${styles.empty} atr-lbl`}>
                NOTHING NEEDS YOU IN THIS ROOM — THAT IS A RESULT, NOT AN ABSENCE
              </p>
            ) : null}
            {sorted.map((item) =>
              item.id === open?.id ? (
                <AttentionCard
                  item={item}
                  key={item.id}
                  onAct={onAct}
                  onJumpToSource={onJumpToSource}
                />
              ) : (
                <AttentionCompact item={item} key={item.id} onAct={onAct} onOpen={onOpen} />
              ),
            )}
          </div>
          <Trailer lastCheck={lastCheck} summary={trailer} />
        </>
      )}
    </section>
  );
}
