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
 *   authored — the actor cell holds `entry.attribution.actor`, read off the
 *     quotation minted from the same message as the words. There is no free
 *     actor string on this row, so the name and the sentence cannot be from
 *     different people.
 *   chosen — no actor cell at all, because a `ChosenMessageEntry` has no actor
 *     field for one. The whole row is a `SystemStatement` rendered through
 *     <SystemVoice>: mono, muted, third person, no quotation marks. This is the
 *     round-1 cardinal defect closed at the type level — the shipped gallery
 *     used to render this exact record as lars's own sentence.
 *
 * THE ATTRIBUTION IS RE-DERIVED HERE, NOT TRUSTED. Rounds 1, 2 and 3 all found
 * the same defect at a different address: the guarantee was enforced at whatever
 * chokepoint the last round had built, and the next round found a path that did
 * not go through it. r1 put a free actor string beside the words; r2 moved it to
 * the body slot; r3 put the check inside `messageEntry` and a caller wrote the
 * `AuthoredMessageEntry` literal instead of calling it.
 *
 * `messageEntry` is now unreachable to write around (model/records.ts brands the
 * entry), but a brand is a compile-time fact and a cast walks through it. This
 * component is on the path EVERY rendered row takes, and it already holds both
 * halves of the claim — `entry.attribution.text` is the record's words and
 * `entry.body` is what is about to be painted — so it checks them against each
 * other before printing a name over them. There is no call site that can skip
 * this one, which is the property the previous three fixes did not have.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
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
  /* THE CHECK A CALL SITE CANNOT SKIP. Both operands come off the entry this
     component was handed, so it holds however the entry was built — factory,
     literal, cast, `JSON.parse`, or a JavaScript caller with no types at all.
     It throws rather than degrading: a row that renders a person's name over
     words that are not on their record is the one failure this whole model
     exists to prevent, and a silently corrected render is a corrected render
     nobody finds out about. */
  const diverged = bodyDivergence('TimelineRow', entry.body, entry.attribution.text, {
    id: entry.attribution.messageId,
    actor: entry.attribution.actor,
  });
  if (diverged !== null) throw new Error(diverged);

  return (
    <>
      <div
        className={[styles.actor, entry.fromViewer ? styles.actorMe : null]
          .filter(Boolean)
          .join(' ')}
        data-attribution={entry.attribution.messageId}
      >
        {entry.attribution.actor}
      </div>
      <div className={styles.body}>
        {entry.replyTo === null ? null : (
          <span className={styles.reply}>
            ↩ {entry.replyTo.actor} {entry.replyTo.at} ·{' '}
            <span data-quoted={quotationRef(entry.replyTo)}>{entry.replyTo.text}</span>
          </span>
        )}
        {/* The words, and nothing else in the body column — tagged with the
            message they must read as, so a browser can check the rendered row
            against the record rather than against the model that built it.
            `messageEntry` proves `bodyText(body) === record.text`; this is what
            proves the renderer did not then print something else. */}
        <span data-row-body={entry.attribution.messageId}>
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
