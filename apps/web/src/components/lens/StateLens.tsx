'use client';

/* ---------------------------------------------------------------------------
 * StateLens — the right pane. What the group now understands.
 *
 * The corpus A/B'd state-in-conversation against state-as-separate-lens and
 * shipped the separate lens; this is that pane.
 *
 * One honesty rule shows up in the header: settled + unverified + open
 * partition the objects, but "awaiting you" cuts across all three. Sub-counts
 * that do not sum are reconciled in prose immediately under the counts, which
 * costs one line and removes the only reading in which the numbers look wrong.
 * ------------------------------------------------------------------------- */

import type { ReactNode } from 'react';
import frame from '../frame/frame.module.css';
import { isClaim, needsViewer } from '../model/glyph';
import type { ObjectiveRecord, StateObject } from '../model/records';
import { plural } from '../model/text';
import styles from './lens.module.css';
import { ObjectiveGroup } from './ObjectiveGroup';

export interface StateLensProps {
  readonly roomName: string;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly updatedAt: string;
  /** when a receipt is open it replaces the body — the lens is the receipt's home */
  readonly receipt?: ReactNode;
  readonly onToggleObjective?: (objectiveId: string) => void;
  readonly onOpenReceipt?: (objectId: string) => void;
}

export function StateLens({
  roomName,
  objectives,
  objects,
  updatedAt,
  receipt,
  onToggleObjective,
  onOpenReceipt,
}: StateLensProps) {
  const settled = objects.filter((o) => ['verified', 'accepted'].includes(o.state.verification));
  const claims = objects.filter((o) => isClaim(o.state));
  const open = objects.filter((o) => o.state.verification === 'open');
  const owed = objects.filter((o) => needsViewer(o.state));

  const perObjectiveOwed = objectives.reduce(
    (n, objective) => n + owed.filter((object) => object.objectives.includes(objective.id)).length,
    0,
  );

  return (
    <aside aria-label="Current state" className={frame.lens} data-region="current-state">
      <div className={styles.lensHead}>
        <div className={styles.lensHeadTop}>
          <span className={`${styles.lensHeadLabel} atr-lbl`}>CURRENT STATE</span>
          <span className={styles.lensHeadSpacer} />
          <span className="atr-meta">#{roomName}</span>
        </div>
        <div className={styles.lensHeadSub}>
          <span aria-hidden="true" className={styles.live} />
          <span>
            {plural(objects.length, 'object')} · {settled.length} settled · {claims.length}{' '}
            unverified · {plural(owed.length, 'item')} awaiting you · updated {updatedAt}
          </span>
        </div>
        <div className={styles.lensSums}>
          {settled.length} + {claims.length}
          {open.length > 0 ? ` + ${open.length} open` : ''} ={' '}
          {settled.length + claims.length + open.length} of {objects.length} · awaiting you overlaps
          them, it does not add to them
        </div>
      </div>

      <div className={`${styles.lensBody} atr-scroll`}>
        {receipt !== undefined ? (
          receipt
        ) : (
          <>
            {perObjectiveOwed === owed.length ? null : (
              <div className={styles.lensNote}>
                the need-you counts below sum to {perObjectiveOwed}, not {owed.length} — an object
                under two objectives is counted by both, and is still one item in Needs you
              </div>
            )}
            {objectives.map((objective) => (
              <ObjectiveGroup
                key={objective.id}
                objective={objective}
                objects={objects}
                onOpenReceipt={onOpenReceipt}
                onToggle={onToggleObjective}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
