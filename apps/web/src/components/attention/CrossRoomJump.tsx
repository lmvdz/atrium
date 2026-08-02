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

import { useCitedRecord } from '../model/ledger';
import { statementText, systemText } from '../model/quotation';
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
  /* The row this trace points at is resolved against the page's register before
     the button can act on it. It was a bare `MessageId` — a caller-supplied
     string dispatched straight into `onReveal`, in a bar whose entire purpose is
     to say "this is the row you came for". */
  const target = useCitedRecord(jump.targetMessage, 'CrossRoomJump target');
  return (
    <div className={styles.trace} data-row="cross-room-jump" data-voice="system">
      <span aria-hidden="true">↪</span>
      {/* The room names are in the sentence and in the back link; repeating
          them a third time is what pushed the reason itself off the end. */}
      <span className={styles.traceText}>{statementText(jump.why, 'CrossRoomJump')}</span>
      <button
        className={styles.traceBack}
        data-jumps-to={target.id}
        onClick={onReveal === undefined ? undefined : () => onReveal(target.id)}
        type="button"
      >
        the row →
      </button>
      <button className={styles.traceBack} onClick={onBack} type="button">
        {/* The room name is caller-supplied and sits inside the trace's
            `data-voice="system"` box, so it goes through the same door the
            statement beside it does. */}
        back to #{systemText(jump.fromRoom, 'CrossRoomJump room')} →
      </button>
      <button aria-label="Dismiss this trace" onClick={onDismiss} type="button">
        ✕
      </button>
    </div>
  );
}
