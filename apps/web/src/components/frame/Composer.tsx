'use client';

/* ---------------------------------------------------------------------------
 * Composer shell — BRIEF concept 4, the answer-binding banner.
 *
 * When a reply is bound to a pending item, the banner says which item and what
 * binding means: "your next message resolves it — nothing is inferred". The
 * message that comes out of a bound composer carries origin `typed`, so it is
 * the human's own words and it is quotable. A one-click answer does NOT come
 * through here — it is page-authored, and model/quotation.ts routes it to
 * system voice instead.
 *
 * The shell is a shell: it takes the binding state and renders it. It holds no
 * draft state of its own (#25 and #27 own that).
 * ------------------------------------------------------------------------- */

import { quotationRef } from '../model/quotation';
import type { ComposerBinding } from '../model/records';
import styles from './frame.module.css';

export interface ComposerProps {
  readonly roomName: string;
  readonly binding: ComposerBinding;
  readonly footNote: string;
  readonly onCancelBinding?: () => void;
  readonly onSend?: () => void;
}

export function Composer({ roomName, binding, footNote, onCancelBinding, onSend }: ComposerProps) {
  return (
    <div className={styles.composer}>
      {binding.mode === 'bound' ? (
        <div className={styles.ctxbar} data-binding="bound">
          <span aria-hidden="true">◆</span>
          <b>ANSWERING</b>
          {/* The promise is the part that must survive a narrow frame: it is
              what makes binding trustworthy. The scope truncates instead. */}
          <span className={styles.ctxbarPromise}>
            your next message resolves it — nothing is inferred
          </span>
          <span
            className={styles.ctxbarIn}
            title={`${binding.itemLabel} · in: ${binding.objective}`}
          >
            {binding.itemLabel} · in: {binding.objective}
          </span>
          <button
            aria-label="Cancel answering"
            className={`${styles.ctxbarClose} atr-mono`}
            onClick={onCancelBinding}
            type="button"
          >
            ✕
          </button>
        </div>
      ) : null}

      {binding.mode === 'replying' ? (
        <div className={`${styles.ctxbar} ${styles.ctxbarReply}`} data-binding="replying">
          <span aria-hidden="true">↩</span>
          <b>REPLYING TO</b>
          {/* The name and the words come off ONE quotation. Round 1: the banner
              took `{actor, at, excerpt}`, so the name beside the excerpt was a
              free string nothing checked. */}
          <span data-attribution={binding.to.messageId}>
            {binding.to.actor} {binding.to.at}
          </span>
          <span
            className={styles.ctxbarIn}
            data-quoted={quotationRef(binding.to)}
            title={binding.to.text}
          >
            “{binding.to.text}”
          </span>
          <button
            aria-label="Cancel reply"
            className={`${styles.ctxbarClose} atr-mono`}
            onClick={onCancelBinding}
            type="button"
          >
            ✕
          </button>
        </div>
      ) : null}

      <div
        className={[
          styles.cbox,
          binding.mode === 'bound' ? styles.cboxBound : null,
          binding.mode === 'replying' ? styles.cboxReplying : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <textarea
          aria-label={
            binding.mode === 'bound'
              ? `Answer ${binding.itemLabel} in your own words`
              : `Message #${roomName}`
          }
          defaultValue=""
          placeholder={
            binding.mode === 'bound'
              ? 'answer in your own words — it is recorded verbatim'
              : `message #${roomName}…`
          }
          rows={1}
        />
        <div className={styles.cboxRight}>
          <button className="atr-btn" onClick={onSend} type="button">
            Send
          </button>
        </div>
      </div>

      <div className={styles.cfoot}>
        <span>
          <span className={styles.key}>↵</span> send · <span className={styles.key}>⇧↵</span>{' '}
          newline
        </span>
        <span className={styles.cfootSpacer} />
        <span>{footNote}</span>
      </div>
    </div>
  );
}
