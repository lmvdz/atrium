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

import type { ChangeEvent, KeyboardEvent, Ref } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAttribution } from '../model/ledger';
import type { Quotation } from '../model/quotation';
import { quotationRef, systemText } from '../model/quotation';
import type { ComposerBinding } from '../model/records';
import { Glyph } from '../primitives/Glyph';
import styles from './frame.module.css';

export interface ComposerProps {
  readonly roomName: string;
  readonly binding: ComposerBinding;
  /**
   * The last thing the page did, in words. OPTIONAL, because a status line with
   * nothing to report should report nothing: `/` used to seed it with "every
   * control on this page is wired — click one and this line reports what it
   * did", which is demo scaffolding standing in the product chrome of the route
   * this round calls the actual product. Found by the r8 blind review.
   */
  readonly footNote?: string;
  readonly onCancelBinding?: () => void;
  /** the draft, when the consumer owns it. Omit for an uncontrolled composer. */
  readonly value?: string;
  readonly onChange?: (draft: string) => void;
  /** runs before the built-in Enter handling; `preventDefault()` overrides it */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
  /** receives the draft the footer promises Enter will send */
  readonly onSend?: (draft: string) => void;
  readonly onAttach?: (file: File) => void;
  readonly attachmentNote?: string;
  /** Explicit request targeting; choosing one inserts the visible authored marker. */
  readonly mentionTargets?: readonly { readonly id: string; readonly label: string }[];
  readonly onMention?: (userId: string) => void;
  /** A replay may permit only a bound answer, never free historical chat. */
  readonly disabled?: boolean;
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
  onAttach,
  attachmentNote,
  mentionTargets = [],
  onMention,
  disabled = false,
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /* WHETHER AN IME IS MID-COMPOSITION, tracked on the element rather than read
     off a key event — because the SEND BUTTON has no key event to read.
     Found by the round-5 blind review: the Enter guard covered the keyboard and
     left the button, so clicking Send while a candidate list was open still put
     half-composed romaji on the record as `origin: 'typed'`. The invariant is
     about what reaches the record, not about which control reached it. */
  const composing = useRef(false);
  /* THE FLAG IS OBSERVABLE, AND EVERY WAY OUT OF A COMPOSITION CLEARS IT.

     Round 6: `composing.current` was set on `compositionstart` and cleared on
     `compositionend` and NOWHERE ELSE. One missed `compositionend` — a blur
     mid-candidate, an unmount, an IME that drops the event — left the flag stuck
     true, and `send()` returns early when it is true. That is the primary write
     path of the product bricked silently: no error, no indicator, and no
     recovery short of a page reload. A one-way flag guarding a write is a latch,
     and a latch needs every exit wired, not the happy one.

     Four exits now: compositionend, blur, unmount, and a change event that says
     the composition is over (`nativeEvent.isComposing === false`). The state is
     mirrored to React state purely so it can be PAINTED — a control that is
     refusing to send has to say it is refusing. */
  const [composingNow, setComposingNow] = useState(false);
  const setComposing = useCallback((value: boolean) => {
    composing.current = value;
    setComposingNow(value);
  }, []);
  /* Unmount is an exit. A ref that outlives its element does not, but the next
     mount gets a fresh one — this is here so a component that is torn down
     mid-composition cannot leave a pending timer or a stale flag behind. */
  useEffect(() => () => setComposing(false), [setComposing]);

  /* The draft is the controlled value when there is one, and the live textarea
     otherwise. Reading the element is what keeps this component stateless while
     still being able to keep the footer's promise. */
  const draft = useCallback(() => value ?? own.current?.value ?? '', [value]);

  const send = useCallback(() => {
    /* Refused from EVERY control, not just the one that had the key event. A
       half-composed buffer is not words the person wrote. */
    if (composing.current) return;
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
      /* ENTER WHILE AN IME IS COMPOSING IS NOT A SEND — IT IS "ACCEPT THIS
         CANDIDATE".

         Every CJK user's first keystroke sequence types romaji or pinyin, sees a
         candidate list, and presses Enter to choose. Without this check that
         Enter sent the half-composed buffer as a real message: `origin: 'typed'`,
         quotable, attributed, and permanently on somebody's record as words they
         did not mean to say. It is the no-synthesized-speech invariant reached
         from the input end rather than the render end — the words under the name
         were never the words the person wrote.

         Two signals because one of them is not enough. `isComposing` is the
         standard, and `keyCode === 229` is what browsers that predate it (and
         some IMEs on Safari) report instead; a check that only reads the modern
         one is a check that passes on the platforms most likely to fail. */
      const native = event.nativeEvent;
      if (native.isComposing || native.keyCode === 229 || composing.current) return;
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

  /* THE ROOM NAME AND THE FOOT NOTE ARE STRINGS THIS COMPONENT PRINTS. The foot
     note is a whole page-authored sentence the consumer supplies — it is what
     `/` writes every handler's outcome into — and it printed raw. */
  const room = systemText(roomName, 'Composer roomName');
  const foot = footNote === undefined ? null : systemText(footNote, 'Composer footNote');
  const attachmentStatus =
    attachmentNote === undefined ? null : systemText(attachmentNote, 'Composer attachmentNote');
  const boundLabel =
    binding.mode === 'bound' ? systemText(binding.itemLabel, 'Composer binding') : '';
  const boundObjective =
    binding.mode === 'bound' ? systemText(binding.objective, 'Composer binding') : '';

  return (
    <div className={styles.composer}>
      {binding.mode === 'bound' ? (
        <div className={styles.ctxbar} data-binding="bound">
          {/* THE BOUND ITEM'S OWN GLYPH — ROUND 10, D1. This was a literal `◆`,
              and on `/` at rest the bound item is X1, which is irreversible and
              wears `■` on its pin card, in its feed tag, in the lens and in its
              receipt. The banner told the one person who is about to answer it
              that it was the reversible kind. `ComposerBinding`'s bound arm
              carries the item's state now and `boundTo` is its only
              constructor, so the label and the glyph are read off one item. */}
          <Glyph state={binding.state} />
          <b>ANSWERING</b>
          {/* The promise is the part that must survive a narrow frame: it is
              what makes binding trustworthy. The scope truncates instead. */}
          <span className={styles.ctxbarPromise}>
            your next message resolves it — nothing is inferred
          </span>
          {/* The scope is what gives way at a narrow frame; the PROMISE never
              does. A clip owes the reader a route (CONVENTIONS), and the route
              is the item's own card in Needs you, which is on the same screen
              and states the label and the objective in full. */}
          <span className={styles.ctxbarIn}>
            {boundLabel} · in: {boundObjective}
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
        <ReplyBanner onCancel={onCancelBinding} to={binding.to} />
      ) : null}

      {binding.mode !== 'free' || mentionTargets.length === 0 || onMention === undefined ? null : (
        <label className={styles.mentionBar}>
          <span className="atr-lbl">MENTION</span>
          <select
            aria-label="Mention a person"
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) onMention(event.target.value);
              event.target.value = '';
            }}
            defaultValue=""
          >
            <option value="">Choose a person…</option>
            {mentionTargets.map((target) => (
              <option key={target.id} value={systemText(target.id, 'Composer mention target id')}>
                {systemText(target.label, 'Composer mention target')}
              </option>
            ))}
          </select>
          <span data-voice="system">inserts a visible request marker; remove it to cancel</span>
        </label>
      )}

      {/* `data-composer-box` names the element whose BORDER is the binding cue,
          so the rendered non-text-graphic audit can measure it by something
          other than a CSS-module hash. The border is in the registry because it
          carries state; the banner above saying ANSWERING in words does not
          exempt it, for the same reason the `~` does not exempt the claim
          underline. */}
      <div
        className={[
          styles.cbox,
          binding.mode === 'bound' ? styles.cboxBound : null,
          binding.mode === 'replying' ? styles.cboxReplying : null,
        ]
          .filter(Boolean)
          .join(' ')}
        data-composer-box={binding.mode}
      >
        <textarea
          aria-label={
            binding.mode === 'bound' ? `Answer ${boundLabel} in your own words` : `Message #${room}`
          }
          data-composing={composingNow ? 'true' : 'false'}
          disabled={disabled}
          onBlur={() => setComposing(false)}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            /* A change whose native event says it is not part of a composition
               is proof the composition is over, whatever `compositionend` did or
               did not do. This is the exit that recovers from a dropped event
               without waiting for a blur. */
            const native = event.nativeEvent as Partial<InputEvent>;
            /* `=== false`, not `!== true`. The platform saying "this input is not
               part of a composition" is evidence; a change event that carries no
               flag at all (a synthetic one, an older engine) is not, and treating
               absence as evidence would clear the guard on exactly the platforms
               whose composition events are least reliable. The guaranteed exits
               are compositionend, blur and unmount; this one is the fast path. */
            if (native.isComposing === false) setComposing(false);
            onChange?.(event.target.value);
          }}
          onCompositionEnd={() => setComposing(false)}
          onCompositionStart={() => setComposing(true)}
          onKeyDown={keyDown}
          placeholder={
            binding.mode === 'bound'
              ? 'answer in your own words — it is recorded verbatim'
              : `message #${room}…`
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
          {onAttach === undefined ? null : (
            <>
              <input
                accept="*/*"
                aria-label="Choose an attachment"
                className={styles.fileInput}
                disabled={disabled}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onAttach(file);
                  event.currentTarget.value = '';
                }}
                ref={fileInput}
                type="file"
              />
              <button
                className="atr-btn"
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
                type="button"
              >
                Attach
              </button>
            </>
          )}
          <button
            className="atr-btn"
            disabled={disabled}
            onClick={send}
            /* KEEP THE COMPOSITION ALIVE ACROSS THE CLICK. Pressing a button
               blurs the textarea, which ends the composition, which clears the
               flag — so by the time `click` fires the guard has nothing to see
               and the half-composed buffer goes on the record as `origin:
               'typed'`. The round-6 critic reproduced exactly that on a real
               CDP composition. Suppressing the default on `mousedown` leaves
               focus (and the composition) where it was, so the guard is still
               true when the send is attempted. */
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            Send
          </button>
        </div>
      </div>

      <div className={styles.cfoot}>
        <span>
          {/* THE REFUSAL SAYS SO. A send that is being declined because an input
              method is mid-candidate is indistinguishable, from the outside,
              from a send that is broken — which is how a stuck flag went from a
              bug to an unrecoverable one. */}
          {composingNow ? (
            <span data-composing-note="true">
              choosing a candidate — <span className={styles.key}>↵</span> accepts it; the message
              is not sent until the composition ends
            </span>
          ) : (
            <>
              <span className={styles.key}>↵</span> send · <span className={styles.key}>⇧↵</span>{' '}
              newline
            </>
          )}
        </span>
        <span className={styles.cfootSpacer} />
        {foot === null ? null : <span data-composer-note="true">{foot}</span>}
        {attachmentStatus === null ? null : (
          <span data-attachment-note="true">{attachmentStatus}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The banner names whoever the RECORD says wrote the message being replied to.
 *
 * Round 1: the banner took `{actor, at, excerpt}`, so the name beside the
 * excerpt was a free string nothing checked. Round 4: it took a Quotation whose
 * `actor` field could be overwritten by a spread, which is the same defect one
 * container in. It now takes a citation and looks the record up, so the name,
 * the time and the words all come out of one row of the register.
 */
function ReplyBanner({ to, onCancel }: { readonly to: Quotation; readonly onCancel?: () => void }) {
  const reply = useAttribution(to, 'Composer reply banner');
  return (
    <div className={`${styles.ctxbar} ${styles.ctxbarReply}`} data-binding="replying">
      <span aria-hidden="true">↩</span>
      <b>REPLYING TO</b>
      <span data-attribution={reply.messageId}>
        {reply.actor} {reply.at}
      </span>
      {/* TRUNCATED QUOTED WORDS, WITH A ROUTE. Nothing in CONVENTIONS governed
          this until round 6, and a quotation is the one string on the page where
          a hover-only remainder is least defensible: the words are somebody's
          own and the reader is being asked to answer them. The route is exact —
          the cited row is in this feed, `data-message-id` names it, and
          `data-quoted` already carries the citation. */}
      <span
        className={styles.ctxbarIn}
        data-quoted={quotationRef(reply)}
        data-truncates={`element:[data-message-id="${reply.messageId}"]`}
        title={reply.text}
      >
        “{reply.text}”
      </span>
      <button
        aria-label="Cancel reply"
        className={`${styles.ctxbarClose} atr-mono`}
        onClick={onCancel}
        type="button"
      >
        ✕
      </button>
    </div>
  );
}
