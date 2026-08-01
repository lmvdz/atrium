/* ---------------------------------------------------------------------------
 * Test harness: render inside a record ledger.
 *
 * Since round 5 a `Quotation` is a message id, and the actor, the words and the
 * time are looked up from the page's records at the render boundary. So a test
 * that renders anything carrying a quotation has to say which records exist —
 * which is the point: a component that renders one without a ledger throws, and
 * `renderBare` below is how that is asserted rather than worked around.
 * ------------------------------------------------------------------------- */

import type { RenderResult } from '@testing-library/react';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AttributionLedger } from '../src/components';
import type { MessageRecord } from '../src/components/model';

export function renderWith(records: readonly MessageRecord[], ui: ReactElement): RenderResult {
  return render(<AttributionLedger messages={records}>{ui}</AttributionLedger>);
}

/** No ledger at all — the case a render boundary must refuse rather than fudge. */
export const renderBare = render;

export interface RefusedRender {
  readonly container: HTMLElement;
  /** what React reported, in the order it reported it */
  readonly reported: readonly string[];
}

/**
 * RENDER SOMETHING THAT IS EXPECTED TO THROW DURING RENDER, AND CATCH WHAT
 * REACT REPORTS INSTEAD OF LETTING IT REACH THE PROCESS.
 *
 * Round 6, D1, and it is the reason `pnpm test` was exit 1 on a clean clone
 * while reporting 580 passed. React 19 answers a throw in a concurrent render by
 * retrying the whole root synchronously; when the retry succeeds it reports a
 * RECOVERABLE error, and the default `onRecoverableError` is `reportError()`,
 * which in jsdom becomes an uncaught exception. A test's own `try/catch` around
 * `render()` never sees it — the render did not fail, it recovered — so the
 * error escaped the test, escaped vitest's per-file accounting, and came out as
 * `Errors 1` with a non-zero exit beside a green summary.
 *
 * That is not a cosmetic mismatch. `test/mutations.mjs` decides "caught" purely
 * from whether the test command threw, so every ledger entry naming a file that
 * is ALREADY RED is credited no matter what the mutation does — two of round 5's
 * reported 101 were unchecked. The ledger now refuses an entry whose catcher is
 * red unmutated (see mutations.mjs), and this is the other half: the suite has
 * no reason to be red.
 *
 * The root is created here rather than through Testing Library because
 * `onRecoverableError` is a `createRoot` option and RTL does not forward one.
 * The reports are RETURNED rather than swallowed, so a test can assert that
 * React reported the refusal — which is a stronger claim than "it did not
 * print", and it is what makes the silence checkable rather than assumed.
 */
export function renderRefusing(ui: ReactElement): RefusedRender {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const reported: string[] = [];
  const collect = (error: unknown) => {
    reported.push(error instanceof Error ? error.message : String(error));
  };
  const root = createRoot(container, {
    onCaughtError: collect,
    onRecoverableError: collect,
    onUncaughtError: collect,
  });
  act(() => {
    root.render(ui);
  });
  act(() => {
    root.unmount();
  });
  return { container, reported };
}
