'use client';

/* ---------------------------------------------------------------------------
 * TimelineRow — the IRC grid, `44px 14px 76px 1fr`.
 *
 * Takes an EpistemicState and derives its glyph and its claim treatment. There
 * is no glyph prop (see model/glyph.ts, `NoGlyph`).
 *
 * The `note` under a row is a SystemStatement, not a string: a line the page
 * writes about a person's message can never be mistaken for the message.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { quotationRef } from '../model/quotation';
import type { MessageEntry, RowTag } from '../model/records';
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
        entry.matchesFilter ? null : styles.dimmed,
      ]
        .filter(Boolean)
        .join(' ')}
      data-dimmed={entry.matchesFilter ? undefined : 'true'}
      data-message-id={entry.id}
      data-row="message"
    >
      <div className={styles.time}>{entry.at}</div>
      {/* not decorative: on a message row the glyph is the ONLY thing carrying
          the epistemic state, so a screen reader has to hear it */}
      <Glyph className={styles.glyphCell} decorative={false} state={entry.state} />
      <div
        className={[styles.actor, entry.fromViewer ? styles.actorMe : null]
          .filter(Boolean)
          .join(' ')}
      >
        {entry.actor}
      </div>
      <div className={styles.body}>
        {entry.replyTo === null ? null : (
          <span className={styles.reply}>
            ↩ {entry.replyTo.actor} {entry.replyTo.at} ·{' '}
            <span data-quoted={quotationRef(entry.replyTo.excerpt)}>
              {entry.replyTo.excerpt.text}
            </span>
          </span>
        )}
        <ClaimText state={entry.state}>
          <MessageBody body={entry.body} />
        </ClaimText>
        {entry.tag === null ? null : (
          <button
            className={[primitives.tag, TAG_CLASS[entry.tag.tone]].filter(Boolean).join(' ')}
            onClick={onOpenTag === undefined ? undefined : () => onOpenTag(entry.id)}
            type="button"
          >
            {entry.tag.label}
          </button>
        )}
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
    </div>
  );
}
