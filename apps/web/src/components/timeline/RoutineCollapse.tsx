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

  return (
    <div className={styles.routine} data-row="routine" data-open={entry.open ? 'true' : 'false'}>
      <button
        aria-expanded={entry.open}
        className={styles.routineStrip}
        onClick={onTogglePeek}
        title="routine = no state change, no claim, nothing owed to anyone"
        type="button"
      >
        {/* count · range · actors, on one line. Never a bare "N hidden": the
            fold has to say what it swallowed or nobody trusts it. */}
        <span className={styles.routineSummary}>
          <b>{count} routine</b>
          <span aria-hidden="true"> · </span>
          {entry.from} – {entry.to}
          <span aria-hidden="true"> · </span>
          {entry.actors.join(', ')}
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
