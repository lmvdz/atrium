'use client';

/* ---------------------------------------------------------------------------
 * Pin — BRIEF concept 3. What needs THIS person, above the feed.
 *
 * Three settled rules, all structural:
 *   - hardest first. The sort is derived from each item's glyph
 *     (`hardestFirst`), so failures outrank destructive decisions outrank
 *     reversible gates outrank open questions — no caller picks the order.
 *   - it FOLDS, it does not scroll, AND IT BOUNDS ITSELF. Round 1 measured the
 *     unbounded version at 1440×900: 13 owed items left 183px of feed, 17 left
 *     55px, and at 19 the composer's bottom edge sat at 909px in a 900px
 *     viewport while `scrollHeight` stayed 900 — the composer was unreachable
 *     by any means. The previous `folded` prop was a caller boolean this
 *     component never set, with no max-height and no overflow affordance; a
 *     bound that depends on the caller remembering is not a bound. The fold is
 *     now derived here by `foldPin` (model/records.ts) from the items
 *     themselves, and `.pinList` carries a max-height as a second line of
 *     defence against a budget that is one row too generous.
 *   - the empty state is a result, not an absence: "nothing needs you in this
 *     room" is an answer the reader wanted.
 *
 * BRIEF concept 3, verbatim: "everything clean compresses to counts; folding
 * hides noise but never signals." Owed items always take a row. Items that are
 * NOT owed to this person never do — they compress to a derived glyph count.
 * ------------------------------------------------------------------------- */

import { useState } from 'react';
import { needsViewer } from '../model/glyph';
import type { AttentionItem, GlyphCount, TrailerSummary } from '../model/records';
import { foldPin, hardestGlyph } from '../model/records';
import { plural } from '../model/text';
import { AttentionCard } from './AttentionCard';
import { AttentionCompact } from './AttentionCompact';
import styles from './attention.module.css';
import { Trailer } from './Trailer';

export interface PinProps {
  readonly items: readonly AttentionItem[];
  /** which item is open; the rest compress. Defaults to the hardest. */
  readonly openId?: string;
  readonly trailer: TrailerSummary;
  readonly lastCheck: string;
  /** the whole pin starts collapsed. It is a preference, not the bound. */
  readonly defaultFolded?: boolean;
  readonly onFold?: (folded: boolean) => void;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onArm?: (itemId: string, actionId: string, armedAt: string) => void;
  readonly onJumpToSource?: (itemId: string) => void;
}

/** "■2 · ◆3 · ?1" — every glyph derived from the items it counts. */
function GlyphTally({ counts }: { readonly counts: readonly GlyphCount[] }) {
  return (
    <>
      {counts.map((count, index) => (
        <span key={count.glyph}>
          {index === 0 ? null : <span aria-hidden="true"> · </span>}
          <span className={styles.tallyGlyph}>{count.glyph}</span>
          {count.n}
        </span>
      ))}
    </>
  );
}

export function Pin({
  items,
  openId,
  trailer,
  lastCheck,
  defaultFolded = false,
  onFold,
  onOpen,
  onAct,
  onArm,
  onJumpToSource,
}: PinProps) {
  const [folded, setFolded] = useState(defaultFolded);
  const [showAll, setShowAll] = useState(false);
  const fold = foldPin(items, { openId, showAll });
  /* The head glyph is the hardest glyph among the items the pin is holding —
     derived through the same `glyphFor` as every other glyph in the app. A
     hand-written ◆ over a pin holding a ✗ is a claim dressed as a fact, one
     level up from the row. */
  const headGlyph = hardestGlyph(items.filter((item) => needsViewer(item.state)));

  return (
    <section aria-label="Needs you" className={styles.pin} data-region="needs-you">
      <div className={styles.pinHead}>
        {/* the head glyph is the hardest thing in the pin, derived — a
            hand-written ◆ over a pin holding a ✗ is a claim dressed as a fact */}
        <span aria-hidden="true" className={styles.pinHeadGlyph} data-pin-glyph="true">
          {headGlyph ?? '·'}
        </span>
        <span className={`${styles.pinHeadLabel} atr-lbl`}>NEEDS YOU</span>
        <span className="atr-meta" data-pin-count="true">
          {fold.owedTotal === 0
            ? 'nothing owed'
            : `${plural(fold.owedTotal, 'item')} · hardest first`}
        </span>
        <span className={styles.pinRule} />
        <button
          aria-pressed={folded}
          className={`${styles.fold} atr-lbl`}
          onClick={() => {
            const next = !folded;
            setFolded(next);
            onFold?.(next);
          }}
          type="button"
        >
          {folded ? 'UNFOLD' : 'FOLD'}
        </button>
      </div>

      {folded ? null : (
        <>
          <div className={styles.pinList} data-pin-list="true">
            {fold.open === null ? (
              <p className={`${styles.empty} atr-lbl`}>
                NOTHING NEEDS YOU IN THIS ROOM — THAT IS A RESULT, NOT AN ABSENCE
              </p>
            ) : (
              <AttentionCard
                item={fold.open}
                onAct={onAct}
                onArm={onArm}
                onJumpToSource={onJumpToSource}
              />
            )}
            {fold.compact.map((item) => (
              <AttentionCompact
                item={item}
                key={item.id}
                onAct={onAct}
                onArm={onArm}
                onOpen={onOpen}
              />
            ))}

            {/* THE OVERFLOW AFFORDANCE. Explicit, counted, and named by glyph:
                folding hides noise, never signal, so what is behind the fold
                says how hard it is before you open it. */}
            {fold.overflow.length === 0 ? null : (
              <button
                className={styles.more}
                data-pin-overflow={String(fold.overflow.length)}
                onClick={() => setShowAll(true)}
                type="button"
              >
                <span className={styles.moreCount}>{fold.overflow.length} more owed</span>
                <span className={styles.moreTally}>
                  <GlyphTally counts={fold.overflowCounts} />
                </span>
                <span className={styles.moreHint}>
                  still owed, still hardest-first — the pin folds rather than pushing the composer
                  off the screen
                </span>
              </button>
            )}

            {/* Everything clean compresses to a count and never takes a row. */}
            {fold.clean.length === 0 ? null : (
              <div className={styles.clean} data-pin-clean={String(fold.clean.length)}>
                {plural(fold.clean.length, 'item')} here no longer needs you ·{' '}
                <GlyphTally counts={fold.cleanCounts} />
              </div>
            )}
          </div>
          <Trailer lastCheck={lastCheck} summary={trailer} />
        </>
      )}
    </section>
  );
}
