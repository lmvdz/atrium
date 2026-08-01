/* ---------------------------------------------------------------------------
 * ClaimText — the dotted underline that separates "someone said it" from "the
 * system checked it".
 *
 * It derives the treatment from the same EpistemicState the glyph derives from,
 * and independently of the glyph: a proposal that is also a gate renders ◆ AND
 * dotted. Deriving the underline from the glyph is how a proposal owed to you
 * silently dresses as settled prose.
 * ------------------------------------------------------------------------- */

import type { ReactNode } from 'react';
import type { EpistemicState, NoGlyph } from '../model/glyph';
import { isClaim } from '../model/glyph';

export type ClaimTextProps = {
  readonly state: EpistemicState;
  readonly children: ReactNode;
  readonly className?: string;
} & NoGlyph;

export function ClaimText({ state, children, className }: ClaimTextProps) {
  const claim = isClaim(state);
  return (
    <span
      className={[claim ? 'atr-claim' : null, className].filter(Boolean).join(' ')}
      data-claim={claim ? 'true' : undefined}
      title={claim ? 'nothing outside the claimant has checked this' : undefined}
    >
      {children}
    </span>
  );
}
