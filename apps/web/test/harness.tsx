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
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AttributionLedger } from '../src/components';
import type { MessageRecord } from '../src/components/model';

export function renderWith(records: readonly MessageRecord[], ui: ReactElement): RenderResult {
  return render(<AttributionLedger messages={records}>{ui}</AttributionLedger>);
}

/** No ledger at all — the case a render boundary must refuse rather than fudge. */
export const renderBare = render;
