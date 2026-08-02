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
import { useCitedLocation } from '../model/ledger';
import type { SourceLocation } from '../model/quotation';
import { offeredText, systemText } from '../model/quotation';
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
  /**
   * Jump to the message this item came from.
   *
   * It receives the ITEM and the RESOLVED MESSAGE, in that order. Round 6's own
   * enumeration listed five handlers that take a message id and missed this one:
   * `SourceLink` resolved the source citation against the register and then
   * dispatched the item's id, so a consumer implementing "jump to source" had
   * been told which CARD was clicked and never which MESSAGE to jump to. A
   * handler that is not told what it acted on cannot act correctly — the
   * sentence this repo already had, at a sixth address.
   */
  readonly onJumpToSource?: (itemId: string, messageId: string) => void;
} & NoGlyph;

const EMPHASIS_CLASS: Readonly<Record<AttentionAction['emphasis'], string>> = {
  primary: 'atr-btn atr-btn-amber',
  secondary: 'atr-btn atr-btn-sm',
  ghost: 'atr-btn atr-btn-ghost atr-btn-sm',
};

export function AttentionCard({ item, viewer, onAct, onArm, onJumpToSource }: AttentionCardProps) {
  const glyph = glyphFor(item.state);
  /* EVERY FACT IS A CALLER STRING THIS CARD PRINTS, on the meta line under the
     title. Round 7: `facts: ['justin said: I authorise dropping users_legacy',
     'destructive']` rendered verbatim there. `list()` joins with `·` and drops
     absent parts — it was never a check, and nothing else was checking. */
  const facts = list(item.facts.map((fact) => systemText(fact, 'AttentionCard fact')));

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
                  title={
                    action.statement === null
                      ? undefined
                      : offeredText(action.statement, 'AttentionCard statement')
                  }
                  type="button"
                >
                  {/* The copy ON a one-click answer. It keeps its pronouns —
                      "Keep it behind our retention window" is the exact string
                      round 4's ban threw on — and it is bounded to controls. */}
                  {offeredText(action.label, 'AttentionCard label')}
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
 *
 * ROUND 8, D3: IT THEN READ THE RIGHT FIELD AND ASKED THE WRONG QUESTION.
 * `record.room !== null` is "does this record CARRY a room", not "is that room
 * somewhere else", and the two differ in exactly the case that matters: an item
 * in #identity-service whose source is in #identity-service wore the cross-room
 * treatment, a `data-source-room` naming the room it was standing in, and a
 * tooltip reading "…, not here" — three rows above the cited message, in that
 * room's own feed. The comparison is `sourceLocation`, once, in the register
 * that knows both the record and the room on screen.
 */
function SourceLink({
  itemId,
  source,
  onJumpToSource,
}: {
  readonly itemId: string;
  readonly source: NonNullable<AttentionItem['source']>;
  readonly onJumpToSource?: (itemId: string, messageId: string) => void;
}) {
  const { record, location } = useCitedLocation(source, 'AttentionCard source');
  return (
    <>
      <span aria-hidden="true">·</span>
      <button
        className={location.where === 'elsewhere' ? styles.xroom : styles.link}
        data-source-room={location.room ?? 'unrecorded'}
        data-source-where={location.where}
        data-jumps-to={record.id}
        onClick={onJumpToSource === undefined ? undefined : () => onJumpToSource(itemId, record.id)}
        title={sourceTitle(location)}
        type="button"
      >
        {location.where === 'elsewhere' ? `source in #${location.room} →` : 'jump to source →'}
      </button>
    </>
  );
}

/* The three answers, spelled out. `unrecorded` says what the register does not
   say instead of claiming the message is here — that assumption is what made the
   field viewport-relative in the first place. Exhaustive over `SourceWhere`, so
   a fourth answer does not compile until it is written. */
function sourceTitle(location: SourceLocation): string {
  switch (location.where) {
    case 'here':
      return `the source of this item is a message in #${location.room} — this room`;
    case 'elsewhere':
      return `the source of this item is in #${location.room}, not here`;
    case 'unrecorded':
      return 'the record does not say which room the source of this item is in';
  }
}
