import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ArtifactRepo,
  addWorktree,
  cleanHome,
  commitWorktree,
  DANGEROUS_GIT_VARS,
  pushArtifactBranch,
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
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  UNSAFE / DEV-ONLY — NOT A SECURITY BOUNDARY.                             ║
 * ║                                                                          ║
 * ║  This adapter runs an ARBITRARY harness command on the SERVER'S OWN      ║
 * ║  disk, in a git worktree on the server's own filesystem. The git env is  ║
 * ║  scrubbed and the harness env is a strict allowlist (below), which stops  ║
 * ║  the OBVIOUS escapes — retargeting git at the real repo, exfiltrating     ║
 * ║  the server's secrets — but it is NOT containment. A hostile harness can  ║
 * ║  still read/write the filesystem, open the network, and spend whatever    ║
 * ║  the process user can. REAL containment needs a REAL sandbox: the         ║
 * ║  `sandbox.ts` BUY seam (E2B/Daytona/ComputeSDK), which is not yet wired.  ║
 * ║                                                                          ║
 * ║  The covenant guarantee for REAL execution therefore holds only under     ║
 * ║  the sandbox. Selecting this provider requires an explicit, loud opt-in   ║
 * ║  (`EXECUTION_ALLOW_UNSANDBOXED=1`, gated at boot in `env.ts`) so it can    ║
 * ║  never be turned on by accident. The deterministic shim is the safe       ║
 * ║  default under test.                                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Held to the same seam as the shim: the shim's "harness" is a fixed in-process
 * routine, this one SPAWNS a configured command in the workspace and reads its
 * actual exit code. Whatever the command leaves in the tree is committed onto
 * the session branch and PUSHED to the durable artifact repo (#120 F3).
 *
 * It shares every git operation with the shim (`git.ts`); the command is argv,
 * never a shell string — the workspace path is the only thing the process is
 * pointed at.
 */

export interface WorktreeCommandOptions {
  /** The scratch repo the per-session worktrees are checked out in. */
  repo: ScratchRepo;
  /**
   * The DURABLE artifact repo the session branch is pushed to (#120 F3). When
   * present, the artifact's `remote` is this repo — which survives shutdown —
   * not the scratch working repo, which does not. Absent, the artifact points at
   * the scratch repo (legacy/test behaviour, not durable).
   */
  artifactRepo?: ArtifactRepo;
  /**
   * The harness command as argv: `['bash', '-lc', '…']` or `['npm', 'test']`.
   * Run with the worktree as its cwd. A non-zero exit is a failed terminal.
   */
  command: readonly string[];
  /** How long the command may run before it is killed and the run fails. */
  timeoutMs?: number;
}

/**
 * The harness environment — built from an explicit ALLOWLIST, never the raw
 * `process.env` (#120 F4). The server's secrets (`DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, `AI_GATEWAY_API_KEY`, S3 keys, …) live in `process.env`;
 * a harness that inherited them could `printenv` them straight out. So the
 * harness gets ONLY what it needs to run: a PATH to find binaries, a scrubbed
 * HOME with no dotfiles, locale, a temp dir, the scrubbing that keeps its own
 * git bound to its worktree, and its session id. Nothing else crosses the seam.
 */
export async function harnessEnv(sessionId: string): Promise<NodeJS.ProcessEnv> {
  const home = await cleanHome();
  const allow = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'] as const;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: home,
    // Bind any git the harness itself runs to its own worktree, never the real
    // repo — the same scrub the adapter's own git operations get.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Round 3: parity with `scrubbedGitBaseEnv`. The harness allowlist already
    // denied the config-injection vars by construction (they are not copied), but
    // the system path was only suppressed by the flag, not pinned.
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ATRIUM_SESSION_ID: sessionId,
  };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Belt and suspenders: even if one of the allowlisted values somehow carried a
  // retargeting var, it is not among the keys we copy — and we never copy the
  // dangerous ones. Assert the intent for the reader.
  for (const dangerous of DANGEROUS_GIT_VARS) delete env[dangerous];
  return env;
}

interface WorktreeWorkspace extends Workspace {
  readonly checkout: WorktreeCheckout;
}

/**
 * Is the unsandboxed opt-in set, right now, in this process? Read at construction
 * rather than closed over at import, so a test that sets and restores the flag
 * around one call gets exactly the window it asked for.
 *
 * Same spelling `env.ts` accepts (`1`/`true`), read straight from `process.env`
 * rather than from a parsed `Env` — the whole point of the round-3 gate is that it
 * binds on EVERY entry path, including the ones that never build an `Env`.
 */
export function unsandboxedExecutionAllowed(): boolean {
  const raw = process.env.EXECUTION_ALLOW_UNSANDBOXED;
  return raw === '1' || raw === 'true';
}

export const UNSANDBOXED_REFUSAL =
  'refusing to construct the UNSANDBOXED worktree execution provider without ' +
  "EXECUTION_ALLOW_UNSANDBOXED=1 (#120 F1) — it runs an arbitrary harness on the server's own " +
  'disk and is NOT a security boundary; real containment is the sandbox BUY seam. Use the ' +
  'deterministic shim provider, or set the opt-in out loud if you mean it.';

/**
 * THE GATE IS HERE, NOT ONLY UPSTREAM (#120 round-3 F6).
 *
 * `env.ts` (`assertExecutionProviderSafe`) and `configure.ts` both refuse to
 * SELECT this provider without `EXECUTION_ALLOW_UNSANDBOXED`. Neither of them is
 * on the path a direct caller takes: the integration suite reached this factory
 * without ever touching an `Env`, and so ran the unsandboxed adapter with no
 * opt-in anywhere. That is the #89 adjacent-path-bypass class — a guard that is
 * real on the paths somebody thought of and absent on the one they did not.
 *
 * So the constructor itself refuses. There is deliberately NO `allowUnsandboxed`
 * option to pass: an option any caller can set is not a gate, it is a spelling.
 * The only way through is the process-wide opt-in, which is the same thing the
 * operator has to say out loud at boot.
 */
export function createWorktreeCommandProvider(options: WorktreeCommandOptions): ExecutionProvider {
  if (!unsandboxedExecutionAllowed()) throw new Error(UNSANDBOXED_REFUSAL);
  const { repo, artifactRepo, command, timeoutMs = 10 * 60_000 } = options;
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
        remote: artifactRepo?.dir ?? repo.dir,
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
          // The harness gets an allowlisted env — never the server's secrets, and
          // scrubbed of any var that could retarget its git off this worktree.
          env: await harnessEnv(ctx.sessionId),
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

      // A clean run with a real commit produces the DURABLE artifact: push the
      // branch to the artifact repo (which outlives shutdown) and report the
      // commit that ref actually resolves to there (#120 F2/F3). If the push
      // fails, there is no durable object — so there is no artifact, not a
      // receipt pointing at a branch that only ever lived in the scratch repo.
      let artifact: { branch: string; commit: string; remote: string } | null = null;
      if (ok && commit !== null) {
        if (artifactRepo) {
          try {
            const durable = await pushArtifactBranch(checkout, artifactRepo);
            artifact = { branch: checkout.branch, commit: durable, remote: artifactRepo.dir };
          } catch (error) {
            detail =
              error instanceof Error
                ? `artifact push failed: ${error.message.split('\n')[0]?.slice(0, 400)}`
                : 'artifact push failed';
            return {
              terminal: { ok: false, exitCode: exitCode ?? 1, detail },
              receipt: {
                exitSummary: `worktree harness produced no durable artifact: ${detail}`,
                spendMicros: null,
                contextPct: null,
                artifact: null,
              },
            };
          }
        } else {
          artifact = { branch: checkout.branch, commit, remote: repo.dir };
        }
      }

      return {
        terminal: { ok, exitCode, detail },
        receipt: {
          exitSummary: ok
            ? `worktree harness settled on ${checkout.branch}`
            : `worktree harness failed (exit ${exitCode}): ${detail ?? 'no detail'}`,
          spendMicros: null,
          contextPct: null,
          artifact,
        },
      };
    },
  };
}
