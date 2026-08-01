'use client';

/* ---------------------------------------------------------------------------
 * RoutineCollapse — BRIEF concept 7.
 *
 * "31 routine · 11:50–11:57 · backfill, tests, hexi · click to peek" — count,
 * time range, actors and a peek affordance. Never a bare "N hidden": the
 * compression model has to be reversible and legible or nobody trusts the fold.
 *
 * The count is derived from the rows the component was handed, not passed
 * alongside them, so "31 routine" cannot disagree with what the peek shows.
 * ------------------------------------------------------------------------- */

import { systemText } from '../model/quotation';
import type { RoutineEntry } from '../model/records';
import { SystemRow } from './SystemRow';
import styles from './timeline.module.css';

export interface RoutineCollapseProps {
  readonly entry: RoutineEntry;
  readonly onTogglePeek?: () => void;
  /** how many rows the peek shows before it says there are more */
  readonly peekLimit?: number;
}

export function RoutineCollapse({ entry, onTogglePeek, peekLimit = 6 }: RoutineCollapseProps) {
  const count = entry.rows.length;
  const shown = entry.open ? entry.rows.slice(0, peekLimit) : [];
  const remaining = count - shown.length;
  const actors = systemText(entry.actors.join(', '), 'RoutineCollapse actors');

  return (
    <div className={styles.routine} data-row="routine" data-open={entry.open ? 'true' : 'false'}>
      <button
        aria-expanded={entry.open}
        /* THE VISIBLE SEPARATORS ARE aria-hidden, WHICH REMOVED THE ONLY
           WHITESPACE. The strip's parts are adjacent inline spans joined by
           `<span aria-hidden> · </span>`, so the computed name ran together as
           "8 routine11:50 – 11:57backfill, tests, deploys". Found by sweeping
           every button's COMPUTED accessible name — the same sweep that showed
           the composite lens rows are fine, because the accname algorithm does
           insert a space for block-level parts. A `·` that is decoration to the
           eye is not decoration to the name computation once it is the only
           thing between two runs of text. */
        aria-label={`${count} routine ${count === 1 ? 'row' : 'rows'} between ${entry.from} and ${entry.to}, from ${actors} — ${entry.open ? 'click to hide' : 'click to peek'}`}
        className={styles.routineStrip}
        onClick={onTogglePeek}
        title="routine = no state change, no claim, nothing owed to anyone"
        type="button"
      >
        {/* count · range · actors, on one line. Never a bare "N hidden": the
            fold has to say what it swallowed or nobody trusts it. */}
        <span
          className={styles.routineSummary}
          data-truncates="the strip's accessible name, and peeking opens the rows"
        >
          <b>{count} routine</b>
          <span aria-hidden="true"> · </span>
          {entry.from} – {entry.to}
          <span aria-hidden="true"> · </span>
          {/* NAMES IN A COUNT, NOT NAMES BESIDE WORDS — and held to the system's
              voice anyway. The blind cross-lineage review of round 6 named this
              as a third instance of the `HappenedLine.who` shape, because
              `RoutineEntry` carries `actors: string[]` alongside
              `rows: SystemEntry[]`. It is NOT that shape and the difference is
              worth being exact about: `who` sat immediately before one
              statement's words, as that statement's speaker. These names
              summarise a SET of rows and are adjacent to no statement — the fold
              has to say whose activity it swallowed or nobody trusts it
              (CONVENTIONS requires the actors here).
              What is true of both is that a caller-supplied string is being
              printed by the page, so it goes through the same door. */}
          {actors}
        </span>
        <span className={styles.routinePeek}>{entry.open ? 'click to hide' : 'click to peek'}</span>
      </button>
      {entry.open ? (
        <p className={`${styles.routineDefinition} atr-meta`}>
          routine = no state change, no claim, nothing owed to anyone
        </p>
      ) : null}

      {entry.open ? (
        <div className={`${styles.peekBody} atr-scroll`}>
          {shown.map((row) => (
            <SystemRow entry={row} key={row.id} />
          ))}
          {remaining > 0 ? (
            <div className={`${styles.peekMore} atr-meta`}>
              {remaining} more in this group — all of the same shape
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
