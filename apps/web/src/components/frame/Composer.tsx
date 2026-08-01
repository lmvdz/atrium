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
 *
 * THE FOOTER'S CONTRACT IS IMPLEMENTED. Round 2's gauntlet: the foot printed
 * "↵ send · ⇧↵ newline" while `onKeyDown` was undefined, there was no
 * `value`/`onChange`/ref seam, and `onSend?: () => void` took no argument — so a
 * consumer could not implement the sentence the component was printing without
 * forking the file. That is round 1's `data-hold` defect in a different
 * component: a contract in the copy with no implementation and no way to add
 * one.
 *
 * Both halves are here now:
 *   - the SEAM: `value` / `onChange` / `onKeyDown` / `textareaRef`, so a
 *     controlled consumer (#25, #27) owns the draft without touching this file.
 *   - the BEHAVIOUR: Enter sends and Shift+Enter does not, out of the box, and
 *     `onSend` receives the draft. Uncontrolled callers get the advertised
 *     behaviour for free; a consumer's own `onKeyDown` runs first and can
 *     `preventDefault()` to take the key over entirely.
 *
 * It still holds no draft state: the uncontrolled path reads the textarea it
 * already has a ref to, rather than mirroring the value into React state.
 * ------------------------------------------------------------------------- */

import type { KeyboardEvent, Ref } from 'react';
import { useCallback, useRef } from 'react';
import { quotationRef } from '../model/quotation';
import type { ComposerBinding } from '../model/records';
import styles from './frame.module.css';

export interface ComposerProps {
  readonly roomName: string;
  readonly binding: ComposerBinding;
  readonly footNote: string;
  readonly onCancelBinding?: () => void;
  /** the draft, when the consumer owns it. Omit for an uncontrolled composer. */
  readonly value?: string;
  readonly onChange?: (draft: string) => void;
  /** runs before the built-in Enter handling; `preventDefault()` overrides it */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
  /** receives the draft the footer promises Enter will send */
  readonly onSend?: (draft: string) => void;
}

export function Composer({
  roomName,
  binding,
  footNote,
  onCancelBinding,
  value,
  onChange,
  onKeyDown,
  textareaRef,
  onSend,
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);

  /* The draft is the controlled value when there is one, and the live textarea
     otherwise. Reading the element is what keeps this component stateless while
     still being able to keep the footer's promise. */
  const draft = useCallback(() => value ?? own.current?.value ?? '', [value]);

  const send = useCallback(() => {
    const text = draft();
    if (text.trim().length === 0) return;
    onSend?.(text);
    /* An uncontrolled composer clears itself; a controlled one is the
       consumer's to clear, and clearing it here would fight their state. */
    if (value === undefined && own.current !== null) own.current.value = '';
  }, [draft, onSend, value]);

  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter' || event.shiftKey) return;
      /* "↵ send · ⇧↵ newline", which is what the foot says two lines down. */
      event.preventDefault();
      send();
    },
    [onKeyDown, send],
  );

  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      own.current = node;
      if (typeof textareaRef === 'function') textareaRef(node);
      else if (textareaRef !== null && textareaRef !== undefined) {
        (textareaRef as { current: HTMLTextAreaElement | null }).current = node;
      }
    },
    [textareaRef],
  );

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
          onChange={onChange === undefined ? undefined : (event) => onChange(event.target.value)}
          onKeyDown={keyDown}
          placeholder={
            binding.mode === 'bound'
              ? 'answer in your own words — it is recorded verbatim'
              : `message #${roomName}…`
          }
          ref={attach}
          rows={1}
          {...(value === undefined
            ? { defaultValue: '' }
            : /* A value with no `onChange` is a field the consumer does not
                 intend to be typed into — say so, rather than let React warn
                 about it into a console this project keeps clean. */
              { value, readOnly: onChange === undefined })}
        />
        <div className={styles.cboxRight}>
          <button className="atr-btn" onClick={send} type="button">
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
        <span data-composer-note="true">{footNote}</span>
      </div>
    </div>
  );
}
