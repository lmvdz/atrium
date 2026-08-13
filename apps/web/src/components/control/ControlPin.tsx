'use client';

/* ---------------------------------------------------------------------------
 * The room PIN — htop filtered to "needs a human" (scout §9, §18).
 *
 * ONLY what needs a person takes a row: a failed session (unpaid attention), a
 * settled session whose artifact still needs landing, and an owed decision.
 * Everything running-clean is NOT here — it is in the tree, calm. The sort is
 * derived from each item's glyph (`GLYPH_HARDNESS`), so a failed `✗` sorts above
 * a destructive land `■` above a reversible gate `◆` — no caller picks the
 * order, and "the failed session is on top" is a property of the vocabulary.
 *
 * The empty state is a result, not an absence — the same rule the room's own
 * pin (attention/Pin.tsx) states.
 * ------------------------------------------------------------------------- */

import type { EpistemicState } from '../model/glyph';
import { GLYPH_HARDNESS, glyphFor } from '../model/glyph';
import { systemText } from '../model/quotation';
import { plural } from '../model/text';
import { AggregateGlyph, Glyph } from '../primitives/Glyph';
import styles from './control.module.css';

export interface ControlPinItem {
  readonly id: string;
  readonly state: EpistemicState;
  readonly title: string;
  readonly detail: string;
  readonly meta: string;
  /** present when the row opens something — a session's review pane */
  readonly onOpen?: () => void;
}

export interface ControlPinProps {
  readonly items: readonly ControlPinItem[];
  readonly openId?: string;
}

/** Hardest first, derived — the same order the vocabulary carries. */
export function pinHardestFirst(items: readonly ControlPinItem[]): readonly ControlPinItem[] {
  return [...items].sort(
    (a, b) => GLYPH_HARDNESS[glyphFor(a.state)] - GLYPH_HARDNESS[glyphFor(b.state)],
  );
}

export function ControlPin({ items, openId }: ControlPinProps) {
  const ordered = pinHardestFirst(items);

  return (
    <section aria-label="Needs you" className={styles.pin} data-region="control-needs-you">
      <div className={styles.pinHead}>
        <span className={styles.pinHeadGlyph} data-pin-glyph="true">
          <AggregateGlyph over={ordered} />
        </span>
        <span className={`${styles.pinLabel} atr-lbl`}>NEEDS YOU</span>
        <span className={`${styles.pinCount} atr-meta`} data-pin-count="true">
          {systemText(
            ordered.length === 0
              ? 'nothing owed'
              : `${plural(ordered.length, 'item')} · hardest first`,
            'ControlPin count',
          )}
        </span>
      </div>

      {ordered.length === 0 ? (
        <p className={`${styles.pinEmpty} atr-lbl`}>
          NOTHING NEEDS YOU IN THIS ROOM — THAT IS A RESULT, NOT AN ABSENCE
        </p>
      ) : (
        <div className={styles.pinList} data-pin-list="true">
          {ordered.map((item) => {
            const rowClass = [
              styles.pinRow,
              item.id === openId ? styles.pinRowOpen : null,
              'atr-rise-s',
            ]
              .filter(Boolean)
              .join(' ');
            const inner = (
              <>
                <Glyph className={styles.pinGlyph} state={item.state} />
                <span className={styles.pinRowMain}>
                  <span className={styles.pinRowTitle}>
                    {systemText(item.title, 'ControlPin title')}
                  </span>
                  <span className={styles.pinRowDetail}>
                    {systemText(item.detail, 'ControlPin detail')}
                  </span>
                </span>
                <span className={`${styles.pinRowMeta} atr-meta`}>
                  {systemText(item.meta, 'ControlPin meta')}
                </span>
              </>
            );
            return item.onOpen === undefined ? (
              <div className={rowClass} data-pin-item={item.id} key={item.id}>
                {inner}
              </div>
            ) : (
              <button
                className={rowClass}
                data-pin-item={item.id}
                key={item.id}
                onClick={item.onOpen}
                type="button"
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
