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
 * A STRICTLY-MONOTONIC ATTEMPT SEQUENCE, per page.
 *
 * #121 round-6 finding 3. Each hold-begin mints one sequence, carried on the
 * server arm, disarm and confirm of that single press so the server can correlate
 * a release to the arm it cancels and refuse a late arm that a cancel already
 * superseded. It must be STRICTLY increasing within a page: two presses in the
 * same millisecond still get distinct, ordered ids. Seeded from wall-clock so the
 * ids of two different clients on one session sort by real time; bumped past the
 * last value otherwise. It orders and correlates a client's own requests — it is
 * NOT a timing the server's gate trusts (that stays `now() - certify_armed_at`,
 * measured server-side).
 * ------------------------------------------------------------------------- */
let lastAttemptSeq = 0;
function nextAttemptSeq(): number {
  const now = Date.now();
  lastAttemptSeq = now > lastAttemptSeq ? now : lastAttemptSeq + 1;
  return lastAttemptSeq;
}

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
  /**
   * The strictly-monotonic id of this press (#121 round-6 finding 3), minted at
   * hold-begin and identical across this hold's `onBegin` / `onCancel` / `onArm` /
   * `onAct`. A caller wiring a server arm→confirm carries it on all three requests
   * so a release can be correlated to the arm it cancels. Callers with no server
   * round-trip (the attention cards' one-shot land) simply ignore it.
   */
  readonly attemptSeq: number;
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
   * Receives this press's `attemptSeq` (round-6 finding 3) so the server arm can be
   * stamped with the id the matching disarm/confirm will carry.
   */
  readonly onBegin?: (attemptSeq: number) => void;
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
   * Receives this press's `attemptSeq` (round-6 finding 3) so the server disarm
   * cancels the exact arm this hold began — and, carried on the disarm even when
   * the arm has not yet landed, raises the cancel watermark that refuses a late
   * arm which the network reordered ahead of it.
   */
  readonly onCancel?: (attemptSeq: number) => void;
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
  onBegin,
  onCancel,
  onArm,
  onAct,
  className,
}: HoldToActProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  /* This press's attempt sequence, minted at begin and read by cancel/complete/
     unmount so all four callbacks carry the SAME id (round-6 finding 3). */
  const attemptRef = useRef<number>(0);

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
    onCancel?.(attemptRef.current);
  }, [onCancel, paint, stop]);

  const complete = useCallback(() => {
    const started = startRef.current;
    if (started === null) return;
    const heldMs = Math.round(performance.now() - started);
    stop();
    paint(1);
    setPhase('armed');
    const arming: Arming = {
      actionId,
      actor,
      armedAt: new Date().toISOString(),
      heldMs,
      attemptSeq: attemptRef.current,
    };
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
    /* Mint this press's attempt id BEFORE arming, so the arm and the disarm/confirm
       that follow all carry it (round-6 finding 3). */
    attemptRef.current = nextAttemptSeq();
    setPhase('holding');
    paint(0);
    /* Before the first frame, so a caller that has to start a clock elsewhere
       starts it at the same instant this one does. */
    onBegin?.(attemptRef.current);
    frameRef.current = requestAnimationFrame(tick);
  }, [onBegin, paint, tick]);

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
    onCancel?.(attemptRef.current);
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
