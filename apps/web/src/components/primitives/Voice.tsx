/* ---------------------------------------------------------------------------
 * The two voices, kept visibly apart. See design/CONVENTIONS.md, "No
 * synthesized speech".
 *
 *   <Quoted>      human voice. Italic, inside <q>, attributed, carrying its
 *                 provenance on the DOM as data-quoted. Its `quote` prop is a
 *                 `Quotation`, which model/quotation.ts will not mint from a
 *                 page-authored message — so there is no way to render
 *                 page-authored text through this component.
 *
 *   <SystemVoice> system voice. Mono, muted, NO quotation marks, no first
 *                 person, no "X said" framing. Its `statement` prop is a
 *                 `SystemStatement`, which is a different type from the one
 *                 <Quoted> takes: the two cannot be swapped by mistake.
 * ------------------------------------------------------------------------- */

import type { Quotation, SystemStatement } from '../model/quotation';
import { quotationRef } from '../model/quotation';
import type { Maybe } from '../model/text';
import { text } from '../model/text';
import styles from './primitives.module.css';

export interface QuotedProps {
  readonly quote: Quotation;
  /** who typed it. Rendered as attribution beneath the words. */
  readonly by: Maybe<string>;
  readonly className?: string;
}

export function Quoted({ quote, by, className }: QuotedProps) {
  const attribution = text(by);
  return (
    <>
      <q
        className={[styles.quote, className].filter(Boolean).join(' ')}
        data-quoted={quotationRef(quote)}
      >
        {quote.text}
      </q>
      {attribution === null ? null : (
        <span className={styles.quoteSource}>
          — {attribution}, {quote.origin === 'typed' ? 'typed here' : 'on the record'}
        </span>
      )}
    </>
  );
}

export interface SystemVoiceProps {
  readonly statement: SystemStatement;
  readonly className?: string;
}

export function SystemVoice({ statement, className }: SystemVoiceProps) {
  return (
    <div className={[styles.system, className].filter(Boolean).join(' ')} data-voice="system">
      {statement.text}
    </div>
  );
}
