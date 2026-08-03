'use client';

/* ---------------------------------------------------------------------------
 * StateLens — the right pane. What the group now understands.
 *
 * The corpus A/B'd state-in-conversation against state-as-separate-lens and
 * shipped the separate lens; this is that pane.
 *
 * ROUND 7, D7: THE HEAD SPENT FIVE OF ITS FIRST EIGHT LINES PROVING ITS OWN
 * ARITHMETIC BEFORE A SINGLE OBJECT APPEARED.
 *
 * Measured at 1124×900: `lensHead` was 139px of a 900px column, roughly 50 of it
 * pure count reconciliation, plus a `lensNote` under it. "nothing is inferred"
 * appeared three times on one screen. Every clause was a TRUE answer to a past
 * objection and nobody had ever removed one — which is how a surface accretes
 * until the thing it exists to show is below the fold.
 *
 * What was removed, and which round put it there:
 *
 *   `.lensSums` — "6 + 3 + 1 = 10 of 10 · awaiting you overlaps them, it does
 *     not add to them". Round 2, after a critic read "9 of 10" and asked where
 *     the tenth went. The answer was right and the fix was a whole line of
 *     arithmetic printed at every load to pre-empt a question about a number
 *     that is on the line above. The REMAINDER is what was worth saying, so it
 *     is said only when there is one, in the head's own line, as a fact about
 *     failures rather than as a proof of addition.
 *
 *   `.lensNote` — "the need-you counts below sum to 5, not 4 — an object under
 *     two objectives is counted by both". Round 3. Same shape: a reconciliation
 *     of two numbers, printed above the objects, permanently. The objective
 *     group's own tooltip already says an object can sit under more than one
 *     objective; that is where the reader is when the question occurs to them.
 *
 * NOTHING GUARANTEED WAS REMOVED. Every count still comes off the objects, the
 * failures are still named as failures, and the pane still refuses to imply that
 * "awaiting you" is a fourth bucket. What went is DISPLAYED PROSE defending
 * arithmetic the reader had not questioned yet.
 * ------------------------------------------------------------------------- */

import frame from '../frame/frame.module.css';
import { needsViewer } from '../model/glyph';
import { systemText } from '../model/quotation';
import type { ObjectiveRecord, StateObject } from '../model/records';
import type { Slot } from '../model/slot';
import { plural } from '../model/text';
import styles from './lens.module.css';
import { ObjectiveGroup } from './ObjectiveGroup';

export interface StateLensProps {
  readonly roomName: string;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly updatedAt: string;
  /** when a receipt is open it replaces the body — the lens is the receipt's home */
  readonly receipt?: Slot;
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
  const unverified = objects.filter((o) =>
    ['proposed', 'unverified', 'self_reported'].includes(o.state.verification),
  );
  const open = objects.filter((o) => o.state.verification === 'open');
  const owed = objects.filter((o) => needsViewer(o.state));
  const accounted = new Set([...settled, ...unverified, ...open].map((o) => o.id));
  const unaccounted = objects.filter((o) => !accounted.has(o.id));

  return (
    <aside aria-label="Current state" className={frame.lens} data-region="current-state">
      <div className={styles.lensHead}>
        <div className={styles.lensHeadTop}>
          <span className={`${styles.lensHeadLabel} atr-lbl`}>CURRENT STATE</span>
          <span className={styles.lensHeadSpacer} />
          <span className="atr-meta">#{systemText(roomName, 'StateLens roomName')}</span>
        </div>
        {/* ONE LINE. The counts, and the remainder NAMED when there is one —
            which is the fact the round-2 sums line was really carrying, said
            where the numbers are rather than proved underneath them. */}
        <div className={styles.lensHeadSub}>
          <span aria-hidden="true" className={`${styles.live} atr-pulse`} data-live="true" />
          <span>
            {plural(objects.length, 'object')} · {settled.length} settled · {unverified.length}{' '}
            unverified
            {open.length === 0 ? '' : ` · ${open.length} open`}
            {unaccounted.length === 0 ? '' : ` · ${plural(unaccounted.length, 'failure')}`} ·{' '}
            {plural(owed.length, 'item')} awaiting you · updated{' '}
            {systemText(updatedAt, 'StateLens updatedAt')}
          </span>
        </div>
      </div>

      <div className={`${styles.lensBody} atr-scroll`}>
        {receipt !== undefined
          ? receipt.node
          : objectives.map((objective) => (
              <ObjectiveGroup
                key={objective.id}
                objective={objective}
                objects={objects}
                onOpenReceipt={onOpenReceipt}
                onToggle={onToggleObjective}
              />
            ))}
      </div>
    </aside>
  );
}
