import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addWorktree,
  commitWorktree,
  removeWorktree,
  type ScratchRepo,
  type WorktreeCheckout,
} from './git.js';
import type { ExecutionProvider, ExecutionReport, SessionContext, Workspace } from './provider.js';

const run = promisify(execFile);

/**
 * The one REAL worktree adapter (#120) — runs a REAL command in an isolated git
 * worktree and reports its real terminal.
 *
 * This is the difference between the shim and a real harness, held to the same
 * seam: the shim's "harness" is a fixed in-process routine, this one SPAWNS a
 * configured command in the workspace and reads its actual exit code. Whatever
 * the command leaves in the tree is committed onto the session branch and
 * becomes the artifact — a genuinely external, observed process, exactly what
 * the ticket refuses to replace with a model gateway.
 *
 * It shares every git operation with the shim (`git.ts`); the sandbox seam
 * (`sandbox.ts`) is the third implementation, behind a flag. The command is
 * argv, never a shell string — the workspace path is the only thing the process
 * is pointed at.
 */

export interface WorktreeCommandOptions {
  /** The scratch repo the artifact branches land in. */
  repo: ScratchRepo;
  /**
   * The harness command as argv: `['bash', '-lc', '…']` or `['npm', 'test']`.
   * Run with the worktree as its cwd. A non-zero exit is a failed terminal.
   */
  command: readonly string[];
  /** How long the command may run before it is killed and the run fails. */
  timeoutMs?: number;
}

interface WorktreeWorkspace extends Workspace {
  readonly checkout: WorktreeCheckout;
}

export function createWorktreeCommandProvider(options: WorktreeCommandOptions): ExecutionProvider {
  const { repo, command, timeoutMs = 10 * 60_000 } = options;
  if (command.length === 0) {
    throw new Error('worktree provider requires a non-empty command argv');
  }
  const [bin, ...args] = command;

  return {
    kind: 'worktree',

    async resolve(ctx: SessionContext): Promise<Workspace> {
      const checkout = await addWorktree(repo, ctx.sessionId);
      const workspace: WorktreeWorkspace = {
        sessionId: ctx.sessionId,
        dir: checkout.dir,
        branch: checkout.branch,
        remote: repo.dir,
        checkout,
        dispose: () => removeWorktree(checkout),
      };
      return workspace;
    },

    async run(workspace: Workspace, ctx: SessionContext): Promise<ExecutionReport> {
      const checkout = (workspace as WorktreeWorkspace).checkout;

      let exitCode: number | null = 0;
      let detail: string | undefined;
      try {
        await run(bin as string, args, {
          cwd: checkout.dir,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, ATRIUM_SESSION_ID: ctx.sessionId },
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        exitCode = typeof code === 'number' ? code : 1;
        detail =
          error instanceof Error
            ? error.message.split('\n')[0]?.slice(0, 500)
            : 'harness command failed';
      }

      // Commit whatever the command produced, regardless of exit — a failing run
      // may still have left a partial artifact worth inspecting, but its terminal
      // is a failure and the coordinator settles it as `session_failed`.
      const commit = await commitWorktree(
        checkout,
        `session ${ctx.sessionId}: ${ctx.harness}/${ctx.model} (exit ${exitCode})`,
      );
      const ok = exitCode === 0;

      return {
        terminal: { ok, exitCode, detail },
        receipt: {
          exitSummary: ok
            ? `worktree harness settled on ${checkout.branch}`
            : `worktree harness failed (exit ${exitCode}): ${detail ?? 'no detail'}`,
          spendMicros: null,
          contextPct: null,
          artifact:
            ok && commit !== null ? { branch: checkout.branch, commit, remote: repo.dir } : null,
        },
      };
    },
  };
}
