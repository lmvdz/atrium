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

import { useState } from 'react';
import type { EpistemicState, NoGlyph, ObjectKind } from '../model/glyph';
import { GLYPHS, glyphMeaning } from '../model/glyph';
import { useAttribution, useCitedLocation, useHere } from '../model/ledger';
import { quotationRef, sourceLocation, systemText } from '../model/quotation';
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
  readonly onRetypeToClaim?: (receiptId: string) => void;
  readonly onAccept?: (receiptId: string, objectiveId: string | null) => void;
  /** Accepted objectives a staged child can be filed under. Empty for objectives themselves. */
  readonly acceptObjectives?: readonly { readonly id: string; readonly label: string }[];
  readonly onAnswer?: (receiptId: string) => void;
  readonly onJump?: (messageId: string) => void;
  readonly supersessionCandidates?: readonly {
    readonly id: string;
    readonly kind: ObjectKind;
    readonly state: EpistemicState;
    readonly text: string;
  }[];
  readonly pendingReplacementId?: string;
  readonly onSupersede?: (retiredObjectId: string, replacementObjectId: string) => void;
} & NoGlyph;

export function ReceiptView({
  receipt,
  onBack,
  onReopen,
  onRetypeToClaim,
  onAccept,
  acceptObjectives = [],
  onAnswer,
  onJump,
  supersessionCandidates = [],
  pendingReplacementId,
  onSupersede,
}: ReceiptViewProps) {
  const [replacementId, setReplacementId] = useState<string | null>(pendingReplacementId ?? null);
  const [acceptObjectiveId, setAcceptObjectiveId] = useState('');
  const replacement = supersessionCandidates.find((candidate) => candidate.id === replacementId);
  return (
    <section
      aria-label="Receipt"
      className={`${styles.receipt} atr-rise`}
      data-receipt-id={receipt.id}
      tabIndex={-1}
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
              {/* A LINE WITH NO CLOCK PRINTS NO CLOCK. `receiptFromObject` used
                  to pass `at: '—'` and this span painted it, so every derived
                  history line read "proposed by justin —" — a glyph standing
                  where a time goes, which the reader has to learn to discount.
                  The field is optional now; see `HappenedLine.at`. */}
              {line.at === undefined ? null : (
                <span className={styles.happenedAt}>
                  {systemText(line.at, 'ReceiptView happened at')}
                </span>
              )}
            </span>
          </div>
        ))}
        {/* THE LEGEND IS THE VOCABULARY, PRINTED — so it is printed FROM the
            vocabulary. Round 8 shipped a hand-written list of five while this
            same section emitted ■ and ·, both unexplained: the section that
            exists to say what the glyphs mean was two glyphs behind the glyphs
            above it. `GLYPHS` is `Record<Glyph, …>`-derived and `glyphMeaning`
            is an exhaustive switch, so an eighth glyph does not compile and a
            seventh cannot go unlisted. */}
        <div className={styles.happenedLegend}>
          {GLYPHS.map((glyph, index) => (
            <span key={glyph}>
              {index === 0 ? null : <span aria-hidden="true"> · </span>}
              {glyph} {glyphMeaning(glyph)}
            </span>
          ))}
        </div>
      </Section>

      <Section label="PROVENANCE">
        {/* AN EMPTY SECTION IS A HEADING THAT TELLS THE READER NOTHING, and nine
            of the ten receipts in this gallery have empty provenance — every one
            built by `receiptFromObject`, which carries no excerpts because
            nothing on the object cites a message. The reader got a bare word and
            found the explanation three sections down in `reopenNote`, while the
            CORRECTION CHAIN immediately below already had an empty state. Same
            treatment, same sentence shape, said where the question is asked.
            Found by the r8 blind review. */}
        {receipt.provenance.length === 0 ? (
          <div className={styles.prov}>
            <div className={styles.provEmpty}>
              no excerpts — nothing on this object cites a message
            </div>
          </div>
        ) : (
          receipt.provenance.map((entry) => (
            <ProvenanceRow entry={entry} key={entry.id} onJump={onJump} />
          ))
        )}
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
        <span>
          {receipt.acceptable === true && onAccept !== undefined ? (
            <span className={styles.rcAccept}>
              {acceptObjectives.length === 0 ? null : (
                <label>
                  <span className="atr-lbl">FILE UNDER</span>
                  <select
                    aria-label="File accepted reading under"
                    onChange={(event) => setAcceptObjectiveId(event.target.value)}
                    value={acceptObjectiveId}
                  >
                    <option value="">Unfiled</option>
                    {acceptObjectives.map((objective) => (
                      <option
                        key={objective.id}
                        value={systemText(objective.id, 'ReceiptView objective id')}
                      >
                        {systemText(objective.label, 'ReceiptView objective label')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="atr-btn atr-btn-sm"
                onClick={() => onAccept(receipt.id, acceptObjectiveId || null)}
                type="button"
              >
                Accept reading
              </button>
            </span>
          ) : null}
          {receipt.answerable === true && onAnswer !== undefined ? (
            <button
              className="atr-btn atr-btn-sm"
              onClick={() => onAnswer(receipt.id)}
              type="button"
            >
              Answer
            </button>
          ) : null}
          {receipt.retypeable && onRetypeToClaim !== undefined ? (
            <button
              className="atr-btn atr-btn-sm"
              onClick={
                onRetypeToClaim === undefined ? undefined : () => onRetypeToClaim(receipt.id)
              }
              type="button"
            >
              Retype as claim
            </button>
          ) : null}
          {receipt.reopenable ? (
            <button
              className="atr-btn atr-btn-sm"
              onClick={onReopen === undefined ? undefined : () => onReopen(receipt.id)}
              type="button"
            >
              Reopen
            </button>
          ) : null}
        </span>
      </div>
      {onSupersede === undefined || supersessionCandidates.length === 0 ? null : (
        <fieldset className={styles.rcSupersede}>
          <legend className="atr-lbl">REPLACE THIS OBJECT WITH AN EXISTING OBJECT</legend>
          <div className={styles.rcSupersedeChoices}>
            {supersessionCandidates.map((candidate) => (
              <button
                aria-pressed={candidate.id === replacementId}
                className="atr-btn atr-btn-sm"
                data-supersession-replacement={candidate.id}
                key={candidate.id}
                onClick={() => setReplacementId(candidate.id)}
                type="button"
              >
                <span>{systemText(candidate.kind, 'ReceiptView supersession kind')}</span>
                <ClaimText content={slot(candidate.text)} state={candidate.state} />
              </button>
            ))}
          </div>
          {replacement === undefined ? null : (
            <button
              className="atr-btn atr-btn-sm"
              data-confirm-supersession={replacement.id}
              onClick={() => onSupersede(receipt.id, replacement.id)}
              type="button"
            >
              {pendingReplacementId === replacement.id
                ? 'Retry supersession with the same durable request'
                : 'Confirm supersession'}
            </button>
          )}
        </fieldset>
      )}
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
  const location = sourceLocation(excerpt, useHere('ReceiptView provenance'));
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
        {/* THE SAME COMPARISON AS THE CARD'S SOURCE LINK, FROM THE SAME DOOR.
            Round 8, D3, in the opposite direction: `excerpt.room === null` read
            "the register does not record a room" as "typed in this room", so a
            receipt open in #identity-service labelled its own room's excerpts
            as cross-room and labelled a room-less record as local. Neither
            branch had ever been told which room it was rendering in. */}
        <span className={styles.provJump} data-source-where={location.where}>
          {location.where === 'elsewhere'
            ? `jump to source in #${location.room} →`
            : 'jump to source →'}
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
  const { record, location } = useCitedLocation(link.ref, 'ReceiptView correction link');
  return (
    <>
      {' · '}
      <button
        className={styles.corrLink}
        data-jumps-to={record.id}
        data-source-where={location.where}
        onClick={onJump === undefined ? undefined : () => onJump(record.id)}
        type="button"
      >
        {systemText(link.label, 'ReceiptView correction link')}
        {/* The third site with the same shape. "(in #X)" is a statement that X
            is somewhere else — it was printed whenever the record carried a
            room, including when X was the room the receipt was open in. */}
        {location.where === 'elsewhere' ? ` (in #${location.room})` : ''}
      </button>
    </>
  );
}
