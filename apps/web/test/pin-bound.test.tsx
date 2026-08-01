/* ---------------------------------------------------------------------------
 * THE PIN BOUNDS ITSELF.
 *
 * Round 1 measured the unbounded pin pushing the composer to 909px in a 900px
 * viewport at 19 owed items, with `scrollHeight` stuck at 900 — unreachable by
 * any means. The pixel half of this is measured in a browser
 * (e2e/pin-bound.spec.ts); this is the derivation half, which is the one that
 * has to be right for the pixels to have a chance.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { nextPageLabel, Pin } from '../src/components';
import type { AttentionItem, TrailerSummary } from '../src/components/model';
import {
  foldPin,
  PIN_COMPACT_BUDGET,
  PIN_PAGE,
  rationale,
  trailerFor,
} from '../src/components/model';

afterEach(cleanup);

const TRAILER: TrailerSummary = trailerFor({ objects: [], objectives: [], overdue: 0 });

/* 60 is the load round 2's gauntlet used: expanded, it stranded 50 owed items
   behind an affordance that could not reveal them. */
const LOADS = [4, 13, 19, 34, 60] as const;

function settled(id: string): AttentionItem {
  return {
    id,
    state: { kind: 'claim', verification: 'verified', owedToViewer: false, irreversible: false },
    title: 'already checked',
    rationale: rationale('nothing here needs you any more'),
    facts: [],
    source: null,
    actions: [],
  };
}

describe('the fold is derived from the items', () => {
  /* CATCHES: removing the budget, or raising it with the item count — which is
     what an unbounded pin does. However many items arrive, the number of ROWS
     the pin renders is capped, and the rest are counted rather than drawn. */
  it.each(LOADS)('bounds the rows at %i owed items', (n) => {
    const fold = foldPin(f.manyOwed(n));
    expect(fold.owedTotal).toBe(n);
    expect(fold.compact.length).toBeLessThanOrEqual(PIN_COMPACT_BUDGET);
    const rows = (fold.open === null ? 0 : 1) + fold.compact.length;
    expect(rows).toBeLessThanOrEqual(PIN_COMPACT_BUDGET + 1);
    expect(rows + fold.overflow.length).toBe(n);
  });

  /* CATCHES: hiding the overflow instead of counting it. "Folding hides noise
     but never signal" — an owed item behind the fold must still be announced,
     and announced by how hard it is. */
  it.each(LOADS)('announces what is behind the fold at %i items', (n) => {
    const fold = foldPin(f.manyOwed(n));
    const counted = fold.overflowCounts.reduce((sum, c) => sum + c.n, 0);
    expect(counted).toBe(fold.overflow.length);
    if (n > PIN_COMPACT_BUDGET + 1) expect(fold.overflow.length).toBeGreaterThan(0);
  });

  /* CATCHES: an item that is no longer owed still taking a row. BRIEF concept
     3: "everything clean compresses to counts". */
  it('clean items compress to counts and never take a row', () => {
    const fold = foldPin([...f.manyOwed(2), settled('done-1'), settled('done-2')]);
    expect(fold.owedTotal).toBe(2);
    expect(fold.clean.map((i) => i.id)).toEqual(['done-1', 'done-2']);
    expect(fold.compact.map((i) => i.id)).not.toContain('done-1');
    expect(fold.cleanCounts).toEqual([{ glyph: '✓', n: 2 }]);
  });

  /* CATCHES: the sort being lost when the budget is applied — the four items
     that survive must be the four HARDEST, not the first four in input order. */
  it('what survives the fold is the hardest, not the earliest', () => {
    const fold = foldPin(f.manyOwed(13));
    const shown = [fold.open, ...fold.compact].filter((i) => i !== null);
    expect(shown[0]?.title).toMatch(/^failure/);
    for (const item of fold.overflow) expect(item.title).not.toMatch(/^failure/);
  });
});

describe('the pin renders its own bound', () => {
  /* CATCHES: the component ignoring `foldPin` and mapping over every item —
     which is what the pre-fix Pin did, with a caller-supplied `folded` boolean
     it never set. */
  it.each(LOADS)('renders a bounded number of rows at %i items', (n) => {
    const { container, unmount } = render(
      <Pin items={f.manyOwed(n)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const rows = container.querySelectorAll('[data-attention-id]');
    expect(rows.length).toBeLessThanOrEqual(PIN_COMPACT_BUDGET + 1);
    if (n > PIN_COMPACT_BUDGET + 1) {
      const more = container.querySelector('[data-pin-overflow]');
      expect(more?.getAttribute('data-pin-overflow')).toBe(String(n - rows.length));
      expect(more?.textContent).toContain(`${n - rows.length} more owed`);
    }
    unmount();
  });

  /* CATCHES: making the bound depend on a caller prop again. There is no
     `folded` prop; passing one is a type error, so a consumer cannot forget to
     set it and cannot set it wrong. */
  it('there is no caller-supplied bound to forget', () => {
    render(
      <Pin
        // @ts-expect-error — `folded` is gone: the pin bounds itself.
        folded={false}
        items={f.manyOwed(19)}
        lastCheck="12:29"
        trailer={TRAILER}
        viewer="lars"
      />,
    );
    expect(screen.getAllByText(/more owed/).length).toBeGreaterThan(0);
  });

  /* CATCHES: a head glyph hard-coded to ◆ while the pin holds a failure. The
     aggregate glyph is derived like every other glyph in the app. */
  it('the head glyph is derived from what the pin is holding', () => {
    const { container } = render(
      <Pin items={f.manyOwed(4)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    // manyOwed(4) contains a ✗ failure, which outranks ■ and ◆
    expect(container.querySelector('[data-pin-glyph]')?.textContent).toBe('✗');
  });
});

/* ---------------------------------------------------------------------------
 * THE WAY PAST THE FOLD IS AS REAL AS THE FOLD.
 *
 * Round 2 bounded the pin correctly and then shipped an idempotent way out of
 * it: `setShowAll(true)` raised the row budget once, from 4 to a hard cap of 9,
 * and every click after that did nothing. At 60 owed items that left 50 of them
 * unreachable by any pointer input, behind a button reading "50 more owed" — a
 * label promising ten times what the control could deliver, and delivering it
 * only once. "Owed attention never hides" (BRIEF concept 3) was false in that
 * state, and the e2e only ever checked the unexpanded one.
 * ------------------------------------------------------------------------- */
describe('the affordance out of the fold is not decorative', () => {
  /* CATCHES the exact defect: an affordance that stops doing anything after the
     first click. Paging all the way round must show EVERY owed item at least
     once — not most of them, not the first nine. */
  it.each(LOADS)('every owed item is reachable by paging — %i owed', (n) => {
    const items = f.manyOwed(n);
    const seen = new Set<string>();
    const { pageCount } = foldPin(items);
    for (let page = 0; page < pageCount; page += 1) {
      const fold = foldPin(items, { page });
      if (fold.open !== null) seen.add(fold.open.id);
      for (const item of fold.compact) seen.add(item.id);
    }
    expect(seen.size, `${seen.size} of ${n} owed items were reachable`).toBe(n);
    expect(pageCount).toBeLessThanOrEqual(Math.ceil(n / PIN_PAGE));
  });

  /* CATCHES: a label that names the total behind the fold as though one click
     revealed it. What the button says the next click does must be what the next
     click does — the same rule as round 1's `data-hold`, which promised a hold
     the code never implemented. */
  it.each(LOADS)('the label states exactly what one more click reveals — %i owed', (n) => {
    const items = f.manyOwed(n);
    const fold = foldPin(items);
    if (fold.overflow.length === 0) return;
    const promised = fold.nextPage.map((item) => item.id);
    expect(nextPageLabel(fold)).toContain(String(promised.length));
    const after = foldPin(items, { page: 1 });
    expect(after.compact.map((item) => item.id)).toEqual(promised);
  });

  /* CATCHES: paging off the end into an empty pin, or a last page that becomes
     inert. The window wraps, and the label says so rather than counting down to
     a control that does nothing. */
  it('the last page wraps back to the hardest rather than going inert', () => {
    const items = f.manyOwed(19);
    const { pageCount } = foldPin(items);
    const last = foldPin(items, { page: pageCount - 1 });
    expect(last.wraps).toBe(true);
    expect(nextPageLabel(last)).toMatch(/^back to the hardest/);
    expect(foldPin(items, { page: pageCount }).compact).toEqual(foldPin(items).compact);
    // and a caller that only ever increments never lands on an empty pin
    for (let page = 0; page < pageCount * 2 + 3; page += 1) {
      expect(foldPin(items, { page }).compact.length).toBeGreaterThan(0);
    }
  });

  /* CATCHES the reason the strand happened: raising the row budget when the
     affordance is used. The belt that keeps the composer on screen is measured
     against ONE budget; a state that renders more rows than the belt can show
     is a clip over live content, which is what took three rows off the top when
     a keyboard user tabbed into the expanded pin. */
  it.each(LOADS)('the row budget does not move when the pin is paged — %i owed', (n) => {
    const items = f.manyOwed(n);
    const { pageCount } = foldPin(items);
    for (let page = 0; page < pageCount; page += 1) {
      expect(foldPin(items, { page }).compact.length).toBeLessThanOrEqual(PIN_COMPACT_BUDGET);
    }
  });

  /* CATCHES: the rendered control not being wired to the paging at all — the
     model can page perfectly and the button can still be a no-op. This clicks
     the real button and reads the real rows. */
  it('clicking the control changes the rows, every time', () => {
    const { container } = render(
      <Pin items={f.manyOwed(60)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const ids = () =>
      [...container.querySelectorAll('[data-attention-id]')].map((el) =>
        el.getAttribute('data-attention-id'),
      );
    const seen = new Set(ids());
    const control = () => container.querySelector('[data-pin-overflow]') as HTMLElement | null;
    expect(control(), 'the pin has no overflow control at 60 owed').not.toBeNull();

    const pages = Number(control()?.getAttribute('data-pin-page')?.split('/')[1]);
    expect(pages).toBeGreaterThan(1);
    for (let click = 0; click < pages; click += 1) {
      const promised = Number(control()?.getAttribute('data-pin-next'));
      const before = ids();
      fireEvent.click(control() as HTMLElement);
      const after = ids();
      expect(after, 'the overflow control did nothing').not.toEqual(before);
      /* the promised count is what actually arrived — the open card is fixed,
         so it is the compressed rows that turn over */
      expect(after.length - 1).toBe(promised);
      for (const id of after) seen.add(id);
    }
    expect(seen.size, `${seen.size} of 60 owed items were reachable by clicking`).toBe(60);
  });

  /* CATCHES: an overflow count that stops accounting for everything once the
     pin is paged. Nothing owed may be dropped in any state. */
  it.each(LOADS)('rows plus overflow account for every owed item, on every page — %i', (n) => {
    const items = f.manyOwed(n);
    const { pageCount } = foldPin(items);
    for (let page = 0; page < pageCount; page += 1) {
      const fold = foldPin(items, { page });
      const rows = (fold.open === null ? 0 : 1) + fold.compact.length;
      expect(rows + fold.overflow.length).toBe(n);
      expect(fold.overflowCounts.reduce((sum, c) => sum + c.n, 0)).toBe(fold.overflow.length);
    }
  });
});
