/* ---------------------------------------------------------------------------
 * The glyph. Takes state, never a glyph.
 *
 * `NoGlyph` is intersected into the props: `glyph`, `mark`, `icon`, `symbol`
 * and `tone` are all typed `never`, so `<Glyph state={s} glyph="✓" />` is a
 * compile error. The only path to a glyph on screen runs through `glyphFor`.
 * ------------------------------------------------------------------------- */

import type { EpistemicState, NoGlyph } from '../model/glyph';
import { glyphFor, glyphMeaning, glyphTone } from '../model/glyph';
import { hardestState } from '../model/records';
import styles from './primitives.module.css';

export type GlyphProps = {
  readonly state: EpistemicState;
  /** the glyph is decorative next to text that already says it; default true */
  readonly decorative?: boolean;
  readonly className?: string;
} & NoGlyph;

const TONE_CLASS = {
  verified: styles.verified,
  needs: styles.needs,
  destructive: styles.destructive,
  failed: styles.failed,
  neutral: styles.neutral,
} as const;

export function Glyph({ state, decorative = true, className }: GlyphProps) {
  const glyph = glyphFor(state);
  const tone = glyphTone(glyph);
  /* Derived from the glyph, which is derived from the state: seven possible
     values, all written in model/glyph.ts. `glyphMeaning`'s return type is the
     union of those seven literals, so the printed-string sweep can SEE that no
     caller text reaches this tooltip — it used to be told so by an exemption
     naming this variable, which is a list where a type would do. */
  const meaning = glyphMeaning(glyph);
  const shared = {
    className: [styles.glyph, TONE_CLASS[tone], className].filter(Boolean).join(' '),
    title: meaning,
    'data-glyph': glyph,
    'data-tone': tone,
  };

  // Beside a row that already says who claimed what, the glyph is a visual
  // restatement and a screen reader should skip it. Standing alone — the pin
  // head, the trailer — it is the only thing carrying the epistemic state, so
  // it announces itself.
  if (decorative) {
    return (
      <span {...shared} aria-hidden="true">
        {glyph}
      </span>
    );
  }
  return (
    <span {...shared} aria-label={meaning} role="img">
      {glyph}
    </span>
  );
}

export type AggregateGlyphProps = {
  /**
   * The set this glyph stands for. It renders the hardest member's state, so the
   * glyph, its tone and its tooltip are all derived from an item that is
   * actually in the set.
   */
  readonly over: readonly { readonly state: EpistemicState }[];
  readonly decorative?: boolean;
  readonly className?: string;
} & NoGlyph;

/**
 * ONE GLYPH FOR A WHOLE SET — ROUND 10, D1.
 *
 * The pin's head, the rail's owed chip and the composer's binding banner all
 * answer "what is the worst thing in this set". Two of the three wrote the
 * character by hand, because there was no component that took a SET; `<Glyph>`
 * takes one state, and a caller holding four items had nothing to hand it.
 *
 * It renders NOTHING for an empty set. An empty set has no state, and the
 * fallback the pin used to carry — `{headGlyph ?? '·'}` — is a hand-written glyph
 * with a `??` in front of it: `·` means "routine, no attention owed", which is a
 * claim about items that are not there.
 */
export function AggregateGlyph({ over, decorative = true, className }: AggregateGlyphProps) {
  const state = hardestState(over);
  if (state === null) return null;
  return <Glyph className={className} decorative={decorative} state={state} />;
}
