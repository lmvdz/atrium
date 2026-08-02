/* ---------------------------------------------------------------------------
 * ClaimText — the dotted underline that separates "someone said it" from "the
 * system checked it".
 *
 * It derives the treatment from the same EpistemicState the glyph derives from,
 * and independently of the glyph: a proposal that is also a gate renders ◆ AND
 * dotted. Deriving the underline from the glyph is how a proposal owed to you
 * silently dresses as settled prose.
 *
 * Its content is a `Slot`, not a `ReactNode`. Round 1: an unrestricted children
 * prop on the component that wraps message text is a hole straight through the
 * quotation model — `<ClaimText state={s}><q>invented words</q></ClaimText>`
 * compiled. See model/slot.ts for exactly how much the slot stops.
 * ------------------------------------------------------------------------- */

import type { EpistemicState, NoGlyph } from '../model/glyph';
import { isClaim } from '../model/glyph';
import type { Slot } from '../model/slot';

export type ClaimTextProps = {
  readonly state: EpistemicState;
  readonly content: Slot;
  readonly className?: string;
} & NoGlyph;

export function ClaimText({ state, content, className }: ClaimTextProps) {
  const claim = isClaim(state);
  return (
    <span
      className={[claim ? 'atr-claim' : null, className].filter(Boolean).join(' ')}
      data-claim={claim ? 'true' : undefined}
      title={claim ? 'nothing outside the claimant has checked this' : undefined}
    >
      {content.node}
    </span>
  );
}
