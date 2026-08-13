import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, coreEvents, plans, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ArtifactVerifier, createCommandService } from '../../apps/server/src/commands.js';
import { createExecutionCoordinator } from '../../apps/server/src/execution/coordinator.js';
import {
  type ArtifactRepo,
  artifactBranchCommit,
  branchCommit,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  listSessionBranches,
  mainCommit,
  type ScratchRepo,
  sessionBranch,
} from '../../apps/server/src/execution/git.js';
import type { ExecutionArtifact } from '../../apps/server/src/execution/provider.js';
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

/** The artifact verifier the live server wires — bound to the provider's durable remote (#120 F2). */
function makeVerifier(ar: ArtifactRepo): ArtifactVerifier {
  return async ({ sessionId, artifact }) => {
    if (artifact.branch !== sessionBranch(sessionId)) return false;
    if (artifact.remote !== ar.dir) return false;
    const resolved = await artifactBranchCommit(ar, artifact.branch);
    return resolved !== null && resolved === artifact.commit;
  };
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
      const provider = createWorktreeCommandProvider({ repo, artifactRepo, command: hostile });
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
