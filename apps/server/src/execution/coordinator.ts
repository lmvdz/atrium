import type { Command, CommandResult } from '../commands.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';
import type { ExecutionArtifact, ExecutionProvider, SessionContext } from './provider.js';

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

export interface ExecutionCoordinatorOptions {
  commands: SessionCommandRunner;
  provider: ExecutionProvider;
  logger: Logger;
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
  const { commands, provider, logger } = options;

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
    });
    if (settle.kind !== 'appended') {
      throw new Error(
        `settling session ${granted.sessionId} as ${outcome} did not append (${settle.kind})`,
      );
    }
  }

  async function runGranted(session: Session, granted: GrantedSession): Promise<ExecutionOutcome> {
    const ctx: SessionContext = {
      sessionId: granted.sessionId,
      roomId: granted.roomId,
      planId: granted.planId,
      harness: granted.harness,
      model: granted.model,
    };

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
    let workspace: Awaited<ReturnType<ExecutionProvider['resolve']>> | null = null;
    let report: Awaited<ReturnType<ExecutionProvider['run']>>;
    try {
      workspace = await provider.resolve(ctx);
      report = await provider.run(workspace, ctx);
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
      await settleOrThrow(session, granted, outcome, report.receipt);
    } catch (error) {
      logger.error('settling an executed session threw — retrying as failed', {
        sessionId: granted.sessionId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      terminal = 'failed';
      try {
        await settleOrThrow(session, granted, 'failed', {
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
