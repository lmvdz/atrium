import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { locallyAcceptedState } from '../lib/replay-view';
import { ClaimText, StateLens } from '../src/components';
import type { EpistemicState, StateObject } from '../src/components/model';
import { glyphFor, slot, trailerFor, truthUnchecked } from '../src/components/model';

afterEach(cleanup);

/**
 * THE ROOT-SWEEP ACCEPTANCE BAR (#98 r4).
 *
 * Three rounds fixed INSTANCES of one class — a glyph or a count that read its
 * own second source instead of the one predicate — and the reviewer kept finding
 * siblings. This is the invariant test that fixing the instance never was: it
 * flips ONE fact and asserts EVERY consumer of that fact moves. If a covenant
 * surface does not move here, it is still a second source.
 *
 * Two orthogonal axes, one predicate each:
 *
 *   CERTIFICATION (`~`/`✓`) — did a PERSON take this? — is `epistemicStateOf`,
 *   reached here through `locallyAcceptedState` (which delegates to it). Its
 *   consumers are the row glyph (`glyphFor`) and the lens's "settled" count.
 *
 *   CLAIM-TRUTH ("nothing outside the claimant has checked this") — is
 *   `truthUnchecked`, the ONE predicate this round centralised. Its consumers are
 *   the row underline (`ClaimText`), the lens's "unverified" count, and the
 *   trailer's "everything is verified" copy.
 *
 * The two axes are independent, and the second flip proves it: certification is
 * held at `✓` while truth flips, and the glyph does NOT move — only the truth
 * consumers do. A consumer that moved on the wrong flip would be reading the
 * wrong axis, which is the whole defect class.
 */

const CLAIM_TEXT = 'the deploy cleared the canary';
const AT = '2026-08-05T12:00:00.000Z';

/** A machine's reading of a claim — no person has touched it. `~`, truth unchecked. */
const machineReading: EpistemicState = {
  kind: 'claim',
  verification: 'self_reported',
  owedToViewer: false,
  irreversible: false,
};

/**
 * A person certified that same claim — through the ONE predicate. `✓`, and its
 * truth is STILL unchecked (a person taking a claim is not a fact-check). Flip
 * `epistemicStateOf` and this reverts to the machine reading, so certification
 * here is genuinely predicate-derived, not hand-set.
 */
const personCertified: EpistemicState = locallyAcceptedState(machineReading, AT);

/** The same certified claim, now checked by something other than the claimant. `✓`, truth checked. */
const personCertifiedAndChecked: EpistemicState = { ...personCertified, verification: 'verified' };

function object(state: EpistemicState): StateObject {
  return { id: 'claim-1', kind: 'claim', state, text: CLAIM_TEXT, facts: [], objectives: [] };
}

/** The lens head's own count line — the span the live pulse precedes. */
function lensCounts(objects: readonly StateObject[]): string {
  const { container } = render(
    <StateLens objectives={[]} objects={objects} roomName="general" updatedAt="12:00" />,
  );
  const region = container.querySelector('[data-region="current-state"]');
  const counts = region?.querySelector('[data-live="true"]')?.nextElementSibling?.textContent;
  if (!counts) throw new Error('lens head count line must render');
  return counts;
}

/** Whether `ClaimText` dressed the row with the truth-unchecked underline. */
function rowUnderlined(state: EpistemicState): boolean {
  const { container } = render(<ClaimText content={slot(CLAIM_TEXT)} state={state} />);
  return container.querySelector('[data-claim="true"]') !== null;
}

describe('the rendered ✓ and "unchecked" derive from one predicate each, for every consumer', () => {
  it('CERTIFICATION flip (machine reading ~ → person-certified ✓): the glyph and the settled count both move', () => {
    // Predicate anchor: the certified state came from `epistemicStateOf`.
    expect(personCertified.verification).toBe('accepted');

    // Consumer 1 — the row glyph.
    expect(glyphFor(machineReading)).toBe('~');
    expect(glyphFor(personCertified)).toBe('✓');

    // Consumer 2 — the lens's "settled" count.
    expect(lensCounts([object(machineReading)])).toContain('0 settled');
    expect(lensCounts([object(personCertified)])).toContain('1 settled');
  });

  it('TRUTH flip (certified-unverified → certified-verified), certification HELD at ✓: only the truth consumers move', () => {
    // Certification does NOT move — both are `✓`. A truth flip that moved the
    // glyph would be a second `✓` source, the exact defect this ticket kills.
    expect(glyphFor(personCertified)).toBe('✓');
    expect(glyphFor(personCertifiedAndChecked)).toBe('✓');

    // The ONE truth predicate.
    expect(truthUnchecked(personCertified)).toBe(true);
    expect(truthUnchecked(personCertifiedAndChecked)).toBe(false);

    // Consumer 1 — the row underline (`ClaimText`).
    expect(rowUnderlined(personCertified)).toBe(true);
    expect(rowUnderlined(personCertifiedAndChecked)).toBe(false);

    // Consumer 2 — the lens's "unverified" count. The certified-unverified claim
    // is BOTH settled (a `✓`) and unverified (dotted), so it counts in both; the
    // certified-and-checked claim is settled only. Before the sweep this count
    // open-coded `isClaim` and called the certified-unverified claim fully
    // settled — the row said "unchecked", the count said "verified".
    const unverifiedCounts = lensCounts([object(personCertified)]);
    expect(unverifiedCounts).toContain('1 settled');
    expect(unverifiedCounts).toContain('1 unverified');
    const checkedCounts = lensCounts([object(personCertifiedAndChecked)]);
    expect(checkedCounts).toContain('1 settled');
    expect(checkedCounts).toContain('0 unverified');

    // Consumer 3 — the trailer's lead copy.
    const unverifiedTrailer = trailerFor({
      objects: [object(personCertified)],
      objectives: [],
      overdue: [],
    });
    expect(unverifiedTrailer.leadsWith).toBe('unverified');
    expect(unverifiedTrailer.lead.text).toContain('still unverified');

    const checkedTrailer = trailerFor({
      objects: [object(personCertifiedAndChecked)],
      objectives: [],
      overdue: [],
    });
    expect(checkedTrailer.leadsWith).toBe('clear');
    expect(checkedTrailer.lead.text).toContain('everything outside your list is verified');
  });
});
