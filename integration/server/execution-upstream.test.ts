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
import { createWorktreeCommandProvider } from '../../apps/server/src/execution/worktree-provider.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMembershipAuthorizer, type Session } from '../../apps/server/src/session.js';
import { openDatabase, resetDatabase, type SeededRoom, seedRoom } from '../support/harness.js';

/**
 * REAL-REPO EXECUTION MODE — THE ACCEPTANCE TEST (#141).
 *
 * The ticket's ask, executed end to end and nothing simulated: with execution
 * pointed at a fixture repo containing a known file, a session whose harness
 * DELETES that file settles with an artifact whose branch, FETCHED FROM THE
 * ARTIFACT REPO by a party that has never seen the scratch checkout, shows
 * EXACTLY that deletion against the upstream ref.
 *
 * Three things are proven together, because any one alone is satisfiable by a
 * seam that does not work:
 *
 *  1. **The diff is real.** `git diff <upstream ref> <fetched branch>` is
 *     exactly `D KEEP.txt` — one path, one status. Against the shipped
 *     empty-trunk seam this diff is the whole repository appearing from nothing.
 *  2. **A human can reach it.** The fetch is done from a THIRD repository,
 *     against the artifact `remote` the receipt names, AFTER the scratch repo is
 *     disposed — the manual-merge path the covenant leaves for the human `✓`.
 *  3. **THE UPSTREAM IS NEVER WRITTEN.** Every file in the fixture repo is
 *     hashed before and after the whole run and must be byte-identical, and its
 *     ref set must be unchanged. This is the headline invariant measured at the
 *     only place it can be measured honestly: the upstream itself, after a real
 *     session really ran.
 *
 * The FLIP is here too: the same coordinator, same provider, same harness, with
 * NO upstream configured, and the empty-trunk behaviour is byte-for-byte what
 * #120 shipped.
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

describe('a session against a seeded UPSTREAM produces a real, fetchable diff (#141)', () => {
  it("settles with a branch whose diff vs the upstream ref is EXACTLY the harness's deletion", async () => {
    const upstream = await makeUpstream();
    cleanup.push(upstream.dir);
    const upstreamBytes = await fingerprint(upstream.dir);
    const upstreamRefs = await refs(upstream.dir);

    const seed = { url: upstream.dir, ref: 'main' };
    scratch = await createScratchRepo(undefined, seed);
    const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-141-artifacts-'));
    cleanup.push(artifactDir);
    const artifactRepo = await createArtifactRepo(artifactDir, seed);

    // THE SEEDED TRUNK: `main` in the scratch repo IS the upstream commit, so a
    // worktree forks the real tree rather than an empty README.
    expect(scratch.seedCommit).toBe(upstream.commit);
    expect(await mainCommit(scratch)).toBe(upstream.commit);

    const commands = commandService(artifactRepo);
    const planId = await openPlan(commands);
    const censusBefore = await census();

    // THE HARNESS: it deletes the known file. Nothing else.
    const provider = createWorktreeCommandProvider({
      repo: scratch,
      artifactRepo,
      command: ['bash', '-lc', `rm ${KNOWN_FILE}`],
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

    // THE DIFF, against the UPSTREAM REF — exactly one path, exactly a deletion.
    // REVERT-REDS: drop the seeding from `createScratchRepo` and this diff
    // becomes "every file in the branch, added from nothing" — the shipped
    // empty-trunk behaviour the ticket calls out.
    const diff = await gitIn(human, ['diff', '--name-status', upstream.commit, 'FETCH_HEAD']);
    expect(diff).toBe(`D\t${KNOWN_FILE}`);
    // The other upstream file survived — the branch is the real tree minus one
    // path, not a fresh commit that happens to lack the file.
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

  it('THE FLIP — with no upstream configured, the empty-trunk seam is unchanged', async () => {
    scratch = await createScratchRepo();
    const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-141-artifacts-'));
    cleanup.push(artifactDir);
    const artifactRepo = await createArtifactRepo(artifactDir);
    expect(scratch.upstream).toBeUndefined();
    expect(artifactRepo.upstreamPath).toBeUndefined();

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
