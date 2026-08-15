import type { SessionDiff, SessionPhase, SessionTestResults } from '@atrium/db';

/**
 * The ExecutionProvider seam (#120, from its binding Resolution).
 *
 * A session is a PROCESS on a harness (Glance §9). Atrium does not run models
 * and holds no autonomous-agent runtime (init.md) — it OBSERVES an external
 * process through two reports and records the durable one in the ledger. This
 * interface is the whole of that seam, and it is deliberately three verbs:
 *
 *   1. RESOLVE an isolated workspace, keyed on the session id. A git worktree
 *      for the deterministic shim and the real worktree adapter; a real sandbox
 *      (E2B/Daytona/ComputeSDK) behind a flag — see `sandbox.ts`.
 *   2. RUN the harness in that workspace.
 *   3. REPORT (a) terminal/liveness and (b) a receipt — the settle/fail
 *      artifact. The workspace is EPHEMERAL ("checkout discardable, history
 *      durable"); the ledger is the durable record.
 *
 * What this seam may NOT do, and the covenant reason for each:
 *
 *  - It never lands or certifies. The verified artifact is a BRANCH/COMMIT the
 *    adapter produced in a scratch git the provider controls; the land is a
 *    human `✓` (the covenant), never the adapter. Nothing here writes an
 *    `accepted_objects` judgement — the provider touches git, never the DB.
 *  - It never authorizes its own draw. Whether a session may run at all is the
 *    budget's decision (#118), taken at `open_session` BEFORE this seam is ever
 *    reached; the coordinator (`coordinator.ts`) refuses to `resolve` a
 *    workspace for a draw the budget refused.
 *
 * The reported spend is a `~` fact (Glance §9.2, #118): enforcement stays on the
 * plan's authorized draws, never on what a session reports it spent.
 */

/**
 * What a provider is told about the session it runs — its id, its plan (the one
 * parent, #114's pstree edge) and the room that owns both. The budget context
 * is the plan+room the draw was authorized against; the provider does not
 * re-check it (that already happened), it only reports against it.
 */
export interface SessionContext {
  /** The session id — the key the workspace is isolated on. */
  readonly sessionId: string;
  /** The room that owns the plan and the session. */
  readonly roomId: string;
  /** The plan that is this session's one parent. */
  readonly planId: string;
  /** The harness process this session runs (a label the shim also reads). */
  readonly harness: string;
  /** The model it runs — a label; NO model abstraction lives inside Atrium. */
  readonly model: string;
  /**
   * THE LIVE-PROGRESS SEAM (#159, decided in #152). Present when the coordinator
   * wired it — the provider calls it during `run` to stream a running session's
   * phases, spend/context heartbeat and diff deltas. It funnels into the ONE
   * authority-guarded `report_session_progress` command (the coordinator holds the
   * session's token from `claim`), so the provider reports `~` progress and can
   * never certify. Best-effort and LOSSY by design: a rejected report (a <1s
   * heartbeat, a transient fault) never fails the run. Absent under a provider that
   * predates the seam or a caller that does not wire it.
   */
  readonly onProgress?: ProgressReporter;
}

/** One file's change in a live diff delta (#159) — `SessionDiffFile` fields, one hunk. */
export interface ProgressDiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly additions: number;
  readonly deletions: number;
  /** A single hunk (the delta stays ≤4KB); the snapshot carries the full coalesced diff. */
  readonly hunk?: { readonly header: string; readonly lines: readonly string[] };
}

/**
 * One live progress report (#159). Exactly one of the three is set per call — a
 * PHASE is durable (`session_phase_changed`), a HEARTBEAT / DIFF is ephemeral — the
 * same shape `report_session_progress` carries. The reporter (the coordinator's
 * wiring) enforces the single-door authorization; the provider only describes what
 * its run is doing.
 */
export interface ProgressReport {
  readonly phase?: SessionPhase;
  readonly heartbeat?: { readonly spendMicros: number | null; readonly contextPct: number | null };
  readonly diffDelta?: {
    readonly truncated?: boolean;
    readonly files: readonly ProgressDiffFile[];
  };
}

/** The seam the coordinator wires and the provider calls to stream progress (#159). */
export type ProgressReporter = (report: ProgressReport) => Promise<void>;

/**
 * The verified artifact a run produces: a branch and the commit it points at, in
 * the scratch git remote the provider controls. This is the "green gate / merged
 * branch the adapter produced" the destination scenario proves — except it is
 * NEVER merged. It sits on its own branch until a human lands it.
 */
export interface ExecutionArtifact {
  /** The branch the adapter pushed the work onto. Never `main`; never merged. */
  readonly branch: string;
  /** The commit the branch points at — the durable, verifiable object. */
  readonly commit: string;
  /** The scratch remote/repo the branch lives in (a path the provider controls). */
  readonly remote: string;
  /**
   * The REAL structured diff the producer computed (#145) — per-file hunks of the
   * scratch worktree against the seeded upstream ref. PRESENT means it reported a
   * diff (an empty `files` is an honest "no changes"); absent means it reported
   * none. A `~` fact the adapter reports, never verified beyond the branch/commit
   * it rides with (the same producer that made the verified commit reported it).
   */
  readonly diff?: SessionDiff;
  /**
   * The harness's own test report (#145). PRESENT means a run was reported (0/0 is
   * honest); absent means none. A `~` fact, like the diff beside it.
   */
  readonly tests?: SessionTestResults;
}

/**
 * The process report Atrium observes: liveness/exit. `ok` is the single bit the
 * coordinator branches a `session_settled` from a `session_failed` on — a clean
 * exit versus one owed triage (§9.5).
 */
export interface Terminal {
  /** A clean exit (settle) versus a failure owed attention (fail). */
  readonly ok: boolean;
  /** The harness process exit code, when there was a real process. */
  readonly exitCode: number | null;
  /** A short, human-facing reason a run failed — surfaced in the exit receipt. */
  readonly detail?: string;
}

/**
 * The receipt half of the report — the settle/fail artifact. `artifact` is
 * present on a run that produced a branch/commit, and `null` on a failure that
 * produced no verifiable object. `spendMicros`/`contextPct` are the reported
 * `~` facts (§9.2), carried into the exit event but never enforced on.
 */
export interface ExecutionReceipt {
  /** The exit-receipt prose (§9.5). */
  readonly exitSummary: string;
  /** Reported spend, micro-dollars — a `~` fact, not an enforcement variable. */
  readonly spendMicros: number | null;
  /** Reported context-window fill, 0..1 — the session's own, never aggregated. */
  readonly contextPct: number | null;
  /** The verified artifact, or `null` when the run produced none. */
  readonly artifact: ExecutionArtifact | null;
}

/** Terminal + receipt: everything Atrium observes about one run. */
export interface ExecutionReport {
  readonly terminal: Terminal;
  readonly receipt: ExecutionReceipt;
}

/**
 * An isolated workspace resolved for one session. `dir` is the checkout the
 * harness runs in; `dispose` reclaims it. The checkout is discardable — anything
 * that must survive it is on the branch by the time `run` returns.
 */
export interface Workspace {
  readonly sessionId: string;
  /** Absolute path to the isolated checkout. */
  readonly dir: string;
  /** The branch this workspace commits onto — the artifact's ref-to-be. */
  readonly branch: string;
  /** The scratch remote/repo the branch belongs to. */
  readonly remote: string;
  /** Reclaim the ephemeral checkout. The branch it produced is NOT removed. */
  dispose(): Promise<void>;
}

/**
 * AN ALREADY-AUTHORIZED SIGNAL, HANDED TO THE RUNNING HARNESS (#147).
 *
 * #127 built `session_signaled {steer|interrupt|resume}` as ledger events with
 * FULL enforcement at append (open-session-only, interrupt-authz by agent/owner,
 * resume-as-a-draw). This seam CONSUMES one of those already-durable rows and
 * delivers it to the process — it does NOT re-authorize, re-check identity, spend,
 * certify, or land. The row's authority was settled at append; delivery only
 * makes an already-legal signal REACH the harness it was appended into.
 *
 *  - `sessionId`/`roomId` — the running session this signal targets.
 *  - `kind` — `steer` (guidance, queued to the NEXT turn boundary, never
 *    mid-token), `interrupt` (terminate the running process promptly), or
 *    `resume` (a continuation DRAW — see `deliver`'s resume note; the provider
 *    does NOT wake a run here, that is the daemon's concern, #124/#128).
 *  - `body` — the steer's words / the interrupt's reason, exactly as the ledger
 *    row carries it.
 *  - `signalId` — the `session_signaled` event's id (#147 FIX 5). It is the
 *    DEDUP KEY for the daemon's future at-least-once dispatch (#139): if a signal
 *    is delivered twice (a retry, a redelivery after a crash), a provider that has
 *    already seen this id ignores the second — a steer queues once, an interrupt
 *    latches once. Optional because an in-process caller/test may deliver a signal
 *    that carries no durable event id; absent, no dedup is possible and every
 *    delivery is treated as distinct (the pre-#139 behaviour).
 */
export interface SignalDelivery {
  readonly sessionId: string;
  readonly roomId: string;
  readonly kind: 'steer' | 'interrupt' | 'resume';
  readonly body: string | null;
  readonly signalId?: string;
}

/**
 * The cap on a single session's pending-steer queue (#147 FIX 5). A steer queue is
 * a PRODUCER-only structure from Atrium's side — the provider appends, the harness
 * drains at its own pace (and a foreign worktree harness may never drain at all) —
 * so without a bound a signal flood grows an unbounded in-memory array (shim) or an
 * unbounded inbox file (worktree). At the cap a further steer is DROPPED and its
 * delivery returns `ignored: queue-full`: an honest refusal a caller can see, not a
 * silent leak. The cap is deliberately generous — a real turn consumes its steers
 * long before this — so it bites only a pathological flood, never ordinary use.
 */
export const MAX_QUEUED_STEERS = 64;

/**
 * The cap on a single session's dedup memory (#147 completing round, FIX C part 2).
 *
 * `deliver` records every APPLIED signal id in a per-session `seen` set so #139's
 * at-least-once dispatch is idempotent (a redelivered id is `duplicate`). Left
 * unbounded, a long-lived session that drains its steer queue and accepts fresh
 * steers turn after turn grows `seen` without limit — a slow leak keyed by uptime,
 * not by anything the covenant bounds. So `seen` is an LRU of the last
 * `MAX_SEEN_SIGNALS` applied ids: recording a new one past the cap EVICTS the
 * oldest. The cap is far larger than a burst of at-least-once retries, so dedup
 * still catches every realistic redelivery; only an id older than the last N
 * applied signals can slip through, and by then the dispatcher has long stopped
 * retrying it. `rememberAppliedSignal` is the one writer, so the bound holds on
 * every path.
 */
export const MAX_SEEN_SIGNALS = 1024;

/**
 * A per-session delivery SERIALIZER (#147 completing round — the structural fix).
 *
 * Every residual delivery defect the re-gauntlet executed is a check-then-act race:
 * a `deliver` reads state (the steer count, the `seen` set, the interrupt latch),
 * awaits (an `appendFile`), then mutates — and a concurrent `deliver` for the SAME
 * session interleaves between the read and the mutate. The per-race patch is a
 * treadmill; the structural answer is to make each session's deliveries ATOMIC with
 * respect to one another. This is a per-session async mutex: `deliver` chains its
 * critical section onto the tail of the session's queue, so delivery N runs to
 * completion — read, await, mutate — before delivery N+1 begins.
 *
 * The stored tail is a SETTLED continuation (never rejects), so one failed delivery
 * never poisons the chain for the next; the caller still receives the real
 * result/rejection of ITS own critical section.
 */
export interface DeliveryQueue {
  tail: Promise<unknown>;
}

/** A fresh, idle delivery queue (nothing in flight). */
export function newDeliveryQueue(): DeliveryQueue {
  return { tail: Promise.resolve() };
}

/**
 * Run `task` once every previously-queued delivery for this session has settled,
 * and advance the queue so the NEXT delivery waits on this one. Serializes the
 * whole check-then-await-then-mutate body, closing the concurrent-delivery races
 * (cap bypass, double-latch, seen/queue-full interleave) as a class.
 */
export function serializeDelivery<T>(queue: DeliveryQueue, task: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(task, task);
  queue.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Record an APPLIED signal id for dedup, bounded to the last `MAX_SEEN_SIGNALS`
 * (#147 completing round, FIX C part 2). Only call this AFTER the signal was
 * actually applied — a queue-full or otherwise-dropped signal must NOT be
 * remembered as `seen`, or a legitimate retry (once the queue drains) reads as a
 * `duplicate` and is silently lost (FIX C part 1). A `Set` iterates in insertion
 * order, so the first entry is the oldest; evicting it past the cap is a plain LRU.
 */
export function rememberAppliedSignal(seen: Set<string>, signalId: string | undefined): void {
  if (signalId === undefined) return;
  seen.add(signalId);
  while (seen.size > MAX_SEEN_SIGNALS) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * What delivery did — an OBSERVATION, never a ledger act.
 *
 *  - `delivered` — a steer was queued for the session's next turn boundary.
 *  - `interrupted` — the running process was terminated (the whole process GROUP,
 *    so grandchildren die too — BEST-EFFORT: a `setsid()` escape survives, and
 *    escape-proof termination is the #138 sandbox, see `deliver`); the ordinary
 *    run/settle path writes the terminal `session_failed` receipt, delivery writes
 *    nothing.
 *  - `ignored` — nothing was delivered. `not-running`: this provider has no
 *    in-flight execution for the session (another coordinator may run it; the row
 *    is already durable, so this is a SAFE no-op, never a crash). `resume-noop`: a
 *    resume is a draw the daemon acts on by OPENING a fresh run, not a delivery
 *    into an execution already in flight (see `deliver`). `duplicate`: this exact
 *    `signalId` was already delivered to this session (#147 FIX 5) — the dedup
 *    that makes #139's at-least-once dispatch idempotent; nothing was queued or
 *    latched a second time. `queue-full`: the session's steer queue is at its cap
 *    and this steer was DROPPED rather than queued (#147 FIX 5) — an honest refusal,
 *    not a silent unbounded append.
 */
export type DeliveryOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'interrupted' }
  | {
      readonly kind: 'ignored';
      readonly reason: 'not-running' | 'resume-noop' | 'duplicate' | 'queue-full';
    };

/**
 * The seam. One provider per deployment; the deterministic shim is the DEFAULT
 * under test, a real worktree adapter is one real implementation, and a sandbox
 * is a third behind a flag. `kind` names which, for the log and the receipt.
 */
export interface ExecutionProvider {
  /** `'shim' | 'worktree' | 'sandbox'` — which implementation this is. */
  readonly kind: string;
  /** RESOLVE an isolated workspace for this session. */
  resolve(ctx: SessionContext): Promise<Workspace>;
  /** RUN the harness in the workspace and REPORT terminal + receipt. */
  run(workspace: Workspace, ctx: SessionContext): Promise<ExecutionReport>;
  /**
   * CANCEL every in-flight execution this provider is running (#120 round-7 F4).
   *
   * The seam runs a process Atrium does not own — a spawned child on the server's
   * disk (worktree), or a remote sandbox (BUY). Nothing in `resolve`/`run` gives
   * shutdown a way to STOP one: on `SIGTERM` the process expired its drain grace,
   * deleted scratch, closed the DB and `process.exit`'d WITHOUT killing the child
   * or signalling the sandbox — so a harness kept executing after Atrium abandoned
   * the session, an orphaned process spending against a plan whose room is gone.
   *
   * `cancelAll` is the missing verb: it terminates whatever this provider still
   * has running — the LOCAL child's whole process GROUP (so grandchildren a
   * `bash -lc` spawned die too, not just the direct child), the REMOTE sandbox by
   * its stop/destroy call. It is idempotent and never throws: called once from the
   * shutdown path AFTER the drain grace and BEFORE scratch is deleted, it is the
   * last chance to not leave a process running loose. A provider with nothing
   * spawned (the shim's in-process routine, the unconfigured sandbox stub)
   * implements it as a no-op — the point is that the seam MUST answer the
   * question, not that every implementation has something to kill.
   */
  cancelAll(): Promise<void>;
  /**
   * DELIVER an already-authorized signal to a RUNNING execution (#147).
   *
   * The coordinator subscribes to `session_signaled` rows and routes them here
   * (`coordinator.ts`). This is the one verb that reaches INTO a live run — the
   * counterpart to `cancelAll`'s shutdown-wide kill, but targeted at one session
   * and one signal:
   *
   *  - `steer` → QUEUE the guidance for the session's next TURN BOUNDARY. WHERE
   *    the boundary is enforced differs by provider, and the seam does not pretend
   *    otherwise (#147 FIX 4):
   *      • the SHIM enforces the boundary itself — it is a deterministic in-process
   *        harness that drains its mailbox at a boundary it controls, so "never
   *        mid-token" is a provider guarantee there;
   *      • the WORKTREE cannot force a foreign process. It DELIVERS the steer to an
   *        inbox file and a cooperating harness reads it at ITS own next boundary.
   *        The provider guarantees the steer is queued (not mid-token on Atrium's
   *        side); it CANNOT guarantee when — or whether — a foreign harness reads
   *        it. That is cooperative delivery, not an enforced boundary.
   *    Returns `delivered`. A steer beyond the queue cap is dropped and returns
   *    `ignored: queue-full` (#147 FIX 5); a redelivered `signalId` returns
   *    `ignored: duplicate`.
   *  - `interrupt` → TERMINATE the running process PROMPTLY, killing the whole
   *    process GROUP (`worktree` reuses the `cancelAll` group-kill, so a `bash -lc`
   *    and the grandchildren it did NOT detach die too). This is BEST-EFFORT, not
   *    an absolute no-orphan guarantee (#147 FIX 1, the #141 lesson): a process
   *    GROUP cannot contain a harness that `setsid()`s a grandchild into its own new
   *    group — that grandchild escapes the `-pid` signal and survives. Full,
   *    escape-proof termination needs cgroup/container containment, which is the
   *    #138 sandbox provider, not a process group. The worktree interrupt stops a
   *    cooperating / non-escaping harness's whole tree; it does not claim to stop
   *    one that deliberately breaks out. The run's ordinary terminal/settle path
   *    then writes `session_failed`. Delivery itself writes NOTHING to the ledger —
   *    an interrupt cannot land or certify. Returns `interrupted`.
   *  - `resume` → a continuation DRAW (#127), which the daemon (#124/#128) acts on
   *    by OPENING a fresh run from the matched event, NOT by mutating an execution
   *    already in flight. So the provider does not "wake" a run here — a session
   *    that is currently running is not one waiting to be woken, and re-running it
   *    would duplicate authorized-but-unspent work. Returns `ignored: resume-noop`.
   *
   * SINGLE-COORDINATOR DELIVERY (#147 FIX 6): a signal is delivered LIVE by the
   * coordinator that is running the session — the one whose provider holds the
   * in-flight record. Routing a signal for session A (run by coordinator A) to a
   * different coordinator B is a MULTI-COORDINATOR concern (#139): B correctly
   * reports `not-running`, but nothing here forwards the durable row to A. The
   * dogfood is single-coordinator, so live delivery by the running coordinator is
   * the whole of what this seam does; cross-coordinator routing is not built.
   *
   * COVENANT: delivery consumes an already-enforced row and NEVER exceeds its
   * authorization. It does not re-check identity (that happened at append, #127),
   * spends nothing (a steer touches no draw), and certifies nothing (an interrupt
   * only kills; the receipt is the ordinary settle). A signal for a session this
   * provider is not running is `ignored: not-running` — a safe no-op, because
   * another coordinator may be running it and the row is already durable.
   */
  deliver(delivery: SignalDelivery): Promise<DeliveryOutcome>;
}
