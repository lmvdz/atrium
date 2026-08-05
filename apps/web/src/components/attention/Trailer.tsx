'use client';

/* ---------------------------------------------------------------------------
 * Trailer — "everything else is green", except it is only allowed to say that
 * when it is true.
 *
 * The lead is derived by `trailerFor()` from verification and attention
 * (model/records.ts). Green means checked by something other than the
 * claimant, so a room with eight unchecked claims outside the pin gets
 * "8 of 11 still unverified" and a `~`, not a reassurance. Hardcoding the
 * sentence over derived numbers is how a room with a failure in it still
 * announces that everything is green.
 *
 * It wraps rather than clipping: below 1340 a nowrap trailer eats the checkable
 * half of the sentence and leaves only the summary clause. A fact you cannot
 * read is not on the page.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { systemText } from '../model/quotation';
import type { TrailerSummary } from '../model/records';
import { SystemVoice } from '../primitives/Voice';
import styles from './attention.module.css';

export type TrailerProps = {
  readonly summary: TrailerSummary;
  readonly lastCheck: string;
  /**
   * Show what the lead is about — the failures, the late commitments, the
   * unverified claims that sit OUTSIDE the pin.
   *
   * Round 6's blind critic clicked "✗ 1 failure outside your list" and nothing
   * happened, because it was a sentence in a `<div>`. A line that tells a person
   * something is wrong somewhere they are not looking, and gives them no way to
   * look, is the same defect class as `data-hold="2000"`: copy describing a
   * capability the code does not have.
   */
  readonly onShowRest?: () => void;
} & NoGlyph;

export function Trailer({ summary, lastCheck, onShowRest }: TrailerProps) {
  /* The lead is the one actionable aggregate. Detailed object and objective
     counts already live in Current state; repeating them here creates a
     reconciliation sentence whose scopes the reader has to untangle. */
  return (
    <div className={styles.trailer} data-row="trailer" data-voice="system">
      <span>
        <button
          className={styles.trailerLead}
          data-trailer-lead="true"
          onClick={onShowRest}
          type="button"
        >
          <SystemVoice inline statement={summary.lead} />
        </button>{' '}
        {/* A clock is a page-authored string with no constructor to be checked
            at, painted inside `data-voice="system"`. The renderer is not merely
            the last place the check can go — it is the only place. */}
        <span data-trailer-scope="check">
          last check {systemText(lastCheck, 'Trailer last check')}
        </span>
      </span>
    </div>
  );
}
