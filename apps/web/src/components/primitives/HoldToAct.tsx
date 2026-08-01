'use client';

/* ---------------------------------------------------------------------------
 * HOLD TO ARM — the asymmetric-friction rule, implemented.
 *
 * design/CONVENTIONS.md: "Irreversible (red ■ decisions — merges, deletions,
 * anything destructive): press-and-hold for 2 seconds, with a progress bar
 * filling during the hold. Click-only; the action records who armed it and
 * when. […] The hold is the confirmation."
 *
 * Round 1 found the previous version was a FALSE SAFETY CLAIM: `data-hold="2000"`
 * was written on five buttons and read by nothing, while `onClick` fired on the
 * first press. The label said "— hold", the tooltip said "press and hold for 2
 * seconds; the hold is the confirmation", and a single click dropped the table.
 * A safety affordance that does not exist is worse than no affordance, because
 * the person trusts it.
 *
 * What is actually implemented here:
 *
 *   - the hold is a real elapsed-time gate, measured with `performance.now()`,
 *     not a transition or an animation. It survives `prefers-reduced-motion`,
 *     which kills every animation in this app — a safety mechanism that stops
 *     working for the motion-sensitive is not a safety mechanism.
 *   - the progress indicator fills from the same clock that gates the action,
 *     so what you see is what is being measured. It is written straight to the
 *     DOM through a ref rather than through state: one paint per frame, no
 *     React render per frame, and the value is observable in a test.
 *   - RELEASE BEFORE COMPLETE CANCELS. Pointer up, pointer cancel, leaving the
 *     button, blurring it, or lifting the key all abort with nothing fired.
 *   - `onArm` and `onAct` are separate. Completing the hold produces an
 *     `Arming` record — the action, when it was armed, how long it was held —
 *     which goes to `onArm` first and then to `onAct`. A caller that must put
 *     the arming on the record can do so without also performing the act.
 *   - keyboard parity: Space or Enter held down is a hold. Releasing early
 *     cancels, exactly as the pointer does.
 * ------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './primitives.module.css';

/**
 * What the hold put on the record: WHO armed it, WHEN, and HOW LONG they held.
 *
 * Round 2's gauntlet found this record claiming all three in its comment while
 * carrying two — there was no actor field at all, and the card boundary then
 * dropped `heldMs` on the way out, handing consumers a bare `armedAt` string.
 * CONVENTIONS is explicit: "the action records who armed it and when". A record
 * of an irreversible act with nobody on it is not a record of who did it.
 */
export interface Arming {
  readonly actionId: string;
  /** the person whose press this was — required, because the convention is */
  readonly actor: string;
  /** wall clock, ISO — the "when" the convention requires be recorded */
  readonly armedAt: string;
  /** measured, not assumed: how long the control was actually held */
  readonly heldMs: number;
}

export const DEFAULT_HOLD_MS = 2000;

export interface HoldToActProps {
  readonly actionId: string;
  /** who is pressing. Not optional: an arming with no actor records nothing. */
  readonly actor: string;
  readonly label: string;
  /** what the hold will do, in words. Shown as the control's description. */
  readonly describe: string;
  readonly holdMs?: number;
  readonly onArm?: (arming: Arming) => void;
  readonly onAct?: (arming: Arming) => void;
  readonly className?: string;
}

type Phase = 'idle' | 'holding' | 'armed';

export function HoldToAct({
  actionId,
  actor,
  label,
  describe,
  holdMs = DEFAULT_HOLD_MS,
  onArm,
  onAct,
  className,
}: HoldToActProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  const meterRef = useRef<HTMLSpanElement | null>(null);

  const paint = useCallback((progress: number) => {
    const node = buttonRef.current;
    if (node === null) return;
    const clamped = Math.max(0, Math.min(1, progress));
    node.style.setProperty('--hold-progress', `${(clamped * 100).toFixed(1)}%`);
    node.setAttribute('data-hold-progress', clamped.toFixed(3));
    /* The meter is a SIBLING of the button now, so this cannot go looking for it
       inside one. Held by ref rather than found by selector for the same reason:
       a query that returns null degrades silently, and this is the indicator for
       a safety mechanism. */
    meterRef.current?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  }, []);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    startRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    if (startRef.current === null) return;
    stop();
    paint(0);
    setPhase('idle');
  }, [paint, stop]);

  const complete = useCallback(() => {
    const started = startRef.current;
    if (started === null) return;
    const heldMs = Math.round(performance.now() - started);
    stop();
    paint(1);
    setPhase('armed');
    const arming: Arming = { actionId, actor, armedAt: new Date().toISOString(), heldMs };
    /* Arm first, act second. The record of who armed it and when must exist
       before the irreversible thing happens, not after it succeeded. */
    onArm?.(arming);
    onAct?.(arming);
  }, [actionId, actor, onAct, onArm, paint, stop]);

  const tick = useCallback(() => {
    const started = startRef.current;
    if (started === null) return;
    const elapsed = performance.now() - started;
    if (elapsed >= holdMs) {
      complete();
      return;
    }
    paint(elapsed / holdMs);
    frameRef.current = requestAnimationFrame(tick);
  }, [complete, holdMs, paint]);

  const begin = useCallback(() => {
    if (startRef.current !== null) return;
    startRef.current = performance.now();
    setPhase('holding');
    paint(0);
    frameRef.current = requestAnimationFrame(tick);
  }, [paint, tick]);

  useEffect(() => stop, [stop]);

  /* THE ACCESSIBLE NAME IS THE LABEL, NOT THE LABEL WITH A NUMBER GLUED TO IT.
     The progress indicator used to be a `role="progressbar"` DESCENDANT of the
     button, and a progressbar contributes its value to its ancestor's computed
     name — so the control announced as "0 Authorise the drop — hold", and the
     leading number changed as the hold ran. The information is real and worth
     announcing; it is just not part of the control's name.

     The fill is now decoration (`aria-hidden`, no role), and the meter is a
     visually-hidden sibling OUTSIDE the button, referenced by
     `aria-describedby`. Outside rather than hidden-inside on purpose: an
     `aria-hidden` element cannot be an describedby target, and a non-hidden
     descendant would go straight back into the name. The description also
     carries what the title says, so the hold contract reaches a screen reader
     that never sees a tooltip. */
  const meterId = `${actionId}-hold-progress`;
  const describeId = `${actionId}-hold-describe`;
  const contract = `${describe} — press and hold for ${(holdMs / 1000).toFixed(0)} seconds; the hold is the confirmation, and releasing early cancels it`;

  return (
    <>
      <button
        aria-describedby={`${describeId} ${meterId}`}
        className={[styles.hold, className].filter(Boolean).join(' ')}
        data-armed={phase === 'armed' ? 'true' : undefined}
        data-hold={String(holdMs)}
        data-hold-action={actionId}
        data-hold-actor={actor}
        data-hold-progress="0.000"
        data-holding={phase === 'holding' ? 'true' : undefined}
        onBlur={cancel}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          /* The browser fires a click for Space/Enter on a button. Suppressing the
           default is what stops this control from ever acting on one press. */
          event.preventDefault();
          if (event.repeat) return;
          begin();
        }}
        onKeyUp={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          cancel();
        }}
        onPointerCancel={cancel}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          begin();
        }}
        onPointerLeave={cancel}
        onPointerUp={cancel}
        ref={buttonRef}
        title={contract}
        type="button"
      >
        {/* Decoration. It shows the same clock the meter announces, so a screen
          reader hearing it twice would be hearing one fact told two ways. */}
        <span aria-hidden="true" className={styles.holdFill} />
        <span className={styles.holdLabel}>
          {phase === 'armed' ? `${label} — armed` : `${label} — hold`}
        </span>
      </button>
      <span className={styles.srOnly} id={describeId}>
        {contract}
      </span>
      {/* A progressbar is not something a screen reader should offer to
          activate, so it is not the button and it is not inside it. */}
      <span
        aria-label="hold progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={0}
        className={styles.srOnly}
        id={meterId}
        ref={meterRef}
        role="progressbar"
      />
    </>
  );
}
