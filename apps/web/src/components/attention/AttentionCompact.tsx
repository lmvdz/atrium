'use client';

/* ---------------------------------------------------------------------------
 * The compressed owed row. Turn-17 compression: still visible, still glyphed,
 * still one click to act. Folding hides noise, never signal — a compressed item
 * keeps its glyph, its primary action and its way back to the full card.
 *
 * THE RATIONALE IS VISIBLE, not a tooltip. Round 1: the compressed row put the
 * required reason in `title=` only, and BRIEF concept 8 wants it on screen —
 * "attention routing is only trusted if it can justify itself", and a reason
 * you have to hover to find has not justified anything to a keyboard or a
 * touch user. It renders on a second line, clamped to one line's worth so the
 * row stays compressed, with the full text still on `title` for the overflow.
 *
 * FRICTION FOLLOWS THE ACTION, NOT THE LAYOUT. An irreversible item renders
 * <HoldToAct> here exactly as it does on the open card. Round 1 found the
 * compressed row had no destructive variant at all: its primary rendered the
 * same neutral button as a reversible one, so compressing an item quietly
 * turned a two-second hold into a one-click destruction.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import type { AttentionItem } from '../model/records';
import { list } from '../model/text';
import { Glyph } from '../primitives/Glyph';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './attention.module.css';

export type AttentionCompactProps = {
  readonly item: AttentionItem;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onArm?: (itemId: string, actionId: string, armedAt: string) => void;
} & NoGlyph;

export function AttentionCompact({ item, onOpen, onAct, onArm }: AttentionCompactProps) {
  const primary = item.actions[0];
  const facts = list(item.facts.slice(0, 2));

  return (
    <div
      className={[styles.acomp, item.state.irreversible ? styles.acompDestructive : null]
        .filter(Boolean)
        .join(' ')}
      data-attention-id={item.id}
    >
      <Glyph decorative={false} state={item.state} />
      <span className={styles.acompText}>
        <button
          className={styles.acompTitle}
          onClick={onOpen === undefined ? undefined : () => onOpen(item.id)}
          type="button"
        >
          {item.title}
        </button>
        {/* BRIEF concept 8, on screen rather than on hover. */}
        <span className={styles.acompWhy} data-voice="system" title={item.rationale}>
          <span className={`${styles.acompWhyLabel} atr-lbl`}>WHY YOU</span>
          {/* The reason is its own element, not a bare text node: a text node in
              a flex container becomes an anonymous flex item, and `text-overflow`
              does not apply to one — the rationale would be cut mid-word with no
              ellipsis to say it had been. */}
          <span className={styles.acompWhyText}>{item.rationale}</span>
        </span>
      </span>
      <span className={styles.acompMeta}>
        {facts === null ? null : <span className={styles.acompFacts}>{facts}</span>}
        {primary === undefined ? null : item.state.irreversible ? (
          <HoldToAct
            actionId={primary.id}
            className={styles.acompHold}
            describe={primary.label}
            label={primary.label}
            onAct={onAct === undefined ? undefined : () => onAct(item.id, primary.id)}
            onArm={
              onArm === undefined
                ? undefined
                : (arming) => onArm(item.id, primary.id, arming.armedAt)
            }
          />
        ) : (
          <button
            className="atr-btn atr-btn-sm"
            onClick={onAct === undefined ? undefined : () => onAct(item.id, primary.id)}
            title={item.rationale}
            type="button"
          >
            {primary.label}
          </button>
        )}
      </span>
    </div>
  );
}
