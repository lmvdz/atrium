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
import { useCitedRecord } from '../model/ledger';
import { rationaleText } from '../model/rationale';
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
        <div className={styles.acardTitle} data-truncates="the object's receipt in Current state">
          <ClaimText content={slot(item.title)} state={item.state} />
        </div>

        <div className={styles.why}>
          <span className={`${styles.whyLabel} atr-lbl`}>WHY YOU</span>
          {/* THE RENDER BOUNDARY FOR THE OTHER PAGE-AUTHORED STRING. Round 5
              wrote `statementText()` for `SystemStatement` and applied it to
              one of the two types that need it: `Rationale` was checked at its
              constructor and at `isRationale`, and printed raw here, under the
              mono-muted treatment that tells a reader the system checked this.
              A guarantee held at the constructor and at the parser is still not
              held at the renderer — the sentence CONVENTIONS already had. */}
          <span data-voice="system">{rationaleText(item.rationale, 'AttentionCard')}</span>
        </div>

        <div className={styles.acardFoot}>
          <div className={styles.acardMeta}>
            {facts === null ? null : <span>{facts}</span>}
            {item.source === null ? null : (
              <SourceLink itemId={item.id} onJumpToSource={onJumpToSource} source={item.source} />
            )}
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

/**
 * The way to the room this item came from.
 *
 * Its own component so the register lookup is an unconditional hook, and so the
 * ROOM is read off the cited record rather than off a copy travelling beside the
 * id. `AttentionItem.source` was a `SourceRef` -- `{messageId, room}` -- and the
 * card printed the carried room while the handler acted on the item; two facts
 * about one source with nothing obliging them to agree.
 */
function SourceLink({
  itemId,
  source,
  onJumpToSource,
}: {
  readonly itemId: string;
  readonly source: NonNullable<AttentionItem['source']>;
  readonly onJumpToSource?: (itemId: string) => void;
}) {
  const record = useCitedRecord(source, 'AttentionCard source');
  const room = record.room ?? null;
  return (
    <>
      <span aria-hidden="true">·</span>
      <button
        className={room === null ? styles.link : styles.xroom}
        data-source-room={room ?? 'here'}
        onClick={onJumpToSource === undefined ? undefined : () => onJumpToSource(itemId)}
        title={
          room === null
            ? 'the source of this item is a message in this room'
            : `the source of this item is in #${room}, not here`
        }
        type="button"
      >
        {room === null ? 'jump to source →' : `source in #${room} →`}
      </button>
    </>
  );
}
