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
  /* ---------------------------------------------------------------------------
   * TWO CLAUSES, EACH NAMING WHAT IT COUNTS — ROUND 10, D4.
   *
   * The r9 tail was "2 objectives clear of you · 2 commitments, 0 overdue · 1
   * failure": three numbers about the pin's objectives, three about the objects
   * outside the pin, and one that was room-wide, run together with `·` between
   * them and the scope stated once, in the lead. So "0 overdue" stood 300px from
   * a lens row reading "overdue 16h", and "0 failures" stood beside a lens head
   * reading "15 failures". Both numbers were true; the sentence did not say of
   * what.
   *
   * Each clause is now ONE element whose own text is the whole clause, scope word
   * included. That is also what makes it readable by the agreement check: a claim
   * belongs to the element that states it, and a clause split across four `<b>`s
   * has no element that states it.
   * ------------------------------------------------------------------------- */
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
        <span data-trailer-scope="outside">
          outside your list, of {plural(summary.outside, 'object')}:{' '}
          {plural(summary.commitments, 'commitment')}
          {/* THE CLAUSE STILL DOES NOT REPEAT THE LEAD (round 7): the lead is
              derived from whichever count is worst, so the clause drops the one
              it led with rather than saying it twice in one sentence. */}
          {summary.leadsWith === 'overdue' ? '' : ` · ${summary.overdue} late`}
          {summary.leadsWith === 'failures' ? '' : ` · ${plural(summary.failures, 'failure')}`}
        </span>{' '}
        ·{' '}
        <span data-trailer-scope="yours">
          your list: {summary.objectivesClear} of {summary.objectivesTotal} objectives clear of you
        </span>{' '}
        ·{' '}
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
