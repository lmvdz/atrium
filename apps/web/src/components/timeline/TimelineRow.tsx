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
import { useAttribution } from '../model/ledger';
import type { Quotation } from '../model/quotation';
import { quotationRef } from '../model/quotation';
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
  readonly onSelect?: () => void;
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

export function TimelineRow({ entry, actions = [], onOpenTag }: TimelineRowProps) {
  return (
    <div
      className={[
        styles.mrow,
        'atr-rise-s',
        entry.targeted ? styles.targeted : null,
        entry.matchesFilter ? styles.matched : styles.unmatched,
      ]
        .filter(Boolean)
        .join(' ')}
      data-dimmed={entry.matchesFilter ? undefined : 'true'}
      data-message-id={entry.id}
      data-origin={entry.origin}
      data-row="message"
    >
      <div className={styles.time}>{entry.at}</div>
      {/* not decorative: on a message row the glyph is the ONLY thing carrying
          the epistemic state, so a screen reader has to hear it */}
      <Glyph className={styles.glyphCell} decorative={false} state={entry.state} />
      {isAuthored(entry) ? (
        <AuthoredRow actions={actions} entry={entry} onOpenTag={onOpenTag} />
      ) : (
        <ChosenRow entry={entry} onOpenTag={onOpenTag} />
      )}
    </div>
  );
}

function RowTagButton({
  entry,
  onOpenTag,
}: {
  readonly entry: MessageEntry;
  readonly onOpenTag?: (entryId: string) => void;
}) {
  if (entry.tag === null) return null;
  return (
    <button
      className={[primitives.tag, TAG_CLASS[entry.tag.tone]].filter(Boolean).join(' ')}
      data-row-tag={entry.id}
      onClick={onOpenTag === undefined ? undefined : () => onOpenTag(entry.id)}
      type="button"
    >
      {entry.tag.label}
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

  return (
    <>
      <div
        className={[styles.actor, entry.fromViewer ? styles.actorMe : null]
          .filter(Boolean)
          .join(' ')}
        data-attribution={attribution.messageId}
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
        <RowTagButton entry={entry} onOpenTag={onOpenTag} />
        {entry.note === null ? null : (
          <SystemVoice className={styles.note} statement={entry.note} />
        )}
        {actions.length === 0 ? null : (
          <div className={styles.acts}>
            {actions.map((action) => (
              <button key={action.id} onClick={action.onSelect} type="button">
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
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
    <span className={styles.reply}>
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
  return (
    <>
      <div className={styles.actor} data-attribution="none" />
      <div className={styles.systemBody}>
        <SystemVoice className={styles.chosen} statement={entry.statement} />
        <RowTagButton entry={entry} onOpenTag={onOpenTag} />
      </div>
    </>
  );
}
