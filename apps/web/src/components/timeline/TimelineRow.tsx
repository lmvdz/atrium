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
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { quotationRef } from '../model/quotation';
import type {
  AuthoredMessageEntry,
  ChosenMessageEntry,
  MessageEntry,
  RowTag,
} from '../model/records';
import { isAuthored } from '../model/records';
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
        <ClaimText content={slot(<MessageBody body={entry.body} />)} state={entry.state} />
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
