'use client';

/* ---------------------------------------------------------------------------
 * CrossRoomJump — the trace bar you land under after following an owed item to
 * the room its source lives in.
 *
 * The reason you are standing in this room should not fade in two seconds, so
 * this is a persistent bar rather than a toast. Its `why` is a SystemStatement:
 * the page explaining its own navigation is system voice by construction, and
 * cannot be dressed as anybody's words.
 * ------------------------------------------------------------------------- */

import type { CrossRoomJumpRecord } from '../model/records';
import styles from '../timeline/timeline.module.css';

export interface CrossRoomJumpProps {
  readonly jump: CrossRoomJumpRecord;
  /** reveal the row the jump landed on — it is marked in the feed */
  readonly onReveal?: (messageId: string) => void;
  readonly onBack?: () => void;
  readonly onDismiss?: () => void;
}

export function CrossRoomJump({ jump, onReveal, onBack, onDismiss }: CrossRoomJumpProps) {
  return (
    <div className={styles.trace} data-row="cross-room-jump" data-voice="system">
      <span aria-hidden="true">↪</span>
      {/* The room names are in the sentence and in the back link; repeating
          them a third time is what pushed the reason itself off the end. */}
      <span className={styles.traceText}>{jump.why.text}</span>
      <button
        className={styles.traceBack}
        onClick={onReveal === undefined ? undefined : () => onReveal(jump.targetMessage)}
        type="button"
      >
        the row →
      </button>
      <button className={styles.traceBack} onClick={onBack} type="button">
        back to #{jump.fromRoom} →
      </button>
      <button aria-label="Dismiss this trace" onClick={onDismiss} type="button">
        ✕
      </button>
    </div>
  );
}
