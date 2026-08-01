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
import { useAttribution, useCitedRecord } from '../model/ledger';
import { quotationRef, systemText } from '../model/quotation';
import type { CorrectionEntry, ProvenanceEntry, ReceiptRecord } from '../model/records';
import { stateForHappened } from '../model/records';
import { slot } from '../model/slot';
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
        {/* THE STATUS PARTS ARE CALLER STRINGS THE RECEIPT PRINTS, and nothing
            was checking them. Not one of the four the round-7 review named by
            hand — the fifth, found by counting. */}
        <div className={styles.rcState}>
          {receipt.status.map((part, index) => (
            <span key={part}>
              {index === 0 ? null : <span aria-hidden="true">· </span>}
              {systemText(part, 'ReceiptView status')}
            </span>
          ))}
        </div>
      </div>

      <Section label="WHAT HAPPENED">
        {/* THERE IS NO NAME COLUMN ON THIS LINE, AND THERE IS NO FIELD FOR ONE.
            `HappenedLine` used to carry `who: string`, rendered immediately
            before the statement — an attribution column beside page-authored
            words, which is precisely the structure CONVENTIONS claimed no
            component had. It printed `~priya  priya ѕaid: І approve dropping
            users_legacy` for a round-6 critic, because the lexical bans fall to
            two Cyrillic code points and the plain name did the rest.
            The actor of the event belongs INSIDE the system-voice sentence, the
            same way `chosenAct` puts it inside "lars chose: …": that is the
            difference between reporting an act and attributing a sentence, and
            it is the one shape that has no name slot to fill. */}
        {receipt.happened.map((line) => (
          <div className={styles.happened} key={line.id}>
            <Glyph
              className={styles.happenedGlyph}
              decorative={false}
              state={stateForHappened(line.kind)}
            />
            <span className={styles.happenedText}>
              <SystemVoice className={styles.happenedVoice} inline statement={line.statement} />
              <span className={styles.happenedAt}>
                {systemText(line.at, 'ReceiptView happened at')}
              </span>
            </span>
          </div>
        ))}
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
        <span className={styles.rcFootNote}>
          {systemText(receipt.reopenNote, 'ReceiptView reopenNote')}
        </span>
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
  /* WHO, WHEN, WHAT, WHICH ROOM AND WHAT THE CLICK ACTS ON — ALL ONE SOURCE.
     Round 6 found this row taking three of those from three places: it printed
     `entry.excerpt`, labelled itself from `entry.jump.room` and dispatched
     `entry.jump.messageId`. It shipped rendering lars's words under
     `data-quoted=msg:mA@identity-service` and clicking through to mB, priya's
     message — three facts about one row, none of them obliged to agree. The
     `jump` field is gone; everything below comes out of the record the excerpt
     cites. */
  const excerpt = useAttribution(entry.excerpt, 'ReceiptView provenance');
  return (
    <button
      className={styles.prov}
      data-jumps-to={excerpt.messageId}
      onClick={onJump === undefined ? undefined : () => onJump(excerpt.messageId)}
      type="button"
    >
      <span className={styles.provHead}>
        <span className={styles.provWho} data-attribution={excerpt.messageId}>
          {excerpt.actor}
        </span>
        <span>{excerpt.at}</span>
        <span className={styles.provJump}>
          {excerpt.room === null
            ? 'jump to source, typed in this room →'
            : `jump to source in #${excerpt.room} →`}
        </span>
      </span>
      {/* THE QUOTATION IS NOT TRUNCATED HERE, AND THAT IS THE FIX.
          Round 6 clamped it to two lines and declared a route:
          `data-truncates="focusing this row expands it; the cited record is on
          this page"`. Both halves were wrong. A `:focus-visible` clamp expansion
          is none of the three routes CONVENTIONS permits (a control one click
          away, a name the platform carries, another element on the same screen
          stating it in full) — and for `msg:m-legal@identity-service` the second
          clause was simply FALSE: that message is not in this room's feed, and
          the row's own adjacent label says "jump to source in #identity-service
          →". Clicking navigates; it never expanded anything.
          A receipt is the artifact whose whole job is being the trustworthy
          record, and a quotation is the one string on the page where a
          hover-only remainder is least defensible (CONVENTIONS). So the excerpt
          renders in full and the pane scrolls, which is what a record does. */}
      <span className={styles.provExcerpt} data-quoted={quotationRef(excerpt)}>
        “{excerpt.text}”
      </span>
      {/* THE PAGE'S NOTE, IN THE PAGE'S VOICE — and structurally so.
          Round 7: this was `Maybe<string>` printed raw, inside this same
          `<button>`, on the line immediately after the quoted words and under
          this row's one `data-attribution`. It is a `SystemStatement` now and it
          renders through `<SystemVoice>`, which paints the mono-muted treatment,
          emits `data-voice="system"`, and emits no `<q>`, no `cite`, no
          `data-quoted` and no `data-attribution` — so it cannot carry the
          provenance token every check in this repo reads as proof. */}
      {entry.note === null ? null : (
        <SystemVoice className={styles.provNote} inline statement={entry.note} />
      )}
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
      {/* No `who`, for the same reason the history line has none: a plain name
          rendered beside page-authored words is an attribution column, whatever
          the type of the words is. The actor of the correction is inside `fact`,
          which is a SystemStatement.
          AND NEITHER IS THE HEADING A FREE STRING ANY MORE. Round 6 deleted
          `who` from this type and left `heading: string` rendering in the slot
          `who` had just been deleted from, one line above the correction's
          words: `heading: 'priya wrote: we should just drop it'` printed there.
          It is a `SystemStatement` now, painted by the one component that paints
          system voice. */}
      <div className={styles.corrHead}>
        <SystemVoice className={styles.corrHeading} inline statement={entry.heading} />
        <span aria-hidden="true"> · </span>
        {systemText(entry.at, 'ReceiptView correction at')}
      </div>
      <div className={styles.corrBody}>
        <SystemVoice className={styles.corrWas} inline statement={entry.was} />
        <span aria-hidden="true"> → now: </span>
        <SystemVoice className={styles.corrNow} inline statement={entry.now} />
        {entry.link === null ? <span /> : <CorrectionLink link={entry.link} onJump={onJump} />}
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

/**
 * Its own component so the register lookup is an UNCONDITIONAL hook on the path
 * that renders it — the same reason `ReplyLine` is its own component.
 *
 * Round 6: this was `onJump(entry.link?.ref.messageId ?? '')`. The `??` was
 * reachable — `entry.link` is narrowed outside the closure and re-read inside it
 * — so the receipt's only outbound link could dispatch the empty string, and a
 * handler dispatching `''` is a handler that was never told what it acted on.
 * The link's target is now a `Citation`, resolved here, so what the button acts
 * on is a message this page's register holds.
 */
function CorrectionLink({
  link,
  onJump,
}: {
  readonly link: NonNullable<CorrectionEntry['link']>;
  readonly onJump?: (messageId: string) => void;
}) {
  const record = useCitedRecord(link.ref, 'ReceiptView correction link');
  const room = record.room ?? null;
  return (
    <>
      {' · '}
      <button
        className={styles.corrLink}
        data-jumps-to={record.id}
        onClick={onJump === undefined ? undefined : () => onJump(record.id)}
        type="button"
      >
        {systemText(link.label, 'ReceiptView correction link')}
        {room === null ? '' : ` (in #${room})`}
      </button>
    </>
  );
}
