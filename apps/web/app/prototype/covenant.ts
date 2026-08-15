'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COVENANT SEAM (#157) — every covenant ACTION the married surface offers,
 * as ONE honestly-inert door apiece, each naming the server-gated command it
 * MUST call.
 *
 * The one hard rule this ticket exists to enforce: a covenant affordance must
 * CALL its server-gated door and MUST NEVER flip a local `setState` that fakes
 * success. The inverted risk is a `✓` that was never gated, or an agent that
 * "stopped" and keeps spending — a boolean that never reached the server.
 *
 * ── Why every door here is inert (the REALITY CHECK, confirmed on int/phase5) ──
 * The `/prototype` route runs entirely on a SEEDED control-plane fixture
 * (`seams.ts` → `controlPlaneFixture()`). It holds:
 *   - NO live room (there is no `roomId`),
 *   - NO `RealtimeClient` (nothing imports `createRealtimeClient` here),
 *   - NO real ledger object / session / plan ids (the tree ids are `s-live`,
 *     `pr-invoice`, … — fixtures, not rows any server knows).
 * So NONE of the real gated doors can be reached from this route yet. The live
 * client + real ids arrive at APP-INTEGRATION — the married surface bound to the
 * live control plane (map #150) — not in this wiring wave.
 *
 * Until then each door is HONESTLY INERT: it names the exact gated command it
 * must call, performs NO durable mutation, and returns `reached: false`. Flip
 * the input — invoke any of these — and nothing changes and nothing is
 * certified. That is the covenant-correct state for an affordance whose gated
 * door is not yet reachable, and the exact opposite of the `setState` theater
 * (`certified = true`, "@hexi stop" freezing the stream) this ticket kills.
 *
 * ── Where the real wiring lands ──
 * When app-integration binds a live `RealtimeClient` (`clientRef`) and a real
 * `roomId`, replace each `inert(...)` body with the real call and return
 * `reached: true` ONLY on the server's `ack` — NEVER short-circuit to a local
 * flag:
 *   certify   → clientRef.correctObject(roomId, objectId, 'amend',
 *                 { patch: { verification: 'verified' } })      (LiveRoomSession:603)
 *   fund      → issueRoomCommand({ name: 'set_plan_rlimit', roomId, planId, slice })
 *                                                                (room-command.ts; human-only)
 *   steer     → clientRef.signalSession(roomId, sessionId, 'steer', { body })
 *   interrupt → clientRef.signalSession(roomId, sessionId, 'interrupt', { body })
 *   retract   → clientRef.correctObject(roomId, objectId, 'retract')
 *   supersede → clientRef.supersedeObject(roomId, replacementId, retiredId)
 *   run       → the dispatch door (open_session / resume_session)
 * The reducer (`packages/core/authority.ts`) refuses a non-human at every
 * certifying/spend door; this seam never re-implements that check and never
 * weakens it.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The exact server-gated command an affordance routes to. */
export type CovenantDoor =
  | "correctObject('amend',{verification:'verified'})"
  | 'set_plan_rlimit'
  | 'signal_session{steer}'
  | 'signal_session{interrupt}'
  | "correctObject('retract')"
  | 'supersede_object'
  | 'open_session|resume_session';

/**
 * What a covenant affordance did. The SAME shape the live wiring will return, so
 * the caller's success/refusal handling does not change when the door goes live —
 * only `reached` starts coming back `true` on the server's ack.
 */
export interface CovenantOutcome {
  /** The server-gated command this affordance MUST call. */
  readonly door: CovenantDoor;
  /**
   * Did the durable command reach the server? Always `false` until
   * app-integration binds a live client — and a caller may NEVER paint success
   * off anything but a `true` here.
   */
  readonly reached: false;
  /** Why it is inert — surfaced to the operator, never swallowed as success. */
  readonly inert: string;
}

const AWAITING =
  'this surface is not yet bound to the live control plane (no live session), so nothing was sent — awaiting a human AND app-integration (#157)';

function inert(door: CovenantDoor): CovenantOutcome {
  // SEAM(#157): MUST call the gated door named by `door`. Inert until
  // app-integration — replace this body with the real client call and return
  // `reached: true` only on the server's ack. NEVER a local flag that fakes it.
  return { door, reached: false, inert: AWAITING };
}

/**
 * Every covenant door the married surface can offer, each honestly inert. The
 * arguments are the ids the live call will need (so the call sites already pass
 * the right things); they are deliberately unused while the door is inert, which
 * is the point — an inert door reads nothing and writes nothing.
 */
export const covenant = {
  /** Certify a `~` draft to `✓ verified`. The machine never certifies (#102). */
  certify: (_objectId: string): CovenantOutcome =>
    inert("correctObject('amend',{verification:'verified'})"),
  /** Set/raise a plan's spend slice. Human-only; the server refuses a machine first. */
  fund: (_planId: string, _slice: number): CovenantOutcome => inert('set_plan_rlimit'),
  /** Steer an open session — public, receipted, powerless over covenant and purse. */
  steer: (_sessionId: string, _body: string): CovenantOutcome => inert('signal_session{steer}'),
  /** Interrupt (stop) an open session — the agent principal or its owner only. */
  interrupt: (_sessionId: string, _body: string): CovenantOutcome =>
    inert('signal_session{interrupt}'),
  /** Retract an accepted `~` reading. Human-only; withdrawn, never erased. */
  retract: (_objectId: string): CovenantOutcome => inert("correctObject('retract')"),
  /** Supersede an object with its forward replacement. */
  supersede: (_retiredObjectId: string, _replacementObjectId: string): CovenantOutcome =>
    inert('supersede_object'),
  /** Dispatch / run a session. */
  run: (_sessionId: string): CovenantOutcome => inert('open_session|resume_session'),
} as const;
