'use client';

/* ---------------------------------------------------------------------------
 * The three SURFACES — decisions / unseen / cost (scout §9; #112).
 *
 * Not a fourth vocabulary: these are three readings of state the tree already
 * holds. DECISIONS is what a human is owed (pending attention + a settled
 * session awaiting its landing). UNSEEN is what happened while you were away
 * (the room's recent lifecycle events). COST is burn vs budget, per plan,
 * derived from the columns `plans` carries — never a projection of its own.
 *
 * A count reads off the same set the lines list, so "3 owed" lists three; the
 * two cannot drift because there is one array. A surface with nothing on it says
 * so, quietly.
 * ------------------------------------------------------------------------- */

import type { EpistemicState } from '../model/glyph';
import { systemText } from '../model/quotation';
import { Glyph } from '../primitives/Glyph';
import styles from './control.module.css';

export interface SurfaceLine {
  readonly id: string;
  readonly state?: EpistemicState;
  readonly text: string;
}

export interface CostPlanLine {
  readonly id: string;
  readonly title: string;
  readonly drawsLabel: string;
  readonly dollarsLabel: string;
  /**
   * Draws Atrium REFUSED under the current slice (#146). The meter reads granted
   * draws only, so it stays honest; this is the separate fact that the slice is
   * turning work away — otherwise visible only as an unseen line (the #140
   * gauntlet finding). Zero renders nothing.
   */
  readonly refused: number;
  readonly warn: boolean;
  /** 0..1 fill of the enforced draw ceiling; ≥1 (or unfunded burn) reads as over. */
  readonly fill: number;
}

export interface ControlSurfacesProps {
  readonly decisions: { readonly count: number; readonly lines: readonly SurfaceLine[] };
  readonly unseen: {
    readonly count: number;
    readonly lines: readonly SurfaceLine[];
    /**
     * True when there are MORE unseen events than the list shows — the query caps
     * the list, so the count reads `12+` rather than misreporting the cap as the
     * whole (round-7 finding 5). The count stays consistent with the list: twelve
     * rows, "twelve or more".
     */
    readonly truncated?: boolean;
  };
  readonly cost: { readonly warn: boolean; readonly plans: readonly CostPlanLine[] };
}

function LineList({
  lines,
  empty,
}: {
  readonly lines: readonly SurfaceLine[];
  readonly empty: string;
}) {
  if (lines.length === 0) {
    return <p className={styles.surfEmpty}>{systemText(empty, 'ControlSurfaces empty')}</p>;
  }
  return (
    <div className={styles.surfBody}>
      {lines.map((line) => {
        const text = systemText(line.text, 'ControlSurfaces line');
        return (
          <span className={styles.surfLine} key={line.id} title={text}>
            {line.state === undefined ? null : (
              <Glyph className={styles.surfLineGlyph} state={line.state} />
            )}
            {text}
          </span>
        );
      })}
    </div>
  );
}

export function ControlSurfaces({ decisions, unseen, cost }: ControlSurfacesProps) {
  return (
    <div className={styles.surfaces}>
      <section
        className={[styles.surf, decisions.count > 0 ? styles.surfWarn : null]
          .filter(Boolean)
          .join(' ')}
        data-surface="decisions"
      >
        <div className={styles.surfHead}>
          <span
            className={[styles.surfCount, decisions.count > 0 ? styles.surfCountWarn : null]
              .filter(Boolean)
              .join(' ')}
            data-surface-count={decisions.count}
          >
            {decisions.count}
          </span>
          <span className={`${styles.surfLabel} atr-lbl`}>DECISIONS OWED</span>
        </div>
        {/* VIEWER-SCOPED, not room-wide. The list is already filtered to what THIS
            viewer is owed (an agent-principal viewer is owed no human-only decision),
            so the empty text must describe the viewer's own empty queue — never
            assert the room holds nothing awaiting a human, which a hidden owed item
            would make a lie (round-8). */}
        <LineList empty="nothing here is owed to you" lines={decisions.lines} />
      </section>

      <section className={styles.surf} data-surface="unseen">
        <div className={styles.surfHead}>
          {/* `12+` when the true total exceeds the list — an honest "more than
              twelve", never the capped list length passed off as the whole. */}
          <span
            className={styles.surfCount}
            data-surface-count={`${unseen.count}${unseen.truncated ? '+' : ''}`}
          >
            {unseen.count}
            {unseen.truncated ? '+' : ''}
          </span>
          <span className={`${styles.surfLabel} atr-lbl`}>UNSEEN ACTIVITY</span>
        </div>
        <LineList empty="the room has been quiet" lines={unseen.lines} />
      </section>

      <section
        className={[styles.surf, cost.warn ? styles.surfWarn : null].filter(Boolean).join(' ')}
        data-surface="cost"
      >
        <div className={styles.surfHead}>
          <span className={`${styles.surfLabel} atr-lbl`}>COST · BURN VS BUDGET</span>
        </div>
        {cost.plans.length === 0 ? (
          <p className={styles.surfEmpty}>no funded work yet</p>
        ) : (
          <div className={styles.surfBody}>
            {cost.plans.map((plan) => (
              <div className={styles.surfBody} data-cost-plan={plan.id} key={plan.id}>
                <span
                  className={styles.surfLine}
                  title={systemText(plan.title, 'ControlSurfaces cost title')}
                >
                  {systemText(plan.title, 'ControlSurfaces cost title')}
                </span>
                <span className={`${styles.surfLine} atr-meta`}>
                  <span data-cost-draws={plan.drawsLabel}>
                    {systemText(plan.drawsLabel, 'ControlSurfaces draws')}
                  </span>
                  {plan.refused > 0 ? (
                    <span className={styles.costRefused} data-cost-refused={plan.refused}>
                      {systemText(` · ${plan.refused} refused`, 'ControlSurfaces refused')}
                    </span>
                  ) : null}
                  {' · '}
                  <span data-cost-dollars={plan.dollarsLabel}>
                    {systemText(plan.dollarsLabel, 'ControlSurfaces dollars')}
                  </span>
                </span>
                <span className={styles.meter} aria-hidden="true">
                  <span
                    className={[styles.meterFill, plan.warn ? styles.meterFillWarn : null]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ width: `${Math.min(100, Math.max(0, plan.fill * 100))}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
