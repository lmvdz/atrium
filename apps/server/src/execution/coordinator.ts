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

  async function runGranted(session: Session, granted: GrantedSession): Promise<ExecutionOutcome> {
    const ctx: SessionContext = {
      sessionId: granted.sessionId,
      roomId: granted.roomId,
      planId: granted.planId,
      harness: granted.harness,
      model: granted.model,
    };

    // RESOLVE → RUN → REPORT, disposing the ephemeral workspace no matter what.
    const workspace = await provider.resolve(ctx);
    let report: Awaited<ReturnType<ExecutionProvider['run']>>;
    try {
      report = await provider.run(workspace, ctx);
    } catch (error) {
      // The provider itself threw — the process could not even be observed. That
      // is a failure owed triage, not a settle. Report it, then settle failed
      // with no artifact.
      logger.error('execution provider threw during run', {
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
      await workspace.dispose().catch((error: unknown) => {
        logger.warn('execution workspace dispose failed', {
          sessionId: granted.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // The terminal chooses the exit spelling (§9.5); the receipt is carried into
    // the event either way. `settle_session` is `open`-class and non-epistemic —
    // it writes the session's exit receipt and touches no `accepted_objects`.
    const outcome = report.terminal.ok ? 'settled' : 'failed';
    const settle = await commands.execute(session, {
      name: 'settle_session',
      roomId: granted.roomId,
      sessionId: granted.sessionId,
      outcome,
      exitSummary: report.receipt.exitSummary,
      spendMicros: report.receipt.spendMicros,
      contextPct: report.receipt.contextPct,
      artifact: report.receipt.artifact,
    });
    if (settle.kind !== 'appended') {
      logger.error('settling an executed session did not append', {
        sessionId: granted.sessionId,
        result: settle.kind,
      });
    }

    return { kind: outcome, sessionId: granted.sessionId, artifact: report.receipt.artifact };
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
