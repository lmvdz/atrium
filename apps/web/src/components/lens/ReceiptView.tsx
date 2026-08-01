'use client';

/* ---------------------------------------------------------------------------
 * ReceiptView — BRIEF concepts 5 and 6. The trustworthy record.
 *
 * Four sections, each doing one job:
 *   WHAT HAPPENED — history lines, each epistemically tagged. The glyph on each
 *     line derives from its `kind` through the same `glyphFor` everything else
 *     uses; the legend under the section is the vocabulary, printed.
 *   PROVENANCE — excerpts. Every excerpt is a `Quotation`, so a receipt cannot
 *     show an excerpt that nothing proves. This is the artifact whose entire
 *     job is being the trustworthy record; it is where the no-synthesized-
 *     speech invariant matters most.
 *   CORRECTION CHAIN — two voices that never mix. `was`/`now`/`fact` are
 *     `SystemStatement`s: mono, muted, no quotation marks, no first person. The
 *     human's `reason` is a `Quotation`, italic, in <q>, attributed. Corrections
 *     are events, not erasures: the chain is append-only.
 *   REOPEN — resets to pending while preserving the prior answer on the record.
 *     Sticky, because a long correction chain would otherwise push it past the
 *     bottom of the pane, which is a dead end by scroll position.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { useAttribution } from '../model/ledger';
import { quotationRef, statementText } from '../model/quotation';
import type { CorrectionEntry, ProvenanceEntry, ReceiptRecord } from '../model/records';
import { stateForHappened } from '../model/records';
import { slot } from '../model/slot';
import { text } from '../model/text';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import { Quoted, SystemVoice } from '../primitives/Voice';
import styles from './lens.module.css';

export type ReceiptViewProps = {
  readonly receipt: ReceiptRecord;
  readonly onBack?: () => void;
  readonly onReopen?: (receiptId: string) => void;
  readonly onJump?: (messageId: string) => void;
} & NoGlyph;

export function ReceiptView({ receipt, onBack, onReopen, onJump }: ReceiptViewProps) {
  return (
    <section
      aria-label="Receipt"
      className={`${styles.receipt} atr-rise`}
      data-receipt-id={receipt.id}
    >
      <div className={styles.rcTop}>
        <button className={`${styles.rcBack} atr-lbl`} onClick={onBack} type="button">
          ← BACK TO CURRENT STATE
        </button>
        <div className={styles.rcTitle}>
          <Glyph className={styles.rcTitleGlyph} decorative={false} state={receipt.state} />
          <span className={styles.rcHeading}>
            <ClaimText content={slot(receipt.title)} state={receipt.state} />
          </span>
        </div>
        <div className={styles.rcState}>
          {receipt.status.map((part, index) => (
            <span key={part}>
              {index === 0 ? null : <span aria-hidden="true">· </span>}
              {part}
            </span>
          ))}
        </div>
      </div>

      <Section label="WHAT HAPPENED">
        {/* A history line is a page-authored fact about an event, so its words
            are a SystemStatement and it carries data-voice="system". `who` is
            the actor of the EVENT, not an attribution for speech — nothing on
            this line is quoted, which is precisely why a plain name is allowed
            here and is not allowed on a provenance row. */}
        {receipt.happened.map((line) => {
          const state = stateForHappened(line.kind);
          return (
            <div className={styles.happened} data-voice="system" key={line.id}>
              <Glyph className={styles.happenedGlyph} decorative={false} state={state} />
              <span className={styles.happenedText}>
                <span className={styles.happenedWho}>{line.who}</span>{' '}
                {statementText(line.statement, 'ReceiptView history line')}
                <span className={styles.happenedAt}>{line.at}</span>
              </span>
            </div>
          );
        })}
        <div className={styles.happenedLegend}>
          ✓ checked by something other than the claimant · ~ the claimant&rsquo;s own account · ?
          explicitly unverified · ◆ needs you · ✗ failed
        </div>
      </Section>

      <Section label="PROVENANCE">
        {receipt.provenance.map((entry) => (
          <ProvenanceRow entry={entry} key={entry.id} onJump={onJump} />
        ))}
      </Section>

      <Section label="CORRECTION CHAIN">
        {receipt.corrections.length === 0 ? (
          <div className={styles.corr}>
            <div className={styles.corrBody}>
              no corrections — this object has never been amended
            </div>
          </div>
        ) : (
          receipt.corrections.map((entry) => (
            <CorrectionRow entry={entry} key={entry.id} onJump={onJump} />
          ))
        )}
      </Section>

      <div className={styles.rcFoot}>
        <span className={styles.rcFootNote}>{receipt.reopenNote}</span>
        {receipt.reopenable ? (
          <button
            className="atr-btn atr-btn-sm"
            onClick={onReopen === undefined ? undefined : () => onReopen(receipt.id)}
            type="button"
          >
            Reopen
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={styles.rcSection}>
      <div className={styles.rcSectionLabel}>
        <span className={`${styles.rcSectionLabelText} atr-lbl`}>{label}</span>
        <span className={styles.groupRule} />
      </div>
      {children}
    </div>
  );
}

function ProvenanceRow({
  entry,
  onJump,
}: {
  readonly entry: ProvenanceEntry;
  readonly onJump?: (messageId: string) => void;
}) {
  const note = text(entry.note);
  const jump = entry.jump;
  /* WHO, WHEN AND WHAT ARE LOOKED UP FROM THE CITED MESSAGE. There is no `who`
     prop to disagree with the words, and since round 5 there is no `actor` on
     the excerpt either — the excerpt is a message id, and this row can only
     render what the record behind that id actually says. The receipt is the
     artifact whose whole job is being the trustworthy record; it is the last
     place a name should be a value somebody passed in. */
  const excerpt = useAttribution(entry.excerpt, 'ReceiptView provenance');
  return (
    <button
      className={styles.prov}
      onClick={onJump === undefined || jump === null ? undefined : () => onJump(jump.messageId)}
      type="button"
    >
      <span className={styles.provHead}>
        <span className={styles.provWho} data-attribution={excerpt.messageId}>
          {excerpt.actor}
        </span>
        <span>{excerpt.at}</span>
        <span className={styles.provJump}>
          {jump === null
            ? 'typed here · no message carries it'
            : `jump to source${jump.room === null ? '' : ` in #${jump.room}`} →`}
        </span>
      </span>
      <span className={styles.provExcerpt} data-quoted={quotationRef(excerpt)}>
        “{excerpt.text}”
      </span>
      {note === null ? null : <span className={styles.provNote}>{note}</span>}
    </button>
  );
}

function CorrectionRow({
  entry,
  onJump,
}: {
  readonly entry: CorrectionEntry;
  readonly onJump?: (messageId: string) => void;
}) {
  return (
    <div className={styles.corr}>
      <div className={styles.corrHead}>
        {entry.heading} · {entry.who} · {entry.at}
      </div>
      <div className={styles.corrBody}>
        <span className={styles.corrWas} data-voice="system">
          {statementText(entry.was, 'ReceiptView correction')}
        </span>{' '}
        → now: {statementText(entry.now, 'ReceiptView correction')}
        {entry.link === null ? null : (
          <>
            {' · '}
            <button
              className={styles.corrLink}
              onClick={
                onJump === undefined || entry.link === null
                  ? undefined
                  : () => onJump(entry.link?.ref.messageId ?? '')
              }
              type="button"
            >
              {entry.link.label}
            </button>
          </>
        )}
      </div>
      {entry.fact === null ? null : (
        <SystemVoice className={styles.corrFact} statement={entry.fact} />
      )}
      {entry.reason === null ? null : (
        <div className={styles.corrReason}>
          {/* No `by`: <Quoted> reads the actor off the quotation. */}
          <Quoted quote={entry.reason} />
        </div>
      )}
    </div>
  );
}
