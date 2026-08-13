import { z } from 'zod';
import type { Command, CommandResult } from '../commands.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';
import type {
  ExecutionArtifact,
  ExecutionProvider,
  ExecutionReport,
  SessionContext,
} from './provider.js';

/**
 * THE PROVIDER REPORT, VALIDATED AT RUNTIME (#120 round-6 F7).
 *
 * `ExecutionProvider.run` returns an `ExecutionReport` — a TS interface with NO
 * runtime guarantee. A provider that returns `undefined`, or a malformed object,
 * used to sail past the coordinator until `report.terminal.ok` was read OUTSIDE
 * the failure boundary, where a `TypeError` escaped `runGranted` into the
 * fire-and-forget catch and left the granted session `open` with its draw spent.
 * This schema is parsed INSIDE the boundary, so a missing or malformed report
 * throws where the catch turns it into a synthesized failed receipt instead.
 */
const ReportSchema = z.object({
  terminal: z.object({
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    detail: z.string().optional(),
  }),
  receipt: z.object({
    exitSummary: z.string(),
    spendMicros: z.number().nullable(),
    contextPct: z.number().nullable(),
    artifact: z
      .object({
        branch: z.string(),
        commit: z.string(),
        remote: z.string(),
      })
      .nullable(),
  }),
});

/**
 * The coordinator (#120) — the wiring between a session's lifecycle and the
 * ExecutionProvider seam. It is where the two covenant/budget refusals the
 * ticket names actually LIVE:
 *
 *  1. **Budget (#118).** A session runs only if its `open_session` draw was
 *     GRANTED. A `draw_refused` NEVER reaches the provider — no workspace is
 *     resolved, no harness runs, no artifact is produced. The whole point of a
 *     refusal is that the draw did not happen, so neither does the execution.
 *     This is the single revertible guard the acceptance test reds on.
 *  2. **Covenant.** The coordinator's ENTIRE command vocabulary is
 *     `open_session` and `settle_session` — both `open`-class, non-epistemic
 *     (#114 T3). It has no `accept_proposal`, no `answer_*`, no `correct`: there
 *     is no verb here that can flip a `~` to a `✓`. The artifact is a branch a
 *     human lands, never one the adapter certifies.
 *
 * It does NOT drive an agent's channel loop (that is a later lane) — the adapter
 * is driven directly: open, run, settle.
 */

/** The narrow slice of the command service the coordinator needs. */
export interface SessionCommandRunner {
  execute(session: Session, command: Command): Promise<CommandResult>;
}

/**
 * The session's STORED execution context, returned by a successful `claim` (#120
 * round-6 F5). The coordinator builds its `SessionContext` from THIS — the values
 * the `session_opened` projection wrote to the row — never from the caller's
 * `GrantedSession` payload, so caller-supplied plan/harness/model can no longer
 * override what the session actually is. `authority` is the capability token the
 * settle must present to write this provider session's terminal.
 */
export interface ClaimedSession {
  readonly planId: string;
  readonly harness: string;
  readonly model: string;
  readonly authority: string;
}

/**
 * THE EXECUTION-OWNERSHIP CLAIM (#120 round-5 F1/F4, consolidated round-6 F5).
 *
 * `claim` is a single guarded UPDATE that transitions a granted provider session
 * `unclaimed → running` EXACTLY ONCE and returns its stored context. It matches a
 * session only if it exists, records an opener (`opened_by_event_id IS NOT NULL` —
 * a `session_opened` a GRANTED draw produced), is still `open`, is `provider`-mode
 * and owned by THIS instance, and is not already claimed
 * (`execution_claimed_at IS NULL`). On a match it stamps `execution_claimed_at`
 * and a fresh heartbeat and RETURNS the row's `plan_id/harness/model` and
 * capability token; a never-granted id, an already-claimed session, or one this
 * instance does not own matches zero rows and returns `null`, so the coordinator
 * refuses to resolve a workspace or run a harness for it.
 *
 * REQUIRED on the coordinator (#120 round-6 F4). Round 5 made it optional and a
 * coordinator built without it silently ran with NO granted-draw guard; the guard
 * can no longer be omitted into silence. Tests pass an in-memory fake, never
 * nothing.
 */
export interface ExecutionOwnership {
  claim(input: { sessionId: string; roomId: string }): Promise<ClaimedSession | null>;
}

export interface ExecutionCoordinatorOptions {
  commands: SessionCommandRunner;
  provider: ExecutionProvider;
  logger: Logger;
  /** The granted-draw guard + ownership claim (#120 round-6). MANDATORY — no bypass. */
  ownership: ExecutionOwnership;
}

/** What the coordinator is asked to open and run. */
export interface OpenSessionInput {
  readonly roomId: string;
  readonly planId: string;
  readonly harness: string;
  readonly model: string;
}

/** A session that was granted a draw and is ready to run. */
export interface GrantedSession {
  readonly sessionId: string;
  readonly roomId: string;
  readonly planId: string;
  readonly harness: string;
  readonly model: string;
}

/** The outcome of trying to open-and-run, or of running a granted session. */
export type ExecutionOutcome =
  | {
      readonly kind: 'refused';
      readonly reason: 'budget';
      readonly slice: number;
      readonly authorizedDraws: number;
    }
  | {
      readonly kind: 'settled';
      readonly sessionId: string;
      readonly artifact: ExecutionArtifact | null;
    }
  | {
      readonly kind: 'failed';
      readonly sessionId: string;
      readonly artifact: ExecutionArtifact | null;
    };

export interface ExecutionCoordinator {
  /**
   * Open a session and, IF the budget granted the draw, run it through the
   * provider and settle it. A refused draw returns `{ kind: 'refused' }` WITHOUT
   * ever touching the provider — the guard the acceptance test reds on.
   */
  openAndRun(session: Session, input: OpenSessionInput): Promise<ExecutionOutcome>;
  /**
   * Run an ALREADY-GRANTED session through the provider and settle it. This is
   * the entry point the live server wires to a granted `session_opened` — the
   * open already happened and was granted, so there is no draw to re-check here.
   */
  runGranted(session: Session, granted: GrantedSession): Promise<ExecutionOutcome>;
}

export function createExecutionCoordinator(
  options: ExecutionCoordinatorOptions,
): ExecutionCoordinator {
  const { commands, provider, logger, ownership } = options;

  /**
   * Append one `settle_session`, and THROW if it did not land. Both spellings of
   * "no receipt was written" — a thrown `CommandError` and an append that came
   * back as something other than `appended` — become the same thrown failure, so
   * the caller's terminal-state guarantee cannot be satisfied by a result nobody
   * checked. (Before round 3 the non-`appended` case was logged and then reported
   * as the session's outcome anyway.)
   */
  async function settleOrThrow(
    session: Session,
    granted: GrantedSession,
    authority: string,
    outcome: 'settled' | 'failed',
    receipt: {
      exitSummary: string | null;
      spendMicros: number | null;
      contextPct: number | null;
      artifact: ExecutionArtifact | null;
    },
  ): Promise<void> {
    const settle = await commands.execute(session, {
      name: 'settle_session',
      roomId: granted.roomId,
      sessionId: granted.sessionId,
      outcome,
      exitSummary: receipt.exitSummary,
      spendMicros: receipt.spendMicros,
      contextPct: receipt.contextPct,
      artifact: receipt.artifact,
      // The capability the settle handler checks for a provider session (#120
      // round-6). Obtained from `claim` — the coordinator is the only in-process
      // holder — so this settle is honored where a room member's manual one is
      // refused.
      authority,
    });
    if (settle.kind !== 'appended') {
      throw new Error(
        `settling session ${granted.sessionId} as ${outcome} did not append (${settle.kind})`,
      );
    }
  }

  async function runGranted(session: Session, granted: GrantedSession): Promise<ExecutionOutcome> {
    // ── THE ONCE-ONLY CLAIM IS THE GRANTED-DRAW GUARD (#120 round-6 F1/F4/F5) ──
    //
    // `runGranted` is wire-reachable — `wireExecutionCoordinator`'s command wrapper
    // calls it directly on a granted `session_opened`. Its `GrantedSession`
    // argument is just DATA. The claim is what proves this is a real, unclaimed,
    // this-instance-owned provider session and, in the SAME guarded UPDATE, both
    // transitions it `unclaimed → running` exactly once and returns its STORED
    // context. So a fabricated/never-granted id, an already-claimed (re-entrant)
    // run, or a session another instance owns all return `null` here and the
    // provider is never reached. `ownership` is MANDATORY (F4) — there is no
    // no-guard path to fall through. Revert the claim guard and a fabricated
    // session id resolves and runs.
    const claimed = await ownership.claim({
      sessionId: granted.sessionId,
      roomId: granted.roomId,
    });
    if (!claimed) {
      logger.error('refusing to run a session without a committed, unclaimed granted draw', {
        sessionId: granted.sessionId,
        roomId: granted.roomId,
        provider: provider.kind,
      });
      // Nothing was resolved, run, or settled — there is no runnable granted
      // session here to write a receipt for. Report failed so the caller sees the
      // run did not happen, without fabricating an exit for a session that was
      // never this coordinator's to run.
      return { kind: 'failed', sessionId: granted.sessionId, artifact: null };
    }

    // THE CONTEXT IS THE STORED CONTEXT (#120 round-6 F5). plan/harness/model come
    // from the row the claim returned, never from the caller's `granted` payload —
    // only `sessionId`/`roomId` (the keys the claim matched on) are taken from it.
    const ctx: SessionContext = {
      sessionId: granted.sessionId,
      roomId: granted.roomId,
      planId: claimed.planId,
      harness: claimed.harness,
      model: claimed.model,
    };
    const authority = claimed.authority;

    // RESOLVE → RUN → REPORT, disposing the ephemeral workspace no matter what.
    //
    // `resolve` is INSIDE the try (#120 F5). A resolve-throw — an unwired
    // sandbox, a colliding ref, a wedged scratch repo — is just as much a
    // failure owed triage as a run-throw: if it escaped, the granted session
    // would be left `open` forever, its draw spent, with no receipt and an
    // orphaned temp dir. Catching it here settles `session_failed` (artifact
    // null) and disposes whatever workspace resolve managed to create. Revert
    // this — hoist `resolve` back above the try — and a resolve-throw orphans the
    // session (the F5 red-on-revert guard in coordinator.test.ts).
    //
    // The report is PARSED inside this boundary too (#120 round-6 F7): a provider
    // that returns `undefined` or a malformed report throws here and is caught,
    // synthesizing a failed receipt — never escaping to leave the session open.
    let workspace: Awaited<ReturnType<ExecutionProvider['resolve']>> | null = null;
    let report: ExecutionReport;
    try {
      workspace = await provider.resolve(ctx);
      report = ReportSchema.parse(await provider.run(workspace, ctx)) as ExecutionReport;
    } catch (error) {
      // The provider threw before a clean terminal could be observed. That is a
      // failure owed triage, not a settle. Report it, then settle failed with no
      // artifact.
      logger.error('execution provider threw during resolve/run', {
        sessionId: granted.sessionId,
        provider: provider.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      report = {
        terminal: { ok: false, exitCode: null, detail: 'provider error' },
        receipt: {
          exitSummary: `execution provider (${provider.kind}) errored`,
          spendMicros: null,
          contextPct: null,
          artifact: null,
        },
      };
    } finally {
      // Dispose only what resolve actually produced — a resolve-throw may leave
      // no workspace to reclaim (its own cleanup handled the partial).
      if (workspace) {
        await workspace.dispose().catch((error: unknown) => {
          logger.warn('execution workspace dispose failed', {
            sessionId: granted.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    // The terminal chooses the exit spelling (§9.5); the receipt is carried into
    // the event either way. `settle_session` is `open`-class and non-epistemic —
    // it writes the session's exit receipt and touches no `accepted_objects`.
    const outcome = report.terminal.ok ? 'settled' : 'failed';

    // ── THE SETTLE IS INSIDE THE FAILURE BOUNDARY (#120 round-3 F2) ───────────
    //
    // It used to be outside it, and that was the whole defect. `resolve`/`run`
    // were wrapped so a provider throw became `session_failed`; the settle that
    // WRITES that receipt was not. So any settle fault — lost membership, a
    // projection refusing an already-exited session, a ledger fault — threw out
    // of `runGranted`, into the fire-and-forget `.catch` in
    // `wireExecutionCoordinator`, which only logs. The `authorized_draws`
    // increment had already committed at `open_session`. Net: a SPENT draw, a
    // session stuck `open` forever, and no receipt anywhere — the exact
    // wedged-and-billed state F5 was written to make impossible, reachable
    // through the one call F5 did not cover.
    //
    // A session that was granted a draw reaches a TERMINAL state. That is the
    // invariant, and it does not care which call failed. So: try the settle the
    // run earned; if that throws, fall back to settling FAILED with no artifact
    // and a receipt naming the settle fault. Only if the fallback ALSO throws is
    // the session left for startup reconciliation (`index.ts`), which is the
    // backstop for the case where the database itself is unreachable — there is
    // no in-process move left that could write a receipt then.
    //
    // Revert this — hoist the settle back out of the try — and
    // `coordinator.test.ts`'s "a settle fault still drives the session terminal"
    // reds immediately.
    let terminal: 'settled' | 'failed' = outcome;
    try {
      await settleOrThrow(session, granted, authority, outcome, report.receipt);
    } catch (error) {
      logger.error('settling an executed session threw — retrying as failed', {
        sessionId: granted.sessionId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      terminal = 'failed';
      try {
        await settleOrThrow(session, granted, authority, 'failed', {
          exitSummary:
            `execution completed (${outcome}) but the settle failed: ` +
            (error instanceof Error ? error.message : String(error)).slice(0, 500),
          spendMicros: report.receipt.spendMicros,
          contextPct: report.receipt.contextPct,
          // No artifact on a fallback settle. The run's artifact may well be
          // real, but the settle that would have carried it did not land, and a
          // receipt asserting a tuple whose write path just faulted is a claim
          // this seam has not earned. The branch is still in the durable repo.
          artifact: null,
        });
      } catch (fallbackError) {
        // Nothing in-process can write a receipt now. Say so loudly and leave it
        // to startup reconciliation rather than returning as if it settled.
        logger.error(
          'session could not be driven to a terminal state — left for startup reconciliation',
          {
            sessionId: granted.sessionId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
        );
      }
    }

    return {
      kind: terminal,
      sessionId: granted.sessionId,
      artifact: terminal === outcome ? report.receipt.artifact : null,
    };
  }

  async function openAndRun(session: Session, input: OpenSessionInput): Promise<ExecutionOutcome> {
    const opened = await commands.execute(session, {
      name: 'open_session',
      roomId: input.roomId,
      planId: input.planId,
      harness: input.harness,
      model: input.model,
    });

    // ── THE BUDGET GUARD (#118) ──────────────────────────────────────────────
    //
    // A session runs ONLY on a granted draw. A `draw_refused` and a granted
    // `session_opened` both ack with empty issues, so the append shape alone
    // cannot tell them apart — `draw.outcome` is the only honest signal, and
    // this is the one place that reads it before reaching the provider. Revert
    // this branch (proceed as if always granted) and a refused draw resolves a
    // workspace and runs a harness Atrium never authorized — the exact
    // unauthorized-execution the acceptance test reds on.
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') {
      const refusal =
        opened.kind === 'appended' && opened.draw?.outcome === 'refused'
          ? opened.draw
          : { slice: 0, authorizedDraws: 0 };
      logger.info('execution refused: draw not granted', {
        roomId: input.roomId,
        planId: input.planId,
        slice: refusal.slice,
        authorizedDraws: refusal.authorizedDraws,
      });
      return {
        kind: 'refused',
        reason: 'budget',
        slice: refusal.slice,
        authorizedDraws: refusal.authorizedDraws,
      };
    }

    return runGranted(session, {
      sessionId: opened.draw.sessionId,
      roomId: input.roomId,
      planId: input.planId,
      harness: input.harness,
      model: input.model,
    });
  }

  return { openAndRun, runGranted };
}
