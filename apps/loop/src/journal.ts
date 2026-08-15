import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

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
 *     answers on a deterministic `clientMessageId`, plans on the server's
 *     per-cause plan claim (#148 FIX 1), and steers on THIS journal — a journaled
 *     cause is not routed twice.
 *
 * Every record is fsync'd BEFORE the in-memory cursor advances (`record()` does
 * the write, the sync, and only then the reduce). That ordering is the whole
 * point: a crash between a server append and the journal write leaves the cursor
 * BEHIND the append, so the cause is re-examined on restart — and re-examining a
 * draw that already funded is refused by the funded-arm claim, and a plan whose
 * cause already opened one is refused by the plan claim, which is where the "no
 * double" guarantee actually lives. A journal that advanced its cursor first
 * would hide the append it had not yet recorded.
 *
 * REPLAY AND LIVE SHARE ONE REDUCER (`reduce`). A second copy of "what does this
 * outcome mean for the state" would be free to disagree with the first, and the
 * disagreement would only ever show up after a crash — the worst place to find
 * it. So `load()` folds the file through exactly the fold `record()` uses, and
 * COMPACTION (below) re-emits state as one `snapshot` record that `reduce` folds
 * the same way — there is no second reconstruction path.
 *
 * ## FAIL-CLOSED, VERSIONED, ROOM-BOUND (#148 FIX 2)
 *
 * The file opens with a header line `{ v, roomId }`. On replay every line is
 * Zod-validated: a line that is not valid JSON, not a known record shape, names
 * the WRONG room, or moves `roomSeq` BACKWARD makes `open()` THROW — the daemon
 * refuses to start rather than silently skip real events. The old reader did
 * `JSON.parse(line) as JournalRecord` and advanced the cursor to whatever
 * `roomSeq` it found, so a single corrupt-but-parseable line with a high seq
 * would skip every event under it, invisibly. Fail-closed is the only safe
 * direction for a durable idempotency store: a daemon that cannot trust its
 * journal must stop, not guess.
 *
 * ## BOUNDED GROWTH BY CRASH-SAFE COMPACTION (#148 FIX 3)
 *
 * The log would otherwise grow without bound — every processed event appends a
 * line, and a quiet room's dominant event is a bare `advance`. `compact()`
 * writes the reduced idempotency state as ONE `snapshot` record into a fresh
 * temp file (header + snapshot), fsyncs it, atomically renames it over the live
 * file, and reopens — so a crash at any point leaves either the intact old file
 * or the intact new one, never a torn one. Replay of a compacted file folds the
 * snapshot through `reduce` (identical state by construction) and then any events
 * that arrived after it.
 */

export type RouteClass = 'draw' | 'steer' | 'answer' | 'ignore';

/** Every outcome kind, named once so the Zod enum and the TS `step` type cannot
 *  drift from the reducer's switch. */
const OUTCOME_KINDS = [
  'plan_requested',
  'draw_taken',
  'draw_refused',
  'funded_terminal',
  'session_opened',
  'steered',
  'answered',
  'ignored',
  'session_terminal',
  'plan_settled',
  'advance',
  'snapshot',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
const OutcomeKindEnum = z.enum(OUTCOME_KINDS);

// ── the serialized reduced state a `snapshot` record carries (FIX 3) ─────────
const SerializedCauseState = z.object({
  class: z.enum(['draw', 'steer', 'answer', 'ignore']),
  step: OutcomeKindEnum,
  planId: z.string().optional(),
  sessionId: z.string().optional(),
  clientMessageId: z.string().optional(),
  retried: z.boolean(),
});
const SerializedPlanState = z.object({
  cause: z.string(),
  sessions: z.array(z.string()),
  terminal: z.array(z.string()),
  settled: z.boolean(),
});
const SnapshotState = z.object({
  cursor: z.number().int().nonnegative(),
  causes: z.array(z.tuple([z.string(), SerializedCauseState])),
  plans: z.array(z.tuple([z.string(), SerializedPlanState])),
  sessions: z.array(z.tuple([z.string(), z.string()])),
});
type SnapshotState = z.infer<typeof SnapshotState>;

// ── the outcome union — the Zod IS the source of truth (FIX 2) ───────────────
const OutcomeSchema = z.discriminatedUnion('kind', [
  /** open_plan appended for this cause; the draw is not yet taken. The plan's id
   *  rides the plan_opened EVENT, not the ack, so it is recorded later. */
  z.object({ kind: z.literal('plan_requested'), cause: z.string() }),
  /** the draw's `open_session` was GRANTED. Terminal for the cause's routing; the
   *  sessionId is learned from the echoed session_opened event, not from here.
   *  `retry` marks a post-funding re-route. */
  z.object({
    kind: z.literal('draw_taken'),
    cause: z.string(),
    planId: z.string(),
    retry: z.boolean(),
  }),
  /** the draw was REFUSED for budget (unfunded/over-slice). Retryable ONCE after
   *  a later `plan_rlimit_set` funds the plan (#139 resolution 3). */
  z.object({
    kind: z.literal('draw_refused'),
    cause: z.string(),
    planId: z.string(),
    retry: z.boolean().optional(),
  }),
  /** the funded-arm claim refused a re-routed draw — the cause already funded an
   *  arm (#128/0047). Terminal: the refusal IS the idempotency. */
  z.object({
    kind: z.literal('funded_terminal'),
    cause: z.string(),
    planId: z.string(),
    retry: z.boolean().optional(),
  }),
  /** a session (this loop's) was observed opening under a plan — sessionId→plan. */
  z.object({
    kind: z.literal('session_opened'),
    cause: z.string(),
    sessionId: z.string(),
    planId: z.string(),
  }),
  /** a steer was mediated to a running session (at-least-once; journaled so a
   *  replay does not re-steer). */
  z.object({ kind: z.literal('steered'), cause: z.string(), sessionId: z.string() }),
  /** an answer was posted, carrying this deterministic `clientMessageId`. */
  z.object({ kind: z.literal('answered'), cause: z.string(), clientMessageId: z.string() }),
  /** the message was classified as nothing the loop acts on. */
  z.object({ kind: z.literal('ignored'), cause: z.string() }),
  /** a child session reached a terminal exit (settled/failed). */
  z.object({ kind: z.literal('session_terminal'), sessionId: z.string(), planId: z.string() }),
  /** the daemon issued settle_plan for a plan whose children are all terminal. */
  z.object({ kind: z.literal('plan_settled'), planId: z.string() }),
  /** a processed event that carried no routing action — advances the cursor. */
  z.object({ kind: z.literal('advance') }),
  /** a COMPACTION checkpoint: the whole reduced state, folded back through
   *  `reduce` on replay (#148 FIX 3). Never emitted by a conductor turn. */
  z.object({ kind: z.literal('snapshot'), state: SnapshotState }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const JournalRecordSchema = z.object({
  /** The inbound event's position. The cursor is the max of these. */
  roomSeq: z.number().int().nonnegative(),
  outcome: OutcomeSchema,
});
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

/** The header on line 1: the format version and the room this journal belongs to.
 *  A journal opened for a DIFFERENT room fails closed — cross-room reuse would
 *  fold another room's cursor/causes into this daemon's state. */
const JOURNAL_VERSION = 1 as const;
const JournalHeaderSchema = z.object({ v: z.literal(JOURNAL_VERSION), roomId: z.string().min(1) });
type JournalHeader = z.infer<typeof JournalHeaderSchema>;

export interface CauseState {
  class: RouteClass;
  step: OutcomeKind;
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
const TERMINAL_STEPS: ReadonlySet<OutcomeKind> = new Set<OutcomeKind>([
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

/** How many appended records trigger a compaction. A quiet room's log is almost
 *  all bare `advance`s; compaction collapses them into one `snapshot` line. */
const DEFAULT_COMPACT_EVERY = 1000;

export interface JournalOptions {
  /** Compact after this many appended records (default 1000). `0`/negative
   *  disables compaction. Tests set it small to witness a real compaction. */
  compactEvery?: number;
}

export class OutcomeJournal {
  private handle: FileHandle;
  private readonly path: string;
  private readonly roomId: string;
  private readonly compactEvery: number;
  private appendsSinceCompaction = 0;
  private _cursor = 0;
  /** The largest roomSeq seen while replaying — records must not move backward. */
  private replayHighWater = 0;
  readonly causes = new Map<string, CauseState>();
  readonly plans = new Map<string, PlanState>();
  readonly sessions = new Map<string, string>();

  private constructor(handle: FileHandle, path: string, roomId: string, compactEvery: number) {
    this.handle = handle;
    this.path = path;
    this.roomId = roomId;
    this.compactEvery = compactEvery;
  }

  /** The temp file compaction writes before its atomic rename. A fixed name so a
   *  crash mid-compaction leaves exactly one stale file `open()` can clean up. */
  private get compactingPath(): string {
    return `${this.path}.compacting`;
  }

  /**
   * Open (or create) the journal at `path` for `roomId` and replay it into memory.
   *
   * Fails CLOSED (throws) on a header for another room, an unparseable or unknown
   * record, or a record whose `roomSeq` moves backward — the daemon must refuse
   * to start rather than skip events it cannot account for (#148 FIX 2).
   */
  static async open(
    path: string,
    roomId: string,
    options: JournalOptions = {},
  ): Promise<OutcomeJournal> {
    await mkdir(dirname(path), { recursive: true });
    // A stale temp from a crash mid-compaction is discarded: the live file is the
    // authority, and compaction only replaces it after its own fsync+rename.
    await unlink(`${path}.compacting`).catch(() => undefined);

    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const compactEvery = options.compactEvery ?? DEFAULT_COMPACT_EVERY;
    const handle = await open(path, 'a');
    const journal = new OutcomeJournal(handle, path, roomId, compactEvery);

    const lines = existing.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      // A fresh (or empty) file: stamp the header before any record.
      await journal.writeLine(JSON.stringify(journal.header()));
    } else {
      journal.replay(lines);
    }
    return journal;
  }

  private header(): JournalHeader {
    return { v: JOURNAL_VERSION, roomId: this.roomId };
  }

  private replay(lines: string[]): void {
    const [headerLine, ...recordLines] = lines;
    const header = JournalHeaderSchema.parse(parseJson(headerLine as string, 'journal header'));
    if (header.roomId !== this.roomId) {
      throw new Error(
        `journal at "${this.path}" belongs to room "${header.roomId}", not "${this.roomId}" — ` +
          "refusing to start rather than fold another room's cursor into this one",
      );
    }
    for (const line of recordLines) {
      const record = JournalRecordSchema.parse(parseJson(line, 'journal record'));
      if (record.roomSeq < this.replayHighWater) {
        throw new Error(
          `journal at "${this.path}" has a non-monotonic record (roomSeq ${record.roomSeq} < ` +
            `${this.replayHighWater}) — refusing to start rather than replay a reordered log`,
        );
      }
      this.replayHighWater = record.roomSeq;
      this.reduce(record);
    }
  }

  get cursor(): number {
    return this._cursor;
  }

  /** Persist (fsync) then reduce. The order is the durability contract. */
  async record(record: JournalRecord): Promise<void> {
    await this.writeLine(JSON.stringify(record));
    this.reduce(record);
    this.appendsSinceCompaction += 1;
    if (this.compactEvery > 0 && this.appendsSinceCompaction >= this.compactEvery) {
      await this.compact();
    }
  }

  /** Append one line and fsync it before returning — every caller depends on the
   *  bytes being durable before the in-memory state that follows is visible. */
  private async writeLine(line: string): Promise<void> {
    await this.handle.write(`${line}\n`);
    await this.handle.sync();
  }

  /**
   * Rewrite the log as one `snapshot` record, atomically (#148 FIX 3).
   *
   * Write header + snapshot to a temp file, fsync it, close the live handle,
   * rename the temp over the live path (atomic on POSIX), fsync the directory so
   * the rename itself is durable, and reopen. A crash before the rename leaves the
   * intact old file; a crash after it leaves the intact, fully-fsynced new file.
   */
  private async compact(): Promise<void> {
    const snapshot: JournalRecord = {
      roomSeq: this._cursor,
      outcome: { kind: 'snapshot', state: this.serialize() },
    };
    const tmp = await open(this.compactingPath, 'w');
    try {
      await tmp.write(`${JSON.stringify(this.header())}\n`);
      await tmp.write(`${JSON.stringify(snapshot)}\n`);
      await tmp.sync();
    } finally {
      await tmp.close();
    }
    await this.handle.close();
    await rename(this.compactingPath, this.path);
    await this.syncDir();
    this.handle = await open(this.path, 'a');
    this.appendsSinceCompaction = 0;
  }

  private async syncDir(): Promise<void> {
    let dir: FileHandle | undefined;
    try {
      dir = await open(dirname(this.path), 'r');
      await dir.sync();
    } catch {
      // Some platforms refuse an fsync on a directory handle; the rename is still
      // ordered after the temp's own fsync, so this is best-effort durability.
    } finally {
      await dir?.close();
    }
  }

  private serialize(): SnapshotState {
    return {
      cursor: this._cursor,
      causes: [...this.causes.entries()].map(([cause, state]) => [
        cause,
        {
          class: state.class,
          step: state.step,
          ...(state.planId !== undefined ? { planId: state.planId } : {}),
          ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
          ...(state.clientMessageId !== undefined
            ? { clientMessageId: state.clientMessageId }
            : {}),
          retried: state.retried,
        },
      ]),
      plans: [...this.plans.entries()].map(([planId, plan]) => [
        planId,
        {
          cause: plan.cause,
          sessions: [...plan.sessions],
          terminal: [...plan.terminal],
          settled: plan.settled,
        },
      ]),
      sessions: [...this.sessions.entries()],
    };
  }

  private loadSnapshot(state: SnapshotState): void {
    this.causes.clear();
    this.plans.clear();
    this.sessions.clear();
    for (const [cause, s] of state.causes) {
      this.causes.set(cause, {
        class: s.class,
        step: s.step,
        planId: s.planId,
        sessionId: s.sessionId,
        clientMessageId: s.clientMessageId,
        retried: s.retried,
      });
    }
    for (const [planId, p] of state.plans) {
      this.plans.set(planId, {
        cause: p.cause,
        sessions: new Set(p.sessions),
        terminal: new Set(p.terminal),
        settled: p.settled,
      });
    }
    for (const [sessionId, planId] of state.sessions) this.sessions.set(sessionId, planId);
    this._cursor = state.cursor;
  }

  private reduce(record: JournalRecord): void {
    if (record.roomSeq > this._cursor) this._cursor = record.roomSeq;
    const outcome = record.outcome;
    switch (outcome.kind) {
      case 'snapshot':
        this.loadSnapshot(outcome.state);
        return;
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
    step: OutcomeKind,
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

/** JSON.parse with a fail-closed message that names WHICH line kind broke — a
 *  corrupt journal must stop the daemon with a legible reason, not a bare
 *  SyntaxError swallowed somewhere upstream. */
function parseJson(line: string, what: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`unparseable ${what}: ${(error as Error).message}`);
  }
}
