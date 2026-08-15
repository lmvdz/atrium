import { LoopClient } from './client.js';
import { answerClientMessageId, classify, type InboundMessage } from './conductor.js';
import { isCauseSettled, OutcomeJournal } from './journal.js';
import {
  actorUserId,
  MessagePosted,
  PlanOpened,
  PlanRlimitSet,
  SessionFailed,
  SessionOpened,
  SessionSettled,
  type WireEvent,
} from './protocol.js';

/**
 * THE REFERENCE CHANNEL-LOOP DAEMON (#148, #139).
 *
 * A separate process holding the AGENT credential and nothing else. It consumes
 * its channel room's ordered stream and, per inbound message, runs one
 * deterministic conductor turn (`conductor.ts`) into exactly one arm. Its only
 * durable state is the outcome journal (`journal.ts`), written before every
 * cursor advance. It talks to the server only over the wire (`client.ts`).
 *
 * ## Idempotency, honestly split by route class (#139 resolution 2)
 *
 *  - DRAWS (open_session): the FUNDED-ARM claim is the backstop (#128/0047). The
 *    daemon always supplies `causeMessageId`; a re-routed draw whose cause already
 *    funded an arm is REFUSED by the server (a nack), and that refusal — not a
 *    daemon-side dedupe cache — is the idempotency. This is what makes a
 *    crash-replay not double-fund.
 *  - ANSWERS: the daemon supplies a deterministic `clientMessageId` derived from
 *    the cause, so the server's existing send_message dedupe holds on replay.
 *  - PLANS (open_plan): the SERVER's per-cause plan claim is the backstop (#148
 *    FIX 1), mirroring the funded-arm claim for draws. A crash after the plan's
 *    ack but before the journal write replays the goal and re-sends `open_plan`;
 *    the server refuses it (a plan for this cause already exists), and that
 *    refusal — not the journal — is the idempotency, so exactly one board is
 *    opened per cause across any crash seam. A plan still takes NO `funded_arms`
 *    claim: a plan is not a draw, and this claim is a distinct board-level one.
 *  - STEERS: at-least-once via the journal — a journaled cause is not re-routed.
 *    A journal loss can double a steer, which the doctrine declares unpreventable
 *    (stated, not hidden).
 *
 * ## The covenant (#122, #148)
 *
 * The daemon can do only what an agent may. It NEVER emits `settle_session`
 * (that is the coordinator's, gated by a capability token the daemon never
 * holds), `set_plan_rlimit` (human-only), or any certification. Those are
 * server-refused; the acceptance test witnesses each refusal.
 */

export interface LoopHooks {
  /**
   * FAULT-INJECTION SEAM (tests only). Invoked after a draw's `open_session` ack
   * returns GRANTED and BEFORE the outcome is journaled — i.e. inside the exact
   * window whose crash the funded-arm claim must cover. A test throws here to
   * simulate a crash between the server append and the journal write.
   */
  beforeDrawJournal?: (info: { cause: string; planId: string }) => Promise<void> | void;
  /**
   * FAULT-INJECTION SEAM (tests only). Invoked after an `open_plan` ack returns
   * and BEFORE `plan_requested` is journaled — the window whose crash opens a
   * SECOND plan on replay unless the SERVER's per-cause plan claim refuses it
   * (#148 FIX 1). A test throws here to simulate that crash.
   */
  beforePlanJournal?: (info: { cause: string }) => Promise<void> | void;
}

export interface LoopDaemonOptions {
  url: string;
  cookie: string;
  roomId: string;
  journalPath: string;
  /** The harness/model stamped on a session's `open_session` (data only — it does
   *  not select the provider; the server's `EXECUTION_PROVIDER` does). Kept off the
   *  shim's reserved directives. */
  harness?: string;
  model?: string;
  /** Compact the outcome journal after this many appended records (#148 FIX 3).
   *  Defaults to the journal's own bound; tests set it small to witness a real
   *  compaction. */
  compactEvery?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: unknown) => void;
  hooks?: LoopHooks;
}

/** The funded-arm refusal is a nack whose message the server writes deterministic
 *  ally (`fundedArmRefusal`). This client keys off a stable fragment of it; the
 *  coupling is PINNED by the integration test, which asserts the real server nack
 *  carries this fragment. */
export function isFundedArmRefusal(nack: { code: string; message: string }): boolean {
  return nack.code === 'invalid' && nack.message.includes('has already funded a draw');
}

/** The per-cause PLAN claim refusal (#148 FIX 1) — the plan-opening analogue of
 *  `isFundedArmRefusal`. A pre-crash `open_plan` this loop had not yet journaled
 *  already opened the board; the server refuses the replay re-send, and that
 *  refusal is not an error — it means the plan EXISTS, so the daemon records the
 *  request and lets the plan's own event drive the draw, exactly as a fresh ack
 *  would. Keyed on a stable fragment of `planCauseRefusal`, PINNED by the
 *  integration test. */
export function isPlanClaimedRefusal(nack: { code: string; message: string }): boolean {
  return nack.code === 'invalid' && nack.message.includes('has already opened a plan');
}

const ANSWER_BODY =
  'The channel loop received your message. Run-zero answers are acknowledgements only ' +
  '(a model conductor is out of scope); heavy work is opened as a session from a goal that names a ticket.';

export class LoopDaemon {
  private readonly options: LoopDaemonOptions;
  private readonly client: LoopClient;
  private readonly log: NonNullable<LoopDaemonOptions['log']>;
  private journal!: OutcomeJournal;
  private halted = false;
  private haltResolve: (() => void) | undefined;
  readonly whenHalted: Promise<void>;

  constructor(options: LoopDaemonOptions) {
    this.options = options;
    this.log =
      options.log ??
      ((level, message, fields) => {
        console[level](message, fields ?? '');
      });
    this.client = new LoopClient({ url: options.url, cookie: options.cookie, log: this.log });
    this.whenHalted = new Promise<void>((resolve) => {
      this.haltResolve = resolve;
    });
  }

  get userId(): string {
    return this.client.userId;
  }

  /** Open the journal, connect, subscribe, and replay from the cursor. Resolves
   *  once live consumption is running; the loop then runs until `stop()`. */
  async start(): Promise<void> {
    this.journal = await OutcomeJournal.open(this.options.journalPath, this.options.roomId, {
      ...(this.options.compactEvery !== undefined
        ? { compactEvery: this.options.compactEvery }
        : {}),
    });
    await this.client.connect();
    this.client.setEventHandler((entry) => this.safeHandle(entry), this.journal.cursor);
    await this.client.subscribe(this.options.roomId);
    await this.client.backfill(this.options.roomId, this.journal.cursor);
    this.log('info', 'loop online', {
      roomId: this.options.roomId,
      userId: this.userId,
      cursor: this.journal.cursor,
    });
  }

  private async safeHandle(entry: WireEvent): Promise<void> {
    if (this.halted) return;
    try {
      await this.handleEvent(entry);
    } catch (error) {
      // A crash mid-turn (real or injected) leaves the journal exactly as it was
      // before the turn — the cursor never advanced past the unfinished event, so
      // a restart re-examines it. This is the daemon's crash semantics.
      this.halted = true;
      this.log('error', 'loop halted mid-turn', { error: (error as Error).message });
      this.haltResolve?.();
    }
  }

  private async handleEvent(entry: WireEvent): Promise<void> {
    const event = entry.event;
    switch (event.type) {
      case 'message_posted':
        return this.onMessage(entry);
      case 'plan_opened':
        return this.onPlanOpened(entry);
      case 'session_opened':
        return this.onSessionOpened(entry);
      case 'session_settled':
      case 'session_failed':
        return this.onSessionTerminal(entry);
      case 'plan_rlimit_set':
        return this.onFunding(entry);
      default:
        // draw_refused/session_signaled/plan_settled echoes and anything else the
        // loop already accounted for via an ack — just move the cursor.
        return this.advance(entry.roomSeq);
    }
  }

  private async advance(roomSeq: number): Promise<void> {
    await this.journal.record({ roomSeq, outcome: { kind: 'advance' } });
  }

  // ── the conductor turn ──────────────────────────────────────────────────
  private async onMessage(entry: WireEvent): Promise<void> {
    const event = MessagePosted.parse(entry.event);
    const cause = event.messageId;
    // Already routed (or in flight) — idempotent on replay.
    if (this.journal.causes.has(cause)) return this.advance(entry.roomSeq);

    const message: InboundMessage = {
      messageId: cause,
      body: event.body,
      replyToId: event.replyToId,
      authorUserId: actorUserId(entry.actor),
    };
    const route = classify(message, {
      ownUserId: this.userId,
      runningSessionForGoal: (goalId) => this.runningSessionForGoal(goalId),
    });

    switch (route.kind) {
      case 'open_work':
        return this.openWork(entry.roomSeq, cause, event.body);
      case 'steer':
        return this.steer(entry.roomSeq, cause, route.sessionId, event.body);
      case 'answer':
        return this.answer(entry.roomSeq, cause, event.body);
      case 'ignore':
        return this.journal.record({ roomSeq: entry.roomSeq, outcome: { kind: 'ignored', cause } });
    }
  }

  private async openWork(roomSeq: number, cause: string, body: string): Promise<void> {
    const ack = await this.client.command({
      name: 'open_plan',
      roomId: this.options.roomId,
      agentUserId: this.userId,
      title: body.slice(0, 200),
      causeMessageId: cause,
    });
    if (ack.type === 'nack') {
      if (isPlanClaimedRefusal(ack)) {
        // A plan for this cause ALREADY EXISTS — a pre-crash `open_plan` this loop
        // acked but had not yet journaled (#148 FIX 1). The refusal IS the
        // idempotency: record the REQUEST so the existing plan's own event drives
        // the draw, exactly as a fresh ack would. Without this the replay would
        // journal `ignored` and the already-opened plan would never draw a session.
        this.log('info', 'open_plan refused — plan already opened for cause, resuming', { cause });
        return this.journal.record({ roomSeq, outcome: { kind: 'plan_requested', cause } });
      }
      this.log('warn', 'open_plan refused', { cause, message: ack.message });
      // A genuine refusal (cross-room cause, non-membership): record the cause so
      // it is not re-routed; the loop cannot open this plan.
      return this.journal.record({ roomSeq, outcome: { kind: 'ignored', cause } });
    }
    // The FAULT SEAM sits here: after the server has opened the plan, before the
    // journal records the request — the window the per-cause plan claim must cover.
    await this.options.hooks?.beforePlanJournal?.({ cause });
    // The plan's id is minted server-side and rides the plan_opened event, not the
    // ack. Record the REQUEST now (so a replay does not re-open the plan) and take
    // the draw when that event arrives.
    await this.journal.record({ roomSeq, outcome: { kind: 'plan_requested', cause } });
  }

  private async steer(
    roomSeq: number,
    cause: string,
    sessionId: string,
    body: string,
  ): Promise<void> {
    const ack = await this.client.command({
      name: 'signal_session',
      roomId: this.options.roomId,
      sessionId,
      kind: 'steer',
      body,
      causeMessageId: cause,
    });
    if (ack.type === 'nack') this.log('warn', 'steer refused', { cause, message: ack.message });
    await this.journal.record({ roomSeq, outcome: { kind: 'steered', cause, sessionId } });
  }

  private async answer(roomSeq: number, cause: string, _body: string): Promise<void> {
    const clientMessageId = answerClientMessageId(cause);
    const ack = await this.client.command({
      name: 'send_message',
      roomId: this.options.roomId,
      body: ANSWER_BODY,
      clientMessageId,
      causeMessageId: cause,
    });
    if (ack.type === 'nack') this.log('warn', 'answer refused', { cause, message: ack.message });
    await this.journal.record({
      roomSeq,
      outcome: { kind: 'answered', cause, clientMessageId },
    });
  }

  // ── the draw, taken when the plan's own event arrives ─────────────────────
  private async onPlanOpened(entry: WireEvent): Promise<void> {
    const event = PlanOpened.parse(entry.event);
    const cause = event.causeMessageId;
    const mine =
      cause !== null &&
      event.agentUserId === this.userId &&
      actorUserId(entry.actor) === this.userId;
    const causeState = cause ? this.journal.causes.get(cause) : undefined;
    // Only act on a plan THIS loop requested and has not yet drawn against.
    if (!mine || !cause || causeState?.step !== 'plan_requested') {
      return this.advance(entry.roomSeq);
    }
    await this.takeDraw(entry.roomSeq, cause, event.planId, false);
  }

  /** Emit `open_session` and journal the draw's outcome. Shared by the first draw
   *  and the post-funding retry. `retry` marks the single re-route. */
  private async takeDraw(
    roomSeq: number,
    cause: string,
    planId: string,
    retry: boolean,
  ): Promise<void> {
    const ack = await this.client.command({
      name: 'open_session',
      roomId: this.options.roomId,
      planId,
      harness: this.options.harness ?? 'atrium-loop',
      model: this.options.model ?? 'run-zero',
      causeMessageId: cause,
    });

    if (ack.type === 'nack') {
      if (isFundedArmRefusal(ack)) {
        // The cause already funded an arm (a pre-crash draw this loop had not yet
        // journaled). The refusal IS the idempotency — terminal, no double fund.
        this.log('info', 'draw refused by funded-arm claim — no double fund', { cause, planId });
        return this.journal.record({
          roomSeq,
          outcome: { kind: 'funded_terminal', cause, planId, ...(retry ? { retry: true } : {}) },
        });
      }
      this.log('warn', 'open_session nacked', { cause, planId, message: ack.message });
      return this.journal.record({
        roomSeq,
        outcome: { kind: 'draw_refused', cause, planId, ...(retry ? { retry: true } : {}) },
      });
    }

    if (ack.draw?.outcome === 'refused') {
      // Budget refusal — retryable ONCE after a later plan_rlimit_set (#139 r3).
      this.log('info', 'draw refused for budget — parked for funding', {
        cause,
        planId,
        slice: ack.draw.slice,
      });
      return this.journal.record({
        roomSeq,
        outcome: { kind: 'draw_refused', cause, planId, ...(retry ? { retry: true } : {}) },
      });
    }

    // Granted. The FAULT SEAM sits here: after the server has funded, before the
    // journal records it — the window the funded-arm claim must cover.
    await this.options.hooks?.beforeDrawJournal?.({ cause, planId });
    await this.journal.record({
      roomSeq,
      outcome: { kind: 'draw_taken', cause, planId, retry },
    });
  }

  // ── session bookkeeping (sessionId learned from the echoed event) ─────────
  private async onSessionOpened(entry: WireEvent): Promise<void> {
    const event = SessionOpened.parse(entry.event);
    const cause = event.causeMessageId;
    const mine = cause !== null && actorUserId(entry.actor) === this.userId;
    if (!mine || !cause || !this.journal.causes.has(cause)) {
      return this.advance(entry.roomSeq);
    }
    if (this.journal.sessions.has(event.sessionId)) return this.advance(entry.roomSeq);
    await this.journal.record({
      roomSeq: entry.roomSeq,
      outcome: { kind: 'session_opened', sessionId: event.sessionId, planId: event.planId, cause },
    });
  }

  private async onSessionTerminal(entry: WireEvent): Promise<void> {
    const event =
      entry.event.type === 'session_settled'
        ? SessionSettled.parse(entry.event)
        : SessionFailed.parse(entry.event);
    const planId = this.journal.sessions.get(event.sessionId);
    if (!planId) return this.advance(entry.roomSeq); // a session this loop did not open
    const plan = this.journal.plans.get(planId);
    if (plan?.terminal.has(event.sessionId)) return this.advance(entry.roomSeq);
    await this.journal.record({
      roomSeq: entry.roomSeq,
      outcome: { kind: 'session_terminal', sessionId: event.sessionId, planId },
    });
    await this.maybeSettlePlan(entry.roomSeq, planId);
  }

  /** Issue settle_plan when every child of the plan is terminal (#140). */
  private async maybeSettlePlan(roomSeq: number, planId: string): Promise<void> {
    const plan = this.journal.plans.get(planId);
    if (!plan || plan.settled) return;
    if (plan.sessions.size === 0) return;
    for (const sessionId of plan.sessions) {
      if (!plan.terminal.has(sessionId)) return; // a child is still running
    }
    const ack = await this.client.command({
      name: 'settle_plan',
      roomId: this.options.roomId,
      planId,
    });
    if (ack.type === 'nack')
      this.log('warn', 'settle_plan nacked', { planId, message: ack.message });
    await this.journal.record({ roomSeq, outcome: { kind: 'plan_settled', planId } });
  }

  // ── the post-funding retry (#139 resolution 3) ────────────────────────────
  private async onFunding(entry: WireEvent): Promise<void> {
    const event = PlanRlimitSet.parse(entry.event);
    const planId = event.planId;
    for (const [cause, state] of this.journal.causes) {
      if (state.class !== 'draw') continue;
      if (state.step !== 'draw_refused') continue;
      if (state.planId !== planId) continue;
      if (state.retried) continue;
      this.log('info', 're-routing a budget-refused draw after funding', { cause, planId });
      await this.takeDraw(entry.roomSeq, cause, planId, true);
    }
    // Whatever the retries did, the funding event itself is now accounted for.
    await this.advance(entry.roomSeq);
  }

  private runningSessionForGoal(goalMessageId: string): string | null {
    const cause = this.journal.causes.get(goalMessageId);
    if (cause?.class !== 'draw' || !isCauseSettled(cause)) return null;
    if (!cause.planId) return null;
    const plan = this.journal.plans.get(cause.planId);
    if (!plan) return null;
    for (const sessionId of plan.sessions) {
      if (!plan.terminal.has(sessionId)) return sessionId;
    }
    return null;
  }

  async stop(): Promise<void> {
    this.halted = true;
    await this.client.close();
    if (this.journal) await this.journal.close();
  }
}
