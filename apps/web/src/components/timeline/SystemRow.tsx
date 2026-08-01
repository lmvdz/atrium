'use client';

/* ---------------------------------------------------------------------------
 * SystemRow — the same IRC grid, one shade of muted.
 *
 * Its text is a `SystemStatement`, so a system row structurally cannot carry a
 * person's words. That is the point: the row that says what the page knows and
 * the row that says what someone wrote must never be confusable.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { statementText } from '../model/quotation';
import type { SystemEntry } from '../model/records';
import { Glyph } from '../primitives/Glyph';
import styles from './timeline.module.css';

export type SystemRowProps = {
  readonly entry: SystemEntry;
} & NoGlyph;

export function SystemRow({ entry }: SystemRowProps) {
  return (
    <div className={`${styles.mrow} atr-rise-s`} data-row="system">
      <div className={styles.time}>{entry.at}</div>
      <Glyph className={styles.glyphCell} state={entry.state} />
      <div className={styles.actor}>system</div>
      <div className={styles.systemBody} data-voice="system">
        {statementText(entry.statement, 'SystemRow')}
      </div>
    </div>
  );
}
