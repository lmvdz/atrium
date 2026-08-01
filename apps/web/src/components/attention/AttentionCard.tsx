'use client';

/* ---------------------------------------------------------------------------
 * AttentionCard — one owed item, open.
 *
 * THE RULE THIS COMPONENT ENFORCES: `item.rationale` is a `Rationale`, which is
 * a branded non-empty string with a throwing constructor (model/rationale.ts).
 * The prop is required, so it cannot be omitted; the brand means `''` and
 * `undefined` are not assignable to it, so a TypeScript caller cannot make it
 * empty. There is no `why?` and no fallback branch — an attention item without
 * a stated reason is an unexplained demand on a person, and this component
 * cannot render one. (`isRationale` is the runtime half, for data that did not
 * come through the compiler.)
 *
 * The rationale is system voice. It is a synthesized sentence about the
 * authority gap, so it is never quoted and never attributed to anybody.
 *
 * FRICTION IS ASYMMETRIC (CONVENTIONS): a reversible ◆ gate answers in one
 * click; an irreversible ■ decision renders as <HoldToAct>, which is a real
 * two-second press-and-hold with a filling bar and a cancel-on-release, not a
 * `data-hold` attribute nothing reads. The component derives which from the
 * same EpistemicState the glyph comes from, so the two can never disagree, and
 * the destructive control wears the red ramp rather than the gate's amber.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { glyphFor } from '../model/glyph';
import type { AttentionAction, AttentionItem } from '../model/records';
import { slot } from '../model/slot';
import { list } from '../model/text';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import type { Arming } from '../primitives/HoldToAct';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './attention.module.css';

export type AttentionCardProps = {
  readonly item: AttentionItem;
  /** whose press an arming records. Required wherever a hold can be rendered. */
  readonly viewer: string;
  readonly onAct?: (itemId: string, actionId: string) => void;
  /**
   * The arming of an irreversible action, recorded before the act. Round 2
   * flattened this to `(itemId, actionId, armedAt)` and dropped the measured
   * hold on the floor; the whole record crosses now, actor included, because
   * what the caller puts on the record should be what the control measured.
   */
  readonly onArm?: (itemId: string, arming: Arming) => void;
  readonly onJumpToSource?: (itemId: string) => void;
} & NoGlyph;

const EMPHASIS_CLASS: Readonly<Record<AttentionAction['emphasis'], string>> = {
  primary: 'atr-btn atr-btn-amber',
  secondary: 'atr-btn atr-btn-sm',
  ghost: 'atr-btn atr-btn-ghost atr-btn-sm',
};

export function AttentionCard({ item, viewer, onAct, onArm, onJumpToSource }: AttentionCardProps) {
  const glyph = glyphFor(item.state);
  const facts = list(item.facts);
  /* `text()` is the runtime boundary for Maybe: `undefined` reaching this from a
     cast or a JS caller used to render "source in #undefined". */
  const crossRoom = item.source === null ? null : (list([item.source.room]) ?? null);

  return (
    <article
      className={[
        styles.acard,
        glyph === '◆' || glyph === '?' ? styles.acardGate : null,
        glyph === '■' ? styles.acardDestructive : null,
        'atr-rise',
      ]
        .filter(Boolean)
        .join(' ')}
      data-attention-id={item.id}
      /* The card's border and inset stripe are a non-text graphic carrying gate
         vs destructive; named here so the rendered audit's registry can measure
         them without depending on a CSS-module hash. */
      data-card-state={
        glyph === '■' ? 'destructive' : glyph === '◆' || glyph === '?' ? 'gate' : 'plain'
      }
      data-irreversible={item.state.irreversible ? 'true' : 'false'}
    >
      <Glyph className={styles.acardGlyph} decorative={false} state={item.state} />
      <div>
        <div className={styles.acardTitle}>
          <ClaimText content={slot(item.title)} state={item.state} />
        </div>

        <div className={styles.why}>
          <span className={`${styles.whyLabel} atr-lbl`}>WHY YOU</span>
          <span data-voice="system">{item.rationale}</span>
        </div>

        <div className={styles.acardFoot}>
          <div className={styles.acardMeta}>
            {facts === null ? null : <span>{facts}</span>}
            {crossRoom === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <button
                  className={styles.xroom}
                  onClick={onJumpToSource === undefined ? undefined : () => onJumpToSource(item.id)}
                  title={`the source of this item is in #${crossRoom}, not here`}
                  type="button"
                >
                  source in #{crossRoom} →
                </button>
              </>
            )}
            {crossRoom === null && item.source !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <button
                  className={styles.link}
                  onClick={onJumpToSource === undefined ? undefined : () => onJumpToSource(item.id)}
                  type="button"
                >
                  jump to source →
                </button>
              </>
            ) : null}
          </div>

          <div className={styles.acardActions}>
            {item.actions.map((action) =>
              item.state.irreversible && action.emphasis === 'primary' ? (
                <HoldToAct
                  actionId={action.id}
                  actor={viewer}
                  describe={action.label}
                  key={action.id}
                  onAct={onAct === undefined ? undefined : () => onAct(item.id, action.id)}
                  onArm={onArm === undefined ? undefined : (arming) => onArm(item.id, arming)}
                  label={action.label}
                />
              ) : (
                <button
                  className={EMPHASIS_CLASS[action.emphasis]}
                  key={action.id}
                  onClick={onAct === undefined ? undefined : () => onAct(item.id, action.id)}
                  title={action.statement ?? undefined}
                  type="button"
                >
                  {action.label}
                </button>
              ),
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
