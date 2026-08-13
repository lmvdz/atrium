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
}

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
}
