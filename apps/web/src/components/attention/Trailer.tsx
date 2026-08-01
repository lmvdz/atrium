'use client';

/* ---------------------------------------------------------------------------
 * Trailer — "everything else is green", except it is only allowed to say that
 * when it is true.
 *
 * The lead AND the glyph are derived by `trailerFor()` from verification and
 * attention (model/records.ts). Green means checked by something other than the
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
import { plural } from '../model/text';
import { Glyph } from '../primitives/Glyph';
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
  return (
    <div className={styles.trailer} data-row="trailer" data-voice="system">
      <Glyph className={styles.trailerGlyph} decorative={false} state={summary.state} />
      <span>
        <button
          className={styles.trailerLead}
          data-trailer-lead="true"
          onClick={onShowRest}
          type="button"
        >
          <SystemVoice inline statement={summary.lead} />
        </button>{' '}
        —{' '}
        <b>
          {summary.objectivesClear}/{summary.objectivesTotal} objectives
        </b>{' '}
        clear of you · <b>{plural(summary.commitments, 'commitment')}</b>
        {/* THE TAIL DOES NOT REPEAT THE LEAD. Round 7: "1 failure outside your
            list — … · 1 failure · last check 12:29". The lead is derived from
            whichever count is worst and the tail printed every count, so the
            worst one was said twice in one sentence. `leadsWith` is what the
            derivation already knew and was not returning. */}
        {summary.leadsWith === 'overdue' ? '' : `, ${summary.overdue} overdue`}
        {summary.leadsWith === 'failures' ? null : (
          <>
            {' · '}
            <b>{plural(summary.failures, 'failure')}</b>
          </>
        )}{' '}
        · last check{' '}
        {/* A clock is a page-authored string with no constructor to be checked
            at, painted inside `data-voice="system"`. The renderer is not merely
            the last place the check can go — it is the only place. */}
        {systemText(lastCheck, 'Trailer last check')}
      </span>
    </div>
  );
}
