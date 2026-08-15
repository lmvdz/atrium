import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * THE DURABLE OUTCOME JOURNAL (#139 resolution 2, #148).
 *
 * The daemon's own state — a single append-only file OUTSIDE Atrium's schema. It
 * holds two things the loop cannot lose across a crash:
 *
 *  1. the CURSOR: the highest `roomSeq` fully processed. On restart the daemon
 *     re-reads from here (`since(roomId, cursor)`), so nothing before it is
 *     re-examined and nothing after it is skipped.
 *  2. a PER-CAUSE OUTCOME for every routed message. Idempotency is by route class
 *     (#139): draws lean on the server's funded-arm claim as the real backstop,
 *     answers on a deterministic `clientMessageId`, and steers/open_plan on THIS
 *     journal — a journaled cause is not routed twice.
 *
 * Every record is fsync'd BEFORE the in-memory cursor advances (`record()` does
 * the write, the sync, and only then the reduce). That ordering is the whole
 * point: a crash between a server append and the journal write leaves the cursor
 * BEHIND the append, so the cause is re-examined on restart — and re-examining a
 * draw that already funded is refused by the funded-arm claim, which is where the
 * "no double fund" guarantee actually lives. A journal that advanced its cursor
 * first would hide the append it had not yet recorded.
 *
 * REPLAY AND LIVE SHARE ONE REDUCER (`reduce`). A second copy of "what does this
 * outcome mean for the state" would be free to disagree with the first, and the
 * disagreement would only ever show up after a crash — the worst place to find
 * it. So `load()` folds the file through exactly the fold `record()` uses.
 */

export type RouteClass = 'draw' | 'steer' | 'answer' | 'ignore';

export type Outcome =
  /** open_plan appended for this cause; the draw is not yet taken. The plan's id
   *  rides the plan_opened EVENT, not the ack, so it is recorded later. */
  | { kind: 'plan_requested'; cause: string }
  /** the draw's `open_session` was GRANTED. Terminal for the cause's routing; the
   *  sessionId is learned from the echoed session_opened event, not from here.
   *  `retry` marks a post-funding re-route. */
  | { kind: 'draw_taken'; cause: string; planId: string; retry: boolean }
  /** the draw was REFUSED for budget (unfunded/over-slice). Retryable ONCE after
   *  a later `plan_rlimit_set` funds the plan (#139 resolution 3). */
  | { kind: 'draw_refused'; cause: string; planId: string; retry?: boolean }
  /** the funded-arm claim refused a re-routed draw — the cause already funded an
   *  arm (#128/0047). Terminal: the refusal IS the idempotency. */
  | { kind: 'funded_terminal'; cause: string; planId: string; retry?: boolean }
  /** a session (this loop's) was observed opening under a plan — sessionId→plan. */
  | { kind: 'session_opened'; cause: string; sessionId: string; planId: string }
  /** a steer was mediated to a running session (at-least-once; journaled so a
   *  replay does not re-steer). */
  | { kind: 'steered'; cause: string; sessionId: string }
  /** an answer was posted, carrying this deterministic `clientMessageId`. */
  | { kind: 'answered'; cause: string; clientMessageId: string }
  /** the message was classified as nothing the loop acts on. */
  | { kind: 'ignored'; cause: string }
  /** a child session reached a terminal exit (settled/failed). */
  | { kind: 'session_terminal'; sessionId: string; planId: string }
  /** the daemon issued settle_plan for a plan whose children are all terminal. */
  | { kind: 'plan_settled'; planId: string }
  /** a processed event that carried no routing action — advances the cursor. */
  | { kind: 'advance' };

export interface JournalRecord {
  /** The inbound event's position. The cursor is the max of these. */
  roomSeq: number;
  outcome: Outcome;
}

export interface CauseState {
  class: RouteClass;
  step: Outcome['kind'];
  planId?: string;
  sessionId?: string;
  clientMessageId?: string;
  /** A draw_refused cause that has already spent its single post-funding retry. */
  retried: boolean;
}

export interface PlanState {
  cause: string;
  /** Sessions this daemon opened under the plan. */
  sessions: Set<string>;
  /** Of those, the ones that reached a terminal exit. */
  terminal: Set<string>;
  settled: boolean;
}

/** A cause step is terminal when no re-routing should happen on a bare replay of
 *  its message. `draw_refused` is terminal in THIS sense — its retry is driven by
 *  a later funding event, never by re-reading the goal. */
const TERMINAL_STEPS: ReadonlySet<Outcome['kind']> = new Set([
  'draw_taken',
  'funded_terminal',
  'draw_refused',
  'steered',
  'answered',
  'ignored',
]);

export function isCauseSettled(state: CauseState | undefined): boolean {
  return state !== undefined && TERMINAL_STEPS.has(state.step);
}

export class OutcomeJournal {
  private handle: FileHandle;
  private _cursor = 0;
  readonly causes = new Map<string, CauseState>();
  readonly plans = new Map<string, PlanState>();
  readonly sessions = new Map<string, string>();

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  /** Open (or create) the journal at `path` and replay it into memory. */
  static async open(path: string): Promise<OutcomeJournal> {
    await mkdir(dirname(path), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const handle = await open(path, 'a');
    const journal = new OutcomeJournal(handle);
    for (const line of existing.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const record = JSON.parse(trimmed) as JournalRecord;
      journal.reduce(record);
    }
    return journal;
  }

  get cursor(): number {
    return this._cursor;
  }

  /** Persist (fsync) then reduce. The order is the durability contract. */
  async record(record: JournalRecord): Promise<void> {
    await this.handle.write(`${JSON.stringify(record)}\n`);
    await this.handle.sync();
    this.reduce(record);
  }

  private reduce(record: JournalRecord): void {
    if (record.roomSeq > this._cursor) this._cursor = record.roomSeq;
    const outcome = record.outcome;
    switch (outcome.kind) {
      case 'plan_requested':
        this.upsertCause(outcome.cause, 'draw', outcome.kind, {});
        return;
      case 'draw_taken':
        this.upsertCause(outcome.cause, 'draw', outcome.kind, {
          planId: outcome.planId,
          retried: outcome.retry ? true : undefined,
        });
        this.ensurePlan(outcome.planId, outcome.cause);
        return;
      case 'draw_refused':
        this.upsertCause(outcome.cause, 'draw', outcome.kind, {
          planId: outcome.planId,
          retried: outcome.retry ? true : undefined,
        });
        this.ensurePlan(outcome.planId, outcome.cause);
        return;
      case 'funded_terminal':
        this.upsertCause(outcome.cause, 'draw', outcome.kind, {
          planId: outcome.planId,
          retried: outcome.retry ? true : undefined,
        });
        this.ensurePlan(outcome.planId, outcome.cause);
        return;
      case 'session_opened': {
        this.upsertCause(outcome.cause, 'draw', 'draw_taken', { planId: outcome.planId });
        const plan = this.ensurePlan(outcome.planId, outcome.cause);
        plan.sessions.add(outcome.sessionId);
        this.sessions.set(outcome.sessionId, outcome.planId);
        return;
      }
      case 'steered':
        this.upsertCause(outcome.cause, 'steer', outcome.kind, { sessionId: outcome.sessionId });
        return;
      case 'answered':
        this.upsertCause(outcome.cause, 'answer', outcome.kind, {
          clientMessageId: outcome.clientMessageId,
        });
        return;
      case 'ignored':
        this.upsertCause(outcome.cause, 'ignore', outcome.kind, {});
        return;
      case 'session_terminal': {
        const plan = this.ensurePlan(outcome.planId, undefined);
        plan.terminal.add(outcome.sessionId);
        this.sessions.set(outcome.sessionId, outcome.planId);
        return;
      }
      case 'plan_settled': {
        const plan = this.ensurePlan(outcome.planId, undefined);
        plan.settled = true;
        return;
      }
      case 'advance':
        return;
    }
  }

  private upsertCause(
    cause: string,
    routeClass: RouteClass,
    step: Outcome['kind'],
    fields: { planId?: string; sessionId?: string; clientMessageId?: string; retried?: boolean },
  ): void {
    const existing = this.causes.get(cause);
    const next: CauseState = {
      class: routeClass,
      step,
      planId: fields.planId ?? existing?.planId,
      sessionId: fields.sessionId ?? existing?.sessionId,
      clientMessageId: fields.clientMessageId ?? existing?.clientMessageId,
      retried: fields.retried ?? existing?.retried ?? false,
    };
    this.causes.set(cause, next);
  }

  private ensurePlan(planId: string, cause: string | undefined): PlanState {
    let plan = this.plans.get(planId);
    if (!plan) {
      plan = { cause: cause ?? '', sessions: new Set(), terminal: new Set(), settled: false };
      this.plans.set(planId, plan);
    } else if (cause && plan.cause === '') {
      plan.cause = cause;
    }
    return plan;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
