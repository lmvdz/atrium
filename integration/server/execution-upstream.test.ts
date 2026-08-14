import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, coreEvents, plans, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../../apps/server/src/commands.js';
import {
  createArtifactVerifier,
  createExecutionOwnership,
} from '../../apps/server/src/execution/configure.js';
import { createExecutionCoordinator } from '../../apps/server/src/execution/coordinator.js';
import {
  type ArtifactRepo,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  mainCommit,
  type ScratchRepo,
  sessionBranch,
} from '../../apps/server/src/execution/git.js';
import type { ExecutionArtifact } from '../../apps/server/src/execution/provider.js';
import {
  createDeterministicShimProvider,
  SHIM_ARTIFACT_PATH,
} from '../../apps/server/src/execution/shim.js';
import {
  createWorktreeCommandProvider,
  WORKTREE_UPSTREAM_SEED_REFUSAL,
} from '../../apps/server/src/execution/worktree-provider.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMembershipAuthorizer, type Session } from '../../apps/server/src/session.js';
import { openDatabase, resetDatabase, type SeededRoom, seedRoom } from '../support/harness.js';

/**
 * REAL-REPO EXECUTION MODE — THE ACCEPTANCE TEST (#141, rewritten for r4).
 *
 * Round 4 REMOVED the capability to run a seeded upstream on the unsandboxed
 * worktree provider (it was gated behind a `containedUpstreamSeed` boolean that
 * was not containment — any direct caller could flip it and build the forbidden
 * provider, whose harness then redirects the push into the upstream). Real-repo
 * EXECUTION — running an arbitrary harness against a real repo — moves to the
 * #138 sandbox provider, which contains the harness. So this file no longer
 * constructs a worktree provider over a seeded upstream; it asserts the REMOVAL.
 *
 * What it proves, end to end and nothing simulated:
 *
 *  1. **The worktree provider REFUSES a seeded upstream — there is no seam.**
 *     `createWorktreeCommandProvider({ repo: seeded, … })` throws, unconditionally.
 *     This is the red-on-revert witness for the removed capability: re-add any
 *     bypass and this test builds a live provider instead of throwing.
 *  2. **The seeded-trunk MECHANISM still works — on the SHIM, the safe provider
 *     that survives.** The shim runs no harness (nothing can rewrite a push
 *     config), so real-repo mode is legitimate on it and stays. Pointed at a
 *     fixture repo, a shim session settles with an artifact whose branch —
 *     FETCHED FROM THE ARTIFACT REPO by a party that never saw the scratch
 *     checkout, AFTER that scratch repo is disposed — forks the real upstream
 *     commit (its parent IS the upstream commit) and carries a real diff against
 *     the upstream ref. This is the seeded-trunk plumbing #138 will reuse, kept
 *     under an acceptance test through its one surviving live caller.
 *  3. **THE UPSTREAM IS NEVER WRITTEN.** Every file in the fixture repo is hashed
 *     before and after the whole run and must be byte-identical, and its ref set
 *     must be unchanged — measured at the only place it can be measured honestly.
 *
 * The FLIP is here too: the empty-trunk WORKTREE path (no upstream configured) is
 * byte-for-byte what #120 shipped — the worktree provider is now empty-trunk only.
 *
 * The boot refusal of `EXECUTION_PROVIDER=worktree` + upstream has its own witness
 * at the config layer in `apps/server/test/execution/upstream-guards.test.ts`; the
 * factory refusal is witnessed both there and here.
 */

const run = promisify(execFile);
const logger = createLogger('error');
const TEST_INSTANCE_ID = 'test-instance-141';

let handle: DatabaseHandle;
let ledger: Ledger;
let room: SeededRoom;
let agentId: string;
let humanId: string;
let agentSession: Session;

/** Git in a directory, outside the seam — the test playing human, never the adapter. */
async function gitIn(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], {
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

/** THE FIXTURE UPSTREAM — a real repo with a known file a session will delete. */
const KNOWN_FILE = 'KEEP.txt';
async function makeUpstream(): Promise<{ dir: string; commit: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-141-upstream-'));
  await gitIn(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, KNOWN_FILE), 'the known file the harness deletes\n');
  await writeFile(join(dir, 'untouched.txt'), 'not part of the diff\n');
  await gitIn(dir, ['add', '-A']);
  await gitIn(dir, [
    '-c',
    'user.name=upstream',
    '-c',
    'user.email=up@example',
    'commit',
    '-q',
    '-m',
    'upstream: the repo a session forks',
  ]);
  return { dir, commit: await gitIn(dir, ['rev-parse', 'HEAD']) };
}

/**
 * A content hash over every file in a directory — paths and bytes. The measure
 * THE UPSTREAM IS NEVER WRITTEN is stated in: a new loose object, a moved ref, a
 * rewritten config, a `gc` repack all move it.
 */
async function fingerprint(dir: string): Promise<string> {
  const { stdout } = await run('bash', [
    '-c',
    `cd ${JSON.stringify(dir)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`,
  ]);
  return stdout.trim();
}

/** Every ref in a repo, as a stable string — the second, sharper immutability read. */
async function refs(dir: string): Promise<string> {
  return gitIn(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

function commandService(artifactRepo: ArtifactRepo) {
  return createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    verifyArtifact: createArtifactVerifier(artifactRepo, logger),
    executionInstanceId: TEST_INSTANCE_ID,
  });
}

async function openPlan(commands: ReturnType<typeof commandService>): Promise<string> {
  const ack = await commands.execute(agentSession, {
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title: 'real-repo plan',
    budgetLimitMicros: null,
    causeMessageId: null,
  });
  expect(ack.kind).toBe('appended');
  const [{ id } = { id: '' }] = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.roomId, room.roomId));
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = 10 WHERE id = ${id}`);
  return id;
}

/** The artifact carried on a session's exit event. */
async function exitArtifact(sessionId: string): Promise<ExecutionArtifact | null> {
  const [row] = await handle.db
    .select({ payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_settled')));
  const payload = row?.payload as { sessionId?: string; artifact?: ExecutionArtifact | null };
  expect(payload?.sessionId).toBe(sessionId);
  return payload?.artifact ?? null;
}

/** The GLOBAL certified-object census — the covenant's measure. */
async function census(): Promise<{ total: number; certified: number }> {
  const [row] = await handle.db
    .select({
      total: sql<number>`count(*)::int`,
      certified: sql<number>`count(*) FILTER (WHERE ${acceptedObjects.acceptedByKind} = 'human' OR ${acceptedObjects.humanTouchedAt} IS NOT NULL)::int`,
    })
    .from(acceptedObjects);
  return row ?? { total: 0, certified: 0 };
}

const cleanup: string[] = [];
let scratch: ScratchRepo | null = null;
let savedOptIn: string | undefined;

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
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
  // The worktree provider is the real-command adapter #141 is about, and it is
  // opt-in by design (#120 F1) — a suite that runs a real harness on this disk
  // says so out loud, exactly as an operator has to.
  savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
  process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
});

afterEach(async () => {
  if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
  else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
  if (scratch) await disposeScratchRepo(scratch);
  scratch = null;
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await handle?.close();
});

describe('real-repo mode: removed from the worktree provider, alive on the shim (#141 r4)', () => {
  it('the worktree provider REFUSES a seeded upstream — the removed capability, no seam through', async () => {
    // THE REMOVAL WITNESS. Round 3 let a direct caller build this provider over a
    // seeded upstream by passing `containedUpstreamSeed: true`; round 4 deleted
    // that boolean. A seeded scratch repo handed to the worktree factory now
    // throws, unconditionally — there is nothing to opt into.
    //
    // REVERT-REDS: re-introduce any bypass (the `containedUpstreamSeed` seam, or
    // weaken the `repo.upstream !== undefined` refusal) and this constructs a LIVE
    // provider that would run an arbitrary harness against a real upstream — the
    // `expect.unreachable` fires instead of the throw.
    const upstream = await makeUpstream();
    cleanup.push(upstream.dir);
    const seed = { url: upstream.dir, ref: 'main' };
    scratch = await createScratchRepo(undefined, seed);
    const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-141-artifacts-'));
    cleanup.push(artifactDir);
    const artifactRepo = await createArtifactRepo(artifactDir, seed);

    let message = '';
    try {
      createWorktreeCommandProvider({
        repo: scratch,
        artifactRepo,
        command: ['bash', '-lc', `rm ${KNOWN_FILE}`],
      });
      expect.unreachable('the worktree provider must refuse a seeded upstream');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(WORKTREE_UPSTREAM_SEED_REFUSAL);
    expect(message).toContain('#138');
  });

  it('the SHIM settles a branch that forks the real upstream and leaves it byte-identical', async () => {
    // THE SEEDED-TRUNK MECHANISM, exercised through its one surviving live caller.
    // The shim runs no harness, so real-repo mode is safe on it (nothing can
    // rewrite a push config) — and the seeded-trunk plumbing #138 will reuse is
    // kept honest by an end-to-end acceptance run here.
    const upstream = await makeUpstream();
    cleanup.push(upstream.dir);
    const upstreamBytes = await fingerprint(upstream.dir);
    const upstreamRefs = await refs(upstream.dir);

    const seed = { url: upstream.dir, ref: 'main' };
    scratch = await createScratchRepo(undefined, seed);
    const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-141-artifacts-'));
    cleanup.push(artifactDir);
    const artifactRepo = await createArtifactRepo(artifactDir, seed);
    // The artifact repo STATES its provenance (#141 r4): a local upstream path,
    // never an absent field. `pushArtifactBranch`'s guard reads this at the write.
    expect(artifactRepo.upstreamPath).toBe(upstream.dir);

    // THE SEEDED TRUNK: `main` in the scratch repo IS the upstream commit, so a
    // worktree forks the real tree rather than an empty README.
    expect(scratch.seedCommit).toBe(upstream.commit);
    expect(await mainCommit(scratch)).toBe(upstream.commit);

    const commands = commandService(artifactRepo);
    const planId = await openPlan(commands);
    const censusBefore = await census();

    const provider = createDeterministicShimProvider({ repo: scratch, artifactRepo });
    const outcome = await createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: createExecutionOwnership({
        db: handle.db,
        instanceId: TEST_INSTANCE_ID,
        logger,
      }),
    }).openAndRun(agentSession, { roomId: room.roomId, planId, harness: 'omp', model: 'haiku' });

    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const artifact = await exitArtifact(outcome.sessionId);
    expect(artifact).not.toBeNull();
    if (!artifact) return;
    expect(artifact.branch).toBe(sessionBranch(outcome.sessionId));
    expect(artifact.remote).toBe(artifactRepo.dir);

    // ── THE MANUAL-MERGE PATH ────────────────────────────────────────────────
    // Dispose the scratch repo FIRST — as shutdown does — so what follows can
    // only be reaching the durable artifact remote, never the working checkout.
    await disposeScratchRepo(scratch);
    scratch = null;

    // A human's own repository, which has never seen this session: fetch the
    // artifact branch from the remote the receipt names.
    const human = await mkdtemp(join(tmpdir(), 'atrium-141-human-'));
    cleanup.push(human);
    await gitIn(human, ['init', '-q', '-b', 'main']);
    await gitIn(human, ['fetch', '--no-tags', '-q', '--', artifact.remote, artifact.branch]);
    expect(await gitIn(human, ['rev-parse', 'FETCH_HEAD'])).toBe(artifact.commit);

    // THE DIFF, against the UPSTREAM REF — the shim's artifact, added atop the
    // REAL tree. REVERT-REDS: drop the seeding from `createScratchRepo` and this
    // diff becomes "every file in the branch, added from nothing" — the shipped
    // empty-trunk behaviour the ticket calls out — plus the parent check below
    // stops resolving to the upstream commit.
    const diff = await gitIn(human, ['diff', '--name-status', upstream.commit, 'FETCH_HEAD']);
    expect(diff).toBe(`A\t${SHIM_ARTIFACT_PATH}`);
    // The upstream's own files survived untouched — the branch is the real tree
    // plus the shim's artifact, not a fresh commit that merely resembles it.
    expect(await gitIn(human, ['show', `FETCH_HEAD:${KNOWN_FILE}`])).toBe(
      'the known file the harness deletes',
    );
    expect(await gitIn(human, ['show', 'FETCH_HEAD:untouched.txt'])).toBe('not part of the diff');
    // And the artifact commit's PARENT is the upstream commit: the branch is
    // genuinely forked from the upstream ref, not merely similar to it.
    expect(await gitIn(human, ['rev-parse', 'FETCH_HEAD^'])).toBe(upstream.commit);

    // ── THE HEADLINE INVARIANT, MEASURED ─────────────────────────────────────
    // THE UPSTREAM IS NEVER WRITTEN: byte-identical, ref-for-ref unchanged,
    // after a real session really ran against it.
    expect(await fingerprint(upstream.dir)).toBe(upstreamBytes);
    expect(await refs(upstream.dir)).toBe(upstreamRefs);
    // Nothing resembling a session branch reached it.
    expect(await gitIn(upstream.dir, ['branch', '--list', 'atrium/*'])).toBe('');

    // THE COVENANT: no ~ became a ✓, and the artifact is a branch — the durable
    // repo has no `main` for it to have landed on.
    expect(await census()).toEqual(censusBefore);
    expect(
      await gitIn(artifactRepo.dir, ['rev-parse', '--verify', '-q', 'refs/heads/main']).catch(
        () => null,
      ),
    ).toBeNull();

    const [row] = await handle.db
      .select({ status: sessions.status, stored: sessions.artifact })
      .from(sessions)
      .where(eq(sessions.id, outcome.sessionId));
    expect(row?.status).toBe('settled');
    expect(row?.stored).toEqual({ branch: artifact.branch, commit: artifact.commit });
  });

  it('THE FLIP — with no upstream configured, the empty-trunk WORKTREE seam is unchanged', async () => {
    scratch = await createScratchRepo();
    const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-141-artifacts-'));
    cleanup.push(artifactDir);
    const artifactRepo = await createArtifactRepo(artifactDir);
    expect(scratch.upstream).toBeUndefined();
    // The mandatory provenance field is present and explicitly `null` — "no local
    // upstream", stated, not communicated by absence (#141 r4).
    expect(artifactRepo.upstreamPath).toBeNull();

    const commands = commandService(artifactRepo);
    const planId = await openPlan(commands);
    const trunkBefore = await mainCommit(scratch);

    const provider = createWorktreeCommandProvider({
      repo: scratch,
      artifactRepo,
      command: ['bash', '-lc', 'printf work > WORK.txt'],
    });
    const outcome = await createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: createExecutionOwnership({
        db: handle.db,
        instanceId: TEST_INSTANCE_ID,
        logger,
      }),
    }).openAndRun(agentSession, { roomId: room.roomId, planId, harness: 'omp', model: 'haiku' });

    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const artifact = await exitArtifact(outcome.sessionId);
    expect(artifact).not.toBeNull();
    if (!artifact) return;

    const human = await mkdtemp(join(tmpdir(), 'atrium-141-human-'));
    cleanup.push(human);
    await gitIn(human, ['init', '-q', '-b', 'main']);
    await gitIn(human, ['fetch', '--no-tags', '-q', '--', artifact.remote, artifact.branch]);
    // The seed commit still holds ONLY `README.atrium`, and the branch is that
    // plus the harness's file — #120's behaviour, byte for byte.
    expect(await gitIn(human, ['ls-tree', '--name-only', trunkBefore])).toBe('README.atrium');
    expect(await gitIn(human, ['diff', '--name-status', trunkBefore, 'FETCH_HEAD'])).toBe(
      'A\tWORK.txt',
    );
    expect(await mainCommit(scratch)).toBe(trunkBefore);
  });
});
