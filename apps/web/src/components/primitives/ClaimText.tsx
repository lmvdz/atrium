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
import { truthUnchecked } from '../model/glyph';
import type { Slot } from '../model/slot';

export type ClaimTextProps = {
  readonly state: EpistemicState;
  readonly content: Slot;
  readonly className?: string;
} & NoGlyph;

/**
 * The underline flags "nothing outside the claimant has checked this" — the
 * TRUTH axis, independent of the `✓`/`~` CERTIFICATION glyph. After #98 split
 * the two, a person accepting a self-reported claim certifies it (`accepted`,
 * `✓`) without anything fact-checking its truth; that is a settled certification
 * but still an unchecked claim, so the underline must stay. That predicate,
 * `truthUnchecked`, lived here as a private copy until the round-4 root sweep
 * moved it to `model/glyph` so `StateLens`'s count and `trailerFor`'s copy speak
 * of the SAME set the row underlines — one truth predicate, every consumer.
 */
export function ClaimText({ state, content, className }: ClaimTextProps) {
  const claim = truthUnchecked(state);
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
