import { type ChildProcess, spawn } from 'node:child_process';
import {
  type ArtifactRepo,
  addWorktree,
  assertArtifactRemoteIsNotUpstream,
  cleanHome,
  commitWorktree,
  DANGEROUS_GIT_VARS,
  isAuthenticScratchRepo,
  pushArtifactBranch,
  removeWorktree,
  type ScratchRepo,
  type WorktreeCheckout,
} from './git.js';
import type { ExecutionProvider, ExecutionReport, SessionContext, Workspace } from './provider.js';

/** The outcome of running a harness child to completion (or timeout/kill). */
interface HarnessRun {
  readonly exitCode: number | null;
  readonly detail?: string;
}

/**
 * Spawn the harness in its OWN process group and run it to completion (#120
 * round-7 F4). `detached: true` makes the child a group leader (pgid = pid), so a
 * later signal to `-pid` reaches the whole tree — a `bash -lc` and everything it
 * spawned — which is what `cancelAll` needs to leave nothing running loose.
 * `execFile` cannot do this: it does not forward `detached` to `spawn`.
 *
 * stdout/stderr are drained into a small capped tail (not the harness's payload —
 * that is the git tree) so a chatty child never blocks on a full pipe, and a
 * non-zero exit carries a short reason. `onSpawn` hands the live `ChildProcess`
 * to the caller for cancellation tracking. A timeout kills the group and reports
 * a timed-out failure.
 */
function runHarness(
  bin: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  onSpawn: (child: ChildProcess) => void,
): Promise<HarnessRun> {
  return new Promise<HarnessRun>((resolve) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn(child);

    let stderrTail = '';
    const capture = (chunk: Buffer) => {
      if (stderrTail.length < 2000) stderrTail += chunk.toString('utf8');
    };
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', capture);

    let settled = false;
    const done = (run: HarnessRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    const timer = setTimeout(() => {
      killGroup(child);
      done({ exitCode: null, detail: `harness timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);

    child.on('error', (error: Error) => {
      done({ exitCode: 1, detail: error.message.split('\n')[0]?.slice(0, 500) });
    });
    child.on('close', (code, signal) => {
      if (code === 0) return done({ exitCode: 0 });
      const reason =
        stderrTail.trim().split('\n').pop()?.slice(0, 500) ??
        (signal ? `killed by ${signal}` : 'harness command failed');
      done({ exitCode: code, detail: signal ? `killed by ${signal}` : reason });
    });
  });
}

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
 * REFUSAL — real-repo mode does not build on the unsandboxed worktree provider,
 * at the FACTORY, not only at env (#141 r4 — the capability is REMOVED, not gated).
 *
 * `env.ts` refuses `EXECUTION_PROVIDER=worktree` + an upstream at boot. But an
 * `ExecutionProvider` is built by a plain function call, and a direct caller (a
 * test, a future daemon) reaches this factory without ever loading an `Env` — the
 * #89 adjacent-path-bypass class. So the constructor itself refuses a seeded
 * scratch repo, UNCONDITIONALLY.
 *
 * Round 3 gated this behind a `containedUpstreamSeed` boolean seam. That was not
 * containment: any direct caller could flip the flag and build the forbidden
 * provider, whose harness then redirects the push into the upstream through git
 * config. Round 4 removes the seam entirely — there is no boolean to set, no path
 * by which this provider runs a seeded upstream. Real-repo execution belongs to
 * the #138 sandbox provider, which contains the harness so the config-rewrite
 * reach no longer exists; the worktree provider is EMPTY-TRUNK ONLY.
 */
export const WORKTREE_UPSTREAM_SEED_REFUSAL =
  'refusing to build the UNSANDBOXED worktree provider against a seeded execution upstream ' +
  '(#141) — a real harness here can rewrite its own push destination through git config, so ' +
  'real-repo mode is not available on this provider at all; it belongs to the sandbox provider ' +
  '(#138, docker/gVisor). The boot gate refuses this configuration and the factory refuses the ' +
  'direct caller who never loaded it — there is no seam through';

/**
 * REFUSAL (#141 r5, F1) — the scratch repo must be a FACTORY-MINTED handle.
 *
 * The `repo.upstream !== undefined` refusal below reads a STRUCTURAL field, and a
 * caller with the opt-in writes that field. Both foreign lineages executed the
 * dodge: `createScratchRepo(…, seed)` produces a real seeded repo on disk, then a
 * hand-built `{ dir: scratch.dir, seedCommit: scratch.seedCommit }` — with the
 * `upstream` field simply LEFT OFF — is passed here. Structurally it is an
 * innocent empty-trunk repo, so it slips the upstream refusal; but it points at a
 * seeded repo, so the harness this factory builds runs against a real upstream and
 * rewrites its own push destination through git config.
 *
 * So provenance is verified as a runtime CAPABILITY, not read from a forgeable
 * field: only `createScratchRepo` can mint an authentic ScratchRepo (a
 * module-private `WeakSet` in `git.ts`), and this factory refuses any handle that
 * is not one. The forged `{ dir, seedCommit }` is not in the set — it is rejected
 * whether or not it carries an `upstream` field, closing the class the structural
 * refusal alone left open.
 */
export const SCRATCH_REPO_NOT_AUTHENTIC_REFUSAL =
  'refusing to build an execution provider over a ScratchRepo that createScratchRepo did not mint ' +
  '(#141 r5) — a hand-built handle can omit its `upstream` field to read as an innocent empty-trunk ' +
  'repo while pointing at a seeded one, so only a factory-branded scratch repo is trusted to build a ' +
  'harness here';

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
  // PRIMARY GATE (#141 r5, F1): the scratch repo must be a FACTORY-MINTED handle.
  // A forged `{ dir, seedCommit }` that omits `upstream` slips the structural
  // refusal below while pointing at a real seeded repo; it is not in the
  // authenticity WeakSet, so it is rejected HERE, before any field is read. This
  // catches the forgery whether or not it carries an `upstream` field.
  if (!isAuthenticScratchRepo(repo)) {
    throw new Error(SCRATCH_REPO_NOT_AUTHENTIC_REFUSAL);
  }
  // REAL-REPO MODE IS NOT AVAILABLE ON THIS PROVIDER, refused at the FACTORY (#141
  // r4 — REMOVED, not gated). A seeded scratch repo means real-repo mode, and this
  // provider's harness can rewrite its own push destination via git config — so the
  // boundary env.ts states at boot is restated here, where a direct caller lands.
  // There is NO opt-in: the round-3 `containedUpstreamSeed` boolean was not
  // containment (any caller flips it), so it is gone and this refusal is absolute.
  if (repo.upstream !== undefined) {
    throw new Error(WORKTREE_UPSTREAM_SEED_REFUSAL);
  }
  // THE UPSTREAM IS NEVER WRITTEN, provider layer (#141). Defense in depth: with a
  // seeded repo already refused above, `repo.upstream` is undefined here and this
  // is a no-op on the worktree path — but it is the shared invariant every provider
  // factory asserts, kept so a future weakening of the refusal above cannot silently
  // wire an artifact remote onto the upstream. (It is LIVE on the shim, which does
  // run real-repo mode.)
  assertArtifactRemoteIsNotUpstream(repo, artifactRepo);
  if (command.length === 0) {
    throw new Error('worktree provider requires a non-empty command argv');
  }
  const [bin, ...args] = command;

  // ── IN-FLIGHT CHILDREN, TRACKED FOR CANCELLATION (#120 round-7 F4) ──────────
  //
  // Every live harness child, keyed by session id, so `cancelAll` can terminate
  // it on shutdown. Without this the child is spawned fire-and-forget and a
  // `SIGTERM` abandons it: Atrium exits and the harness keeps running loose.
  const children = new Map<string, ChildProcess>();

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

      // Run the harness in its own process group, tracked for cancellation. The
      // harness gets an allowlisted env — never the server's secrets, and scrubbed
      // of any var that could retarget its git off this worktree.
      const outcome = await runHarness(
        bin as string,
        args,
        { cwd: checkout.dir, env: await harnessEnv(ctx.sessionId), timeoutMs },
        (child) => {
          children.set(ctx.sessionId, child);
          child.once('close', () => children.delete(ctx.sessionId));
          child.once('error', () => children.delete(ctx.sessionId));
        },
      );
      const exitCode = outcome.exitCode;
      const detail = outcome.detail;

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
            const pushDetail =
              error instanceof Error
                ? `artifact push failed: ${error.message.split('\n')[0]?.slice(0, 400)}`
                : 'artifact push failed';
            return {
              terminal: { ok: false, exitCode: exitCode ?? 1, detail: pushDetail },
              receipt: {
                exitSummary: `worktree harness produced no durable artifact: ${pushDetail}`,
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

    async cancelAll(): Promise<void> {
      // Kill every in-flight harness's whole process GROUP (#120 round-7 F4).
      // Each child was spawned `detached`, so its pgid is its own pid and the
      // negated-pid signal reaches the harness AND anything it spawned. `SIGKILL`
      // rather than `SIGTERM` because this is the shutdown backstop — the run
      // already had its drain grace, and a harness that ignores `SIGTERM` must not
      // outlive the process that abandoned it. Best-effort and never throws: a
      // child that already exited (ESRCH) is exactly the state we want.
      for (const child of children.values()) killGroup(child);
      children.clear();
    },
  };
}

/**
 * Terminate a detached child's whole process group (#120 round-7 F4). The child
 * is its own group leader (spawned `detached`), so signalling `-pid` reaches every
 * descendant. Falls back to signalling the child directly if the group send fails
 * (e.g. the leader already reaped), and swallows `ESRCH` — an already-dead process
 * is the goal, not an error.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone — nothing to kill, which is the desired end state.
    }
  }
}
