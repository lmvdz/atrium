import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ArtifactRepo,
  addWorktree,
  commitWorktree,
  pushArtifactBranch,
  removeWorktree,
  type ScratchRepo,
  type WorktreeCheckout,
} from './git.js';
import type { ExecutionProvider, ExecutionReport, SessionContext, Workspace } from './provider.js';

/**
 * The deterministic shim (#120) — the DEFAULT provider under test.
 *
 * It resolves a real git worktree and produces a real branch/commit, exactly as
 * a real adapter does, but its "harness" is a FIXED, in-process routine rather
 * than a spawned command or a model: no network, no clock, no randomness. The
 * same session context in yields the same artifact out. That determinism is the
 * whole reason it is the tested path — a real sandbox is Atrium's differentiation
 * (`sandbox.ts`), but it is not what a verification gate can depend on.
 *
 * ## Flip-the-input, so the shim is not ornament (the #120 gauntlet's ask)
 *
 * The artifact CONTENT is derived from the session context — the file it writes
 * names the session, plan, harness and model — so two different sessions produce
 * two byte-different commits. And the TERMINAL is driven by input too: a session
 * whose model directive is `EXECUTION_FAIL_DIRECTIVE` exits `ok: false` with no
 * artifact. Change the input and the output moves; that is what proves the seam
 * is genuinely exercised rather than a canned success.
 */

/**
 * The reserved model directive that makes the deterministic harness FAIL. It is
 * a session-context input, so the "a failing harness → session_failed" arm of
 * the acceptance test flips exactly one field and asserts the terminal moved —
 * the shim is reading its input, not returning a constant.
 */
export const EXECUTION_FAIL_DIRECTIVE = '__atrium_shim_fail__';

/** The file the fake harness writes — the artifact's payload, on the branch. */
export const SHIM_ARTIFACT_PATH = 'ARTIFACT.json';

export interface DeterministicShimOptions {
  /** The scratch repo the shim controls — where every per-session worktree lands. */
  repo: ScratchRepo;
  /**
   * The DURABLE artifact repo the session branch is pushed to (#120 F3). Present,
   * the artifact's `remote` is this repo (survives shutdown); absent, it points
   * at the scratch repo (test behaviour, not durable).
   */
  artifactRepo?: ArtifactRepo;
}

interface ShimWorkspace extends Workspace {
  readonly checkout: WorktreeCheckout;
}

/**
 * Build the deterministic shim provider over a scratch repo.
 *
 * `resolve` adds a per-session worktree; `run` writes the deterministic artifact
 * file, commits it onto the session branch, and reports terminal + receipt. On
 * the fail directive it writes nothing, commits nothing, and reports a failed
 * terminal — so trunk AND the session branch both stay empty of an artifact,
 * which the covenant proof reads as "no autonomous land, and nothing to land".
 */
export function createDeterministicShimProvider(
  options: DeterministicShimOptions,
): ExecutionProvider {
  const { repo, artifactRepo } = options;

  return {
    kind: 'shim',

    async resolve(ctx: SessionContext): Promise<Workspace> {
      const checkout = await addWorktree(repo, ctx.sessionId);
      const workspace: ShimWorkspace = {
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
      const checkout = (workspace as ShimWorkspace).checkout;
      const shouldFail = ctx.model === EXECUTION_FAIL_DIRECTIVE;

      if (shouldFail) {
        // The failing harness: no file, no commit, no artifact. The exit is a
        // failure owed triage (§9.5), and the receipt says why.
        return {
          terminal: { ok: false, exitCode: 1, detail: 'harness reported a non-clean exit' },
          receipt: {
            exitSummary: `deterministic shim: harness for session ${ctx.sessionId} failed`,
            spendMicros: 0,
            contextPct: null,
            artifact: null,
          },
        };
      }

      // The clean harness: write the deterministic artifact, commit it onto the
      // session branch. The content is a pure function of the context, so the
      // commit is reproducible and flip-the-input visibly changes it.
      const artifactBody = deterministicArtifact(ctx);
      await writeFile(join(checkout.dir, SHIM_ARTIFACT_PATH), `${artifactBody}\n`);
      const commit = await commitWorktree(
        checkout,
        `session ${ctx.sessionId}: ${ctx.harness}/${ctx.model} settled`,
      );

      if (commit === null) {
        // Defensive: the write above always dirties the tree, so this is
        // unreachable in practice — but a run that produced no object is a
        // failure, not a settle claiming an artifact it does not have.
        return {
          terminal: { ok: false, exitCode: 1, detail: 'harness produced no artifact' },
          receipt: {
            exitSummary: `deterministic shim: session ${ctx.sessionId} produced no commit`,
            spendMicros: 0,
            contextPct: null,
            artifact: null,
          },
        };
      }

      // Push the branch to the DURABLE artifact repo so the receipt resolves
      // after shutdown (#120 F3); the reported commit is the one the durable ref
      // points at. Absent a durable repo, the artifact stays on the scratch repo.
      let remote = repo.dir;
      let durableCommit = commit;
      if (artifactRepo) {
        durableCommit = await pushArtifactBranch(checkout, artifactRepo);
        remote = artifactRepo.dir;
      }

      return {
        terminal: { ok: true, exitCode: 0 },
        receipt: {
          exitSummary: `deterministic shim: session ${ctx.sessionId} settled on ${checkout.branch}`,
          spendMicros: 0,
          contextPct: null,
          artifact: { branch: checkout.branch, commit: durableCommit, remote },
        },
      };
    },

    // Nothing to cancel (#120 round-7 F4): the shim's "harness" is a synchronous
    // in-process routine — it spawns no child and holds no remote sandbox, so a
    // `run` is either not started or already returned. The seam still answers the
    // question, it just has nothing to kill.
    async cancelAll(): Promise<void> {},
  };
}

/**
 * The deterministic artifact content — a stable JSON encoding of the session
 * context. Pure in its input, so the commit it becomes is reproducible and a
 * different session yields a different object.
 */
export function deterministicArtifact(ctx: SessionContext): string {
  return JSON.stringify(
    {
      kind: 'atrium-execution-artifact',
      sessionId: ctx.sessionId,
      planId: ctx.planId,
      roomId: ctx.roomId,
      harness: ctx.harness,
      model: ctx.model,
    },
    null,
    2,
  );
}
