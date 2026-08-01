/* ---------------------------------------------------------------------------
 * THE PIN BOUNDS ITSELF.
 *
 * Round 1 measured the unbounded pin pushing the composer to 909px in a 900px
 * viewport at 19 owed items, with `scrollHeight` stuck at 900 — unreachable by
 * any means. The pixel half of this is measured in a browser
 * (e2e/pin-bound.spec.ts); this is the derivation half, which is the one that
 * has to be right for the pixels to have a chance.
 * ------------------------------------------------------------------------- */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { Pin } from '../src/components';
import type { AttentionItem, TrailerSummary } from '../src/components/model';
import { foldPin, PIN_COMPACT_BUDGET, rationale, trailerFor } from '../src/components/model';

afterEach(cleanup);

const TRAILER: TrailerSummary = trailerFor({ objects: [], objectives: [], overdue: 0 });

const LOADS = [4, 13, 19, 34] as const;

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
      <Pin items={f.manyOwed(n)} lastCheck="12:29" trailer={TRAILER} />,
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
    // @ts-expect-error — `folded` is gone: the pin bounds itself.
    render(<Pin folded={false} items={f.manyOwed(19)} lastCheck="12:29" trailer={TRAILER} />);
    expect(screen.getAllByText(/more owed/).length).toBeGreaterThan(0);
  });

  /* CATCHES: a head glyph hard-coded to ◆ while the pin holds a failure. The
     aggregate glyph is derived like every other glyph in the app. */
  it('the head glyph is derived from what the pin is holding', () => {
    const { container } = render(<Pin items={f.manyOwed(4)} lastCheck="12:29" trailer={TRAILER} />);
    // manyOwed(4) contains a ✗ failure, which outranks ■ and ◆
    expect(container.querySelector('[data-pin-glyph]')?.textContent).toBe('✗');
  });
});
