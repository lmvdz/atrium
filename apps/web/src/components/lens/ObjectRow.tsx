'use client';

/* ---------------------------------------------------------------------------
 * ObjectRow — one semantic object in the state lens.
 *
 * Glyph derived, claim treatment derived, both from the same state. Clicking a
 * row opens its receipt: every rendered derived object gets an inspect
 * affordance from day one, not as polish (BRIEF concept 5).
 * ------------------------------------------------------------------------- */

import type { NoGlyph } from '../model/glyph';
import { glyphFor } from '../model/glyph';
import { systemText } from '../model/quotation';
import type { StateObject } from '../model/records';
import { slot } from '../model/slot';
import { ClaimText } from '../primitives/ClaimText';
import { Glyph } from '../primitives/Glyph';
import styles from './lens.module.css';

export type ObjectRowProps = {
  readonly object: StateObject;
  readonly onOpenReceipt?: (objectId: string) => void;
} & NoGlyph;

/** facts that report something unfinished read amber, so the row scans right */
const WARN = /overdue|not accepted|open |blocked|reopened|unverified|late/i;

export function ObjectRow({ object, onOpenReceipt }: ObjectRowProps) {
  const settled = glyphFor(object.state) === '✓';
  return (
    <button
      className={[styles.oitem, settled ? styles.oitemSettled : null, 'atr-rise']
        .filter(Boolean)
        .join(' ')}
      data-object-id={object.id}
      onClick={onOpenReceipt === undefined ? undefined : () => onOpenReceipt(object.id)}
      title="open the receipt — what happened, who checked it, and what it rests on"
      type="button"
    >
      <Glyph className={styles.oitemGlyph} decorative={false} state={object.state} />
      <span>
        <span className={styles.oitemText}>
          <ClaimText content={slot(object.text)} state={object.state} />
        </span>
        <span className={styles.oitemMeta}>
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
      </span>
    </button>
  );
}
