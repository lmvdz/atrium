import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, coreEvents, plans, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ArtifactVerifier, createCommandService } from '../../apps/server/src/commands.js';
import { createArtifactVerifier } from '../../apps/server/src/execution/configure.js';
import { createExecutionCoordinator } from '../../apps/server/src/execution/coordinator.js';
import {
  type ArtifactRepo,
  artifactBranchCommit,
  artifactCommitResolves,
  branchCommit,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  listSessionBranches,
  mainCommit,
  type ScratchRepo,
  sessionBranch,
  settledArtifactRef,
} from '../../apps/server/src/execution/git.js';
import type { ExecutionArtifact } from '../../apps/server/src/execution/provider.js';
import { reconcileWedgedSessions } from '../../apps/server/src/execution/reconcile.js';
import {
  createDeterministicShimProvider,
  EXECUTION_FAIL_DIRECTIVE,
} from '../../apps/server/src/execution/shim.js';
import { createWorktreeCommandProvider } from '../../apps/server/src/execution/worktree-provider.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMembershipAuthorizer, type Session } from '../../apps/server/src/session.js';
import { openDatabase, resetDatabase, type SeededRoom, seedRoom } from '../support/harness.js';

/**
 * THE EXECUTIONPROVIDER ACCEPTANCE TEST (#120), through the REAL command
 * boundary and a REAL git shim — plus the fix-round-2 covenant guards.
 *
 * A session under a funded plan runs the deterministic shim, produces a real
 * artifact (a branch/commit PUSHED to a DURABLE git repo the shim controls), and
 * settles to `session_settled` INDEXING that artifact. The flips: a failing
 * harness settles to `session_failed` with the receipt and no artifact; a
 * session whose plan budget REFUSES the draw never starts the adapter.
 *
 * The guards proven red-on-revert here:
 *  - **Budget (#118):** the refused-draw case asserts the coordinator never
 *    resolved a workspace (zero session branches in the scratch repo).
 *  - **Covenant:** the global certified-object census is byte-unchanged across a
 *    full run, and trunk (`main`) never moves.
 *  - **F2 (artifact is provider-verified):** a `settle_session` carrying a
 *    FABRICATED artifact is stripped — the ledger indexes no forged pointer.
 *  - **F3 (artifact is durable):** the receipt resolves in the durable repo.
 *  - **F1/F4 (the harness is contained):** a HOSTILE harness that attempts to
 *    move a real repo's `main` via an inherited `GIT_DIR` cannot — the real
 *    repo's trunk is byte-unchanged and no session branch leaks into it.
 */

let handle: DatabaseHandle;
let ledger: Ledger;
let repo: ScratchRepo;
let artifactRepo: ArtifactRepo;
let artifactDir: string;
let room: SeededRoom;
let agentId: string;
let humanId: string;
let agentSession: Session;
const logger = createLogger('error');

/**
 * The artifact verifier the live server wires — bound to the provider's durable
 * remote (#120 F2/F4). Round 3: this is now the PRODUCTION closure, imported, not
 * a lookalike reimplemented here. The previous local copy agreed with production
 * on the checks and silently disagreed on the pin, which is exactly the kind of
 * drift a test-owned duplicate buys you.
 */
function makeVerifier(ar: ArtifactRepo): ArtifactVerifier {
  return createArtifactVerifier(ar, logger);
}

function commandService(verifyArtifact: ArtifactVerifier | undefined = makeVerifier(artifactRepo)) {
  return createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    verifyArtifact,
  });
}

function coordinator(commands = commandService()) {
  const provider = createDeterministicShimProvider({ repo, artifactRepo });
  return createExecutionCoordinator({ commands, provider, logger });
}

/** Open a plan as the agent and return its id. */
async function openPlan(commands = commandService()): Promise<string> {
  const ack = await commands.execute(agentSession, {
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title: 'execution plan',
    budgetLimitMicros: null,
  });
  expect(ack.kind).toBe('appended');
  const [{ id } = { id: '' }] = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.roomId, room.roomId));
  return id;
}

/** Fund a plan directly — no `plan_rlimit_set` event, so the event sequence stays clean. */
async function fundPlan(planId: string, slice = 10): Promise<void> {
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = ${slice} WHERE id = ${planId}`);
}

/** The GLOBAL certified-object census — the covenant's measure (mirrors lifecycle-events). */
async function census(): Promise<{ total: number; certified: number }> {
  const [row] = await handle.db
    .select({
      total: sql<number>`count(*)::int`,
      certified: sql<number>`count(*) FILTER (WHERE ${acceptedObjects.acceptedByKind} = 'human' OR ${acceptedObjects.humanTouchedAt} IS NOT NULL)::int`,
    })
    .from(acceptedObjects);
  return row ?? { total: 0, certified: 0 };
}

/** The artifact carried in a session's exit event payload, if any. */
async function exitArtifact(
  sessionId: string,
  type: 'session_settled' | 'session_failed',
): Promise<ExecutionArtifact | null> {
  const [row] = await handle.db
    .select({ payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, type)));
  const payload = row?.payload as { sessionId?: string; artifact?: ExecutionArtifact | null };
  expect(payload?.sessionId).toBe(sessionId);
  return payload?.artifact ?? null;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  repo = await createScratchRepo();
  artifactDir = await mkdtemp(join(tmpdir(), 'atrium-durable-'));
  artifactRepo = await createArtifactRepo(artifactDir);
  room = await seedRoom(handle, ['alice', 'hexi'], { agents: ['hexi'] });
  humanId = room.people.alice as string;
  agentId = room.people.hexi as string;
  agentSession = { userId: agentId, principalKind: 'agent' };
  await handle.db.execute(
    sql`UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${room.roomId}`,
  );
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${humanId}, ${room.roomId}, 'localhost', 'claude', 'opus')
  `);
  ledger = createLedger({ db: handle.db, logger });
  await ledger.hydrate();
});

afterEach(async () => {
  await disposeScratchRepo(repo);
  await rm(artifactDir, { recursive: true, force: true });
});

afterAll(async () => {
  await handle?.close();
});

describe('a funded session runs the shim, produces an artifact, and settles indexing it', () => {
  it('settles to session_settled referencing a real, durable branch/commit', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const censusBefore = await census();
    const trunkBefore = await mainCommit(repo);

    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const sessionId = outcome.sessionId;

    // The session row settled.
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('settled');
    expect(row?.settledByEventId).toBeTruthy();

    // The exit event INDEXES the artifact — a real branch/commit in the DURABLE
    // git repo the shim pushed to (#120 F2/F3).
    const artifact = await exitArtifact(sessionId, 'session_settled');
    expect(artifact).not.toBeNull();
    expect(artifact?.branch).toBe(sessionBranch(sessionId));
    expect(artifact?.remote).toBe(artifactRepo.dir);
    // The commit the receipt names actually exists on that branch, in the DURABLE
    // repo (not just the scratch working repo).
    expect(await artifactBranchCommit(artifactRepo, sessionBranch(sessionId))).toBe(
      artifact?.commit,
    );
    expect(artifact?.commit).not.toBe(repo.seedCommit);

    // THE COVENANT: no ~ became a ✓ anywhere, and trunk never moved — the
    // artifact is a branch waiting for a human `✓`, not one the adapter landed.
    expect(await census()).toEqual(censusBefore);
    expect(await mainCommit(repo)).toBe(trunkBefore);

    // F3, durability: tearing down the scratch working repo — as shutdown does —
    // leaves the receipt still resolvable in the durable repo. Revert F3 (point
    // the artifact at the scratch repo, drop the push) and this reds: the receipt
    // would name a branch in a repo that no longer exists.
    await disposeScratchRepo(repo);
    expect(await artifactBranchCommit(artifactRepo, sessionBranch(sessionId))).toBe(
      artifact?.commit,
    );
    repo = await createScratchRepo(); // re-seed so afterEach dispose is safe

    // Exactly the two lifecycle rows landed — an open and a clean exit.
    const kinds = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId));
    expect(new Set(kinds.map((k) => k.type))).toEqual(
      new Set(['plan_opened', 'session_opened', 'session_settled']),
    );
  });

  it('settles to session_failed with a receipt and no artifact when the harness fails', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      // The reserved directive flips the deterministic harness to a failure.
      harness: 'omp',
      model: EXECUTION_FAIL_DIRECTIVE,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    const sessionId = outcome.sessionId;

    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('failed');
    expect(row?.exitSummary).toContain('failed');

    // A failed exit carries the receipt but NO artifact — no verifiable object.
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();
    // The branch exists (worktree-add forks it) but never advanced past trunk.
    expect(await branchCommit(repo, sessionBranch(sessionId))).toBe(repo.seedCommit);
  });
});

describe('the artifact is PROVIDER-VERIFIED, not a caller assertion (#120 F2, red-on-revert)', () => {
  it('strips a fabricated artifact from a settle_session — the ledger indexes no forged pointer', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // Open a real session (granted), but DO NOT let the coordinator settle it —
    // settle it ourselves, as a hostile caller would, with a FABRICATED artifact
    // that names a commit no provider ever produced and a remote we do not
    // control.
    const commands = commandService();
    const opened = await commands.execute(agentSession, {
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(opened.kind).toBe('appended');
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') return;
    const sessionId = opened.draw.sessionId;

    const forged: ExecutionArtifact = {
      branch: 'main',
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      remote: '/some/real/repo',
    };
    const settle = await commands.execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'I claim a verified artifact',
      spendMicros: null,
      contextPct: null,
      artifact: forged,
    });
    expect(settle.kind).toBe('appended');

    // The forged artifact was DROPPED — the exit event carries null, not the
    // caller's fabrication. Revert F2 (persist `command.artifact` unverified) and
    // this reds: the forged `{branch:"main",…,remote:"/some/real/repo"}` lands in
    // the ledger as a "verified artifact" it never was.
    expect(await exitArtifact(sessionId, 'session_settled')).toBeNull();

    // And even a well-formed-but-unproduced artifact — right branch name, right
    // remote, but a commit the provider never pushed — is refused.
    await resetSecondSession(planId);
  });
});

/** A second granted session whose settle claims a plausible-looking but unproduced commit. */
async function resetSecondSession(planId: string): Promise<void> {
  const commands = commandService();
  const opened = await commands.execute(agentSession, {
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
  });
  if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') return;
  const sessionId = opened.draw.sessionId;
  const plausible: ExecutionArtifact = {
    branch: sessionBranch(sessionId),
    commit: 'cafebabecafebabecafebabecafebabecafebabe',
    remote: artifactRepo.dir,
  };
  await commands.execute(agentSession, {
    name: 'settle_session',
    roomId: room.roomId,
    sessionId,
    outcome: 'settled',
    exitSummary: 'plausible but unproduced',
    spendMicros: null,
    contextPct: null,
    artifact: plausible,
  });
  const [row] = await handle.db
    .select({ payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.type, 'session_settled'), sql`payload->>'sessionId' = ${sessionId}`));
  const payload = row?.payload as { artifact?: ExecutionArtifact | null };
  // The commit does not resolve in the durable repo → the artifact is stripped.
  expect(payload?.artifact ?? null).toBeNull();
}

describe('a refused draw NEVER starts the adapter (#118, red-on-revert)', () => {
  it('runs no workspace and produces no artifact when the budget refuses the draw', async () => {
    // An UNFUNDED plan authorizes ZERO draws — every open_session refuses.
    const planId = await openPlan();
    const censusBefore = await census();

    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });

    // The draw was refused at #118's boundary, before the adapter.
    expect(outcome.kind).toBe('refused');

    // NO session rowed up…
    const sessionRows = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    expect(sessionRows).toHaveLength(0);

    // …the durable refusal receipt landed…
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'draw_refused')));
    expect(n).toBe(1);

    // …and — the guard — the adapter NEVER STARTED: not one session branch was
    // resolved in the scratch repo, and no session_opened landed.
    expect(await listSessionBranches(repo)).toEqual([]);
    const [{ opened } = { opened: 0 }] = await handle.db
      .select({ opened: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_opened')));
    expect(opened).toBe(0);

    // The covenant is untouched, and trunk never moved.
    expect(await census()).toEqual(censusBefore);
    expect(await mainCommit(repo)).toBe(repo.seedCommit);
  });
});

describe('a HOSTILE harness cannot move a real repo trunk (#120 F1/F4, red-on-revert)', () => {
  it('leaves the real repo main byte-unchanged and its session branches empty', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // A stand-in for the SERVER'S OWN repository — the one a harness must never
    // reach. Its `main` and its ref set are the covenant we protect.
    const realRepo = await createScratchRepo();
    const realMainBefore = await mainCommit(realRepo);
    const realBranchesBefore = await listSessionBranches(realRepo);

    // The hostile-server-env / hostile-harness vector: `GIT_DIR`/`GIT_WORK_TREE`
    // exported into the process, pointing every un-scrubbed git at the real repo.
    const savedGitDir = process.env.GIT_DIR;
    const savedWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(realRepo.dir, '.git');
    process.env.GIT_WORK_TREE = realRepo.dir;

    const censusBefore = await census();
    try {
      // The harness tries to commit and move `main`. Under the scrub (F1/F4) its
      // git is bound to its OWN worktree and never sees GIT_DIR, so this touches
      // the sandbox, never the real repo. `-c user.*` gives it an identity so the
      // attempt is genuine, not merely blocked by a missing committer.
      const hostile = [
        'bash',
        '-lc',
        'git -c user.name=evil -c user.email=evil@evil commit --allow-empty -m HOSTILE >/dev/null 2>&1; ' +
          'git update-ref refs/heads/main HEAD >/dev/null 2>&1; true',
      ];
      // ROUND 3 (F6): the factory itself now refuses to build the unsandboxed
      // adapter without the process-wide opt-in — this suite used to construct it
      // with no opt-in anywhere, which was the adjacent-path bypass. A test that
      // deliberately runs a HOSTILE harness on the server's own disk is exactly
      // the caller that should have to say so out loud.
      const savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
      process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
      let provider: ReturnType<typeof createWorktreeCommandProvider>;
      try {
        provider = createWorktreeCommandProvider({ repo, artifactRepo, command: hostile });
      } finally {
        if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
        else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
      }
      const outcome = await createExecutionCoordinator({
        commands: commandService(),
        provider,
        logger,
      }).openAndRun(agentSession, {
        roomId: room.roomId,
        planId,
        harness: 'omp',
        model: 'haiku',
      });
      expect(['settled', 'failed']).toContain(outcome.kind);
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedWorkTree;
    }

    // THE BOUNDARY. The real repo's trunk is byte-identical, and no session
    // branch leaked into it — the adapter's own git (F1) and the harness's git
    // (F4) both stayed inside the sandbox.
    //
    //  • Revert F4 (harness env `{...process.env, …}`): the harness inherits
    //    GIT_DIR, its `git commit`/`update-ref` land in the real repo, and real
    //    `main` MOVES → reds.
    //  • Revert F1 (git.ts no scrub): the adapter's own `worktree add` runs
    //    against the real repo, leaking a session branch into it → reds.
    expect(await mainCommit(realRepo)).toBe(realMainBefore);
    expect(await listSessionBranches(realRepo)).toEqual(realBranchesBefore);

    // The covenant census is unchanged, and no ~ became a ✓.
    expect(await census()).toEqual(censusBefore);

    await disposeScratchRepo(realRepo);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ROUND 3 — the findings both foreign lineages converged on, proven here.
 * ═══════════════════════════════════════════════════════════════════════════ */

const execGit = promisify(execFile);

/**
 * Run a git command in a repo directly, OUTSIDE the adapter's plumbing — this is
 * the test playing the part of teardown, an operator, or a rogue force-push, not
 * the seam under test. Uses the same hardened env shape so a stray `~/.gitconfig`
 * on the runner cannot change the result.
 */
async function gitIn(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execGit('git', [...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  return stdout.trim();
}

/** What a ref points at in a repo, or `null` if it does not exist. */
async function refValue(dir: string, ref: string): Promise<string | null> {
  return gitIn(dir, ['rev-parse', '--verify', '-q', ref]).catch(() => null);
}

/** Open a granted session as `who` and return its id, WITHOUT settling it. */
async function openGrantedSession(
  planId: string,
  who: Session,
  commands = commandService(),
): Promise<string> {
  const opened = await commands.execute(who, {
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
  });
  expect(opened.kind).toBe('appended');
  if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') {
    throw new Error('expected a granted draw');
  }
  return opened.draw.sessionId;
}

describe("a session's exit is its OPENER's to write (#120 r3 F3, red-on-revert)", () => {
  it('REFUSES a settle from another room member while the session is running', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // The agent opens (and, in the live server, the coordinator settles as this
    // same principal). Alice is a full, legitimate member of the room — she is
    // not an intruder, which is the point: `settle_session` was `open`-class, so
    // *any* member could write *any* session's exit receipt.
    const sessionId = await openGrantedSession(planId, agentSession);
    const alice: Session = { userId: humanId, principalKind: 'human' };
    const commands = commandService();

    // REVERT-REDS: drop the owner check in `commands.ts`'s `settle_session`
    // guard and this resolves instead of rejecting — Alice's fabricated clean
    // exit wins the one-exit predicate, the real settle then finds no open
    // session and throws, and the ledger indexes a caller-chosen outcome.
    await expect(
      commands.execute(alice, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: 'I declare this session done',
        spendMicros: null,
        contextPct: null,
        artifact: null,
      }),
    ).rejects.toThrow(/only the party that OPENED that session/);

    // NOTHING was written. The session is still open, and no exit event landed.
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('open');
    expect(row?.settledByEventId).toBeNull();
    const [{ exits } = { exits: 0 }] = await handle.db
      .select({ exits: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(
        and(
          eq(coreEvents.roomId, room.roomId),
          sql`${coreEvents.type} IN ('session_settled','session_failed')`,
        ),
      );
    expect(exits).toBe(0);

    // And the OWNER can still settle it — the gate narrows who may write the
    // receipt, it does not make the session unsettleable.
    const settled = await commands.execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'the run finished',
      spendMicros: null,
      contextPct: null,
      artifact: null,
    });
    expect(settled.kind).toBe('appended');
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('settled');
  });

  it("refuses a non-member's settle the same way it refuses any command", async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    const stranger: Session = { userId: randomUUID(), principalKind: 'human' };
    await expect(
      commandService().execute(stranger, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: null,
        spendMicros: null,
        contextPct: null,
        artifact: null,
      }),
    ).rejects.toThrow(/no membership/);
  });
});

describe('a SETTLED artifact survives teardown and GC (#120 r3 F4, red-on-revert)', () => {
  it('still resolves after the branch is deleted and the durable repo is gc-pruned', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const sessionId = outcome.sessionId;
    const artifact = await exitArtifact(sessionId, 'session_settled');
    expect(artifact).not.toBeNull();
    if (!artifact) return;

    // The receipt is indexed, so the object it names is pinned — a ref OUTSIDE
    // `refs/heads/*`, which no branch operation can reach.
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(artifact.commit);

    // Now the teardown/GC the finding is about: the mutable branch a receipt
    // indexes is deleted, and the durable repo is aggressively pruned — the
    // operation that actually destroys unreachable objects.
    await gitIn(artifactRepo.dir, ['branch', '-D', sessionBranch(sessionId)]);
    await gitIn(artifactRepo.dir, ['reflog', 'expire', '--expire=now', '--all']);
    await gitIn(artifactRepo.dir, ['gc', '--prune=now', '--quiet']);

    // The branch is genuinely gone…
    expect(await artifactBranchCommit(artifactRepo, sessionBranch(sessionId))).toBeNull();
    // …and the commit the RECEIPT indexes still resolves. REVERT-REDS: remove
    // the `pinSettledArtifact` call from `createArtifactVerifier` and this reds —
    // the object becomes unreachable, `gc --prune=now` collects it, and a settled
    // receipt permanently names nothing.
    expect(await artifactCommitResolves(artifactRepo, artifact.commit)).toBe(true);
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(artifact.commit);
  });

  /**
   * ROUND 4 F1: the settled pin is CREATE-ONCE — it never moves, even on a second
   * verify (grok's round-3 re-gauntlet probe, reproduced exactly).
   *
   * Grok EXECUTED this against the round-3 durability fix: pin session S at commit
   * C, force-update the durable session branch to a NEW commit D, verify again —
   * the round-3 `update-ref` had no old-value guard, so the pin FOLLOWED to D —
   * then delete the branch and `gc --prune=now`, and the commit C the already-
   * written receipt still names is COLLECTED. "A settled artifact is durable" was
   * falsified.
   */
  it('does not move the pin on a second verify, so C survives branch-delete + gc (grok probe)', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const sessionId = outcome.sessionId;
    const branch = sessionBranch(sessionId);
    const artifact = await exitArtifact(sessionId, 'session_settled');
    expect(artifact).not.toBeNull();
    if (!artifact) return;
    const C = artifact.commit;
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(C);

    // ── Force the durable session branch to a NEW commit D (the force-push). ──
    const work = await mkdtemp(join(tmpdir(), 'atrium-attacker-'));
    await gitIn(work, ['clone', '-q', artifactRepo.dir, '.']);
    await gitIn(work, ['checkout', '-q', branch]);
    await writeFile(join(work, 'evil.txt'), 'a commit the session never produced\n');
    await gitIn(work, ['add', '-A']);
    await gitIn(work, ['-c', 'user.name=evil', '-c', 'user.email=e@e', 'commit', '-q', '-m', 'D']);
    const D = await gitIn(work, ['rev-parse', 'HEAD']);
    expect(D).not.toBe(C);
    await gitIn(work, ['push', '-f', 'origin', `${branch}:${branch}`]);
    expect(await artifactBranchCommit(artifactRepo, branch)).toBe(D);

    // ── The SECOND verify, at D. The production verifier calls the pin. ──
    // REVERT-REDS: restore `pinSettledArtifact` to a bare `update-ref <ref> <sha>`
    // and this verify MOVES the pin to D and returns true. Create-once refuses to
    // move it: the pin cannot be re-written, so the artifact is REFUSED.
    const moved = await makeVerifier(artifactRepo)({
      sessionId,
      artifact: { branch, commit: D, remote: artifactRepo.dir },
    });
    expect(moved).toBe(false);
    // The pin never budged from C.
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(C);

    // ── Delete the branch and aggressively prune — grok's collection step. ──
    await gitIn(artifactRepo.dir, ['branch', '-D', branch]);
    await gitIn(artifactRepo.dir, ['reflog', 'expire', '--expire=now', '--all']);
    await gitIn(artifactRepo.dir, ['gc', '--prune=now', '--quiet']);

    // The branch is gone, D is unreachable and collected — but C, the commit the
    // RECEIPT names, is still pinned and still resolves. Under round 3 the pin had
    // followed to D, so C was unreachable and gc collected it → this reds.
    expect(await artifactBranchCommit(artifactRepo, branch)).toBeNull();
    expect(await artifactCommitResolves(artifactRepo, C)).toBe(true);
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(C);

    await rm(work, { recursive: true, force: true });
  });

  /**
   * ROUND 4 F1 corollary: re-pinning the SAME commit is idempotent — a second
   * verify of the unchanged artifact must not be refused just because a pin exists.
   */
  it('accepts a second verify of the SAME commit (idempotent re-pin)', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const sessionId = outcome.sessionId;
    const artifact = await exitArtifact(sessionId, 'session_settled');
    if (!artifact) return;
    // Same tuple, verified again: the pin already guarantees exactly this, so it
    // is accepted rather than refused, and the pin is unchanged.
    const again = await makeVerifier(artifactRepo)({ sessionId, artifact });
    expect(again).toBe(true);
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBe(artifact.commit);
  });

  it('pins nothing for an artifact it refuses', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const commands = commandService();
    const sessionId = await openGrantedSession(planId, agentSession, commands);

    // A plausible-looking but unproduced commit. The pin is the LAST step of the
    // verifier, so a refused artifact must leave no ref behind — otherwise the
    // settle path would be a way to make arbitrary objects permanent.
    await commands.execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'unproduced',
      spendMicros: null,
      contextPct: null,
      artifact: {
        branch: sessionBranch(sessionId),
        commit: 'cafebabecafebabecafebabecafebabecafebabe',
        remote: artifactRepo.dir,
      },
    });
    expect(await exitArtifact(sessionId, 'session_settled')).toBeNull();
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBeNull();
  });
});

describe('startup reconciles a session left open with a spent draw (#120 r3 F5, red-on-revert)', () => {
  it('drives open+spent+no-execution to session_failed', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // The wedge, built exactly as a SIGTERM mid-harness builds it: the draw is
    // granted and committed, the session row is `open`, and the process that was
    // going to settle it is gone.
    const sessionId = await openGrantedSession(planId, agentSession);
    const [before] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(before?.status).toBe('open');
    const [planBefore] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    // THE SPEND. It has already committed and it never decrements.
    expect(planBefore?.authorizedDraws).toBe(1);

    // What the next boot does, before accepting a single connection — a boot that
    // OWNS execution (round-4 F3: reconciliation is gated on that).
    const result = await reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      executionEnabled: true,
    });
    expect(result).toEqual({ found: 1, failed: 1, unreconciled: 0 });

    // REVERT-REDS: delete the `reconcileWedgedSessions` call from `index.ts` (or
    // this function's body) and the session stays `open` forever, holding a draw
    // the plan can never get back.
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
    expect(after?.settledByEventId).toBeTruthy();
    expect(after?.exitSummary).toContain('did not survive the previous process');

    // An HONEST receipt: failed, no artifact. A killed run did not settle, and
    // the reconciler does not invent a clean exit or a pointer to work nobody
    // watched finish.
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();

    // And it is IDEMPOTENT — a second boot finds nothing to do, rather than
    // trying to re-exit a session that has already taken its one exit.
    expect(
      await reconcileWedgedSessions({
        db: handle.db,
        commands: commandService(),
        logger,
        executionEnabled: true,
      }),
    ).toEqual({ found: 0, failed: 0, unreconciled: 0 });
  });

  it('leaves an already-settled session alone', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');
    expect(
      await reconcileWedgedSessions({
        db: handle.db,
        commands: commandService(),
        logger,
        executionEnabled: true,
      }),
    ).toEqual({ found: 0, failed: 0, unreconciled: 0 });
  });

  /**
   * ROUND 4 F3: reconciliation is OWNED-execution only. With execution DISABLED
   * (`EXECUTION_PROVIDER` unset — the documented external-settle mode), an `open`
   * session belongs to an outside settler and is LIVE, not dead. A boot that does
   * not own execution must leave it alone, or it destroys a live external settle
   * and fabricates a `session_failed`.
   */
  it('does NOT force-fail an open session when this boot does not own execution', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    const [before] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(before?.status).toBe('open');

    // A boot with execution DISABLED. REVERT-REDS: gate off (run reconciliation
    // unconditionally, as round-3 did) and this open session is force-failed —
    // exactly the live external settle round-4 refuses to destroy.
    const result = await reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      executionEnabled: false,
    });
    expect(result).toEqual({ found: 0, failed: 0, unreconciled: 0 });

    // The session is untouched — still open, no exit event, no fabricated receipt.
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('open');
    expect(after?.settledByEventId).toBeNull();
    const [{ exits } = { exits: 0 }] = await handle.db
      .select({ exits: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(
        and(
          eq(coreEvents.roomId, room.roomId),
          sql`${coreEvents.type} IN ('session_settled','session_failed')`,
        ),
      );
    expect(exits).toBe(0);

    // And an EXECUTION-OWNED boot still reconciles the very same wedge — the gate
    // narrows WHO reconciles, it does not make the session unreconcilable.
    const owned = await reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      executionEnabled: true,
    });
    expect(owned).toEqual({ found: 1, failed: 1, unreconciled: 0 });
    const [reconciled] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(reconciled?.status).toBe('failed');
  });
});
