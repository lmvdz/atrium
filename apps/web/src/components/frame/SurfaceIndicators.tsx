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
            /* The label and the count are two adjacent elements with no text
               node between them, so the computed name concatenated to
               "NEEDS YOU0" — a label welded to a number, and worst on the
               disabled chip where the number is the reason it is disabled.
               Stating the name rather than relying on how the platform joins
               two spans: the visible text is unchanged, and the count is said
               as a count. */
            aria-label={
              surface.count === null ? surface.label : `${surface.label} — ${surface.count}`
            }
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
              /* The chip's border goes dashed to say the surface it counts has
                 nothing on it, which makes it a non-text graphic carrying state.
                 Named by data attribute so the rendered audit's registry can
                 select it — a CSS-module class cannot be selected from outside
                 the module, and a registry selector that matches nothing reports
                 exactly like one that passes. */
              <span
                className={styles.surfCount}
                data-surface-count={String(surface.count)}
                data-surface-empty={empty ? 'true' : 'false'}
              >
                {surface.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
