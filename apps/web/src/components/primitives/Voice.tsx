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
 *                 THE ATTRIBUTION IS DERIVED. There is no `by` prop. Round 1:
 *                 a name passed beside a quotation is a name nothing checks,
 *                 and priya's could sit over lars's sentence with no cast and
 *                 no error. The actor comes off the quotation, which was minted
 *                 from the same message as the words.
 *
 *   <SystemVoice> system voice. Mono, muted, NO quotation marks, no first
 *                 person, no "X said" framing. Its `statement` prop is a
 *                 `SystemStatement`, which is a different type from the one
 *                 <Quoted> takes: the two cannot be swapped by mistake.
 * ------------------------------------------------------------------------- */

import type { Quotation, SystemStatement } from '../model/quotation';
import { quotationRef } from '../model/quotation';
import styles from './primitives.module.css';

export interface QuotedProps {
  readonly quote: Quotation;
  /** hide the attribution line where the surrounding row already carries it */
  readonly attributed?: boolean;
  readonly className?: string;
}

export function Quoted({ quote, attributed = true, className }: QuotedProps) {
  return (
    <>
      <q
        className={[styles.quote, className].filter(Boolean).join(' ')}
        data-quoted={quotationRef(quote)}
      >
        {quote.text}
      </q>
      {attributed ? (
        <span className={styles.quoteSource} data-attribution={quote.messageId}>
          — {quote.actor} {quote.at}, {quote.origin === 'typed' ? 'typed here' : 'on the record'}
        </span>
      ) : null}
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
