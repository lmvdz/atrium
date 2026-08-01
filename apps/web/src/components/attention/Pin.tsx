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
 *   - THE WAY PAST THE FOLD IS AS REAL AS THE FOLD. Round 2 bounded the pin and
 *     then shipped an idempotent affordance out of it: "50 more owed" raised
 *     the budget once, from 4 rows to 9, and every click after that did
 *     nothing. Fifty owed items sat behind a button that looked live and was
 *     not — the same shape as round 1's `data-hold`, where the label promised
 *     a safety the code never implemented. The control now PAGES: it advances a
 *     window through the owed items, its label is rendered from the page it
 *     will actually show, and the last page wraps back to the hardest instead
 *     of becoming inert. Every owed item is reachable, by pointer and by
 *     keyboard, in a bounded number of clicks.
 *
 * BRIEF concept 3, verbatim: "everything clean compresses to counts; folding
 * hides noise but never signals." Owed items always take a row. Items that are
 * NOT owed to this person never do — they compress to a derived glyph count.
 * ------------------------------------------------------------------------- */

import { useState } from 'react';
import { needsViewer } from '../model/glyph';
import type { AttentionItem, GlyphCount, PinFold, TrailerSummary } from '../model/records';
import { foldPin, hardestGlyph } from '../model/records';
import { plural } from '../model/text';
import type { Arming } from '../primitives/HoldToAct';
import { AttentionCard } from './AttentionCard';
import { AttentionCompact } from './AttentionCompact';
import styles from './attention.module.css';
import { Trailer } from './Trailer';

export interface PinProps {
  readonly items: readonly AttentionItem[];
  /** which item is open; the rest compress. Defaults to the hardest. */
  readonly openId?: string;
  /** the person this pin is for — an arming records whose press it was */
  readonly viewer: string;
  readonly trailer: TrailerSummary;
  readonly lastCheck: string;
  /** the whole pin starts collapsed. It is a preference, not the bound. */
  readonly defaultFolded?: boolean;
  readonly onFold?: (folded: boolean) => void;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  /** the whole arming record — actor, wall clock, and the measured hold */
  readonly onArm?: (itemId: string, arming: Arming) => void;
  readonly onJumpToSource?: (itemId: string) => void;
  /** the overflow control paged; `page` is 0-based and already normalised */
  readonly onPage?: (page: number, pageCount: number) => void;
}

/**
 * What one more click on the overflow control will do, in words, derived from
 * the page it will show. Round 2's version said "50 more owed" and revealed
 * five of them, once — the number in the label has to be the number the click
 * delivers, or the control is a promise the code does not keep.
 */
export function nextPageLabel(fold: PinFold): string {
  const n = fold.nextPage.length;
  return fold.wraps ? `back to the hardest ${n}` : `show the next ${n}`;
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
  viewer,
  trailer,
  lastCheck,
  defaultFolded = false,
  onFold,
  onOpen,
  onAct,
  onArm,
  onJumpToSource,
  onPage,
}: PinProps) {
  const [folded, setFolded] = useState(defaultFolded);
  /* A page counter, not a `showAll` flag. A boolean can only be set once, which
     is exactly how round 2's affordance became inert after one click. */
  const [page, setPage] = useState(0);
  const fold = foldPin(items, { openId, page });
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
                viewer={viewer}
              />
            )}
            {fold.compact.map((item) => (
              <AttentionCompact
                item={item}
                key={item.id}
                onAct={onAct}
                onArm={onArm}
                onOpen={onOpen}
                viewer={viewer}
              />
            ))}

            {/* THE OVERFLOW AFFORDANCE. Explicit, counted, named by glyph —
                and it PAGES. The count says how much is off the page; the
                action says exactly what the next click brings, derived from
                the page it will render. Round 2 shipped these as the same
                number, which made the second sentence a lie the moment the
                first exceeded the budget. */}
            {fold.overflow.length === 0 ? null : (
              <button
                aria-label={`${nextPageLabel(fold)} of ${fold.overflow.length} owed items not on this page — page ${fold.page + 1} of ${fold.pageCount}`}
                className={styles.more}
                data-pin-next={String(fold.nextPage.length)}
                data-pin-overflow={String(fold.overflow.length)}
                data-pin-page={`${fold.page + 1}/${fold.pageCount}`}
                onClick={() => {
                  setPage((current) => current + 1);
                  onPage?.((fold.page + 1) % fold.pageCount, fold.pageCount);
                }}
                type="button"
              >
                <span className={styles.moreCount}>{fold.overflow.length} more owed</span>
                <span className={styles.moreTally}>
                  <GlyphTally counts={fold.overflowCounts} />
                </span>
                {/* What the click does never truncates. The tail explaining
                    why the pin pages rather than grows is what gives way at a
                    narrow width — losing "show the next 4" to an ellipsis
                    would put us back to a control that does not say what it
                    does. */}
                <span className={styles.moreNext} data-pin-action="true">
                  {nextPageLabel(fold)} · page {fold.page + 1} of {fold.pageCount}
                </span>
                <span className={styles.moreHint}>
                  the pin folds rather than pushing the composer off the screen
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
