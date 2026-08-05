'use client';

/* ---------------------------------------------------------------------------
 * ObjectiveGroup — objects grouped under the objective they serve, then by kind.
 *
 * The per-objective owed counts can sum to more than the pin's item count,
 * because one object can sit under two objectives. Where that is true the lens
 * says so in prose rather than leaving two numbers to contradict each other —
 * see `LensNote` in StateLens.
 * ------------------------------------------------------------------------- */

import type { ObjectKind } from '../model/glyph';
import { needsViewer } from '../model/glyph';
import { systemText } from '../model/quotation';
import type { ContextualReferenceAttention, ObjectiveRecord, StateObject } from '../model/records';
import { plural } from '../model/text';
import styles from './lens.module.css';
import { ObjectRow } from './ObjectRow';
import { ReferenceMarkers } from './ReferenceMarkers';

export interface ObjectiveGroupProps {
  readonly objective: ObjectiveRecord;
  readonly objects: readonly StateObject[];
  readonly onToggle?: (objectiveId: string) => void;
  readonly onOpenReceipt?: (objectId: string) => void;
  readonly referenceAttention?: readonly ContextualReferenceAttention[];
  readonly onOpenReferences?: (attentionIds: readonly string[], messageId: string) => void;
}

const KIND_ORDER: readonly ObjectKind[] = ['decision', 'commitment', 'question', 'claim', 'event'];

const KIND_LABEL: Readonly<Record<ObjectKind, string>> = {
  decision: 'DECISIONS',
  commitment: 'COMMITMENTS',
  question: 'QUESTIONS',
  claim: 'CLAIMS',
  event: 'EVENTS',
};

const STATUS_CLASS = {
  active: styles.statusActive,
  blocked: styles.statusBlocked,
  idle: undefined,
  proposed: undefined,
} as const;

export function ObjectiveGroup({
  objective,
  objects,
  onToggle,
  onOpenReceipt,
  referenceAttention = [],
  onOpenReferences,
}: ObjectiveGroupProps) {
  const mine = objects.filter((object) => object.objectives.includes(objective.id));
  const owedHere = mine.filter((object) => needsViewer(object.state)).length;
  const objectiveReferences = referenceAttention.filter(
    (reference) =>
      reference.location.kind === 'objective' && reference.location.id === objective.id,
  );

  /* THE HEADER STATES ITS OWN NAME — the same repair `ObjectRow` carries, for
     the same reason. v8 lays this out as a six-cell tree row, and every cell
     declares `data-truncates="name"`, which is a promise that the full string
     is reachable through an ancestor's accessible name. Composed from content,
     that name welds adjacent cells together and drops the aria-hidden twisty's
     neighbours; the cells' own text ("active", "3 objects · 1 need you") went
     missing from it entirely. Stated here, with separators, so the promise the
     cells make is one this row actually keeps. */
  const headName = [
    systemText(objective.title, 'ObjectiveGroup title'),
    systemText(objective.status, 'ObjectiveGroup status'),
    `${plural(mine.length, 'object')} · ${owedHere > 0 ? `${owedHere} need you` : 'all clear'}`,
    'objective',
  ]
    .map((part) => String(part).trim())
    .filter((part) => part.length > 0)
    .join(' — ');

  return (
    <section className={styles.obj} data-objective-id={objective.id}>
      <button
        aria-expanded={objective.open}
        aria-label={headName}
        className={styles.objHead}
        onClick={
          objective.status === 'proposed'
            ? onOpenReceipt === undefined
              ? undefined
              : () => onOpenReceipt(objective.id)
            : onToggle === undefined
              ? undefined
              : () => onToggle(objective.id)
        }
        title={
          objective.status === 'proposed'
            ? 'open the receipt — inspect the source and accept or decline this reading'
            : owedHere > 0
              ? `${plural(mine.length, 'object')} sit under this objective, ${owedHere} of which need you. An object can sit under more than one objective, so these counts overlap the other objectives and the pin.`
              : `${plural(mine.length, 'object')} sit under this objective. Nothing here is waiting on you.`
        }
        type="button"
      >
        <span className={styles.sessionCell}>
          <span aria-hidden="true" className={styles.objTwisty}>
            {objective.open ? '▾' : '▸'}
          </span>
          <span className={styles.objTitle} data-truncates="name">
            {systemText(objective.title, 'ObjectiveGroup title')}
          </span>
        </span>
        <span
          className={`${styles.stateCell} ${STATUS_CLASS[objective.status] ?? ''}`}
          data-truncates="name"
        >
          {systemText(objective.status, 'ObjectiveGroup status')}
        </span>
        <span className={styles.latestCell} data-truncates="name">
          {plural(mine.length, 'object')} ·{' '}
          {owedHere > 0 ? <span className={styles.warn}>{owedHere} need you</span> : 'all clear'}
        </span>
        <span className={styles.lensCell} data-truncates="name">
          objective
        </span>
        <span className={styles.spendCell} data-truncates="name">
          —
        </span>
        <span className={styles.ageCell} data-truncates="name">
          —
        </span>
      </button>
      <ReferenceMarkers onOpen={onOpenReferences} references={objectiveReferences} />

      {objective.open
        ? KIND_ORDER.map((kind) => {
            const items = mine.filter((object) => object.kind === kind);
            if (items.length === 0) return null;
            return (
              <div className={styles.group} key={kind}>
                <div className={styles.groupLabel}>
                  <span className={`${styles.groupLabelText} atr-lbl`}>{KIND_LABEL[kind]}</span>
                  <span className="atr-meta">{items.length}</span>
                  <span className={styles.groupRule} />
                </div>
                {items.map((object) => (
                  <ObjectRow
                    key={object.id}
                    object={object}
                    onOpenReceipt={onOpenReceipt}
                    onOpenReferences={onOpenReferences}
                    referenceAttention={referenceAttention}
                  />
                ))}
              </div>
            );
          })
        : null}
    </section>
  );
}
