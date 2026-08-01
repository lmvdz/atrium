'use client';

/* ---------------------------------------------------------------------------
 * The compressed owed row. Turn-17 compression: still visible, still glyphed,
 * still one click to act. Folding hides noise, never signal — a compressed item
 * keeps its glyph, its primary action and its way back to the full card.
 *
 * It takes the same `AttentionItem` as the open card, so it inherits the
 * required rationale: the rationale is surfaced as the row's title text, which
 * means even the compressed form can say why it is asking.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import type { AttentionItem } from '../model/records';
import { list } from '../model/text';
import { Glyph } from '../primitives/Glyph';
import styles from './attention.module.css';

export type AttentionCompactProps = {
  readonly item: AttentionItem;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
} & NoGlyph;

export function AttentionCompact({ item, onOpen, onAct }: AttentionCompactProps) {
  const primary = item.actions[0];
  const facts = list(item.facts.slice(0, 2));

  return (
    <div className={styles.acomp} data-attention-id={item.id}>
      <Glyph decorative={false} state={item.state} />
      <button
        className={styles.acompTitle}
        onClick={onOpen === undefined ? undefined : () => onOpen(item.id)}
        title={item.rationale}
        type="button"
      >
        {item.title}
      </button>
      <span className={styles.acompMeta}>
        {facts === null ? null : <span className={styles.acompFacts}>{facts}</span>}
        {primary === undefined ? null : (
          <button
            className="atr-btn atr-btn-sm"
            /* Friction is a property of the ACTION, not of how much room the
               card was given. Compressing an item must never turn a two-second
               hold into a one-click destruction. */
            data-hold={item.state.irreversible ? '2000' : undefined}
            onClick={onAct === undefined ? undefined : () => onAct(item.id, primary.id)}
            title={
              item.state.irreversible
                ? 'destructive — press and hold for 2 seconds; the hold is the confirmation'
                : item.rationale
            }
            type="button"
          >
            {item.state.irreversible ? `${primary.label} — hold` : primary.label}
          </button>
        )}
      </span>
    </div>
  );
}
