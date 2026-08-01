'use client';

/* ---------------------------------------------------------------------------
 * SystemRow — the same IRC grid, one shade of muted.
 *
 * Its text is a `SystemStatement`, so a system row structurally cannot carry a
 * person's words. That is the point: the row that says what the page knows and
 * the row that says what someone wrote must never be confusable.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { statementText, systemText } from '../model/quotation';
import type { SystemEntry } from '../model/records';
import { Glyph } from '../primitives/Glyph';
import styles from './timeline.module.css';

export type SystemRowProps = {
  readonly entry: SystemEntry;
} & NoGlyph;

export function SystemRow({ entry }: SystemRowProps) {
  return (
    <div className={`${styles.mrow} atr-rise-s`} data-row="system">
      {/* The clock is a caller string too — the same sink as the trailer's
          last-check time, which round 6 found and fixed one component over. */}
      <div className={styles.time}>{systemText(entry.at, 'SystemRow at')}</div>
      <Glyph className={styles.glyphCell} state={entry.state} />
      <div className={styles.actor} data-truncates="none">
        system
      </div>
      <div className={styles.systemBody} data-voice="system">
        {statementText(entry.statement, 'SystemRow')}
      </div>
    </div>
  );
}
