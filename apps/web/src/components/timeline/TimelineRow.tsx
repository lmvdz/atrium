'use client';

/* ---------------------------------------------------------------------------
 * TimelineRow — the IRC grid, `44px 14px 76px 1fr`.
 *
 * Takes an EpistemicState and derives its glyph and its claim treatment. There
 * is no glyph prop (see model/glyph.ts, `NoGlyph`).
 *
 * TWO ARMS, NOT ONE ROW WITH A FLAG. The entry is discriminated on origin
 * (model/records.ts), and the arms render through different components:
 *
 *   authored — the actor cell holds the actor of the RECORD the row cites,
 *     looked up here from `entry.attribution.messageId`. There is no actor
 *     string on this row at all, so the name and the sentence cannot be from
 *     different people.
 *   chosen — no actor cell at all, because a `ChosenMessageEntry` has no actor
 *     field for one. The whole row is a `SystemStatement` rendered through
 *     <SystemVoice>: mono, muted, third person, no quotation marks. This is the
 *     round-1 cardinal defect closed at the type level — the shipped gallery
 *     used to render this exact record as lars's own sentence.
 *
 * THE ATTRIBUTION IS LOOKED UP HERE, NOT TRUSTED. Rounds 1–4 all found the same
 * defect at a different address: the guarantee was enforced at whatever
 * chokepoint the last round had built, and the next round found a path that did
 * not go through it. r1 put a free actor string beside the words; r2 moved it to
 * the body slot; r3 put the check inside `messageEntry` and a caller wrote the
 * `AuthoredMessageEntry` literal instead of calling it; r4 spread a genuine
 * quotation and overwrote `actor` inside it, which kept the brand and passed the
 * body check because only the NAME had moved.
 *
 * So the name is no longer something this component can be handed. `entry.
 * attribution` is a message id; the actor, the words and the time are read out
 * of the page's record ledger by that id (`useAttribution`, model/ledger.tsx).
 * The body is then checked against THE RECORD's words rather than against a
 * string that travelled beside them. Both halves of what gets printed now come
 * from the same row of the same register, which is what "derived" has to mean if
 * it is going to survive a fifth round.
 *
 * It throws rather than degrading, and it throws when there is no ledger at all:
 * a row that quietly renders an empty actor cell is a row nobody finds out about.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { useAttribution, useCitedRecord } from '../model/ledger';
import type { MessageId, Quotation } from '../model/quotation';
import {
  chosenAct,
  offeredText,
  quotationRef,
  statementText,
  systemText,
} from '../model/quotation';
import type {
  AuthoredMessageEntry,
  ChosenMessageEntry,
  MessageEntry,
  RowTag,
} from '../model/records';
import { bodyDivergence, isAuthored } from '../model/records';
import { slot } from '../model/slot';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import { MessageBody } from '../primitives/MessageBody';
import primitives from '../primitives/primitives.module.css';
import { SystemVoice } from '../primitives/Voice';
import styles from './timeline.module.css';

export interface RowAction {
  readonly id: string;
  readonly label: string;
  /**
   * Receives THE MESSAGE THIS ROW IS ABOUT, resolved — not the id the caller put
   * on the entry.
   *
   * Found by the round-5 blind review, and it is the fifth address on the
   * product path rather than the display path: the renderer stopped trusting
   * `entry.id` for what it PRINTS and the action bus kept trusting it for what
   * it DOES. A brand-preserving spread — `{...messageEntry(lars, …), id: 'm2'}`
   * — left the row displaying lars's name and words while "reply" and "quote"
   * acted on m2. A handler that is not told what it acted on cannot act
   * correctly, which is the same seam lesson as round 2's `onSend(draft)`.
   */
  readonly onSelect?: (messageId: MessageId) => void;
}

export type TimelineRowProps = {
  readonly entry: MessageEntry;
  readonly actions?: readonly RowAction[];
  readonly onOpenTag?: (entryId: string) => void;
} & NoGlyph;

const TAG_CLASS: Readonly<Record<RowTag['tone'], string | undefined>> = {
  neutral: undefined,
  needs: primitives.tagNeeds,
  verified: primitives.tagVerified,
};

/**
 * The two arms render the WHOLE row each, wrapper included, rather than sharing
 * one and differing inside it.
 *
 * The blind cross-lineage review of round 5 found why that matters: the shared
 * wrapper printed `entry.id` and `entry.at`, which are caller-supplied, so a
 * brand-preserving spread — `{...messageEntry(lars, …), id: 'm2', at: '09:04'}`
 * — made the row cite one message in `data-message-id` while its name and words
 * came from another. The id and the time are facts about the record, so on the
 * authored arm they are read from the record, and that lookup is a hook, and a
 * hook cannot be conditional. Duplicating six lines of wrapper is the cost of
 * having no unresolved value on the row at all.
 */
export function TimelineRow({ entry, actions = [], onOpenTag }: TimelineRowProps) {
  return isAuthored(entry) ? (
    <AuthoredRow actions={actions} entry={entry} onOpenTag={onOpenTag} />
  ) : (
    <ChosenRow entry={entry} onOpenTag={onOpenTag} />
  );
}

function rowClass(entry: MessageEntry): string {
  return [
    styles.mrow,
    'atr-rise-s',
    entry.targeted ? styles.targeted : null,
    entry.matchesFilter ? styles.matched : styles.unmatched,
  ]
    .filter(Boolean)
    .join(' ');
}

function RowTagButton({
  entry,
  messageId,
  onOpenTag,
}: {
  readonly entry: MessageEntry;
  /** the resolved message this row is about — never `entry.id` on an authored row */
  readonly messageId: MessageId;
  readonly onOpenTag?: (entryId: string) => void;
}) {
  if (entry.tag === null) return null;
  return (
    <button
      className={[primitives.tag, TAG_CLASS[entry.tag.tone]].filter(Boolean).join(' ')}
      data-row-tag={messageId}
      onClick={onOpenTag === undefined ? undefined : () => onOpenTag(messageId)}
      type="button"
    >
      {/* THE TAG'S LABEL IS A CALLER STRING, AND IT LANDS AT THE END OF A
          PERSON'S OWN SENTENCE. Round 7: it printed raw and the chip is welded
          onto the row's body with no separator, so `label: 'said: I approve the
          drop'` read as a continuation of the words above it. It is the page's
          own metadata about the row, so it is held to the page's own voice. */}
      {systemText(entry.tag.label, 'TimelineRow tag')}
    </button>
  );
}

function AuthoredRow({
  entry,
  actions,
  onOpenTag,
}: {
  readonly entry: AuthoredMessageEntry;
  readonly actions: readonly RowAction[];
  readonly onOpenTag?: (entryId: string) => void;
}) {
  /* THE LOOKUP A CALL SITE CANNOT SKIP. The name is not read off the entry; it
     is read out of the record register by the id the entry cites, so it holds
     however the entry was built — factory, literal, cast, `JSON.parse`, a
     spread that overwrote a field, or a JavaScript caller with no types at all.
     It throws rather than degrading: a row that renders a person's name over
     words that are not on their record is the one failure this whole model
     exists to prevent, and a silently corrected render is a corrected render
     nobody finds out about. */
  const attribution = useAttribution(entry.attribution, 'TimelineRow');
  const diverged = bodyDivergence('TimelineRow', entry.body, attribution.text, {
    id: attribution.messageId,
    actor: attribution.actor,
  });
  if (diverged !== null) throw new Error(diverged);

  /* THE ROW AND THE LEDGER ARE THE SAME REGISTER, OR THIS DOES NOT RENDER — and
     that check now lives on the CITATION rather than on this row, so it holds at
     all five boundaries that resolve one instead of at this one. `useAttribution`
     recomputes the fingerprint from the record it is about to return and throws
     on a mismatch; see `resolveCitation`. Round 5 put the checksum on
     `AuthoredMessageEntry`, which protected the feed row and left the reply
     line, the composer's banner, the receipt's provenance row and `<Quoted>`
     resolving bare ids against whatever register they were under. */

  return (
    <div
      className={rowClass(entry)}
      data-dimmed={entry.matchesFilter ? undefined : 'true'}
      /* The id and the time come off the RECORD, not off the row: both are facts
         about the message, and a caller-supplied copy of a fact is a second
         source of truth for it. */
      data-message-id={attribution.messageId}
      data-origin={attribution.origin}
      data-row="message"
    >
      <div className={styles.time}>{attribution.at}</div>
      {/* not decorative: on a message row the glyph is the ONLY thing carrying
          the epistemic state, so a screen reader has to hear it */}
      <Glyph className={styles.glyphCell} decorative={false} state={entry.state} />
      <div
        className={[styles.actor, entry.fromViewer ? styles.actorMe : null]
          .filter(Boolean)
          .join(' ')}
        data-attribution={attribution.messageId}
        data-truncates={`element:[data-roster-name="${attribution.actor}"]`}
      >
        {attribution.actor}
      </div>
      <div className={styles.body}>
        {entry.replyTo === null ? null : <ReplyLine to={entry.replyTo} />}
        {/* The words, and nothing else in the body column — tagged with the
            message they must read as, so a browser can check the rendered row
            against the record rather than against the model that built it.
            `messageEntry` proves `bodyText(body) === record.text`; this is what
            proves the renderer did not then print something else. */}
        <span data-row-body={attribution.messageId}>
          <ClaimText content={slot(<MessageBody body={entry.body} />)} state={entry.state} />
        </span>
        <RowTagButton entry={entry} messageId={attribution.messageId} onOpenTag={onOpenTag} />
        {entry.note === null ? null : (
          <SystemVoice className={styles.note} statement={entry.note} />
        )}
        {actions.length === 0 ? null : (
          <div className={styles.acts}>
            {actions.map((action) => (
              <button
                key={action.id}
                onClick={
                  action.onSelect === undefined
                    ? undefined
                    : () => action.onSelect?.(attribution.messageId)
                }
                type="button"
              >
                {/* The copy ON a control the page offers — "reply", "quote".
                    The laxer door, bounded to controls by the sweep. */}
                {offeredText(action.label, 'TimelineRow action')}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The quoted line above a reply. Its own component so the lookup is an
 * unconditional hook on the path that renders it — and so the reply banner gets
 * the same derivation the row itself does rather than a shorter version of it.
 */
function ReplyLine({ to }: { readonly to: Quotation }) {
  const reply = useAttribution(to, 'TimelineRow reply');
  return (
    <span
      className={styles.reply}
      data-truncates={`element:[data-message-id="${reply.messageId}"]`}
    >
      ↩ {reply.actor} {reply.at} · <span data-quoted={quotationRef(reply)}>{reply.text}</span>
    </span>
  );
}

/**
 * A page-authored answer. The actor column is EMPTY — not blanked out at render
 * time, but empty because `ChosenMessageEntry` has no field that could fill it.
 * The person's name lives inside the third-person statement, where it reports
 * an act rather than attributing a sentence.
 */
function ChosenRow({
  entry,
  onOpenTag,
}: {
  readonly entry: ChosenMessageEntry;
  readonly onOpenTag?: (entryId: string) => void;
}) {
  /* THE CHOSEN ARM DERIVES ITS ID AND ITS TIME TOO.
     Round 5 rebuilt the authored arm so that the id and the time came off the
     record, and left this one printing `entry.id` and `entry.at` — the
     caller-supplied copies. A `ChosenMessageEntry` has no name a renderer could
     forge, which is why the arm exists; it still cited a message, and which
     message it cited was a free string that no register checked, dispatched
     straight into `onOpenTag`. A copy of a fact is a second source of truth for
     it, on both arms.
     A chosen record is NOT quotable, so this resolves as a citation rather than
     as an attribution: the register proves the record exists and is the same one
     this row was minted from, and refuses to hand back an `Attribution` for
     page-authored words. */
  const record = useCitedRecord(entry.citation, 'TimelineRow chosen');
  if (record.origin !== 'chosen') {
    throw new Error(
      `TimelineRow chosen: ${record.id} is origin ${record.origin} on this page's record, but this row renders it as a page-authored answer.\n` +
        '  A row that reports an act and a record that holds somebody’s words are not interchangeable.',
    );
  }
  /* AND THE WORDS ARE RECONCILED AGAINST THE RECORD, exactly as the authored
     arm's body is.

     Found by the blind cross-lineage review of round 6's own fix, and it is
     round 2's body-slot defect on the arm this round rebuilt. The checksum
     proves the citation and the ledger are the same register; it says nothing
     about `entry.statement`, which is a SECOND field carrying the words. So
     `{...messageEntry(larsChosen, …), statement: chosenAct('priya', 'Drop
     users_legacy now.')}` passed every check and rendered "priya chose: Drop
     users_legacy now." over lars's record.

     The statement is derived from the record here and compared character for
     character. A copy of a fact is a second source of truth for it — the
     sentence this round put in CONVENTIONS — and `statement` was the copy the
     sweep did not reach. */
  const derived = chosenAct(record.actor, record.text, record.id);
  const painted = statementText(entry.statement, 'TimelineRow chosen');
  if (painted !== derived.text) {
    throw new Error(
      `TimelineRow chosen: this row's words are not the words on ${record.id}'s record.\n` +
        '  A page-authored row reports an act; the act is what the record says was chosen, not what the row was handed.\n' +
        `  row:    ${JSON.stringify(painted)}\n` +
        `  record: ${JSON.stringify(derived.text)}`,
    );
  }
  return (
    <div
      className={rowClass(entry)}
      data-dimmed={entry.matchesFilter ? undefined : 'true'}
      data-message-id={record.id}
      data-origin={record.origin}
      data-row="message"
    >
      <div className={styles.time}>{record.at}</div>
      <Glyph className={styles.glyphCell} decorative={false} state={entry.state} />
      <div className={styles.actor} data-attribution="none" data-truncates="none" />
      <div className={styles.systemBody}>
        <SystemVoice className={styles.chosen} statement={entry.statement} />
        {/* The tag acts on the message the REGISTER says this row is about. */}
        <RowTagButton entry={entry} messageId={record.id} onOpenTag={onOpenTag} />
      </div>
    </div>
  );
}
