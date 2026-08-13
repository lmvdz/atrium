import type { CommandResult, CommandService } from '../commands.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';
import { createExecutionCoordinator, type ExecutionCoordinator } from './coordinator.js';
import { createScratchRepo, disposeScratchRepo, type ScratchRepo } from './git.js';
import type { ExecutionProvider } from './provider.js';
import { createSandboxProvider } from './sandbox.js';
import { createDeterministicShimProvider } from './shim.js';
import { createWorktreeCommandProvider } from './worktree-provider.js';

/**
 * The env → provider → coordinator wiring for the live server (#120).
 *
 * `EXECUTION_PROVIDER` unset returns `null`: execution is DISABLED and the
 * command service is handed back untouched, so a session opens and settles only
 * when something else settles it. Set, this builds the named provider, a
 * coordinator over it, and a COMMAND-SERVICE WRAPPER that fires the coordinator
 * on a granted `session_opened` — post-commit, fire-and-forget.
 *
 * ## The budget guard is upstream of the wrapper
 *
 * The wrapper fires the coordinator ONLY when `open_session` returned
 * `draw.outcome === 'granted'`. A `draw_refused` never satisfies that branch, so
 * a refused draw never reaches the provider here either — the same guard the
 * coordinator enforces for the direct-drive path, at the wiring layer.
 */
export interface ConfiguredExecution {
  provider: ExecutionProvider;
  coordinator: ExecutionCoordinator;
  /** The wrapped command service to hand to the realtime server. */
  commands: CommandService;
  /** Tear down anything the provider owns (the scratch repo). */
  dispose(): Promise<void>;
}

export async function configureExecution(input: {
  env: Env;
  commands: CommandService;
  logger: Logger;
}): Promise<ConfiguredExecution | null> {
  const { env, commands, logger } = input;
  if (env.EXECUTION_PROVIDER === undefined) return null;

  let repo: ScratchRepo | null = null;
  let provider: ExecutionProvider;

  switch (env.EXECUTION_PROVIDER) {
    case 'shim': {
      repo = await createScratchRepo(env.EXECUTION_SCRATCH_DIR);
      provider = createDeterministicShimProvider({ repo });
      break;
    }
    case 'worktree': {
      repo = await createScratchRepo(env.EXECUTION_SCRATCH_DIR);
      provider = createWorktreeCommandProvider({
        repo,
        command: parseArgv(env.EXECUTION_HARNESS_COMMAND ?? ''),
      });
      break;
    }
    case 'sandbox': {
      // The BUY seam. No client is wired here, so the provider refuses at
      // runtime — a loud failure on the first session, never a silent
      // fall-through to the server's own disk.
      provider = createSandboxProvider();
      logger.warn('execution provider is sandbox but no client is wired — sessions will fail', {});
      break;
    }
    default: {
      const exhaustive: never = env.EXECUTION_PROVIDER;
      throw new Error(`unknown execution provider ${JSON.stringify(exhaustive)}`);
    }
  }

  const coordinator = createExecutionCoordinator({ commands, provider, logger });
  logger.info('execution provider enabled', { provider: provider.kind });

  const wrapped: CommandService = {
    ...commands,
    execute: async (session: Session, command): Promise<CommandResult> => {
      const result = await commands.execute(session, command);
      if (
        command.name === 'open_session' &&
        result.kind === 'appended' &&
        result.draw?.outcome === 'granted'
      ) {
        // Post-commit, fire-and-forget: the session is already durably open, so
        // whether the adapter runs is not the opener's transaction to fail. A
        // refused draw never reaches this branch (the budget guard).
        const { sessionId } = result.draw;
        void coordinator
          .runGranted(session, {
            sessionId,
            roomId: command.roomId,
            planId: command.planId,
            harness: command.harness,
            model: command.model,
          })
          .catch((error: unknown) => {
            logger.error('execution run failed after granted session_opened', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return result;
    },
  };

  return {
    provider,
    coordinator,
    commands: wrapped,
    dispose: async () => {
      if (repo) await disposeScratchRepo(repo);
    },
  };
}

/**
 * Parse the harness command from JSON argv. Argv only — never a shell string, so
 * there is no `/bin/sh` to inject into. A non-array or empty value is a config
 * error (already gated at boot by `assertExecutionProviderSafe`).
 */
export function parseArgv(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `EXECUTION_HARNESS_COMMAND must be a JSON array of argv strings, got: ${raw.slice(0, 80)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string') || parsed.length === 0) {
    throw new Error('EXECUTION_HARNESS_COMMAND must be a non-empty JSON array of strings');
  }
  return parsed as string[];
}
