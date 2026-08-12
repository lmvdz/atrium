'use client';

/* ---------------------------------------------------------------------------
 * The two voices, kept visibly apart. See design/CONVENTIONS.md, "No
 * synthesized speech".
 *
 *   <Quoted>      human voice. Italic, inside <q>, attributed, carrying its
 *                 provenance on the DOM as data-quoted. Its `quote` prop is a
 *                 `Quotation`, which is a MESSAGE ID: the words, the name and
 *                 the time are looked up from the page's record ledger here, at
 *                 render.
 *
 *                 THE ATTRIBUTION IS DERIVED. There is no `by` prop — round 1:
 *                 a name passed beside a quotation is a name nothing checks —
 *                 and since round 5 there is no `actor` on the quotation either,
 *                 because round 4 forged one by spreading a real quotation and
 *                 overwriting that field. Both halves come out of one record.
 *
 *   <SystemVoice> system voice. Mono, muted, NO quotation marks, no first
 *                 person, no "X said" framing. Its `statement` prop is a
 *                 `SystemStatement`, which is a different type from the one
 *                 <Quoted> takes: the two cannot be swapped by mistake.
 *
 *                 A statement knows which of its words the system WROTE and
 *                 which it is REPORTING back from a button somebody clicked, and
 *                 the reported span is marked on the DOM (`data-verbatim`) so
 *                 the distinction is checkable in a browser rather than only in
 *                 the model.
 * ------------------------------------------------------------------------- */

import { useAttribution } from '../model/ledger';
import type { Quotation, SystemStatement } from '../model/quotation';
import { quotationRef, statementText } from '../model/quotation';
import styles from './primitives.module.css';

export interface QuotedProps {
  readonly quote: Quotation;
  /** hide the attribution line where the surrounding row already carries it */
  readonly attributed?: boolean;
  readonly className?: string;
}

export function Quoted({ quote, attributed = true, className }: QuotedProps) {
  const attribution = useAttribution(quote, 'Quoted');
  /* WHO WROTE THESE WORDS IS PART OF THE QUOTATION. An agent's words are real
     and quotable, but rendering them in the human register — italic, the reading
     font — would read as a person's. So a cited machine takes the machine
     register (upright mono) and its source line names the kind, the same
     no-synthesized-speech rule the feed row applies, reached through a citation.
     Read off the resolved record, never a carried flag. */
  const nonHuman = attribution.authorKind === 'agent' || attribution.authorKind === 'unknown';
  const kindWord =
    attribution.authorKind === 'agent'
      ? 'agent'
      : attribution.authorKind === 'unknown'
        ? 'unknown'
        : null;
  return (
    <>
      <q
        className={[styles.quote, nonHuman ? styles.quoteMachine : null, className]
          .filter(Boolean)
          .join(' ')}
        data-quoted={quotationRef(attribution)}
        data-author-kind={nonHuman ? attribution.authorKind : undefined}
      >
        {attribution.text}
      </q>
      {attributed ? (
        <span className={styles.quoteSource} data-attribution={attribution.messageId}>
          — {attribution.actor}
          {kindWord === null ? '' : ` · ${kindWord}`} {attribution.at},{' '}
          {attribution.origin === 'typed' ? 'typed here' : 'on the record'}
        </span>
      ) : null}
    </>
  );
}

export interface SystemVoiceProps {
  readonly statement: SystemStatement;
  readonly className?: string;
  /**
   * Render as a `<span>` rather than a `<div>`, for the places a statement sits
   * inside a sentence (the receipt's history line, a correction's was → now).
   *
   * It is a flag on THIS component rather than a second component, on purpose:
   * round 5's finding was that four components printed `statement.text` directly
   * because putting a statement on screen was easy to do without going through
   * the one checked path. A second inline component would be a second path.
   */
  readonly inline?: boolean;
}

export function SystemVoice({ statement, className, inline = false }: SystemVoiceProps) {
  /* THE CHECK ON THE PATH EVERY SYSTEM-VOICE RENDER TAKES. The bans held at the
     constructor and at the JSON parser, and this component printed whatever it
     was handed — so a cast or a `JSON.parse` put a first-person sentence into
     the mono-muted treatment that tells a reader the system checked this. Same
     shape as the attribution half: the constructor is a door, the renderer is
     the path. Found by the blind cross-lineage review of round 5. */
  /* SNAPSHOT FIRST, THEN CHECK, THEN RENDER THE SNAPSHOT. Validating the value
     and then reading it again is a time-of-check/time-of-use gap: a getter or a
     Proxy can return one string to the checker and another to the renderer.
     Copying the spans into plain data first means the thing checked and the
     thing painted are the same object. Raised by the round-5 blind review.

     A statement that arrived without parts (JSON, an older adapter) is rendered
     as one system-voice span — the same conservative default `isSystemStatement`
     applies, rather than a second, laxer reading of the same value. */
  const parts: readonly { voice: 'system' | 'verbatim'; text: string }[] = (
    statement.parts ?? [{ voice: 'system' as const, text: statement.text }]
  ).map((part) => ({ voice: part.voice, text: String(part.text) }));
  statementText({ ...statement, text: parts.map((p) => p.text).join(''), parts }, 'SystemVoice');
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={[styles.system, className].filter(Boolean).join(' ')} data-voice="system">
      {parts.map((part, index) =>
        part.voice === 'verbatim' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one statement are positional and never reordered
          <span data-verbatim="true" key={index}>
            {part.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <span key={index}>{part.text}</span>
        ),
      )}
    </Tag>
  );
}
