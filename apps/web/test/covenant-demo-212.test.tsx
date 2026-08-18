/* ═══════════════════════════════════════════════════════════════════════════
 * COVENANT DEMO — the #212 flip-the-input, end to end over the WHOLE demo.
 *
 * `certify-passage.test.tsx` pins the panel-level regression (a completed certify
 * receipt must not outlive the body it described). This proves the SAME truth over
 * the mounted `CovenantDemo`: certify a span in Pane A, drive a peer edit in Pane B,
 * and assert the RELATION the cardinal #212 bug broke —
 *   the resolver-driven feed glyph flips ✓→~ (it always did), AND
 *   the certify panel's standing ✓ / "now stands" receipt is GONE (it used to lie),
 * so the two never disagree. Then an exact revert re-validates the feed glyph to ✓.
 *
 * This is the flip-the-input probe for this glyph over the real component graph: the
 * unit suite never mounted CovenantDemo, which is why the false-✓ slipped a blind
 * gauntlet.
 * ═════════════════════════════════════════════════════════════════════════ */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CovenantDemo } from '../app/prototype/covenant-demo/CovenantDemo';
import { BODY_ROOT_ATTR } from '../app/prototype/certify-span';

/* The certify hold is an elapsed-time gate over a rAF chain; fake all of it so a
   full press is deterministic (matches certify-passage.test.tsx / hold-to-act). */
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** The first descendant text node of the (single) certify-body root — Pane A's. */
function firstBodyTextNode(): Text {
  const root = document.querySelector(`[${BODY_ROOT_ATTR}]`);
  if (!root) throw new Error('certify body root not rendered');
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3) return n as Text;
    for (let i = 0; i < n.childNodes.length; i++) {
      const child = n.childNodes[i];
      const hit = child ? walk(child) : null;
      if (hit) return hit;
    }
    return null;
  };
  const node = walk(root);
  if (!node) throw new Error('certify body has no text node');
  return node;
}

/** Put a real DOM selection over `[from, to)` of Pane A's body and fire the mouseup
    the surface syncs on — the exact path a human drag produces. */
function selectChars(from: number, to: number) {
  const node = firstBodyTextNode();
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  act(() => {
    sel.removeAllRanges();
    sel.addRange(range);
    const root = document.querySelector(`[${BODY_ROOT_ATTR}]`) as HTMLElement;
    fireEvent.mouseUp(root.parentElement ?? root);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the whole demo: a peer edit flips the feed glyph AND clears the panel receipt (#212)', () => {
  it('certify → peer char-edit → feed ~ and NO standing panel ✓; exact revert → feed ✓', async () => {
    render(<CovenantDemo />);

    // ── certify a passage in Pane A ─────────────────────────────────────────
    selectChars(0, 11); // "The invoice" of the agent's message
    const hold = screen.getByRole('button', { name: /Certify this passage/ });
    fireEvent.pointerDown(hold);
    advance(2100); // past the 2s gate → onCertify captures a real client anchor
    await flush();

    // The panel paints the standing receipt (the pre-fix false-✓ lived here).
    expect(screen.getByText(/a human certification now stands over this span/)).toBeTruthy();
    // Both panes now render a certified feed glyph over the target message.
    for (const g of screen.getAllByTestId('glyph-m-agent')) {
      expect(g.getAttribute('data-covenant-status')).toBe('ok');
    }

    // ── a peer edits ONE char inside the certified span (Pane B) ─────────────
    await act(async () => {
      fireEvent.click(screen.getByTestId('peer-edit-char'));
    });
    await flush();

    // THE RELATION #212 broke: the feed glyph flipped to drift on BOTH panes …
    for (const g of screen.getAllByTestId('glyph-m-agent')) {
      expect(g.getAttribute('data-covenant-status')).not.toBe('ok');
    }
    // … AND the panel's standing ✓ / "now stands" receipt is GONE (no lie left
    // hanging over drifted content). The whole outcome row unmounts on convergence.
    expect(screen.queryByTestId('certify-outcome')).toBeNull();
    expect(screen.queryByText(/now stands over this span/)).toBeNull();
    expect(screen.queryByText(/certified — a human certification/)).toBeNull();

    // ── an exact revert re-validates the feed glyph to ✓ ─────────────────────
    await act(async () => {
      fireEvent.click(screen.getByTestId('peer-revert'));
    });
    await flush();
    for (const g of screen.getAllByTestId('glyph-m-agent')) {
      expect(g.getAttribute('data-covenant-status')).toBe('ok');
    }
    // The panel does NOT resurrect a receipt on the revert — the standing truth is
    // the feed glyph's alone; the panel only ever shows a fresh act-receipt.
    expect(screen.queryByText(/now stands over this span/)).toBeNull();
  });
});
