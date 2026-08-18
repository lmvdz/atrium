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
 *     button, blurring it, or lifting the key all abort with nothing fired to
 *     `onAct`. A cancel fires `onCancel` (the mirror of `onBegin`), so a caller
 *     that started something on begin — the certify's server arm — can undo it
 *     when the hold is abandoned, rather than leave it live.
 *   - `onArm` and `onAct` are separate. Completing the hold produces an
 *     `Arming` record — the action, when it was armed, how long it was held —
 *     which goes to `onArm` first and then to `onAct`. A caller that must put
 *     the arming on the record can do so without also performing the act.
 *   - keyboard parity: Space or Enter held down is a hold. Releasing early
 *     cancels, exactly as the pointer does.
 * ------------------------------------------------------------------------- */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { offeredText } from '../model/quotation';
import styles from './primitives.module.css';

/* ---------------------------------------------------------------------------
 * NO CLIENT-MINTED ATTEMPT SEQUENCE ANY MORE (#121 round-7 finding 2).
 *
 * Round 6 minted a strictly-monotonic `attemptSeq` here from the wall clock and
 * carried it on the server arm/disarm/confirm to correlate a release to its arm.
 * But the server raised that client number into a session-global cancel watermark,
 * so `disarm(MAX_SAFE_INTEGER)` jammed every honest arm and clock skew did it by
 * accident. The correlation is the SERVER's job now: `armCertification` mints an
 * opaque token and returns it, and the caller carries THAT back on the confirm and
 * disarm (see ControlPlane). This control just reports begin / cancel / complete;
 * it counts nothing the server trusts.
 * ------------------------------------------------------------------------- */

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
  /**
   * The client-side elapsed time of the press. This is the UI affordance's own
   * number, NOT evidence: the server measures its own arm→confirm interval and
   * records that (`certified_held_ms`). Kept as a local receipt of the gesture,
   * never sent as the duration the covenant gates on (#121 CS-2).
   */
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
  /**
   * Fired the instant the hold BEGINS — before anything has been held.
   *
   * Added for #121's certify, where the server has to stamp its own clock at the
   * start of the interval it will later measure. Without it the only signal a
   * caller got was hold-complete, and a server told about a hold only once it was
   * over can do nothing but believe the duration it is handed — which is the
   * client-supplied-timing defect the arm→confirm protocol exists to remove.
   *
   * A cancelled hold simply never reaches `onAct`; a caller that recorded
   * something on begin is responsible for that being harmless, and for certify it
   * is: a pending arm that is never confirmed certifies nothing and expires.
   *
   * Takes no argument: the attempt's identity is the server-issued token the arm
   * this fires returns (round-7 finding 2), which the caller holds, not a number
   * this control mints.
   */
  readonly onBegin?: () => void;
  /**
   * Fired when a hold that had BEGUN is released before it completes — pointer up
   * or cancel, leaving or blurring the button, lifting the key. It does NOT fire
   * for a release after completion (the hold already armed) or when nothing was
   * being held.
   *
   * The mirror of `onBegin`: a caller that started something on begin (the
   * certify's server arm) can undo it on cancel (the server disarm), so a
   * cancelled hold leaves no live intention behind. A cancel that reaches nothing
   * must be harmless — this fires on every abort, including redundant ones.
   *
   * Takes no argument: the caller cancels the exact arm this hold began by the
   * server-issued token that arm returned (round-7 finding 2), so it awaits the arm
   * before disarming and there is no client counter to carry.
   */
  readonly onCancel?: () => void;
  readonly onArm?: (arming: Arming) => void;
  readonly onAct?: (arming: Arming) => void;
  readonly className?: string;
  /**
   * When true, the control is inert: it renders `disabled` and refuses to begin a
   * hold, so no act can fire. #146 FIX 1 wires this from the fund pane, which must
   * disable the affordance when the slice input is not a whole, non-negative
   * number — a human may not hold-to-authorize a value the command would silently
   * coerce into a different one. A safety hold over an amount the surface would
   * change is worse than no hold, so the door is shut rather than the number bent.
   */
  readonly disabled?: boolean;
  /**
   * When true, a completed hold returns the control to `idle` rather than resting
   * at `armed`. #146 FIX 3: the fund/settle acts fire once and are done — an act
   * whose control still reads `armed` on an already-funded plan is ambiguous. The
   * arm and act still fire exactly as before; re-firing simply needs a fresh full
   * hold (`startRef` is cleared either way, so this changes only the resting
   * legibility, never the friction). Certify keeps the default `armed` rest, where
   * the armed state legitimately mirrors a server arm still awaiting its confirm.
   */
  readonly resetOnComplete?: boolean;
}

type Phase = 'idle' | 'holding' | 'armed';

export function HoldToAct({
  actionId,
  actor,
  label,
  describe,
  holdMs = DEFAULT_HOLD_MS,
  onBegin,
  onCancel,
  onArm,
  onAct,
  className,
  disabled = false,
  resetOnComplete = false,
}: HoldToActProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  /* THE LIVE `disabled`, read at fire time — not the value captured when a hold's
     `requestAnimationFrame` chain was scheduled. A body edit under an open certify
     panel invalidates the pending span, which the caller reflects by flipping
     `disabled` true (certify: `!canCertify`); but a frame already in flight still
     holds the closure from BEFORE the edit, so the running `tick`/`complete` would
     otherwise fire the STALE act. `complete` re-checks this ref at the instant it
     fires and refuses if the control has since gone disabled (E8 r2 blocker). Kept
     in a ref, written every render, so a frame scheduled before the flip reads the
     value AFTER it — a captured prop could not. */
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

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
    /* Only a hold that had actually begun can be cancelled. `startRef` is null
       after a completed hold (`stop()` clears it) and before any press, so a
       pointer-up following a successful arm — or a stray blur — reaches nothing,
       and `onCancel` fires ONLY for a real release-before-complete. */
    if (startRef.current === null) return;
    stop();
    paint(0);
    setPhase('idle');
    onCancel?.();
  }, [onCancel, paint, stop]);

  const complete = useCallback(() => {
    const started = startRef.current;
    if (started === null) return;
    /* RE-CHECK VALIDITY AT FIRE TIME (E8 r2 blocker). A frame scheduled while the
       control was enabled can run AFTER an edit disabled it — the certify span the
       hold was over is now stale. `disabledRef` carries the current value (written
       every render), so this reads the state as of NOW, not as of when the frame was
       scheduled. If the control has gone disabled, abandon the hold exactly as a
       release would: cancel, reset, and fire `onCancel` (the server disarm, if one
       was armed on begin) — never `onAct`. */
    if (disabledRef.current) {
      stop();
      paint(0);
      setPhase('idle');
      onCancel?.();
      return;
    }
    const heldMs = Math.round(performance.now() - started);
    stop();
    if (resetOnComplete) {
      /* #146 FIX 3: the fund/settle act fires once and is done. Return to idle so
         the control does not rest reading `armed` on an already-funded plan. The
         arm/act below still fire; `stop()` cleared `startRef`, so a re-fire is a
         fresh full hold, not a second act off the same press. */
      paint(0);
      setPhase('idle');
    } else {
      paint(1);
      setPhase('armed');
    }
    const arming: Arming = {
      actionId,
      actor,
      armedAt: new Date().toISOString(),
      heldMs,
    };
    /* Arm first, act second. The record of who armed it and when must exist
       before the irreversible thing happens, not after it succeeded. */
    onArm?.(arming);
    onAct?.(arming);
  }, [actionId, actor, onAct, onArm, onCancel, paint, resetOnComplete, stop]);

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
    /* #146 FIX 1: a disabled control begins nothing, so no act can fire off it —
       the guard here backs the `disabled` DOM attribute, since a synthesised
       pointer/key event can still reach a handler in some engines. */
    if (disabled) return;
    if (startRef.current !== null) return;
    startRef.current = performance.now();
    setPhase('holding');
    paint(0);
    /* Before the first frame, so a caller that has to start a clock elsewhere
       starts it at the same instant this one does. The arm this fires returns the
       server-issued token the matching confirm/disarm carry (round-7 finding 2). */
    onBegin?.();
    frameRef.current = requestAnimationFrame(tick);
  }, [disabled, onBegin, paint, tick]);

  /* ABANDON AN IN-FLIGHT HOLD WHEN THE CONTROL GOES DISABLED (E8 r2 blocker). A body
     edit under an open certify panel invalidates the pending span; the caller flips
     `disabled` true. Cancel the running `requestAnimationFrame` and abandon the hold
     NOW — do not let the frame chain run to completion over a span the human never
     saw. `cancel` is a no-op unless a hold had actually begun (`startRef`), so this
     stays inert for ordinary enabled/disabled toggles and fires `onCancel` (the
     server disarm, if any) exactly once for a real mid-hold invalidation. This is the
     cleanup path; the RACE-PROOF refusal is `complete`'s own `disabledRef` check,
     since a scheduled frame can fire before this post-commit effect runs. */
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  /* DISARM ON UNMOUNT — the mirror of release, for the navigation that never
     released. A hold in progress when the control unmounts (the person left the
     page mid-press) used to run only `stop()`, which cancels the animation frame
     and nothing else: the server arm stamped on begin then outlived the page for
     its whole TTL, and a later direct confirm could spend it (CS-3). This fires
     `onCancel` — the server disarm — whenever a hold had actually begun, exactly
     as a pointer-up does, so a navigated-away hold leaves no live arm behind. A
     completed hold has already cleared `startRef`, so its in-flight confirm is not
     disarmed. No `setPhase`/`paint` here: the component is leaving the tree.

     Held in a ref so the empty-deps unmount effect always calls the latest
     `onCancel` without re-subscribing (and thus re-running its cleanup) on every
     render — a cleanup that ran on each `onCancel` identity change would disarm a
     live hold mid-press. */
  const disarmOnUnmount = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (startRef.current === null) return;
    startRef.current = null;
    onCancel?.();
  }, [onCancel]);
  const unmountRef = useRef(disarmOnUnmount);
  unmountRef.current = disarmOnUnmount;
  useEffect(() => () => unmountRef.current(), []);

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
  /* THE ID IS MINTED FROM THE INSTANCE, NOT FROM THE CALLER'S STRING.

     Round 6: these were `${actionId}-hold-progress` and `-hold-describe`, and
     `actionId` is a caller-supplied value that repeats — on /gallery the same
     five action ids render in five frames, so four of the five destructive hold
     controls had `aria-describedby` pointing at another frame's nodes. A screen
     reader user pressing one heard a frozen meter belonging to a different
     button, on the one control in the product whose whole job is to be a safety
     mechanism. `getElementById` returns the FIRST match; duplicate ids do not
     error, they silently resolve somewhere else.

     `useId` is React's per-instance identifier and is stable across hydration,
     which is the property a server-rendered `id` needs. `actionId` is still on
     the DOM as `data-hold-action`, which is what selectors want and what an id
     was being abused for. */
  const uid = useId();
  const meterId = `${uid}-hold-progress`;
  const describeId = `${uid}-hold-describe`;
  /* THE LABEL AND THE DESCRIPTION ARE THE COPY ON A CONTROL, so they go through
     the offered door rather than the system one: this is the button for
     "Authorise the drop" and "Keep it behind our retention window", and round 4
     already shipped the mistake of holding a one-click answer's own words to the
     interface's first-person ban. Quotation marks are still refused — that is
     the one thing that makes offered copy read as an utterance. */
  const spoken = offeredText(label, 'HoldToAct label');
  /* HONEST ABOUT WHAT THE HOLD IS, PER CALLER. It used to say "the hold is the
     confirmation", which reads as a claim that the continuous press itself is the
     attested act. Against a scripted client, a continuous physical hold is
     unprovable server-side without interaction attestation this does not have.
     What some callers enforce is a MINIMUM DELAY between two deliberate server calls
     (certify-session.ts's arm→confirm); the press is the affordance for meeting it.

     But NOT every caller has that. The certify pane wires a server arm (`onBegin`);
     the attention cards (AttentionCard/AttentionCompact) do not — their land is a
     single client-measured hold with no server-timed arm→confirm behind it. Round-5
     shipped this contract string claiming "the server requires a minimum delay" for
     ALL of them, which was false for the attention path (grok's residual). So the
     claim is scoped to what THIS caller's path actually enforces: the server-delay
     sentence only when a server arm is wired, the plain client-hold sentence
     otherwise. `onBegin` is exactly the presence of that server round-trip. */
  const serverTimed = onBegin !== undefined;
  const held = `press and hold for at least ${(holdMs / 1000).toFixed(0)} seconds`;
  const tail = serverTimed
    ? '; the server requires a minimum delay before it will confirm, and releasing early cancels it'
    : ', and releasing early cancels it';
  const contract = `${offeredText(describe, 'HoldToAct describe')} — ${held}${tail}`;

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
        disabled={disabled || undefined}
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
          {phase === 'armed' ? `${spoken} — armed` : `${spoken} — hold`}
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
