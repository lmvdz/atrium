/* ---------------------------------------------------------------------------
 * The glyph. Takes state, never a glyph.
 *
 * `NoGlyph` is intersected into the props: `glyph`, `mark`, `icon`, `symbol`
 * and `tone` are all typed `never`, so `<Glyph state={s} glyph="✓" />` is a
 * compile error. The only path to a glyph on screen runs through `glyphFor`.
 * ------------------------------------------------------------------------- */

import type { EpistemicState, NoGlyph } from '../model/glyph';
import { glyphFor, glyphMeaning, glyphTone } from '../model/glyph';
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
     values, all written in model/glyph.ts. Named here because the printed-string
     sweep exempts it by name and the exemption has to be findable. */
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
