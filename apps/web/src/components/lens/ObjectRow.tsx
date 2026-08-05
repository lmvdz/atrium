'use client';

/* ---------------------------------------------------------------------------
 * ObjectRow — one semantic object in the state lens.
 *
 * Glyph derived, claim treatment derived, both from the same state. Clicking a
 * row opens its receipt: every rendered derived object gets an inspect
 * affordance from day one, not as polish (BRIEF concept 5).
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { isSettled } from '../model/glyph';
import { systemText } from '../model/quotation';
import type { ContextualReferenceAttention, StateObject } from '../model/records';
import { slot } from '../model/slot';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import styles from './lens.module.css';
import { ReferenceMarkers } from './ReferenceMarkers';

export type ObjectRowProps = {
  readonly object: StateObject;
  readonly onOpenReceipt?: (objectId: string) => void;
  readonly referenceAttention?: readonly ContextualReferenceAttention[];
  readonly onOpenReferences?: (attentionIds: readonly string[], messageId: string) => void;
} & NoGlyph;

/** facts that report something unfinished read amber, so the row scans right */
const WARN = /overdue|not accepted|open |blocked|reopened|unverified|late/i;

export function ObjectRow({
  object,
  onOpenReceipt,
  referenceAttention = [],
  onOpenReferences,
}: ObjectRowProps) {
  /* `isSettled`, not `glyphFor(state) === '✓'`. Round 10, D1: the second spells a
     glyph character outside the vocabulary module, and asks a question about a
     character when the question is about the state. */
  const settled = isSettled(object.state);
  const references = referenceAttention.filter(
    (reference) => reference.location.kind === 'object' && reference.location.id === object.id,
  );
  /* THE ROW STATES ITS OWN NAME, because six adjacent cells do not.
     v8 laid this row out as a tree grid — sentence, verification, facts, kind,
     spend, age — and adjacent elements with no text node between them are
     announced welded: "accepted by lars" beside "29 Jul 11:20" reads as
     "lars29 Jul 11:20", and that beside "answer-bound" reads as
     "11:20answer-bound". Eighteen rows in the gallery announced that way. It is
     the defect `Rail.tsx` records against its own room chips ("#identity-service12"
     — the badge saying twelve things are owed is the half that gets eaten), and
     the remedy is the same one: compose the name here with separators the
     platform cannot swallow, rather than leave it to how two spans happen to
     join. The facts' own `·` separators are `aria-hidden`, so they are absent
     from the computed name — which is exactly why the weld appears there. */
  const rowName = [
    systemText(object.text, 'ObjectRow text'),
    systemText(object.state.verification, 'ObjectRow verification'),
    ...object.facts.map((fact) => systemText(fact, 'ObjectRow fact')),
    systemText(object.kind, 'ObjectRow kind'),
  ]
    .map((part) => String(part).trim())
    .filter((part) => part.length > 0)
    .join(' — ');
  return (
    <div className={styles.oitemWrap}>
      <button
        aria-label={rowName}
        className={[styles.oitem, settled ? styles.oitemSettled : null, 'atr-rise']
          .filter(Boolean)
          .join(' ')}
        data-object-id={object.id}
        onClick={onOpenReceipt === undefined ? undefined : () => onOpenReceipt(object.id)}
        title="open the receipt — what happened, who checked it, and what it rests on"
        type="button"
      >
        <span className={styles.sessionCell}>
          <Glyph className={styles.oitemGlyph} decorative={false} state={object.state} />
          <span className={styles.oitemText} data-truncates="name">
            <ClaimText content={slot(object.text)} state={object.state} />
          </span>
        </span>
        <span className={styles.stateCell} data-truncates="name">
          {systemText(object.state.verification, 'ObjectRow verification')}
        </span>
        <span className={styles.latestCell} data-truncates="name">
          {/* EVERY FACT IS A CALLER STRING THIS ROW PRINTS. Round 7: the same
            shape as `AttentionItem.facts` — a metadata line under an object's
            own sentence, page-authored, and printed raw. */}
          {object.facts.map((fact, index) => (
            <span key={fact}>
              {index === 0 ? null : <span aria-hidden="true">· </span>}
              <span className={WARN.test(fact) ? styles.warn : undefined}>
                {systemText(fact, 'ObjectRow fact')}
              </span>
            </span>
          ))}
        </span>
        <span className={styles.lensCell} data-truncates="name">
          {systemText(object.kind, 'ObjectRow kind')}
        </span>
        <span className={styles.spendCell} data-truncates="name">
          —
        </span>
        <span className={styles.ageCell} data-truncates="name">
          —
        </span>
      </button>
      <ReferenceMarkers onOpen={onOpenReferences} references={references} />
    </div>
  );
}
