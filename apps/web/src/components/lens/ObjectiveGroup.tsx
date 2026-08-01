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
import type { ObjectiveRecord, StateObject } from '../model/records';
import { plural } from '../model/text';
import styles from './lens.module.css';
import { ObjectRow } from './ObjectRow';

export interface ObjectiveGroupProps {
  readonly objective: ObjectiveRecord;
  readonly objects: readonly StateObject[];
  readonly onToggle?: (objectiveId: string) => void;
  readonly onOpenReceipt?: (objectId: string) => void;
}

const KIND_ORDER: readonly ObjectKind[] = ['decision', 'commitment', 'question', 'claim', 'event'];

const KIND_LABEL: Readonly<Record<ObjectKind, string>> = {
  decision: 'DECISIONS',
  commitment: 'COMMITMENTS',
  question: 'OPEN QUESTIONS',
  claim: 'CLAIMS',
  event: 'EVENTS',
};

const STATUS_CLASS = {
  active: styles.statusActive,
  blocked: styles.statusBlocked,
  idle: undefined,
} as const;

export function ObjectiveGroup({
  objective,
  objects,
  onToggle,
  onOpenReceipt,
}: ObjectiveGroupProps) {
  const mine = objects.filter((object) => object.objectives.includes(objective.id));
  const owedHere = mine.filter((object) => needsViewer(object.state)).length;

  return (
    <section className={styles.obj} data-objective-id={objective.id}>
      <button
        aria-expanded={objective.open}
        className={styles.objHead}
        onClick={onToggle === undefined ? undefined : () => onToggle(objective.id)}
        title={
          owedHere > 0
            ? `${plural(mine.length, 'object')} sit under this objective, ${owedHere} of which need you. An object can sit under more than one objective, so these counts overlap the other objectives and the pin.`
            : `${plural(mine.length, 'object')} sit under this objective. Nothing here is waiting on you.`
        }
        type="button"
      >
        <span aria-hidden="true" className={styles.objTwisty}>
          {objective.open ? '▾' : '▸'}
        </span>
        <span>
          <span className={styles.objTitle}>
            {systemText(objective.title, 'ObjectiveGroup title')}
          </span>
          <span className={styles.objCount}>
            {plural(mine.length, 'object')} ·{' '}
            {owedHere > 0 ? <span className={styles.warn}>{owedHere} need you</span> : 'all clear'}
          </span>
        </span>
        <span className={`${styles.status} ${STATUS_CLASS[objective.status] ?? ''} atr-lbl`}>
          {systemText(objective.status, 'ObjectiveGroup status').toUpperCase()}
        </span>
      </button>

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
                  <ObjectRow key={object.id} object={object} onOpenReceipt={onOpenReceipt} />
                ))}
              </div>
            );
          })
        : null}
    </section>
  );
}
