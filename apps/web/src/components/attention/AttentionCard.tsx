'use client';

/* ---------------------------------------------------------------------------
 * AttentionCard — one owed item, open.
 *
 * THE RULE THIS COMPONENT ENFORCES: `item.rationale` is a `Rationale`, which is
 * a branded non-empty string with a throwing constructor (model/rationale.ts).
 * The prop is required, so it cannot be omitted; the brand means `''` and
 * `undefined` are not assignable to it, so it cannot be empty. There is no
 * `why?` and no fallback branch — an attention item without a stated reason is
 * an unexplained demand on a person, and this component cannot render one.
 *
 * The rationale is system voice. It is a synthesized sentence about the
 * authority gap, so it is never quoted and never attributed to anybody.
 *
 * Friction is asymmetric (CONVENTIONS): a reversible ◆ gate answers in one
 * click; an irreversible ■ decision renders its action as press-and-hold. The
 * component derives which from the same EpistemicState the glyph comes from,
 * so the two can never disagree.
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { glyphFor } from '../model/glyph';
import type { AttentionAction, AttentionItem } from '../model/records';
import { list } from '../model/text';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import styles from './attention.module.css';

export type AttentionCardProps = {
  readonly item: AttentionItem;
  readonly onAct?: (itemId: string, actionId: string) => void;
  readonly onJumpToSource?: (itemId: string) => void;
} & NoGlyph;

const EMPHASIS_CLASS: Readonly<Record<AttentionAction['emphasis'], string>> = {
  primary: 'atr-btn atr-btn-amber',
  secondary: 'atr-btn atr-btn-sm',
  ghost: 'atr-btn atr-btn-ghost atr-btn-sm',
};

export function AttentionCard({ item, onAct, onJumpToSource }: AttentionCardProps) {
  const glyph = glyphFor(item.state);
  const facts = list(item.facts);
  const crossRoom = item.source !== null && item.source.room !== null ? item.source.room : null;

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
      data-irreversible={item.state.irreversible ? 'true' : 'false'}
    >
      <Glyph className={styles.acardGlyph} decorative={false} state={item.state} />
      <div>
        <div className={styles.acardTitle}>
          <ClaimText state={item.state}>{item.title}</ClaimText>
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
            {item.actions.map((action) => (
              <button
                className={EMPHASIS_CLASS[action.emphasis]}
                data-hold={
                  item.state.irreversible && action.emphasis === 'primary' ? '2000' : undefined
                }
                key={action.id}
                onClick={onAct === undefined ? undefined : () => onAct(item.id, action.id)}
                title={
                  item.state.irreversible && action.emphasis === 'primary'
                    ? 'destructive — press and hold for 2 seconds; the hold is the confirmation'
                    : (action.statement ?? undefined)
                }
                type="button"
              >
                {item.state.irreversible && action.emphasis === 'primary'
                  ? `${action.label} — hold`
                  : action.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
