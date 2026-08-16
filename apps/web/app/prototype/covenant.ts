'use client';

import type { ArmOutcome, CertifyOutcome, DisarmOutcome } from '@/lib/certify-session';
import type { RoomCommand, RoomCommandOutcome } from '@/lib/room-command';
import type { RealtimeClient } from '@/src/lib/realtime';

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

/* ── DOOR NAMES AS CONSTANTS (#168 go-live B1) ─────────────────────────────
 * A door's NAME is a compile-time constant, readable WITHOUT invoking the act.
 * This exists to kill a RENDER-TIME LANDMINE: `ThreadStatus` (a component) read
 * a door name for a label by CALLING `covenant.steer(...)`/`covenant.interrupt(...)`
 * during render. That is harmless only while the act body is inert — the moment
 * go-live B2 puts a live durable call in `steer`/`interrupt`, every render would
 * fire a durable signal. So the label reads THIS constant instead, and a covenant
 * ACT function is never invoked in render position.
 *
 * The act functions below return `inert(DOOR_NAMES.<kind>)`, so this map is the
 * SINGLE SOURCE OF TRUTH for the door name — a label and the act it names can
 * never drift. `satisfies` pins every value to a real `CovenantDoor`.
 */
export const DOOR_NAMES = {
  certify: 'certifySession{arm→confirm}',
  certifyClaim: "correctObject('amend',{verification:'verified'})",
  fund: 'set_plan_rlimit',
  steer: 'signal_session{steer}',
  mediateSteer: 'signal_session{steer}',
  interrupt: 'signal_session{interrupt}',
  retract: "correctObject('retract')",
  supersede: 'supersede_object',
  run: 'open_session|resume_session',
} as const satisfies Record<string, CovenantDoor>;

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
  certify: (_sessionId: string): CovenantOutcome => inert(DOOR_NAMES.certify),
  /**
   * Certify a semantic CLAIM (an accepted reading in `LiveRoomSession`) to
   * `✓ verified`. A DIFFERENT door from a session landing: `amend
   * {verification:'verified'}`. Named separately so neither can be mis-wired to
   * the other. Not surfaced in the ArtifactPane; here for the seam's completeness.
   */
  certifyClaim: (_objectId: string): CovenantOutcome => inert(DOOR_NAMES.certifyClaim),
  /** Set/raise a plan's spend slice. Human-only; the server refuses a machine first. */
  fund: (_planId: string, _slice: number): CovenantOutcome => inert(DOOR_NAMES.fund),
  /** Steer an open session — public, receipted, powerless over covenant and purse. */
  steer: (_sessionId: string, _body: string): CovenantOutcome => inert(DOOR_NAMES.steer),
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
  ): CovenantOutcome => inert(DOOR_NAMES.mediateSteer),
  /** Interrupt (stop) an open session — the agent principal or its owner only. */
  interrupt: (_sessionId: string, _body: string): CovenantOutcome => inert(DOOR_NAMES.interrupt),
  /** Retract an accepted `~` reading. Human-only; withdrawn, never erased. */
  retract: (_objectId: string): CovenantOutcome => inert(DOOR_NAMES.retract),
  /** Supersede an object with its forward replacement. */
  supersede: (_retiredObjectId: string, _replacementObjectId: string): CovenantOutcome =>
    inert(DOOR_NAMES.supersede),
  /** Dispatch / run a session. */
  run: (_sessionId: string): CovenantOutcome => inert(DOOR_NAMES.run),
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
 * GO-LIVE B2 (#168) — THE LIVE, GATED DOORS.
 *
 * `covenant` above is the honestly-inert NAME REGISTRY (kept, so the render-time
 * landmine guard and the `/prototype` fixture route keep the exact inert
 * behaviour they assert). `makeCovenant` is the LIVE half: bound to a real
 * `RealtimeClient`, the certify Server Actions, and the funding command socket,
 * it returns doors that perform the REAL durable mutation — and ONLY inside a
 * human gesture handler, NEVER on render (the factory only CONSTRUCTS bindings;
 * a door fires nothing until called).
 *
 * TWO ACK MODELS, both honest, neither a local flag:
 *
 *  1. THE RESERVED HUMAN-ONLY GATES — certify (a forged `✓`) and fund (a forged
 *     spend). These reach the server through an ACK-RESOLVING transport (a Server
 *     Action / the command socket), so `reached` is the server's AWAITED `ok` and
 *     nothing else. A refusal comes back `reached:false` carrying the server's own
 *     sentence. The server reducer (`apps/server/src/commands.ts` ~:1767,
 *     `certificationClassOf`) refuses a non-human at BOTH before the append; this
 *     seam wires the client affordance to that existing gate and never reimplements
 *     or weakens it.
 *
 *  2. THE FIRE-AND-FORGET REALTIME DOORS — steer / interrupt / retract /
 *     supersede / certifyClaim. The `RealtimeClient` has NO synchronous per-command
 *     ack and — the honesty correction #168 go-live B2 fix1 forced — NO outbound
 *     command journal either: `command` sends the frame over the socket and mints a
 *     `commandId`, and `send` SILENTLY DROPS the frame when the socket is not OPEN
 *     (there is no retry-across-reconnect for outbound commands; only INBOUND events
 *     are journaled). So a `commandId` alone is not proof the command left. The
 *     honest report is `dispatched` — gated on `client().isConnected()`, i.e. the
 *     frame actually left the OPEN socket — keyed by the ack/nack `commandId` the
 *     server will receipt or `nack`, NOT a `reached:true` that claims the server
 *     confirmed. When there is no live client (`client()` is null) OR the socket is
 *     not yet OPEN (mid-(re)connect), the door is inert: nothing is sent, no fake
 *     `commandId`, and `dispatched:false`.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The reserved human-only gate outcome (certify, fund). `reached` is the
    server's awaited `ok` — never a local flag. `refusal` carries the server's own
    machine reason when it refused (e.g. `not_human`, `stale_review`, the spend
    refusal), surfaced to the operator and never swallowed as success. */
export interface GateOutcome {
  readonly door: CovenantDoor;
  readonly reached: boolean;
  readonly refusal?: string;
}

/** The fire-and-forget realtime-door outcome. `dispatched` = the durable command
    actually left the authenticated client over an OPEN socket (there is no
    outbound command journal — `send` drops a frame on a non-OPEN socket, so this
    is gated on `isConnected()`, never on the minted `commandId` alone). `commandId`
    is its ack/nack correlation id. `inert` is set (and `dispatched:false`) when
    nothing was sent because no live client is connected yet — honestly inert,
    never a faked delivery. */
export interface DispatchOutcome {
  readonly door: CovenantDoor;
  readonly dispatched: boolean;
  readonly commandId: string | null;
  readonly inert?: string;
}

/** The transports the live doors bind to. Structural so the factory is decoupled
    from the RSC/server modules and trivially mockable in a flip-input test: the
    component wires the real client ref, the certify Server Actions, and
    `issueRoomCommand`; a test wires spies. */
export interface CovenantDeps {
  readonly roomId: string;
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  /** The persistent client, or null until it connects. Read fresh on each call
      (a getter, never a captured snapshot) so a door dispatched after connect
      sees the live client, and one fired before it stays honestly inert. */
  readonly client: () => Pick<
    RealtimeClient,
    'signalSession' | 'correctObject' | 'supersedeObject' | 'isConnected'
  > | null;
  readonly armCertify: (input: {
    sessionId: string;
    workspaceSlug: string;
    roomSlug: string;
    reviewedDigest: string;
  }) => Promise<ArmOutcome>;
  readonly confirmCertify: (input: {
    sessionId: string;
    workspaceSlug: string;
    roomSlug: string;
    attemptToken: string;
  }) => Promise<CertifyOutcome>;
  readonly disarmCertify: (input: {
    sessionId: string;
    attemptToken: string;
  }) => Promise<DisarmOutcome>;
  readonly issueRoomCommand: (command: RoomCommand) => Promise<RoomCommandOutcome>;
}

/** The live covenant — bound doors returning REAL outcomes. certify is the
    arm→confirm/disarm lifecycle `HoldToAct` drives; the rest are single calls. */
export interface LiveCovenant {
  /** STEP ONE of the session-landing certify: fire the server arm on hold-BEGIN.
      Binds the signature to `reviewedDigest` (the session's real `artifactDigest`
      — you certify the reading you were shown). Stores the arm's attempt-token
      promise, keyed by session, for the confirm/disarm to thread back. */
  certifyArm(sessionId: string, reviewedDigest: string): void;
  /** STEP TWO: fire the server confirm on hold-COMPLETE. Awaits the arm's token
      and, only if one was minted, calls `certifySession`. `reached` is that
      server `ok` — a forged `✓` is impossible because nothing here paints one. */
  certifyConfirm(sessionId: string): Promise<GateOutcome>;
  /** CANCELLATION: release-before-complete cancels the exact arm it belongs to. */
  certifyDisarm(sessionId: string): void;
  /** THE SPEND GATE: set/raise a plan's rlimit slice over the command socket, the
      ONE path the server's human-only spend gate lives on. `reached` is the
      server `ok`; a machine is refused there before any append. */
  fund(planId: string, slice: number): Promise<GateOutcome>;
  /** Certify a semantic CLAIM to `✓ verified` — the `amend {verification}` door,
      distinct from the session-landing certify. */
  certifyClaim(objectId: string): DispatchOutcome;
  steer(sessionId: string, body: string): DispatchOutcome;
  interrupt(sessionId: string, body: string): DispatchOutcome;
  retract(objectId: string): DispatchOutcome;
  supersede(retiredObjectId: string, replacementObjectId: string): DispatchOutcome;
  /** Mediate an anchored comment into a session steer. HONESTLY INERT: both wire
      gaps the seam names are still open — `MessageReference.kind`
      (`typed-references.ts`) has no `message`/`quotation` variant, and
      `sendMessage` does not forward `causeMessageId` — so the quotation-anchored
      durable message→steer link is not representable on the wire yet. Nothing is
      sent; `reached:false`. */
  mediateSteer(
    sessionId: string,
    comment: { readonly anchor: string; readonly quote: string; readonly body: string },
  ): CovenantOutcome;
  /** Dispatch / run a session. HONESTLY INERT: the persistent `RealtimeClient`
      exposes no `open_session`/`resume_session` verb, and this surface offers no
      run gesture, so there is nothing to fire. Named for the seam's completeness. */
  run(sessionId: string): CovenantOutcome;
}

const NO_CLIENT =
  'the live realtime client is not connected yet, so nothing was sent — the durable command was not dispatched';

export function makeCovenant(deps: CovenantDeps): LiveCovenant {
  // The arm's attempt-token, keyed by session, as the PROMISE of the token so a
  // confirm/disarm that outruns its arm still threads the exact attempt (the
  // ControlPlane pattern). `null` means the arm was refused or skipped — the
  // confirm then sends nothing, so a stale/absent digest can never certify.
  const armTokens = new Map<string, Promise<string | null>>();

  /** Run a realtime door HONESTLY: report `dispatched:true` ONLY when the frame
      actually left the socket. Inert when there is no client at all AND when a
      client exists but its socket is not OPEN — because `RealtimeClient.send`
      silently DROPS a frame whose `socket.readyState !== OPEN` while `command`
      still mints a `commandId`, so the id alone would be a fake ack. The
      `isConnected()` read and the synchronous `send(client)` below share one tick
      with no await between them, so a door told OPEN here cannot be dropped there.
      `send` returns the durable command's id. */
  const dispatch = (
    door: CovenantDoor,
    send: (client: NonNullable<ReturnType<CovenantDeps['client']>>) => string,
  ): DispatchOutcome => {
    const client = deps.client();
    if (client === null || !client.isConnected())
      return { door, dispatched: false, commandId: null, inert: NO_CLIENT };
    return { door, dispatched: true, commandId: send(client) };
  };

  return {
    certifyArm: (sessionId, reviewedDigest) => {
      if (reviewedDigest.length === 0) {
        // No reviewed digest ⇒ there is no reading to bind a signature to. Store a
        // resolved-null token so the confirm sends nothing rather than arming over
        // whatever is current (the round-6 stale-review hole, closed here too).
        armTokens.set(sessionId, Promise.resolve(null));
        return;
      }
      const armPromise = deps
        .armCertify({
          sessionId,
          workspaceSlug: deps.workspaceSlug,
          roomSlug: deps.roomSlug,
          reviewedDigest,
        })
        .then((outcome) => (outcome.ok ? outcome.attemptToken : null));
      armTokens.set(sessionId, armPromise);
      void armPromise;
    },
    certifyConfirm: async (sessionId) => {
      const pending = armTokens.get(sessionId) ?? Promise.resolve(null);
      const attemptToken = await pending;
      if (attemptToken === null) {
        return { door: DOOR_NAMES.certify, reached: false, refusal: 'not_armed' };
      }
      const outcome = await deps.confirmCertify({
        sessionId,
        workspaceSlug: deps.workspaceSlug,
        roomSlug: deps.roomSlug,
        attemptToken,
      });
      return outcome.ok
        ? { door: DOOR_NAMES.certify, reached: true }
        : { door: DOOR_NAMES.certify, reached: false, refusal: outcome.reason };
    },
    certifyDisarm: (sessionId) => {
      const pending = armTokens.get(sessionId);
      if (pending === undefined) return;
      armTokens.delete(sessionId);
      void pending.then((attemptToken) => {
        if (attemptToken === null) return;
        void deps.disarmCertify({ sessionId, attemptToken });
      });
    },
    fund: async (planId, slice) => {
      const outcome = await deps.issueRoomCommand({
        name: 'set_plan_rlimit',
        roomId: deps.roomId,
        planId,
        slice,
      });
      return outcome.ok
        ? { door: DOOR_NAMES.fund, reached: true }
        : { door: DOOR_NAMES.fund, reached: false, refusal: outcome.message };
    },
    certifyClaim: (objectId) =>
      dispatch(DOOR_NAMES.certifyClaim, (client) =>
        client.correctObject(deps.roomId, objectId, 'amend', {
          patch: { verification: 'verified' },
        }),
      ),
    steer: (sessionId, body) =>
      dispatch(DOOR_NAMES.steer, (client) =>
        client.signalSession(deps.roomId, sessionId, 'steer', { body }),
      ),
    interrupt: (sessionId, body) =>
      dispatch(DOOR_NAMES.interrupt, (client) =>
        client.signalSession(deps.roomId, sessionId, 'interrupt', { body }),
      ),
    retract: (objectId) =>
      dispatch(DOOR_NAMES.retract, (client) =>
        client.correctObject(deps.roomId, objectId, 'retract'),
      ),
    supersede: (retiredObjectId, replacementObjectId) =>
      dispatch(
        DOOR_NAMES.supersede,
        (client) =>
          client.supersedeObject(deps.roomId, replacementObjectId, retiredObjectId).commandId,
      ),
    // Honestly inert — both wire gaps confirmed still open at go-live (#168).
    mediateSteer: (_sessionId, _comment) => inert(DOOR_NAMES.mediateSteer),
    // Honestly inert — no client verb, no surface gesture.
    run: (_sessionId) => inert(DOOR_NAMES.run),
  };
}
