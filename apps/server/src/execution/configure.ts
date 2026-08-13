import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@atrium/db';
import { sessions } from '@atrium/db/schema';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { ArtifactVerifier, CommandResult, CommandService } from '../commands.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';
import {
  createExecutionCoordinator,
  type ExecutionCoordinator,
  type ExecutionOwnership,
} from './coordinator.js';
import {
  type ArtifactRepo,
  artifactBranchCommit,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  pinSettledArtifact,
  type ScratchRepo,
  sessionBranch,
} from './git.js';
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
 * ## Two phases, because the artifact verifier is upstream of the command service
 *
 * `createExecutionProvider` builds the provider, the DURABLE artifact repo, and
 * the `verifyArtifact` closure that binds a `settle_session` artifact to a real
 * provider object (#120 F2). That verifier must be handed to
 * `createCommandService` BEFORE the command service exists, so `index.ts` runs
 * this phase first, injects the verifier, then calls `wireExecutionCoordinator`
 * over the resulting command service. `configureExecution` composes both phases
 * for callers that already hold a command service (the tests).
 *
 * ## The budget guard is upstream of the wrapper
 *
 * The wrapper fires the coordinator ONLY when `open_session` returned
 * `draw.outcome === 'granted'`. A `draw_refused` never satisfies that branch, so
 * a refused draw never reaches the provider here either.
 */
export interface ConfiguredExecution {
  provider: ExecutionProvider;
  coordinator: ExecutionCoordinator;
  /** The wrapped command service to hand to the realtime server. */
  commands: CommandService;
  /** Verifies a settle artifact against the provider's durable remote (#120 F2). */
  verifyArtifact: ArtifactVerifier;
  /** Wait for in-flight executions before teardown (#120 r3 F5). */
  drainExecutions(graceMs: number): Promise<number>;
  /** Tear down the SCRATCH working repo. The durable artifact repo is left intact. */
  dispose(): Promise<void>;
}

/** Phase 1: the provider, its durable artifact repo, and the artifact verifier. */
export interface ExecutionRuntime {
  provider: ExecutionProvider;
  /** The durable remote the artifact branches are pushed to and resolved from. */
  artifactRepo: ArtifactRepo;
  /** Verifies a settle artifact against `artifactRepo` (#120 F2). */
  verifyArtifact: ArtifactVerifier;
  /**
   * Tear down the SCRATCH working repo (worktrees). The DURABLE artifact repo is
   * NEVER removed here (#120 F3) — a settled receipt points at it and must
   * resolve after shutdown.
   */
  dispose(): Promise<void>;
}

/**
 * PHASE 1 — build the execution provider, its durable artifact repo, and the
 * artifact verifier. `null` when `EXECUTION_PROVIDER` is unset (disabled).
 */
export async function createExecutionProvider(input: {
  env: Env;
  logger: Logger;
}): Promise<ExecutionRuntime | null> {
  const { env, logger } = input;
  if (env.EXECUTION_PROVIDER === undefined) return null;

  // The DURABLE artifact remote (#120 F3): a stable, bare repo that survives the
  // process. Session branches are pushed here so a receipt's {branch,commit,
  // remote} resolves after shutdown. It is NEVER disposed.
  const artifactDir =
    env.EXECUTION_ARTIFACT_DIR ?? join(env.EXECUTION_SCRATCH_DIR ?? tmpdir(), 'atrium-artifacts');
  const artifactRepo = await createArtifactRepo(artifactDir);

  let scratch: ScratchRepo | null = null;
  let provider: ExecutionProvider;

  switch (env.EXECUTION_PROVIDER) {
    case 'shim': {
      scratch = await createScratchRepo(env.EXECUTION_SCRATCH_DIR);
      provider = createDeterministicShimProvider({ repo: scratch, artifactRepo });
      break;
    }
    case 'worktree': {
      // Defense in depth: the boot gate (`assertExecutionProviderSafe`) already
      // refuses this without the explicit opt-in, but never build the unsafe,
      // unsandboxed provider silently even if that gate is somehow bypassed.
      if (!env.EXECUTION_ALLOW_UNSANDBOXED) {
        throw new Error(
          'refusing to build the UNSANDBOXED worktree provider without EXECUTION_ALLOW_UNSANDBOXED=1 ' +
            "(#120 F1) — it runs an arbitrary harness on the server's own disk and is not a security " +
            'boundary; real containment is the sandbox BUY seam. Use EXECUTION_PROVIDER=shim.',
        );
      }
      logger.warn(
        'execution provider is worktree — UNSANDBOXED and NOT a security boundary; the covenant ' +
          'guarantee for real execution requires the sandbox seam (#120 F1)',
        {},
      );
      scratch = await createScratchRepo(env.EXECUTION_SCRATCH_DIR);
      provider = createWorktreeCommandProvider({
        repo: scratch,
        artifactRepo,
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

  logger.info('execution provider enabled', { provider: provider.kind, artifactRepo: artifactDir });

  const verifyArtifact = createArtifactVerifier(artifactRepo, logger);

  return {
    provider,
    artifactRepo,
    verifyArtifact,
    dispose: async () => {
      // The scratch working repo is torn down; the durable artifact repo is NOT
      // (#120 F3) — a settled receipt points at it and must still resolve.
      if (scratch) await disposeScratchRepo(scratch);
    },
  };
}

/**
 * THE ARTIFACT VERIFIER (#120 F2, extended by round-3 F4).
 *
 * Closed over the provider's OWN durable remote, so a caller cannot point it at a
 * repo they control. An artifact is trusted only when its branch is exactly this
 * session's branch, its remote is exactly the durable repo, and the commit
 * resolves to that ref there.
 *
 * ROUND 3 adds the PIN. `commands.ts` now calls this inside the append's critical
 * section, so the tuple that was verified is the tuple that gets written — but
 * the branch it verified stays mutable forever after, and a `session_settled`
 * whose commit was later force-pushed away or `branch -D`'d would index an
 * object that is unreachable and eligible for `git gc`. Writing
 * `refs/atrium/settled/<sessionId>` at the verified commit makes that object a GC
 * root in its own right: the branch may move, the receipt still resolves.
 *
 * The pin is the LAST step, so an artifact that fails any check is never pinned
 * and this cannot be used to make arbitrary objects permanent. If the pin itself
 * fails, the artifact is REFUSED — a commit this seam cannot promise will still
 * resolve is one it should not be certifying a receipt against.
 *
 * Exported so the integration suite verifies the REAL closure rather than a
 * lookalike. A test that reimplements the thing it is testing proves only that
 * two copies agree.
 */
export function createArtifactVerifier(
  artifactRepo: ArtifactRepo,
  logger: Logger,
): ArtifactVerifier {
  return async ({ sessionId, artifact }) => {
    if (artifact.branch !== sessionBranch(sessionId)) return false;
    if (artifact.remote !== artifactRepo.dir) return false;
    // ── OCCUPANCY, NOT PROVENANCE — a documented boundary (#120 round-4 F-note) ──
    //
    // This resolves the claimed commit against the durable repo's branch TIP: it
    // proves the object OCCUPIES this session's ref in a repo the provider
    // controls. It does NOT prove THIS provider is what pushed it — there is no
    // per-push signature recorded and compared. The two coincide as long as the
    // provider is the ONLY writer of the durable repo, which is the shipped
    // configuration: the bare repo is created by `createExecutionProvider`, its
    // path is never handed to the harness, and no other process is wired to push
    // into it. So in a shim-only (or single-writer worktree) deployment the gap is
    // UNREACHABLE — an attacker would need write access to a repo whose path they
    // are not given.
    //
    // It becomes reachable only if some OTHER writer can push
    // `refs/heads/<sessionBranch>` here. Closing that would need a real provenance
    // record the caller cannot forge (a signed push token, or a provider-private
    // ref an outside writer also cannot set) — and a local bare repo has no
    // per-ref auth to hang that on, so there is no cheap tightening that actually
    // adds assurance rather than moving the same trust to a second unauthenticated
    // ref. It is left as occupancy, named here so the check is not read as
    // promising provenance it does not provide.
    // ── RESOLVE ONCE, VERIFY, PIN THE SAME SHA (#120 round-5 F7) ──────────────
    //
    // Resolution and pinning used to read the branch twice — verify against
    // `artifact.commit`, then pin `artifact.commit` — with a window in between in
    // which a same-UID writer could force-move the ref. The fix pins the EXACT sha
    // this call resolved (`resolved`), by OBJECT, not by re-reading the branch:
    // once resolved and checked, the pin depends only on that immutable commit, so
    // a branch that moves afterward cannot make the pin land on a different object.
    // `pinSettledArtifact` is create-once and its `update-ref` fails if the object
    // is gone, so a commit GC'd in the window makes the pin THROW (→ refuse), never
    // dangle. This is the atomicity a local bare repo affords — a single object
    // value carried from check to pin — not a cross-process ref lock, and it is
    // still OCCUPANCY, not provenance (see above): it proves the object sits at
    // this session's ref in a repo the provider controls, not that this provider
    // pushed it.
    const resolved = await artifactBranchCommit(artifactRepo, artifact.branch);
    if (resolved === null || resolved !== artifact.commit) return false;
    try {
      await pinSettledArtifact(artifactRepo, sessionId, resolved);
    } catch (error) {
      logger.error('refusing a settle artifact that could not be pinned durably', {
        sessionId,
        commit: artifact.commit,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    return true;
  };
}

/**
 * THE EXECUTION-OWNERSHIP LEASE MANAGER (#120 round-5 F1 + F4).
 *
 * Owns the two lease columns on `sessions`. `claim` is the granted-draw guard AND
 * the lease write in one guarded UPDATE (see `ExecutionOwnership`); `heartbeat`
 * keeps this process's live leases warm so reconciliation does not read them as a
 * dead owner's. Both are process-liveness bookkeeping — NOT the ledger projection,
 * NOT covenant state — scoped to `status = 'open'` so they never present an UPDATE
 * to a terminal row (which `sessions_terminal_immutable` would refuse).
 */
export interface ExecutionOwnershipManager extends ExecutionOwnership {
  /** This process's execution instance id — the value stamped on a claimed lease. */
  readonly instanceId: string;
  /** Bump the heartbeat on every open session this process owns. Returns the count. */
  heartbeat(): Promise<number>;
}

export function createExecutionOwnership(input: {
  db: Database;
  instanceId: string;
  logger: Logger;
}): ExecutionOwnershipManager {
  const { db, instanceId, logger } = input;
  return {
    instanceId,
    claim: async ({ sessionId, roomId }) => {
      // Matches ONLY a session that exists, was GRANTED (a `session_opened` was
      // projected — `opened_by_event_id IS NOT NULL`), is still `open`, and is not
      // already owned by a DIFFERENT live instance. A "never-granted" id, an
      // already-exited session, or one a peer owns matches zero rows → false, and
      // the coordinator refuses to run it. On a match it stamps this instance and a
      // fresh heartbeat in the SAME statement, so the guard and the lease are one
      // atomic write with no window between them.
      const claimed = await db
        .update(sessions)
        .set({ executionOwner: instanceId, executionHeartbeatAt: new Date() })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.roomId, roomId),
            isNotNull(sessions.openedByEventId),
            eq(sessions.status, 'open'),
            // Not already owned by a DIFFERENT instance — free, or ours to re-claim.
            or(isNull(sessions.executionOwner), eq(sessions.executionOwner, instanceId)),
          ),
        )
        .returning({ id: sessions.id });
      return claimed.length > 0;
    },
    heartbeat: async () => {
      const bumped = await db
        .update(sessions)
        .set({ executionHeartbeatAt: new Date() })
        .where(and(eq(sessions.executionOwner, instanceId), eq(sessions.status, 'open')))
        .returning({ id: sessions.id });
      if (bumped.length > 0) {
        logger.debug?.('execution ownership heartbeat', { instanceId, count: bumped.length });
      }
      return bumped.length;
    },
  };
}

/**
 * PHASE 2 — wrap a command service so a granted `session_opened` fires the
 * coordinator, and return the coordinator + the wrapped service.
 */
export function wireExecutionCoordinator(input: {
  provider: ExecutionProvider;
  commands: CommandService;
  logger: Logger;
  /** The granted-draw guard + ownership lease (#120 round-5). Injected in production. */
  ownership?: ExecutionOwnership;
}): {
  coordinator: ExecutionCoordinator;
  commands: CommandService;
  /**
   * Wait for in-flight executions, up to `graceMs` (#120 round-3 F5). Resolves
   * with how many were still running when the grace expired — zero means every
   * granted draw got its receipt before the process went away.
   */
  drainExecutions(graceMs: number): Promise<number>;
  /** How many executions are running right now. For tests and the boot log. */
  inFlight(): number;
} {
  const { provider, commands, logger, ownership } = input;
  const coordinator = createExecutionCoordinator({ commands, provider, logger, ownership });

  // ── EXECUTIONS ARE TRACKED, NOT DETACHED (#120 round-3 F5) ─────────────────
  //
  // The run is still fire-and-forget with respect to the OPENER's request — the
  // session is durably open before it starts, so a harness must not be able to
  // fail somebody's `open_session` ack. It is no longer fire-and-forget with
  // respect to the PROCESS. Round 2 found that a `SIGTERM` mid-harness closed the
  // database and deleted the scratch repo underneath a run nobody was holding a
  // handle to, and the session it had already been billed for stayed `open`
  // forever. A promise nobody keeps is a promise the shutdown path cannot wait
  // for, so we keep it.
  const running = new Set<Promise<unknown>>();

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
        const run = coordinator
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
          })
          .finally(() => {
            running.delete(run);
          });
        running.add(run);
      }
      return result;
    },
  };

  return {
    coordinator,
    commands: wrapped,
    inFlight: () => running.size,
    drainExecutions: async (graceMs: number): Promise<number> => {
      if (running.size === 0) return 0;
      logger.info('waiting for in-flight executions before shutdown', {
        count: running.size,
        graceMs,
      });
      // BOUNDED. A harness may legitimately run for ten minutes and shutdown
      // cannot; what the grace buys is that the common case — a run seconds from
      // its settle — gets its receipt instead of being severed. Whatever is still
      // going when the grace expires is left to startup reconciliation, which is
      // why that backstop is not optional.
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.allSettled([...running]).then(() => undefined), grace]);
      if (timer) clearTimeout(timer);
      if (running.size > 0) {
        logger.warn('executions still running at end of shutdown grace — left for reconciliation', {
          count: running.size,
        });
      }
      return running.size;
    },
  };
}

/**
 * Compose both phases over an EXISTING command service. Used by tests and any
 * caller that already holds a command service; `index.ts` runs the two phases
 * itself so it can inject the verifier into the command service it builds.
 */
export async function configureExecution(input: {
  env: Env;
  commands: CommandService;
  logger: Logger;
  /**
   * The database and this process's execution instance id, for the ownership
   * lease (#120 round-5). When provided, the coordinator enforces the granted-draw
   * guard and stamps ownership leases; absent (the pure-unit fixtures that pass a
   * fake command service and no DB), the guard is inert.
   */
  db?: Database;
  instanceId?: string;
}): Promise<ConfiguredExecution | null> {
  const { env, commands, logger, db, instanceId } = input;
  const runtime = await createExecutionProvider({ env, logger });
  if (runtime === null) return null;
  const ownership =
    db !== undefined
      ? createExecutionOwnership({ db, instanceId: instanceId ?? randomUUID(), logger })
      : undefined;
  const wired = wireExecutionCoordinator({
    provider: runtime.provider,
    commands,
    logger,
    ownership,
  });
  return {
    provider: runtime.provider,
    coordinator: wired.coordinator,
    commands: wired.commands,
    verifyArtifact: runtime.verifyArtifact,
    drainExecutions: wired.drainExecutions,
    dispose: runtime.dispose,
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
