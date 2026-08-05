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
import { offeredText, systemText } from '../model/quotation';
import { rationaleText } from '../model/rationale';
import type { AttentionItem } from '../model/records';
import { list } from '../model/text';
import { Glyph } from '../primitives/Glyph';
import type { Arming } from '../primitives/HoldToAct';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './attention.module.css';

export type AttentionCompactProps = {
  readonly item: AttentionItem;
  /** whose press an arming records — same requirement as the open card */
  readonly viewer: string;
  readonly onOpen?: (itemId: string) => void;
  readonly onAct?: (itemId: string, actionId: string) => void;
  /** the whole measured record, not a timestamp cut out of it */
  readonly onArm?: (itemId: string, arming: Arming) => void;
} & NoGlyph;

export function AttentionCompact({ item, viewer, onOpen, onAct, onArm }: AttentionCompactProps) {
  const primary = item.actions[0];
  const facts = list(
    item.facts.slice(0, 2).map((fact) => systemText(fact, 'AttentionCompact fact')),
  );
  const title = systemText(item.title, 'AttentionCompact title');
  /* ONE CHECKED READ, USED BY ALL THREE PLACES THIS ROW PUTS THE REASON ON
     SCREEN — the visible span and two `title=` attributes. Round 5's
     `statementText` discipline, applied to the second page-authored string type
     rather than to one of them. */
  const why = rationaleText(item.rationale, 'AttentionCompact');

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
          data-truncates="control"
          onClick={onOpen === undefined ? undefined : () => onOpen(item.id)}
          title={title}
          type="button"
        >
          {title}
        </button>
        {/* BRIEF concept 8, on screen rather than on hover.

            AND THE CLIP OWES THE READER A ROUTE. Round 1 moved the reason off
            `title=` and onto the row; round 6 measured the row and found all
            three of the shipped compressed reasons clipped — 321 of 777px, 199
            of 801px, 379 of 680px at 1440 — with the remainder on `title=` only,
            which is exactly the affordance the component's own header records as
            the defect it was written to fix. The clamp itself is right: the row
            is a compressed row and unclamping it is the unbounded pin again.
            What was missing is the route. The whole WHY YOU line is now the
            same control as the title — one click, no hover, no pointer — and it
            opens the full card, where the reason renders unclamped. The clamped
            element says so on the DOM (`data-truncates`) so the e2e sweep can
            assert that every clipped string on the page names its way out. */}
        <button
          className={styles.acompWhy}
          data-voice="system"
          onClick={onOpen === undefined ? undefined : () => onOpen(item.id)}
          title={why}
          type="button"
        >
          <span className={`${styles.acompWhyLabel} atr-lbl`}>WHY YOU</span>
          {/* The reason is its own element, not a bare text node: a text node in
              a flex container becomes an anonymous flex item, and `text-overflow`
              does not apply to one — the rationale would be cut mid-word with no
              ellipsis to say it had been. */}
          <span className={styles.acompWhyText} data-truncates="control">
            {why}
          </span>
        </button>
      </span>
      <span className={styles.acompMeta}>
        {facts === null ? null : (
          /* THE FACTS ARE A CONTROL TOO, for the same reason the title and the
             WHY YOU line are: this row shows two of them and clips whatever is
             left, and the route out of a clip has to be something a reader can
             press. Round 7 — it was a `<span>` declaring "opens the full card"
             while being nothing a click could reach. */
          <button
            className={styles.acompFacts}
            data-truncates="control"
            onClick={onOpen === undefined ? undefined : () => onOpen(item.id)}
            type="button"
          >
            {facts}
          </button>
        )}
        {primary === undefined ? null : item.state.irreversible ? (
          <HoldToAct
            actionId={primary.id}
            actor={viewer}
            className={styles.acompHold}
            describe={primary.label}
            label={primary.label}
            onAct={onAct === undefined ? undefined : () => onAct(item.id, primary.id)}
            onArm={onArm === undefined ? undefined : (arming) => onArm(item.id, arming)}
          />
        ) : (
          <button
            className="atr-btn atr-btn-sm"
            onClick={onAct === undefined ? undefined : () => onAct(item.id, primary.id)}
            title={why}
            type="button"
          >
            {offeredText(primary.label, 'AttentionCompact label')}
          </button>
        )}
      </span>
    </div>
  );
}
