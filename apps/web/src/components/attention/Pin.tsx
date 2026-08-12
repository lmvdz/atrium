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

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { needsViewer } from '../model/glyph';
import type { AttentionItem, GlyphCount, PinFold, TrailerSummary } from '../model/records';
import {
  beltCss,
  foldPin,
  PIN_COMPACT_BUDGET,
  pinBeltFor,
  pinBudgetForBelt,
} from '../model/records';
import { plural } from '../model/text';
import { AggregateGlyph } from '../primitives/Glyph';
import type { Arming } from '../primitives/HoldToAct';
import { AttentionCard } from './AttentionCard';
import { AttentionCompact } from './AttentionCompact';
import styles from './attention.module.css';
import { Trailer } from './Trailer';

/* The measurement has to land BEFORE the browser paints the hydrated frame, or
   the pin paints once at the server's viewport-only belt (`min(340px, 34vh)` =
   306px at 900) and then jumps to the measured, container-limited px — a visible
   hop on load. A layout effect runs synchronously after the DOM is committed and
   before paint, so the corrected height is the first thing shown; a plain effect
   runs after paint, which is where the hop lived. `useLayoutEffect` warns when it
   runs on the server (it does nothing there), so it degrades to `useEffect` where
   there is no `window` — the server render stays the bounded vh expression it
   already was. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  /** the item, and the message the register resolved for its source */
  readonly onJumpToSource?: (itemId: string, messageId: string) => void;
  /** the overflow control paged; `page` is 0-based and already normalised */
  readonly onPage?: (page: number, pageCount: number) => void;
  /** the trailer's lead — show what is wrong OUTSIDE the pin */
  readonly onShowRest?: () => void;
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
  onShowRest,
}: PinProps) {
  const [folded, setFolded] = useState(defaultFolded);
  /* A page counter, not a `showAll` flag. A boolean can only be set once, which
     is exactly how round 2's affordance became inert after one click. */
  const [page, setPage] = useState(0);
  /* HOW MANY ROWS THERE IS ROOM FOR, MEASURED — not a prop, not a constant.
     `.pinList`'s belt is `beltCss()`, so at a short viewport the box shrinks;
     without this the pin would hold more than it can show, which is exactly the
     hidden-scroll-container state round 2 shipped. The ladder is `pinBudgetFor`
     (model/records.ts) and it divides the same two fields `beltCss` renders, so
     "the agreement between the ladder and the stylesheet" is no longer an
     agreement between two numbers — it is one number reaching two places. The
     e2e still drives it at five heights.

     This comment used to say the belt was `min(340px, 34vh)` while the
     stylesheet said `min(260px, 30vh)`. Both were quoted as fact for four
     rounds. Neither is quoted now: there is one place to read it.

     The server renders the full budget and the effect corrects it, because
     there is no viewport on the server and guessing one would be a number
     nothing measured. The correction is not a one-off either: `measure` runs
     after every commit and on every box the pin is made of, because a budget
     measured once is a cache of a layout that has since changed. */
  const [budget, setBudget] = useState(PIN_COMPACT_BUDGET);
  const [measured, setMeasured] = useState(false);
  /* AND THE BOX IT IS ACTUALLY IN, which is not the viewport.
     The belt is a share of `vh`, but the pin is laid out inside the workspace
     split's Current-state pane — a share of the FRAME, which is the viewport
     less the room head. While that pane took a flat 60% the two never crossed:
     at 420px the pane was 185.1px and the belt 126px, so the belt bound first
     and the mismatch was invisible. Once the pane yields to the conversation's
     floor it is 138.5px, and a card that grows past its clamp takes the pin to
     185.5px — past the pane's bottom edge, where `.splitState`'s
     `overflow: hidden` clips it. The "N more owed" control was made a SIBLING
     of the clipped list precisely so a grown card could not eat it, and it was
     eaten anyway, one container further out: measured at 420, the control sat
     at y=266 in a pane ending at y=241, and `elementFromPoint` returned the
     conversation surface stacked above it.
     So the pin yields to whichever is smaller, and the budget is derived from
     the SAME number the box is capped at rather than from a parallel one. */
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [belt, setBelt] = useState<number | null>(null);
  /* WHAT THE LAST MEASUREMENT SAW, so a measurement that has learned nothing
     new can stop rather than commit. See the convergence note on `measure`. */
  const settledRef = useRef<{ key: string; belt: number; budget: number } | null>(null);
  /* Everything about the pin's content that the BUDGET does not decide — the
     items, which one is open, which page, whether the pin is folded. A change
     here is news from outside, and it ends the settling episode below. */
  const contentRef = useRef('');
  /* THE REFERENCE OPEN CARD'S HEIGHT, AND WHETHER IT IS WHAT IS DRAWN.
     The budget is "how many compressed rows fit BESIDE THE OPEN CARD", and the
     open card that shows whenever a row shows is the hardest owed item (or
     `openId`) — a pure function of the items, NOT of the budget. At budget 0 the
     pin has no room for a row, so it PAGES the single card it can show for
     reachability (records.ts `foldPin`); that paged-to card is a paging artifact
     and must not be what the budget is priced against, or the budget depends on
     the card, which depends on the budget: at a boundary belt with the reference
     card tall and a paged card short, `measure` reads tall→0 rows, renders the
     short paged card, reads short→1 row, renders the reference, reads tall→0 …
     forever, and the episode key changes every pass so the ratchet never bites.
     So `measure` reads the first child's height only while the reference is what
     is drawn — page 0, or any budget ≥ 1 — and reuses the last reference height
     it saw otherwise. Page 0 always draws the reference, so the cache is seeded
     before the user can ever page away from it. */
  const openHeightRef = useRef(0);
  const openIsReferenceRef = useRef(true);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const list = listRef.current;
    const container = root?.parentElement ?? null;
    const viewport = window.innerHeight;
    const fromViewport = pinBeltFor(viewport);
    const px = (element: Element | null | undefined) =>
      element === null || element === undefined ? 0 : element.getBoundingClientRect().height;
    /* The pin's own chrome — head, the overflow control, padding — is
       everything it is that the list is not, so it holds whatever the list's
       height happens to be at the moment it is read. */
    const chrome = root === null || list === null ? 0 : px(root) - px(list);
    /* A box that reports no height has not told us anything — jsdom gives
       every rect zeros, and so does a container that has not been laid out
       yet. Reading that as "no room" would fold the pin to nothing on the
       evidence of a measurement that did not happen, which is the same error
       as the server guessing a viewport. It constrains only when it has a
       height to constrain with. */
    const containerHeight = container === null ? 0 : container.clientHeight;
    const fromContainer =
      containerHeight <= 0 ? Number.POSITIVE_INFINITY : containerHeight - chrome;
    const available = Math.max(0, Math.min(fromViewport, fromContainer));
    /* THE BELT'S FIXED COST, READ RATHER THAN ALLOWED FOR.
       The open card is the list's first child — `Pin` draws it before any
       compressed row, and the empty state that replaces it sits in the same
       place — and the clean summary carries `data-pin-clean`, written a dozen
       lines below. Both are in the DOM by the time this runs, with the height
       the browser gave them, so the ladder charges what is there instead of the
       three-title-line allowance that answers before there is a page to read.
       `pinFixedCost` falls back to that allowance when the card has no box. */
    const firstChildHeight = px(list?.firstElementChild);
    /* Price the open card against the REFERENCE, not the paged-to one. Cache the
       first child's height only while the reference is what is drawn; otherwise
       (budget 0, paged off page 0) reuse the last reference height, so the card
       the budget decides cannot feed back into the budget. See `openHeightRef`. */
    if (openIsReferenceRef.current && firstChildHeight > 0) {
      openHeightRef.current = firstChildHeight;
    }
    const openHeight = openHeightRef.current > 0 ? openHeightRef.current : firstChildHeight;
    const boxes =
      list === null
        ? null
        : { open: openHeight, clean: px(list.querySelector('[data-pin-clean]')) };
    const computed = pinBudgetForBelt(available, boxes);

    /* WHY THIS TERMINATES.
       Setting the budget changes what the pin renders, which changes the pin's
       height, which the observers below are watching — so this can call itself.
       Every input the budget divides is now budget-INDEPENDENT: the viewport and
       the container are the room, and `boxes.open` is the REFERENCE card, not
       whichever card the budget happened to page to (that decoupling is the
       whole of `openHeightRef` above — without it the open box moved with the
       budget at a boundary belt and the loop had a genuine two-cycle). So the
       only feedback left is `budget → the overflow control → chrome → belt →
       budget`, and it is monotone: lowering the budget can only ADD the control,
       which only lowers the belt further. The episode key is those same
       budget-independent inputs plus the content signature; while it holds the
       applied budget is only ever lowered (`Math.min`) and bounded below by 0,
       so at most PIN_COMPACT_BUDGET passes can change it. When the key changes —
       a genuine reshape, or the reference card actually growing or shrinking —
       the episode is over and the measurement is taken at face value, so a card
       that SHRANK raises the budget again rather than being pinned to the worst
       thing ever measured. `test/pin-bound.test.tsx` drives the loop with cards
       of DIFFERENT heights and asserts it commits nothing once settled; assuming
       convergence is how a render loop ships. */
    const key = [
      Math.round(viewport),
      Math.round(containerHeight),
      Math.round(boxes?.open ?? 0),
      Math.round(boxes?.clean ?? 0),
      contentRef.current,
    ].join('|');
    const settled = settledRef.current;
    const settling = settled !== null && settled.key === key;
    const budget = settling ? Math.min(computed, settled.budget) : computed;
    if (settling && settled.belt === available && settled.budget === budget) return;
    settledRef.current = { key, belt: available, budget };
    setBelt(available);
    setBudget(budget);
    setMeasured(true);
  }, []);

  const fold = foldPin(items, { openId, page, budget });

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  /* AFTER EVERY COMMIT, AND ON EVERY BOX THE PIN IS MADE OF.
     Round 9 observed the CONTAINER and nothing else, so `chrome` was a cache of
     the pin's children as they stood at the last window or pane resize: the
     overflow control appearing, a page turning, the pin folding, or the open
     card growing a title line all changed the pin's height with no
     re-measurement, and the belt kept dividing a room that no longer existed.
     A commit covers everything React causes; the observer covers what it does
     not — a reflow at a new width, a font arriving late, a title that grows
     inside a list whose own height is pinned by the clip and therefore reports
     no change at all. That last one is why the card and the clean summary are
     observed directly: both are children of the clipped list, so a title that
     wraps or a clean line that wraps on a late font load moves no box further
     out. This is the pin's own bound and nothing else's: Timeline's removed
     bottom-re-pin observer is not being reintroduced here.

     It is a LAYOUT effect so the first measurement lands before paint — see
     `useIsomorphicLayoutEffect`. */
  useIsomorphicLayoutEffect(() => {
    contentRef.current = [
      items.length,
      fold.open?.id ?? '',
      fold.page,
      fold.clean.length,
      folded ? 'folded' : 'open',
    ].join('/');
    /* Whether the card currently drawn is the reference the budget is priced
       against: the reference is drawn at any budget ≥ 1 and at page 0. When it
       is not (budget 0, paged off page 0), `measure` reuses the cached reference
       height rather than the paging artifact's. See `openHeightRef`. */
    openIsReferenceRef.current = budget >= 1 || fold.page === 0;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    const list = listRef.current;
    for (const target of [
      rootRef.current?.parentElement,
      rootRef.current,
      list,
      list?.firstElementChild,
      list?.querySelector('[data-pin-clean]'),
    ]) {
      if (target !== null && target !== undefined) observer.observe(target);
    }
    return () => observer.disconnect();
  });
  /* The items the head glyph is about: what still needs this person. */
  const owedItems = items.filter((item) => needsViewer(item.state));

  return (
    <section
      aria-label="Needs you"
      className={styles.pin}
      data-region="needs-you"
      /* THE BELT, ONCE, FROM THE PLACE THE ROW LADDER READS IT.
         `.pinList` carries no belt literal — it is `max-height: var(--pin-belt)`
         — so this is where the stylesheet's copy of the bound comes from, and it
         is `PIN_GEOMETRY.beltMax` and `beltShare` rendered as CSS. It is set
         here rather than on the list because it is a fact about the pin, it
         costs nothing on the server, and it needs no viewport to be true: `vh`
         is answered by the browser before any script runs, which is what makes
         the pre-hydration frame bounded at all.
         Round 9 replaced a hard-coded `min(260px, 30vh)` in the stylesheet that
         had drifted 80px from the ladder without anything failing. */
      style={{ '--pin-belt': beltCss() } as CSSProperties}
      ref={rootRef}
    >
      <div className={styles.pinHead}>
        {/* THE HEAD GLYPH IS THE HARDEST THING IN THE PIN, and it is a component
            over a SET rather than a character over a count — see AggregateGlyph.
            It used to be `{headGlyph ?? '·'}`, which is a hand-written glyph
            behind a `??`: `·` means "routine, no attention owed", a claim about
            items that are not there. An empty pin says so in words on the line
            beside this, so the glyph renders nothing rather than borrowing one. */}
        <span className={styles.pinHeadGlyph} data-pin-glyph="true">
          <AggregateGlyph over={owedItems} />
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
          <div
            className={styles.pinList}
            ref={listRef}
            /* The measured belt, when there is one.
               This said "the stylesheet's `min(260px, 30vh)` is the server's
               answer and stays the ceiling — this only ever takes space away,
               never adds it". Both halves were false. An inline `max-height`
               outranks a class rule outright, so this REPLACED the stylesheet's
               cap rather than tightening it, and at 900px it replaced 260 with
               306 — it added 46px, the same 46 the ladder was over-charging.
               It is true now, and structurally rather than by assertion:
               `available` is `Math.min(fromViewport, fromContainer)` where
               `fromViewport` is `pinBeltFor`, the pixel rendering of the very
               expression `--pin-belt` carries. The min() is taken in JS because
               the row budget must be derived from the SAME number the box is
               capped at (below); handing CSS a second expression to evaluate is
               how the two registers happened. */
            style={belt === null ? undefined : { maxHeight: `${belt}px` }}
            data-pin-belt={belt === null ? undefined : String(Math.round(belt))}
            data-pin-budget={String(budget)}
            /* The server cannot see a viewport, so it renders the full budget and
               this flips once the effect has measured. The e2e waits for it
               rather than racing hydration — a geometry assertion taken before
               the geometry is settled is a check that passes for the wrong
               reason, which is the same species as reading a computed style
               mid-transition (round 4). */
            data-pin-measured={measured ? 'true' : 'false'}
            data-pin-list="true"
          >
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

            {/* Everything clean compresses to a count and never takes a row. */}
            {fold.clean.length === 0 ? null : (
              <div className={styles.clean} data-pin-clean={String(fold.clean.length)}>
                {plural(fold.clean.length, 'item')} here no longer needs you ·{' '}
                <GlyphTally counts={fold.cleanCounts} />
              </div>
            )}
          </div>

          {/* THE WAY OUT OF THE FOLD LIVES OUTSIDE THE CLIP.

              Found by the blind cross-lineage review of round 5: the budget
              ladder assumes a 74px card, and `AttentionCard` puts no bound on a
              wrapping title, wrapping facts or the number of actions. An item
              whose title runs to four lines pushes the card past the belt, and
              while it sat INSIDE `.pinList` the first thing `overflow: hidden`
              took was the "N more owed" control — which is round 2's stranding
              defect exactly: owed items behind an affordance that cannot be
              used. The rows may be clipped by a card that grew; the affordance
              that pages past them may not. */}
          {fold.overflow.length === 0 ? null : (
            <div className={styles.pinMore}>
              {/* THE OVERFLOW AFFORDANCE. Explicit, counted, named by glyph —
                and it PAGES. The count says how much is off the page; the
                action says exactly what the next click brings, derived from
                the page it will render. Round 2 shipped these as the same
                number, which made the second sentence a lie the moment the
                first exceeded the budget. */}
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
                <span className={styles.moreHint} data-truncates="name">
                  the pin folds rather than pushing the composer off the screen
                </span>
              </button>
            </div>
          )}
          <Trailer lastCheck={lastCheck} onShowRest={onShowRest} summary={trailer} />
        </>
      )}
    </section>
  );
}
