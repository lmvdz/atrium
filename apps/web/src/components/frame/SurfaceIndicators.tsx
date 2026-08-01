'use client';

/* ---------------------------------------------------------------------------
 * SurfaceIndicators — Conversation / Needs you / Current state.
 *
 * All three surfaces are on screen at once. These FOCUS a surface; they do not
 * navigate to it. That is in the group's accessible name rather than printed
 * into the header as commentary.
 *
 * A count of zero is not a clickable no-op: the indicator is disabled and says
 * so, because a control that does nothing is worse than one that is not there.
 * ------------------------------------------------------------------------- */

import type { SurfaceId, SurfaceIndicator } from '../model/records';
import styles from './frame.module.css';

export interface SurfaceIndicatorsProps {
  readonly surfaces: readonly SurfaceIndicator[];
  readonly focused: SurfaceId;
  readonly onFocus?: (surface: SurfaceId) => void;
}

export function SurfaceIndicators({ surfaces, focused, onFocus }: SurfaceIndicatorsProps) {
  return (
    <div
      aria-label="Focus a surface — all three are already on screen"
      className={styles.surfaces}
      role="toolbar"
    >
      {surfaces.map((surface) => {
        const empty = surface.count !== null && surface.count === 0;
        return (
          <button
            aria-pressed={surface.id === focused}
            className={[styles.surf, surface.warn ? styles.surfWarn : null]
              .filter(Boolean)
              .join(' ')}
            data-surface={surface.id}
            disabled={empty}
            key={surface.id}
            onClick={onFocus === undefined || empty ? undefined : () => onFocus(surface.id)}
            title={
              empty
                ? `nothing on the ${surface.label.toLowerCase()} surface right now`
                : `focus ${surface.label.toLowerCase()} — it is already on screen`
            }
            type="button"
          >
            <span className={`${styles.surfLabel} atr-lbl`}>{surface.label}</span>
            {surface.count === null ? null : (
              <span className={styles.surfCount}>{surface.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
