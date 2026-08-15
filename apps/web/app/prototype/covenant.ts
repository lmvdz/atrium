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
 *   certify   → certifySessionAction({ sessionId, attemptToken, … }) via the
 *                 HoldToAct arm→confirm/cancel flow (lib/certify-session.ts;
 *                 the server times its own arm→confirm hold) — the ArtifactPane
 *                 hosts a SESSION LANDING, so it certifies the SESSION, not a
 *                 claim. A semantic-claim certify is the SEPARATE door
 *                 clientRef.correctObject(roomId, objectId, 'amend',
 *                 { patch: { verification: 'verified' } }) (LiveRoomSession:603).
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
  // A SESSION LANDING is certified through the SQL-timed arm→confirm hold
  // (`lib/certify-session.ts` `certifySession`, driven by `HoldToAct` via
  // `certifySessionAction`) — NOT `correctObject`, which certifies a semantic
  // CLAIM. The ArtifactPane hosts a session landing, so its certify names this.
  | 'certifySession{arm→confirm}'
  // A semantic CLAIM (an accepted reading in `LiveRoomSession`) is certified with
  // `amend {verification:'verified'}`. Named separately so a session-landing
  // certify can never be mis-wired to a claim door, or the reverse (#157 r1 D2).
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
  /**
   * Certify a session LANDING (the ArtifactPane's context: a `~` draft/diff that
   * a human accepts `✓`). The gated door is the server-timed `certifySession`
   * arm→confirm hold (`lib/certify-session.ts`, driven by `HoldToAct`) — the
   * server measures its own arm→confirm interval and writes the human signature
   * on the session row; the browser clock is never trusted. The machine never
   * certifies (#102). This is NOT `correctObject('amend',…)`, which certifies a
   * semantic claim, not a session landing (#157 r1 D2).
   */
  certify: (_sessionId: string): CovenantOutcome => inert('certifySession{arm→confirm}'),
  /**
   * Certify a semantic CLAIM (an accepted reading in `LiveRoomSession`) to
   * `✓ verified`. A DIFFERENT door from a session landing: `amend
   * {verification:'verified'}`. Named separately so neither can be mis-wired to
   * the other. Not surfaced in the ArtifactPane; here for the seam's completeness.
   */
  certifyClaim: (_objectId: string): CovenantOutcome =>
    inert("correctObject('amend',{verification:'verified'})"),
  /** Set/raise a plan's spend slice. Human-only; the server refuses a machine first. */
  fund: (_planId: string, _slice: number): CovenantOutcome => inert('set_plan_rlimit'),
  /** Steer an open session — public, receipted, powerless over covenant and purse. */
  steer: (_sessionId: string, _body: string): CovenantOutcome => inert('signal_session{steer}'),
  /**
   * Mediate an anchored artifact COMMENT into a session steer (#158/#152). This
   * is the comment-to-steer client shape, and it is TWO gated calls in order —
   * NEVER a local mutation and NEVER a faked delivery:
   *
   *   1. `clientRef.sendMessage(roomId, body, { references: [<quotation anchor>] })`
   *      — post the comment as a REAL room message carrying the quotation anchor
   *      (`send_message`; realtime.ts). This is the "durable room message" half.
   *   2. `clientRef.signalSession(roomId, sessionId, 'steer', { body,
   *      causeMessageId: <the message's durable id> })` — classify it into the
   *      gated `signal_session{steer}` door (realtime.ts; commands.ts), which
   *      `signalSession` ALREADY accepts a `causeMessageId` for. The server links
   *      it same-room via `requireSameRoomCause`; a steer is powerless over
   *      covenant and purse, so it never touches a spend/certify gate. This is
   *      the "mediatedFromMessageId" edge the ticket names.
   *
   * Two REAL go-live gaps (#168), named here so app-integration cannot forget
   * them: (a) `MessageReference.kind` (room-events.ts) has no `message`/
   * `quotation` variant, so a durable message→message quotation anchor is not
   * yet representable on the wire; (b) `sendMessage` does not forward
   * `causeMessageId`. Until both close AND a live client/room/session bind, this
   * door is honestly INERT: it performs no durable mutation, returns
   * `reached: false`, and NEVER emits a `session_signaled{steer}`. The interrupt
   * path is deliberately NOT reachable from a comment (scope boundary: no ungated
   * interrupt) — a comment mediates only to the member-gated steer.
   */
  mediateSteer: (
    _sessionId: string,
    _comment: { readonly anchor: string; readonly quote: string; readonly body: string },
  ): CovenantOutcome => inert('signal_session{steer}'),
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
