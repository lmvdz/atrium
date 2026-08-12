/* ---------------------------------------------------------------------------
 * THE PIN BOUNDS ITSELF.
 *
 * Round 1 measured the unbounded pin pushing the composer to 909px in a 900px
 * viewport at 19 owed items, with `scrollHeight` stuck at 900 — unreachable by
 * any means. The pixel half of this is measured in a browser
 * (e2e/pin-bound.spec.ts); this is the derivation half, which is the one that
 * has to be right for the pixels to have a chance.
 * ------------------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { nextPageLabel, Pin } from '../src/components';
import type { AttentionItem, TrailerSummary } from '../src/components/model';
import {
  beltCss,
  foldPin,
  PIN_COMPACT_BUDGET,
  PIN_GEOMETRY,
  pinBeltFor,
  pinBudgetFor,
  pinBudgetForBelt,
  pinFixedCost,
  rationale,
  trailerFor,
} from '../src/components/model';

afterEach(cleanup);

/** Walk up from the working directory until the file turns up, so paths resolve
    whether vitest ran from the repo root or from apps/web (token-contrast.test.ts
    carries the same helper for the same reason). */
function find(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${relative} not found above ${process.cwd()}`);
}

const TRAILER: TrailerSummary = trailerFor({ objects: [], objectives: [], overdue: [] });

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
    /* The window advances by exactly what it shows, so the number of pages is
       the item count over the budget. `PIN_PAGE` used to be a second name for
       `PIN_COMPACT_BUDGET` and stopped being true the moment the budget started
       moving with the viewport — a stale alias is a second source of truth
       waiting to drift. */
    expect(pageCount).toBeLessThanOrEqual(Math.ceil(n / PIN_COMPACT_BUDGET));
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

/* ---------------------------------------------------------------------------
 * ROUND 5 — THE BOUND AGAINST THE VIEWPORT, NOT AGAINST A CONSTANT.
 *
 * Round 4's gauntlet: `.pinList`'s `max-height: 340px` does not shrink against
 * `.app`'s `height: 100vh`, so at 1124x500 the composer's bottom edge sat at 511
 * in a 500px viewport with `scrollHeight === clientHeight` — round 1's exact
 * signature, at a short viewport instead of a long list. Every harness viewport
 * in the e2e hard-coded 900.
 *
 * Making the belt relative fixes the composer and, on its own, turns the pin
 * back into a box holding more than it can show. So the COUNT bound moves with
 * the pixel bound: `pinBudgetFor` does the same arithmetic the stylesheet does,
 * and `foldPin` takes it.
 * ------------------------------------------------------------------------- */
describe('the pin’s row budget shrinks with the viewport', () => {
  /* CATCHES: the ladder going back to a constant, or losing its clamp. The
     numbers are the rendered geometry measured in Chromium; the e2e asserts the
     stylesheet agrees with them at the same five heights. */
  it.each([
    [900, 4],
    [768, 3],
    [640, 2],
    [500, 1],
    [420, 0],
  ])('a %ipx viewport has room for %i compressed rows', (height, rows) => {
    expect(pinBudgetFor(height)).toBe(rows);
  });

  it('the ladder is clamped at both ends', () => {
    expect(pinBudgetFor(4000)).toBe(PIN_COMPACT_BUDGET);
    expect(pinBudgetFor(120)).toBe(0);
    expect(pinBudgetFor(0)).toBe(0);
  });

  /* CATCHES: `foldPin` ignoring the budget — the fix that keeps the composer on
     screen while leaving the pin holding rows it cannot draw. */
  it.each([0, 1, 2, 3, 4])('the fold never renders more than %i compressed rows', (budget) => {
    const items = f.manyOwed(34);
    for (let page = 0; page < 20; page += 1) {
      expect(foldPin(items, { budget, page }).compact.length).toBeLessThanOrEqual(budget);
    }
  });

  /* CATCHES the way this fix could reintroduce round 2's inert affordance. With
     no room for a compressed row the overflow control would promise "the next 0"
     and deliver nothing — a live-looking button that has already done everything
     it will ever do. At budget 0 the page advances THE CARD instead, so every
     owed item is still reachable in a bounded number of clicks. */
  it('the way past the fold survives a viewport with no room for a row', () => {
    const items = f.manyOwed(34);
    const seen = new Set<string>();
    let page = 0;
    for (let click = 0; click < 34; click += 1) {
      const fold = foldPin(items, { budget: 0, page });
      expect(fold.compact).toEqual([]);
      expect(fold.nextPage.length, 'the overflow control promises nothing').toBe(1);
      expect(fold.open, 'the pin renders no card at all').not.toBeNull();
      if (fold.open !== null) seen.add(fold.open.id);
      page += 1;
    }
    expect(seen.size, 'paging a one-card pin does not reach every owed item').toBe(34);
    // and page 0 is still the hardest thing in the room
    expect(foldPin(items, { budget: 0, page: 0 }).open?.id).toBe(foldPin(items).open?.id);
  });

  /* CATCHES: the rendered pin not consulting the measurement at all. jsdom
     reports a viewport, so the component's own effect has a real number to
     react to — and the row count on screen has to follow it. */
  it.each([
    [900, 4],
    [500, 1],
  ])('the rendered pin draws %ipx worth of rows (%i)', (height, rows) => {
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    const { container, unmount } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const drawn = container.querySelectorAll('[data-pin-list] [data-attention-id]').length;
    expect(drawn, `a ${height}px viewport drew ${drawn} rows`).toBe(rows + 1);
    expect(container.querySelector('[data-pin-list]')?.getAttribute('data-pin-measured')).toBe(
      'true',
    );
    unmount();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: original });
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 9 — THE BELT IS ONE NUMBER, AND FLIPPING IT MOVES EVERY SURFACE.
 *
 * `PIN_GEOMETRY` said the belt was `min(340px, 34vh)`. `.pinList` said
 * `max-height: min(260px, 30vh)`. Three comments — records.ts, the stylesheet
 * and Pin.tsx — asserted the two agreed. They had disagreed by 80px for four
 * rounds and no test failed, because the cap that ships is the INLINE one `Pin`
 * writes after measuring and an inline `max-height` outranks a class rule: at
 * 900px the stylesheet said 260 and the element rendered 306. The stylesheet's
 * copy was live only before hydration, so it was free to drift.
 *
 * The arithmetic balanced anyway because `PIN_GEOMETRY.overflow` charged 46px
 * for the "N more owed" control, which has been a SIBLING of the clipped list
 * since round 5 — a charge for a box outside the box being measured, cancelling
 * a belt that was too small. Removing either alone moves the row ladder.
 *
 * There is one belt now and the stylesheet takes it from `--pin-belt`. These
 * tests are the mutation the two-register version could not survive: change the
 * single value and the CSS expression, the pixel belt, the row ladder and the
 * rendered custom property all move together. Under the old shape the
 * stylesheet's 260 would not have moved at all.
 * ------------------------------------------------------------------------- */
describe('the belt is one value', () => {
  /** the fields under test are `as const` for callers; the runtime object is a
      plain object, and flipping it is the whole point of these tests */
  const mutable = PIN_GEOMETRY as unknown as { beltMax: number; beltShare: number };

  function withBelt<T>(beltMax: number, beltShare: number, body: () => T): T {
    const max = mutable.beltMax;
    const share = mutable.beltShare;
    mutable.beltMax = beltMax;
    mutable.beltShare = beltShare;
    try {
      return body();
    } finally {
      mutable.beltMax = max;
      mutable.beltShare = share;
    }
  }

  function renderedBelt(): string | null {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const pin = container.querySelector('[data-region="needs-you"]') as HTMLElement | null;
    return pin === null ? null : pin.style.getPropertyValue('--pin-belt').trim();
  }

  /* CATCHES: the stylesheet keeping a belt literal of its own — the exact
     two-register shape this round removed. Asserted against the file rather than
     against a copy of the number, so there is no list of forbidden values to
     fall out of date: any `max-height` on `.pinList` that is not the custom
     property fails. */
  it('the stylesheet writes no belt of its own', () => {
    const css = readFileSync(
      find('apps/web/src/components/attention/attention.module.css'),
      'utf8',
    );
    const rule = /\.pinList\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.pinList is not in attention.module.css any more').not.toBeNull();
    const declarations = (rule?.[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter((line) => line.startsWith('max-height'));
    expect(declarations, '.pinList declares no max-height at all').toHaveLength(1);
    expect(declarations[0], 'the stylesheet is carrying a second belt register again').toBe(
      'max-height: var(--pin-belt);',
    );
  });

  /* CATCHES: the rendered pin not passing the belt to the stylesheet — which
     would leave `var(--pin-belt)` unresolved and `.pinList` with no max-height
     at all, i.e. round 1's unbounded pin, before hydration. */
  it('the pin hands the stylesheet the belt, and it is the derived one', () => {
    expect(renderedBelt()).toBe(beltCss());
    expect(beltCss()).toBe('min(340px, 34vh)');
  });

  /* THE FLIP. One value changes and every surface claiming to derive from it
     moves: the CSS expression, the pixel belt, the ladder, and the property the
     pin actually renders. CATCHES: any of the four going back to a literal. */
  it('flipping the belt moves the stylesheet, the pixel belt and the ladder together', () => {
    const before = {
      css: beltCss(),
      belt: pinBeltFor(900),
      budget: pinBudgetFor(900),
      rendered: renderedBelt(),
    };
    expect(before).toEqual({
      css: 'min(340px, 34vh)',
      belt: 306,
      budget: 4,
      rendered: 'min(340px, 34vh)',
    });

    cleanup();
    const after = withBelt(200, 0.2, () => ({
      css: beltCss(),
      belt: pinBeltFor(900),
      budget: pinBudgetFor(900),
      rendered: renderedBelt(),
    }));

    /* halving the belt halves what the pin may hold, in every register at once */
    expect(after).toEqual({
      css: 'min(200px, 20vh)',
      belt: 180,
      budget: 1,
      rendered: 'min(200px, 20vh)',
    });

    // and the flip is not sticky: the constant is restored
    expect(beltCss()).toBe(before.css);
    expect(pinBudgetFor(900)).toBe(before.budget);
  });

  /* AND THE PIXEL ARM IS FLIPPED WHERE IT IS THE ONE THAT BINDS.
     Round 1's gauntlet, finding 3: the flip above moves both fields at a
     viewport where the SHARE arm binds on both sides — 34vh of 900 is 306 and
     20vh of 900 is 180, both under their own `beltMax` — so `beltMax` never
     reaches the pixel belt at all. A mutant hard-coding `Math.min(340,
     viewportHeight * g.beltShare)` inside `pinBeltFor` passed the entire suite:
     `beltCss` reads the field honestly and masked it, and every rung of the
     ladder still landed where it does because the share was doing the work.

     Two cases, one each way, so both arms of the `min()` are load-bearing:
     `beltMax` binding at a tall viewport, and `beltShare` binding at a short
     one. Belt AND budget move in both. */
  it.each([
    // beltMax binds: 34vh of 2000 is 680, so the 200px cap is the limiter
    { viewport: 2000, max: 200, share: 0.34, css: 'min(200px, 34vh)', belt: 200, budget: 2 },
    // beltShare binds: 20vh of 900 is 180, under the 340px cap
    { viewport: 900, max: 340, share: 0.2, css: 'min(340px, 20vh)', belt: 180, budget: 1 },
  ])('the belt is $css at $viewportpx, and the ladder divides that number', (flip) => {
    cleanup();
    const after = withBelt(flip.max, flip.share, () => ({
      css: beltCss(),
      belt: pinBeltFor(flip.viewport),
      budget: pinBudgetForBelt(pinBeltFor(flip.viewport)),
      rendered: renderedBelt(),
    }));
    expect(after).toEqual({
      css: flip.css,
      belt: flip.belt,
      budget: flip.budget,
      rendered: flip.css,
    });
  });

  /* THE MUTANT, WRITTEN OUT, so what the case above is for is not a claim about
     a case. `Math.min(340, viewportHeight * g.beltShare)` — the literal the old
     flip could not distinguish from the field — answers 340 where the field
     answers 200, and the ladder built on it allows two rows that do not fit.
     The ledger applies the same edit to the source and runs this file. */
  it('a pixel belt hard-coded at 340 answers a different number where beltMax binds', () => {
    const hardCoded = (viewportHeight: number) =>
      Math.min(340, viewportHeight * PIN_GEOMETRY.beltShare);
    withBelt(200, 0.34, () => {
      expect(pinBeltFor(2000)).toBe(200);
      expect(hardCoded(2000)).toBe(340);
      expect(pinBudgetForBelt(pinBeltFor(2000))).toBe(2);
      expect(pinBudgetForBelt(hardCoded(2000))).toBe(4);
    });
  });

  /* CATCHES: `beltCss` shipping binary floating point into a stylesheet.
     `0.34 * 100` is 34.000000000000004, and `min(340px, 34.000000000000004vh)`
     is a valid but embarrassing declaration. */
  it('the share reaches the stylesheet as a number a person would write', () => {
    expect(beltCss()).not.toMatch(/\d{6,}vh/);
    expect(withBelt(340, 0.305, () => beltCss())).toBe('min(340px, 30.5vh)');
  });

  /* CATCHES: the belt charge going back to a box that is not inside the belt.
     `overflow: 46` charged for the "N more owed" control, which has been a
     sibling of the clipped list since round 5. Every term of the fixed cost is
     now a box the belt actually contains, and this is the arithmetic that says
     so: the ladder's rungs are exactly the counts whose measured content fits.

     The measurements are Chromium at 1280, 1340 and 1440 — the card 72.27px,
     a compressed row 37.22px, the list's own gap 2px (`PIN_GEOMETRY.gap` read 4
     against that 2 until this round). */
  it.each([
    [900, 4],
    [768, 3],
    [640, 2],
    [500, 1],
    [420, 0],
  ])('at %ipx the %i rows the ladder allows are rows that measurably fit', (height, rows) => {
    const MEASURED = { card: 72.27, row: 37.22, gap: 2 } as const;
    const belt = pinBeltFor(height);
    expect(pinBudgetFor(height)).toBe(rows);
    const needed = MEASURED.card + rows * (MEASURED.row + MEASURED.gap);
    expect(needed, `a ${rows}-row list is ${needed}px in a ${belt}px belt`).toBeLessThanOrEqual(
      belt,
    );
  });

  /* CATCHES: the fixed cost being padded back out with a charge for something
     outside the box. The headroom the belt carries is the open card growing —
     round 6 removed `.acardTitle`'s clamp on purpose — and it is three measured
     title lines, not an unattributed 46. */
  it('the pre-measure fixed cost is the open card and its allowed growth, and nothing else', () => {
    expect(PIN_GEOMETRY).not.toHaveProperty('overflow');
    expect(PIN_GEOMETRY.titleLine * PIN_GEOMETRY.cardGrowthLines).toBeCloseTo(42.9, 5);

    /* AND THE LADDER ACTUALLY DIVIDES THOSE FIELDS, rather than merely having
       them nearby. Naming the constants is not evidence: the first version of
       this test asserted the fields and their product, and a mutant restoring
       `card + gap + 46` — 122px against the honest 116.9 — ESCAPED it, because
       both land inside the window that leaves the five rungs where they are.

       So the cost is read back OUT of `pinBudgetForBelt` instead. The function is
       `floor((a - fixed) / perRow)`, so the belt at which it first allows one row
       is exactly `fixed + perRow`; bisecting for that threshold recovers `fixed`
       from behaviour. The 122px mutant moves the threshold to 163 and fails
       here. */
    const perRow = PIN_GEOMETRY.row + PIN_GEOMETRY.gap;
    let low = 0;
    let high = 1000;
    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (pinBudgetForBelt(mid) >= 1) high = mid;
      else low = mid;
    }
    const fixed = high - perRow;
    expect(fixed, 'the belt is charging for something that is not the open card').toBeCloseTo(
      PIN_GEOMETRY.card + PIN_GEOMETRY.titleLine * PIN_GEOMETRY.cardGrowthLines,
      6,
    );

    /* and the headroom is really load-bearing: without it a 768px viewport would
       allow a fourth row, which is the rung the phantom 46 was holding up */
    const belt = pinBeltFor(768);
    const bare = Math.floor((belt - PIN_GEOMETRY.card) / perRow);
    expect(bare).toBe(4);
    expect(pinBudgetFor(768)).toBe(3);
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 10 — THE BELT CHARGES FOR BOXES IT READ, NOT FOR BOXES IT ALLOWED FOR.
 *
 * Round 1's gauntlet, finding 1: `card + titleLine × cardGrowthLines` is an
 * ALLOWANCE standing where a MEASUREMENT exists. At `measure()` time the open
 * card is in the DOM with the height the browser gave it, growth and all, and
 * so is the clean-item summary — which is also a child of `.pinList` and was
 * charged nothing at all. That is the 46px disease one level down: a stated
 * number standing in for a box that could be read, and a box in the belt that
 * nothing was paying for.
 *
 * The allowance is not deleted. It is what answers on the server and in the
 * first paint, where there is no layout to read; `pinFixedCost` says which of
 * the two is speaking, and a box reporting zero height is "not laid out" rather
 * than "free".
 * ------------------------------------------------------------------------- */
describe('the belt charges for the boxes the browser drew', () => {
  const perRow = PIN_GEOMETRY.row + PIN_GEOMETRY.gap;
  const ALLOWANCE = PIN_GEOMETRY.card + PIN_GEOMETRY.titleLine * PIN_GEOMETRY.cardGrowthLines;
  /* Chromium at 1280/1340/1440, the same pass the constants come from. */
  const CARD = 72.27;

  /* CATCHES: the allowance answering where a measurement was available — and
     equally, a zero-height box being read as a card that costs nothing, which
     would hand the ladder the whole belt on the render before layout. */
  it('the allowance answers only where nothing has been measured', () => {
    expect(pinFixedCost()).toBeCloseTo(ALLOWANCE, 6);
    expect(pinFixedCost(null)).toBeCloseTo(ALLOWANCE, 6);
    expect(pinFixedCost({ open: 0, clean: 0 })).toBeCloseTo(ALLOWANCE, 6);
    expect(pinFixedCost({ open: CARD, clean: 0 })).toBeCloseTo(CARD, 6);
  });

  /* CATCHES: the clean summary staying uncharged. It is a child of `.pinList`,
     inside the clip, and it was not in the sum — the same shape as the control
     that was in the sum without being in the box, pointing the other way. */
  it('the clean summary is inside the belt, so the belt pays for it', () => {
    expect(pinFixedCost({ open: CARD, clean: 40 })).toBeCloseTo(CARD + PIN_GEOMETRY.gap + 40, 6);
    expect(pinBudgetForBelt(306, { open: CARD, clean: 0 })).toBe(4);
    expect(pinBudgetForBelt(306, { open: CARD, clean: 100 })).toBe(3);
  });

  /* CATCHES: the ladder ignoring the boxes it was handed. A card that grew five
     title lines costs a row; the allowance cannot see the difference, because
     an allowance is the same number whatever the card did. */
  it('a card that grew costs a row, and the allowance cannot tell', () => {
    const grown = CARD + 5 * PIN_GEOMETRY.titleLine;
    expect(pinBudgetForBelt(306, { open: CARD, clean: 0 })).toBe(4);
    expect(pinBudgetForBelt(306, { open: grown, clean: 0 })).toBe(3);
    expect(pinBudgetForBelt(306)).toBe(4);
    expect(pinBudgetForBelt(306, { open: 40 + CARD, clean: 0 })).toBe(4);
  });

  /* CATCHES the failure the round-9 receipt recorded against its own first
     attempt: naming the terms without checking the ladder DIVIDES them. The
     cost is read back out of `pinBudgetForBelt` by bisecting for the belt at
     which it first allows a row, which is `fixed + perRow`. */
  it('the ladder divides the measured boxes rather than merely naming them', () => {
    const boxes = { open: 91.4, clean: 33.6 };
    let low = 0;
    let high = 2000;
    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (pinBudgetForBelt(mid, boxes) >= 1) high = mid;
      else low = mid;
    }
    expect(high - perRow, 'the belt is not charging what it was handed').toBeCloseTo(
      boxes.open + PIN_GEOMETRY.gap + boxes.clean,
      6,
    );
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 10 — `chrome` WAS A CACHE, AND THE PIN'S OWN CONTENT NEVER INVALIDATED IT.
 *
 * Round 1's gauntlet, finding 2: `measure()` re-ran on a window resize and on a
 * CONTAINER resize, and on nothing else. The overflow control mounting, a page
 * turning, the pin folding and the open card growing a line all change the pin's
 * height without moving the container an inch, so the room the belt was dividing
 * was the room as it stood at the last resize. The card is the worst case: the
 * list's own height is pinned by the clip, so a card growing inside it changes
 * no box the old observer was watching.
 *
 * jsdom lays nothing out and has no ResizeObserver, so a small layout is
 * supplied here — and it is a layout with the FEEDBACK IN IT, because that is
 * what has to be shown to settle. The pin's chrome carries the overflow control
 * when there is one, so lowering the budget can change the room the budget is
 * derived from: `budget → rows → the control → chrome → belt → budget`. A stub
 * where the pin's height ignores its own content would let a loop through.
 * ------------------------------------------------------------------------- */
describe('the pin re-measures when its own boxes change', () => {
  interface FakeObserver {
    readonly targets: Element[];
    live: boolean;
    fire: () => void;
  }
  /** the pane the pin sits in, the only room there is */
  const CONTAINER = 300;
  /** the pin head and the trailer: chrome that is there whatever the budget is */
  const CHROME = 50;
  /** the "N more owed" control: chrome that is there only when rows were cut */
  const CONTROL = 40;
  const PER_ROW = PIN_GEOMETRY.row + PIN_GEOMETRY.gap;
  const observers: FakeObserver[] = [];
  let cardHeight = 72;
  /* PER-CARD heights, so the open card is not one global number. The oscillation
     the round-2 gauntlet found only exists when the reference card and a paged-to
     card differ in height — a fixture with one card height cannot see it. */
  let cardHeights: Record<string, number> = {};
  /* the clean-item summary's own height, so a late font wrap of it can be driven */
  let cleanHeight = 0;
  let realRect: () => DOMRect;
  let realObserver: typeof ResizeObserver | undefined;
  let realHeight: number;

  /** what the browser would have made of the pin as it currently stands */
  function laidOut(element: Element): number {
    if (element.hasAttribute('data-pin-clean')) return cleanHeight;
    if (element.tagName === 'ARTICLE') {
      const id = element.getAttribute('data-attention-id');
      return id !== null && cardHeights[id] !== undefined ? cardHeights[id] : cardHeight;
    }
    if (element.hasAttribute('data-pin-list')) {
      const rows = element.querySelectorAll('[data-attention-id]').length - 1;
      const article = element.querySelector('article');
      const card = article === null ? 0 : laidOut(article);
      const clean = element.querySelector('[data-pin-clean]');
      const content =
        card + Math.max(0, rows) * PER_ROW + (clean === null ? 0 : PIN_GEOMETRY.gap + cleanHeight);
      /* the clip is real: the list is never taller than the belt it wears */
      const cap = /max-height:\s*([\d.]+)px/.exec(element.getAttribute('style') ?? '');
      return cap === null ? content : Math.min(Number(cap[1]), content);
    }
    if (element.getAttribute('data-region') === 'needs-you') {
      const list = element.querySelector('[data-pin-list]');
      const control = element.querySelector('[data-pin-overflow]');
      return CHROME + (list === null ? 0 : laidOut(list)) + (control === null ? 0 : CONTROL);
    }
    return 0;
  }

  beforeEach(() => {
    observers.length = 0;
    cardHeight = 72;
    cardHeights = {};
    cleanHeight = 0;
    realHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    /* the pane. `clientHeight` is what `measure` reads for the room it has. */
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.firstElementChild?.getAttribute('data-region') === 'needs-you' ? CONTAINER : 0;
      },
    });
    realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
      const height = laidOut(this);
      return {
        height,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
    realObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly record: FakeObserver;
      constructor(callback: () => void) {
        this.record = { targets: [], live: true, fire: callback };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.record.live = false;
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    if (realObserver === undefined) {
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = undefined;
    } else {
      globalThis.ResizeObserver = realObserver;
    }
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
  });

  /** everything currently observing, fired once each, as a reshape would */
  function reshape() {
    act(() => {
      for (const observer of [...observers].filter((o) => o.live)) observer.fire();
    });
  }

  /** ONLY the observers watching `target`, as a resize of that one box would
      fire — a box that nothing is observing fires nothing, which is the whole
      point of watching the clean summary and the card directly. */
  function reshapeOnly(target: Element | null) {
    act(() => {
      for (const observer of [...observers].filter(
        (o) => o.live && o.targets.includes(target as Element),
      ))
        observer.fire();
    });
  }

  function budgetOf(container: HTMLElement): string | null {
    return container.querySelector('[data-pin-list]')?.getAttribute('data-pin-budget') ?? null;
  }

  function overflowOf(container: HTMLElement): number {
    const control = container.querySelector('[data-pin-overflow]');
    return control === null ? 0 : Number(control.getAttribute('data-pin-overflow'));
  }

  /* CATCHES the finding exactly: a card that grows while the window and the
     pane hold still. Under round 9 nothing fired (the observer watched the
     container) and nothing would have moved if it had (the card was an
     allowance), so the pin kept drawing four rows into a belt that now holds
     three — rows the fold counts as visible and the clip eats. */
  it('a card that grows costs a row without the window or the pane moving', () => {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const drawn = () => container.querySelectorAll('[data-pin-list] [data-attention-id]').length;
    /* 300px of pane less 90px of chrome is a 210px belt; a 72px card leaves
       three rows of 41. */
    const settled = pinBudgetForBelt(CONTAINER - CHROME - CONTROL, { open: 72, clean: 0 });
    expect(settled).toBe(3);
    expect(budgetOf(container)).toBe(String(settled));
    expect(drawn()).toBe(settled + 1);

    // the title wraps five more lines. Nothing outside the pin has moved.
    cardHeight = 72 + 5 * PIN_GEOMETRY.titleLine;
    reshape();
    const grown = pinBudgetForBelt(CONTAINER - CHROME - CONTROL, { open: cardHeight, clean: 0 });
    expect(grown, 'a card that grew 71px did not cost a row').toBeLessThan(settled);
    expect(budgetOf(container), 'the grown card cost nothing').toBe(String(grown));
    expect(drawn()).toBe(grown + 1);

    /* and it RECOVERS: the ratchet that makes the settling loop terminate has a
       reset, so a card that shrank raises the budget again rather than pinning
       the pin to the worst thing it ever measured. */
    cardHeight = 72;
    reshape();
    expect(budgetOf(container), 'the budget never came back').toBe(String(settled));
    expect(drawn()).toBe(settled + 1);
  });

  /* CATCHES: the observer going back to watching the container alone. The list
     is watched for its own sake and the card because the clip pins the list's
     height, so a card growing inside it moves no box further out. */
  it('the observer watches the pin’s own boxes, not only the pane it sits in', () => {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const watched = new Set([...observers].filter((o) => o.live).flatMap((o) => o.targets));
    const root = container.querySelector('[data-region="needs-you"]');
    const list = container.querySelector('[data-pin-list]');
    const card = container.querySelector('[data-pin-list] article');
    expect(card, 'the pin drew no open card').not.toBeNull();
    expect(watched.has(root as Element), 'nothing is watching the pin').toBe(true);
    expect(watched.has(list as Element), 'nothing is watching the list').toBe(true);
    expect(watched.has(card as Element), 'nothing is watching the card that grows').toBe(true);
    expect(watched.has(root?.parentElement as Element), 'nothing is watching the pane').toBe(true);
  });

  /* CONVERGENCE, ASSERTED RATHER THAN ASSUMED. Measuring the pin's own height
     and then changing it is a feedback loop, and a loop that settles is a claim
     until something drives it. One observer is constructed per commit here, so
     the count of observers IS the count of commits: a reshape that changes
     nothing must commit nothing, and one that does must stop. */
  it('the settling loop reaches a fixed point and stops committing', () => {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    /* THE LOOP RAN: the pin was serving the full budget, measured, found the
       control in its own chrome, and came down. That is the feedback edge. */
    expect(budgetOf(container)).not.toBe(String(PIN_COMPACT_BUDGET));

    /* AND IT IS A FIXED POINT, not a resting place: re-derive the budget from
       the pin as it now stands and get the same answer back. */
    const root = container.querySelector('[data-region="needs-you"]') as HTMLElement;
    const list = container.querySelector('[data-pin-list]') as HTMLElement;
    const chrome = root.getBoundingClientRect().height - list.getBoundingClientRect().height;
    expect(chrome, 'the overflow control is not in the pin’s chrome').toBe(CHROME + CONTROL);
    expect(budgetOf(container)).toBe(
      String(pinBudgetForBelt(CONTAINER - chrome, { open: cardHeight, clean: 0 })),
    );

    const settled = observers.length;
    for (let i = 0; i < 10; i += 1) reshape();
    expect(observers.length, 'the pin re-rendered itself on a reshape it had already seen').toBe(
      settled,
    );

    /* one input moves; the loop takes a bounded number of passes and stops */
    cardHeight = 240;
    for (let i = 0; i < 10; i += 1) reshape();
    const after = observers.length;
    expect(after - settled, 'the pin did not settle after the card changed').toBeLessThanOrEqual(3);
    for (let i = 0; i < 10; i += 1) reshape();
    expect(observers.length, 'the pin never stopped re-measuring').toBe(after);
  });

  /* ROUND 11, FINDING 1(b) — THE OVERFLOW COUNT MOVES WHEN THE OPEN CARD GROWS.
     The round-2 receipt claimed a grown card drops a row and takes the overflow
     from 29 to 30; the page critic drove the real page and saw the overflow
     count SIT STILL. This drives the same feedback in jsdom and reads the control
     the reader reads: growing the open card must increment `data-pin-overflow`,
     not just some internal budget. CATCHES: the ladder ignoring the measured card
     (the allowance mutant), which leaves the count reporting a page that is no
     longer true. */
  it('growing the open card moves the overflow count the reader sees', () => {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    /* 210px belt (300 pane − 90 chrome), a 72px card: three rows, 30 owed off the
       page. */
    expect(budgetOf(container)).toBe('3');
    const drawn = () => container.querySelectorAll('[data-pin-list] [data-attention-id]').length;
    expect(drawn()).toBe(4);
    expect(overflowOf(container)).toBe(30);

    /* grow ONLY the open card — the reference, at budget ≥ 1 — not every card. */
    const refId = container
      .querySelector('[data-pin-list] article')
      ?.getAttribute('data-attention-id') as string;
    expect(refId, 'the pin drew no open card').toBeTruthy();
    cardHeights[refId] = 100;
    reshape();

    expect(budgetOf(container), 'the grown card cost no row').toBe('2');
    expect(drawn()).toBe(3);
    expect(overflowOf(container), 'the count still reads the page before the card grew').toBe(31);
  });

  /* ROUND 11, FINDING 1(a) — THE CIRCULAR DEPENDENCY THAT OSCILLATED.
     `foldPin`'s budget-0 branch pages the OPEN CARD so every owed item stays
     reachable at a viewport with no room for a row. That makes the card the pin
     draws a function of the budget — and if the budget is then priced against
     that card, the two chase each other: a tall reference card says "no room for
     a row" (budget 0), which pages to a SHORT card, which says "a row fits"
     (budget 1), which draws the tall reference again… forever, the episode key
     changing every pass so the ratchet never engages. A fixture with one global
     card height cannot see this — the reference and the paged card have to
     DIFFER. The budget must be priced against the reference (the card shown
     whenever a row shows), never the paging artifact.
     CATCHES: pricing the open card against `firstElementChild` — the paged-to
     card — instead of the cached reference height. */
  it('a tall reference and a short paged card do not chase each other at the boundary', () => {
    const items = f.manyOwed(34);
    const refId = foldPin(items, { budget: 0, page: 0 }).open?.id as string;
    const pagedId = foldPin(items, { budget: 0, page: 1 }).open?.id as string;
    expect(refId).not.toBe(pagedId);
    /* 210px belt: no room for a row beside a 180px card, room for one beside a
       168px card. Under the defect, paging from ref to paged flips the budget
       0→1→0→… without anything outside the pin moving. */
    cardHeights[refId] = 180;
    cardHeights[pagedId] = 168;
    const { container } = render(
      <Pin items={items} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    /* priced against the reference, there is no room for a compressed row */
    expect(budgetOf(container)).toBe('0');
    const before = observers.length;

    /* page to the short card. The budget is priced against the reference still,
       so it must not move — and the loop must stop. */
    const control = container.querySelector('[data-pin-overflow]') as HTMLElement;
    fireEvent.click(control);
    expect(
      container.querySelector('[data-pin-list] article')?.getAttribute('data-attention-id'),
      'the click did not page the card',
    ).toBe(pagedId);
    expect(budgetOf(container), 'the paged-to card fed the budget that pages it').toBe('0');

    const afterClick = observers.length;
    expect(afterClick - before, 'paging to a shorter card churned commits').toBeLessThanOrEqual(3);
    for (let i = 0; i < 12; i += 1) reshape();
    expect(
      observers.length,
      'the pin never stopped re-measuring — the open card and the budget are chasing each other',
    ).toBe(afterClick);
  });

  /* ROUND 11, FINDING 2 — THE CLEAN SUMMARY IS OBSERVED.
     The clean-item line is a child of the clipped list, so a late font load that
     wraps it changes no box further out and fires no React commit — only a
     ResizeObserver on the clean box itself can catch it. Round 9 watched the
     pane, the pin, the list and the card, but not this. CATCHES: dropping the
     clean box from the observe set, which lets a wrapped clean line clip in
     silence. */
  it('the observer watches the clean summary, so a late wrap of it is measured', () => {
    const items = [...f.manyOwed(6), settled('done-1'), settled('done-2')];
    cleanHeight = 20;
    const { container } = render(
      <Pin items={items} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const cleanBox = container.querySelector('[data-pin-clean]');
    expect(cleanBox, 'the pin drew no clean summary').not.toBeNull();

    const watched = new Set([...observers].filter((o) => o.live).flatMap((o) => o.targets));
    expect(watched.has(cleanBox as Element), 'nothing is watching the clean summary').toBe(true);

    /* the clean line wraps to five more lines on a late font load. Nothing else
       moves: the list is pinned by its clip, the card is unchanged. Only the
       clean box's own observer can carry this. */
    const before = budgetOf(container);
    cleanHeight = 120;
    reshapeOnly(cleanBox);
    expect(Number(budgetOf(container)), 'the wrapped clean line went unmeasured').toBeLessThan(
      Number(before),
    );
  });
});

/* ---------------------------------------------------------------------------
 * THE WAY OUT OF THE FOLD IS NOT INSIDE THE THING THAT CLIPS.
 *
 * Found by the blind cross-lineage review of round 5: the row budget is computed
 * from a MEASURED card height, and `AttentionCard` bounds neither its title nor
 * its action count — so an item with a long enough title pushes the card past
 * the belt, and while the "N more owed" control was a child of `.pinList` the
 * first thing `overflow: hidden` took was the control. Owed items behind an
 * affordance that cannot be reached is round 2's stranding defect with a
 * different cause.
 *
 * The pixel half is in e2e/pin-bound.spec.ts, which stretches a title past the
 * clamp and asserts the control is still hit-testable. This is the structural
 * half, and it is the one that holds without a browser: the control is a
 * SIBLING of the clipped list, so no amount of card growth can eat it.
 * ------------------------------------------------------------------------- */
describe('the affordance out of the fold is outside the clip', () => {
  /* CATCHES: the overflow control going back inside the clipped box, by
     nesting or by wearing the clipped box's own class. */
  it('the overflow control is not a descendant of the clipped list', () => {
    const { container } = render(
      <Pin items={f.manyOwed(34)} lastCheck="12:29" trailer={TRAILER} viewer="lars" />,
    );
    const list = container.querySelector('[data-pin-list]');
    const more = container.querySelector('[data-pin-overflow]');
    expect(list, 'the pin rendered no list').not.toBeNull();
    expect(more, 'the pin rendered no overflow control').not.toBeNull();
    expect(
      list?.contains(more as Node),
      'the way out of the fold is inside the box that clips',
    ).toBe(false);
    /* and not merely un-nested: it must not be wearing the clipping class
       either, which is the cheapest way to reintroduce the same defect. */
    const clipped = list?.className ?? '';
    expect(clipped).not.toBe('');
    expect(
      (more as HTMLElement | null)?.closest(`.${clipped.trim().split(/\s+/).join('.')}`),
      'the way out of the fold wears the clipping belt itself',
    ).toBeNull();
  });
});
