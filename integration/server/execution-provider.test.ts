import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, coreEvents, plans, sessionSignals, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ArtifactVerifier, createCommandService } from '../../apps/server/src/commands.js';
import {
  createArtifactVerifier,
  createExecutionOwnership,
} from '../../apps/server/src/execution/configure.js';
import { createExecutionCoordinator } from '../../apps/server/src/execution/coordinator.js';
import {
  type ArtifactRepo,
  addWorktree,
  artifactBranchCommit,
  artifactCommitResolves,
  branchCommit,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  listSessionBranches,
  mainCommit,
  readFileAtBranch,
  removeWorktree,
  type ScratchRepo,
  sessionBranch,
  settledArtifactRef,
} from '../../apps/server/src/execution/git.js';
import type {
  ExecutionArtifact,
  ExecutionProvider,
  SessionContext,
  Workspace,
} from '../../apps/server/src/execution/provider.js';
import { reconcileWedgedSessions } from '../../apps/server/src/execution/reconcile.js';
import {
  createDeterministicShimProvider,
  EXECUTION_AWAIT_STEER_DIRECTIVE,
  EXECUTION_FAIL_DIRECTIVE,
  SHIM_ARTIFACT_PATH,
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
 *  - **F1/F4 (INHERITED-env retarget is closed):** a harness that exports
 *    `GIT_DIR`/`GIT_WORK_TREE` into the process cannot retarget the adapter's own
 *    git through the env — the allowlist copies neither into a git process. This
 *    is NOT a claim that the worktree provider contains a hostile harness: it is
 *    opt-in, dev-only, and NOT a security boundary (a same-UID harness can plant
 *    hooks/filters, rewrite `.git`, redirect pushes, and reach any path this UID
 *    can). The real boundary is the BUY sandbox seam. This asserts only the one
 *    inherited-env vector the allowlist actually closes.
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

/** This test process's execution instance id — stamped on leases the coordinator claims. */
const TEST_INSTANCE_ID = 'test-instance';

/**
 * The execution-ENABLED command service (#120 round-6): `executionInstanceId` set,
 * so a granted `open_session` records a `provider`-mode execution-authority record
 * (owner = this instance, a capability token) in the same transaction as the draw.
 * This is what makes the capability, clean-settle, and lease-at-grant rules apply.
 */
function commandService(verifyArtifact: ArtifactVerifier | undefined = makeVerifier(artifactRepo)) {
  return createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    verifyArtifact,
    executionInstanceId: TEST_INSTANCE_ID,
  });
}

/**
 * The execution-DISABLED command service — no `executionInstanceId`, no verifier —
 * so a granted session is `external`-mode (unleased, external-settle). Used where a
 * test needs the pre-provider mode (e.g. the unleased-external reconcile case).
 */
function externalCommandService() {
  return createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
  });
}

/** The capability token a provider session was minted at grant — read off the row. */
async function sessionAuthority(sessionId: string): Promise<string> {
  const [row] = await handle.db
    .select({ authority: sessions.executionAuthority })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const authority = row?.authority;
  if (!authority) throw new Error(`session ${sessionId} has no execution_authority`);
  return authority;
}

function ownership(instanceId = TEST_INSTANCE_ID) {
  return createExecutionOwnership({ db: handle.db, instanceId, logger });
}

function coordinator(commands = commandService(), owns = ownership()) {
  const provider = createDeterministicShimProvider({ repo, artifactRepo });
  return createExecutionCoordinator({ commands, provider, logger, ownership: owns });
}

/** Open a plan as the agent and return its id. */
async function openPlan(commands = commandService()): Promise<string> {
  const ack = await commands.execute(agentSession, {
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title: 'execution plan',
    budgetLimitMicros: null,
    causeMessageId: null,
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

    // The lifecycle rows landed — an open, the durable phase timeline the run
    // streamed (#159), and a clean exit. `session_phase_changed` is ledger-only and
    // never folded (`isCoreEvent` false), so the covenant census below is unmoved by
    // it; the coordinator now wires the shim's `onProgress`, so a full run appends the
    // phase timeline as genuine history.
    const kinds = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId));
    expect(new Set(kinds.map((k) => k.type))).toEqual(
      new Set(['plan_opened', 'session_opened', 'session_phase_changed', 'session_settled']),
    );
  });

  /**
   * THE #120×#121 SEAM — the produced artifact is exactly what the control
   * plane certifies. #120's ExecutionProvider mints the artifact onto the exit
   * EVENT ({branch, commit, remote}); #121's certify surface reads the
   * `sessions.artifact` COLUMN (a `SessionArtifact`). The two were built apart —
   * #120's settle projection wrote no column (there was none) and #121's column
   * named #120 as "the eventual writer at settle time" without one — so on the
   * merged tree the artifact reached the event but not the column, and certify
   * saw `no_artifact`. The integration fix makes `projectSessionExit` persist the
   * event's branch+commit into `sessions.artifact`, so a human reviews and lands
   * exactly what execution produced.
   *
   * REVERT-REDS: drop the `artifact:` write from `projectSessionExit` and this
   * reds — `sessions.artifact` stays null and the certify surface has nothing to
   * be a signature of.
   */
  it('persists the produced artifact into sessions.artifact for the control plane to certify', async () => {
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

    // What #120 PRODUCED, read off the exit event it indexed.
    const produced = await exitArtifact(sessionId, 'session_settled');
    expect(produced).not.toBeNull();
    if (!produced) return;

    // What #121's control plane READS — the sessions.artifact column.
    const [row] = await handle.db
      .select({ artifact: sessions.artifact })
      .from(sessions)
      .where(eq(sessions.id, sessionId));

    // The column carries exactly the produced branch+commit AND the #145
    // enrichment (real structured diff + test report) — the identity that composes
    // the two seams. `remote` is #120's internal scratch pointer and is NOT a
    // review fact, so it is not copied into the column.
    expect(produced.diff).toBeDefined();
    expect(produced.tests).toBeDefined();
    expect(row?.artifact).toEqual({
      branch: produced.branch,
      commit: produced.commit,
      diff: produced.diff,
      tests: produced.tests,
    });
    expect(row?.artifact).not.toHaveProperty('remote');
    expect(row?.artifact?.branch).toBe(sessionBranch(sessionId));
    expect(row?.artifact?.commit).toBe(produced.commit);
    // The diff carried real hunks (the session id lives inside ARTIFACT.json), so
    // the control plane renders the actual change — not a summary, not a stub.
    const diffBody = (produced.diff?.files ?? [])
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .join('\n');
    expect(diffBody).toContain(sessionId);
  });

  /**
   * THE PINNED WRITE-SET (#145; the #127/#128 lesson). A settle carries the #145
   * enrichment (a real per-file diff + a test report) INTO `sessions.artifact` —
   * and it must still write NOTHING on the covenant/budget tables. This folds JUST
   * the settle (the open, which increments `authorized_draws`, is already done and
   * snapshotted around) and asserts `accepted_objects`, `plans.authorized_draws`
   * and `plans.rlimit_slice` are BYTE-STABLE across it, while proving the diff/tests
   * did land in the column. Revert `projectSessionExit` to write those tables and
   * this reds; a settle has no route to a `✓` or a draw.
   */
  it('pins the settle write-set: folding a settle with diff+tests moves accepted_objects / authorized_draws / rlimit_slice by nothing', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);

    // Open (granted) — the draw increments `authorized_draws` HERE, before the snap.
    const opened = await commands.execute(agentSession, {
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
      causeMessageId: null,
    });
    expect(opened.kind).toBe('appended');
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') {
      throw new Error('open_session was not granted');
    }
    const sessionId = opened.draw.sessionId;

    const writeSet = async () => {
      const [plan] = await handle.db
        .select({
          authorizedDraws: plans.authorizedDraws,
          rlimitSlice: plans.rlimitSlice,
        })
        .from(plans)
        .where(eq(plans.id, planId));
      return { census: await census(), plan };
    };
    const before = await writeSet();

    // Drive JUST the settle: claim → run the shim (produces the diff+tests) → settle.
    const outcome = await coordinator(commands).runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');

    // The settle WROTE the enrichment into the column…
    const [row] = await handle.db
      .select({ artifact: sessions.artifact, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('settled');
    expect(row?.artifact?.diff?.files.length).toBeGreaterThan(0);
    expect(row?.artifact?.tests).toBeDefined();

    // …and yet the covenant/budget tables are byte-identical across the settle.
    expect(await writeSet()).toEqual(before);
  });

  it('leaves sessions.artifact null on a failed exit — nothing for a signature to sign', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    const outcome = await coordinator().openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: EXECUTION_FAIL_DIRECTIVE,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;

    const [row] = await handle.db
      .select({ artifact: sessions.artifact, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, outcome.sessionId));
    expect(row?.status).toBe('failed');
    expect(row?.artifact).toBeNull();
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
  it('REFUSES a clean settle whose artifact the provider never produced', async () => {
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
      causeMessageId: null,
    });
    expect(opened.kind).toBe('appended');
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') return;
    const sessionId = opened.draw.sessionId;

    const forged: ExecutionArtifact = {
      branch: 'main',
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      remote: '/some/real/repo',
    };
    // The forged artifact fails verification → drops to null → and a CLEAN settle
    // with no provider-verified artifact is REFUSED outright (#120 r5 F2). The
    // caller presents the session's real capability token (round 6) so it clears
    // the provider-capability gate and reaches the ARTIFACT rule under test — a
    // hostile wire caller could not, but that is what the capability test proves
    // separately; here the artifact rule itself is exercised.
    await expect(
      commands.execute(agentSession, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: 'I claim a verified artifact',
        spendMicros: null,
        contextPct: null,
        artifact: forged,
        authority: await sessionAuthority(sessionId),
      }),
    ).rejects.toThrow(/provider-verified artifact/);

    // No session_settled event exists for this session — nothing was appended.
    expect(await settledEventCount(sessionId)).toBe(0);

    // And even a well-formed-but-unproduced artifact — right branch name, right
    // remote, but a commit the provider never pushed — is refused the same way.
    await resetSecondSession(planId);
  });
});

/** How many `session_settled` rows name this session — 0 when the clean settle was refused. */
async function settledEventCount(sessionId: string): Promise<number> {
  const rows = await handle.db
    .select({ id: coreEvents.id })
    .from(coreEvents)
    .where(and(eq(coreEvents.type, 'session_settled'), sql`payload->>'sessionId' = ${sessionId}`));
  return rows.length;
}

/** A second granted session whose settle claims a plausible-looking but unproduced commit. */
async function resetSecondSession(planId: string): Promise<void> {
  const commands = commandService();
  const opened = await commands.execute(agentSession, {
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
    causeMessageId: null,
  });
  if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') return;
  const sessionId = opened.draw.sessionId;
  const plausible: ExecutionArtifact = {
    branch: sessionBranch(sessionId),
    commit: 'cafebabecafebabecafebabecafebabecafebabe',
    remote: artifactRepo.dir,
  };
  // The commit does not resolve in the durable repo → verification fails → the
  // clean settle is refused (#120 r5 F2), so no session_settled row is written.
  await expect(
    commands.execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'plausible but unproduced',
      spendMicros: null,
      contextPct: null,
      artifact: plausible,
      authority: await sessionAuthority(sessionId),
    }),
  ).rejects.toThrow(/provider-verified artifact/);
  expect(await settledEventCount(sessionId)).toBe(0);
}

describe("the artifact's diff/tests are schema-checked at the settle boundary (#145 r3 FIX 1, red-on-revert)", () => {
  it('REFUSES an in-process settle whose diff is incoherent — not persisted, not deferred to replay', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // Open a real granted session, then settle it OURSELVES with a CONSTRUCTED
    // command object — exactly what the in-process coordinator does when it
    // forwards a provider `ExecutionReport`. That path reaches `execute()` WITHOUT
    // `Command.parse`, so the `SessionDiff` coherence refine (files-empty ⟺
    // totals-zero) never ran on the wire. The artifact below is otherwise
    // well-formed — real-looking branch/commit/remote strings — but its diff
    // DECLARES one changed file while carrying none: the incoherent "no changes"
    // lie the durable schema rejects. The real session authority is presented so
    // the ONLY defect is the diff itself.
    //
    // The command service is wired with a PERMISSIVE verifier (always true) so the
    // branch/commit passes the #120 provider-verification and clean-settle gates —
    // ISOLATING the FIX 1 schema check as the only thing that can reject the
    // incoherent diff. Without this, a fabricated commit would be refused by the
    // downstream "no provider-verified artifact" rule and the schema guard would
    // never be exercised. With the permissive verifier, revert the guard and this
    // incoherent diff settles durably (see the revert assertions in the comment
    // below); keep it and the diff is refused at the command boundary.
    const commands = commandService(async () => true);
    const opened = await commands.execute(agentSession, {
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
      causeMessageId: null,
    });
    expect(opened.kind).toBe('appended');
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') return;
    const sessionId = opened.draw.sessionId;

    const incoherent: ExecutionArtifact = {
      branch: sessionBranch(sessionId),
      commit: 'cafebabecafebabecafebabecafebabecafebabe',
      remote: artifactRepo.dir,
      // FILES EMPTY yet totals non-zero — the biconditional the refine enforces.
      diff: { files: [], fileCount: 1, additions: 1, deletions: 0, truncated: false },
    };

    // The settle boundary re-parses the artifact through `ExecutionArtifact` and
    // REFUSES the incoherent diff at the command — before the append, before any
    // git verification — rather than persisting a row that reds only on the next
    // read.
    await expect(
      commands.execute(agentSession, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: 'a coherent-looking receipt over an incoherent diff',
        spendMicros: null,
        contextPct: null,
        artifact: incoherent,
        authority: await sessionAuthority(sessionId),
      }),
    ).rejects.toThrow(/artifact is malformed and would break replay/);

    // Nothing was appended — no session_settled row carries the incoherent diff.
    expect(await settledEventCount(sessionId)).toBe(0);
    // And the session is still open (the refused settle wrote no terminal).
    const [row] = await handle.db
      .select({ status: sessions.status, artifact: sessions.artifact })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('open');
    expect(row?.artifact).toBeNull();
    // RED ON REVERT: drop the `ExecutionArtifact.safeParse(command.artifact)` guard
    // at the settle boundary and this incoherent diff is appended durably, deferring
    // rejection to a later read.
  });
});

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

describe('the INHERITED-env retarget vector is closed (#120 F1/F4, red-on-revert)', () => {
  // SCOPE, STATED HONESTLY (#120 round-5 F6): this proves ONLY that an inherited
  // `GIT_DIR`/`GIT_WORK_TREE` does not retarget the adapter's or the harness's git
  // — the vector the env allowlist closes. It does NOT prove the worktree provider
  // "contains" a hostile harness. It cannot: the provider is opt-in, dev-only, and
  // NOT a security boundary. A same-UID harness can plant hooks in the shared
  // hooks dir, set `filter.clean`/`commit.gpgsign` to run code, redirect a push
  // with `url.insteadOf`, or `cd` to any path this UID can reach. Those are the
  // unsandboxed provider being unsandboxed, by design — the real boundary is the
  // BUY sandbox. The assertion below is the inherited-env retarget, and nothing
  // stronger.
  it('an inherited GIT_DIR does not retarget the adapter, leaving the real repo untouched', async () => {
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
      // The harness tries to commit and move `main` via the inherited GIT_DIR.
      // Under the allowlist its git does not receive GIT_DIR, so this touches its
      // own worktree, never the real repo. `-c user.*` gives it an identity so the
      // attempt is genuine, not merely blocked by a missing committer. (Only the
      // inherited-env vector is exercised here — not the same-UID vectors the
      // provider does not, and cannot, contain.)
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
        ownership: ownership(),
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

    // THE INHERITED-ENV VECTOR, CLOSED. The real repo's trunk is byte-identical
    // and no session branch leaked into it — neither the adapter's own git (F1)
    // nor the harness's git (F4) followed the inherited GIT_DIR. This is NOT a
    // containment proof (see the scope note above): it is exactly the assertion
    // that an exported GIT_DIR/GIT_WORK_TREE is not honored, and no more.
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
    causeMessageId: null,
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
    // receipt, it does not make the session unsettleable. Settled as `failed`
    // (artifact null). This is a provider session, so the settle also carries its
    // capability token (round 6) — the coordinator/reconciler hold it; a hand-
    // driven settle here presents the row's token to stand in for that holder.
    const settled = await commands.execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'failed',
      exitSummary: 'the run finished',
      spendMicros: null,
      contextPct: null,
      artifact: null,
      authority: await sessionAuthority(sessionId),
    });
    expect(settled.kind).toBe('appended');
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
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
    // settle path would be a way to make arbitrary objects permanent. Under #120
    // r5 F2 a clean settle whose artifact fails verification is REFUSED, so the
    // settle throws and nothing — no event, no pin — is written.
    await expect(
      commands.execute(agentSession, {
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
        authority: await sessionAuthority(sessionId),
      }),
    ).rejects.toThrow(/provider-verified artifact/);
    expect(await settledEventCount(sessionId)).toBe(0);
    expect(await refValue(artifactRepo.dir, settledArtifactRef(sessionId))).toBeNull();
  });
});

describe('a clean settle needs provider evidence (#120 r5 F2, red-on-revert)', () => {
  it('REFUSES outcome:"settled" with a null artifact on a running session', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    const commands = commandService();

    // The opener (owner + token) tries to declare a clean exit with NO provider
    // artifact, mid-run. REVERT-REDS: remove the "settled needs a verified
    // artifact" refusal and this appends a fabricated clean exit that wins the
    // one-exit race with no provider evidence. The token is presented so the check
    // under test is the artifact rule, not the capability gate.
    await expect(
      commands.execute(agentSession, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: 'done, trust me',
        spendMicros: null,
        contextPct: null,
        artifact: null,
        authority: await sessionAuthority(sessionId),
      }),
    ).rejects.toThrow(/provider-verified artifact/);

    // Nothing was written; the session is still open.
    expect(await settledEventCount(sessionId)).toBe(0);
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('open');
  });
});

describe('an out-of-range provider report is rejected, not persisted (#120 r5 F3, red-on-revert)', () => {
  // Each of these would parse on WRITE (the append path runs no RoomEvent.parse on
  // a ledger-only exit event) and then THROW on every READ (which does), poisoning
  // replay. The bounds check at the settle boundary refuses them instead.
  const cases: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: 'contextPct above 1', patch: { contextPct: 2 } },
    { name: 'negative spendMicros', patch: { spendMicros: -7 } },
    { name: 'an over-length exit summary', patch: { exitSummary: 'x'.repeat(5001) } },
  ];
  for (const { name, patch } of cases) {
    it(`refuses ${name}, leaving the ledger replay-clean`, async () => {
      const planId = await openPlan();
      await fundPlan(planId);
      const sessionId = await openGrantedSession(planId, agentSession);
      const commands = commandService();

      // REVERT-REDS: remove the `SettleReceiptBounds` check in `settle_session` and
      // this out-of-range report appends a row that then breaks `RoomEvent.parse`
      // on the next read.
      await expect(
        commands.execute(agentSession, {
          name: 'settle_session',
          roomId: room.roomId,
          sessionId,
          outcome: 'failed',
          exitSummary: null,
          spendMicros: null,
          contextPct: null,
          ...patch,
        } as never),
      ).rejects.toThrow(/out of bounds|would break replay/i);

      // No exit event of either spelling was persisted, and the ledger still folds.
      const [{ exits } = { exits: 0 }] = await handle.db
        .select({ exits: sql<number>`count(*)::int` })
        .from(coreEvents)
        .where(
          and(
            sql`payload->>'sessionId' = ${sessionId}`,
            sql`${coreEvents.type} IN ('session_settled','session_failed')`,
          ),
        );
      expect(exits).toBe(0);
      // A fresh hydrate folds the whole ledger through RoomEvent.parse — no throw.
      const fresh = createLedger({ db: handle.db, logger });
      await expect(fresh.hydrate()).resolves.toBeUndefined();
    });
  }
});

describe('reconciliation acts on a dead OWNER, told from the lease (#120 r5 F4, red-on-revert)', () => {
  // A fixed clock so staleness is deterministic, never a wall-clock race.
  const T0 = new Date('2026-01-01T00:00:00.000Z');
  const STALE_MS = 30_000;

  /** Stamp an ownership lease directly, as a running (or dead) owner would hold it. */
  async function leaseSession(sessionId: string, owner: string, heartbeatAt: Date): Promise<void> {
    // ISO string + explicit cast — a raw `Date` bound through `sql` bypasses the
    // column mapper that `db.update().set()` would apply and postgres-js refuses it.
    await handle.db.execute(
      sql`UPDATE sessions SET execution_owner = ${owner},
            execution_heartbeat_at = ${heartbeatAt.toISOString()}::timestamptz
          WHERE id = ${sessionId} AND room_id = ${room.roomId}`,
    );
  }

  function reconcile(now: Date) {
    return reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      staleAfterMs: STALE_MS,
      now,
    });
  }

  it('drives a STALE-leased wedge to session_failed, idempotently', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // The wedge, built exactly as a SIGTERM mid-harness builds it: the draw is
    // granted and committed, the session row is `open`, a LOCAL execution owned it
    // (a lease is stamped), and the owning process is gone — so its heartbeat has
    // frozen and gone stale.
    const sessionId = await openGrantedSession(planId, agentSession);
    await leaseSession(sessionId, 'dead-instance', T0);
    const [planBefore] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(planBefore?.authorizedDraws).toBe(1); // THE SPEND, already committed.

    // The next reconcile pass, at a clock a full stale-window past the last
    // heartbeat. REVERT-REDS: restore the `executionEnabled` boot flag in place of
    // the lease predicate and this either never fires (disabled) or fires on
    // everything (enabled) — either way it stops being about THIS owner.
    const result = await reconcile(new Date(T0.getTime() + STALE_MS + 1_000));
    expect(result).toEqual({ found: 1, failed: 1, unreconciled: 0 });

    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
    expect(after?.settledByEventId).toBeTruthy();
    expect(after?.exitSummary).toContain('did not survive the previous process');
    // An HONEST receipt: failed, no artifact.
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();

    // IDEMPOTENT — the row is no longer `open`, so a second pass finds nothing.
    expect(await reconcile(new Date(T0.getTime() + STALE_MS + 2_000))).toEqual({
      found: 0,
      failed: 0,
      unreconciled: 0,
    });
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
    // Even far in the future — the session is settled, not open, so it is not a wedge.
    expect(await reconcile(new Date(T0.getTime() + 10 * STALE_MS))).toEqual({
      found: 0,
      failed: 0,
      unreconciled: 0,
    });
  });

  /**
   * THE disabled→enabled REGRESSION (#120 r5 F4). A session opened while execution
   * was DISABLED holds NO lease — it is a live external-settle session. A later
   * boot WITH a provider set must never touch it. Under round-4's boot flag it was
   * force-failed; keyed on the lease it is invisible to reconciliation, at any
   * clock. REVERT-REDS: reintroduce the boot-flag predicate and this open external
   * session is force-failed the instant a boot owns execution.
   */
  it('NEVER reconciles an UNLEASED external-settle session, however stale the clock', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    // Opened through the execution-DISABLED command service, so the session is
    // `external`-mode and holds NO lease at grant (owner NULL) — the documented
    // external-settle mode. A later boot WITH a provider must never touch it.
    const sessionId = await openGrantedSession(planId, agentSession, externalCommandService());
    // No lease is stamped — this is the external-settle mode.

    const result = await reconcile(new Date(T0.getTime() + 100 * STALE_MS));
    expect(result).toEqual({ found: 0, failed: 0, unreconciled: 0 });

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
  });

  /**
   * THE two-instance OVERLAP (#120 r5 F4). A session a LIVE peer instance is
   * running holds a FRESH lease (the peer keeps heartbeating). This process must
   * not force-fail it. Under round-4's boot flag each instance killed the other's
   * running sessions; keyed on the lease, a fresh heartbeat is left alone.
   * REVERT-REDS: drop the `heartbeat < staleBefore` predicate and this live peer's
   * session is reconciled out from under it.
   */
  it("leaves a live PEER's FRESH-leased session running", async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    // A concurrent peer owns it and beat its heartbeat one second ago.
    await leaseSession(sessionId, 'peer-instance', new Date(T0.getTime() - 1_000));

    // This process reconciles at T0 — the peer's lease is 1s old, well inside the
    // 30s window, so it is a LIVE owner and is left running.
    const result = await reconcile(T0);
    expect(result).toEqual({ found: 0, failed: 0, unreconciled: 0 });
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('open');
  });
});

describe('the ownership lease is claimed atomically as the granted-draw guard (#120 r5 F1, red-on-revert)', () => {
  it('runGranted refuses a fabricated (never-granted) session id — no workspace, no branch', async () => {
    const before = await listSessionBranches(repo);
    // A session id that no `open_session` ever granted. On the wire the wrapper
    // would never call `runGranted` for it, but `runGranted` is directly reachable
    // and must refuse it ITSELF. REVERT-REDS: remove the `ownership.claim` guard in
    // `runGranted` and the provider resolves a workspace + branch for this id.
    const outcome = await coordinator().runGranted(agentSession, {
      sessionId: randomUUID(),
      roomId: room.roomId,
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.artifact).toBeNull();
    // The provider was never reached — no session branch was created in the scratch repo.
    expect(await listSessionBranches(repo)).toEqual(before);
  });

  it('a granted session claims its lease and settles, stamping this instance as owner', async () => {
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
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, outcome.sessionId));
    // Owner was stamped at GRANT and the claim marked it running (round 6).
    expect(row?.executionOwner).toBe(TEST_INSTANCE_ID);
    expect(row?.executionHeartbeatAt).not.toBeNull();
    expect(row?.executionClaimedAt).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ROUND 6 — the execution-authority record, consolidated.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('a granted draw is BORN with its execution authority (#120 r6 F1, red-on-revert)', () => {
  it('leases a provider session AT GRANT, so it is reconcilable before it is ever claimed', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    // Open a granted provider session and DO NOT run/claim it — the SIGTERM-between-
    // open-and-claim window that round 5 left as a spent, unleased, never-reconciled
    // wedge. Round 6 writes the whole authority record in the session_opened
    // transaction, so the row is already leased here.
    const sessionId = await openGrantedSession(planId, agentSession);
    const [born] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    // REVERT-REDS: drop the executionOwner/heartbeat/authority writes from
    // `projectSessionOpened` and these are all null — the session is unleased, and
    // (below) reconciliation never touches it: the exact F1 wedge.
    expect(born?.executionMode).toBe('provider');
    expect(born?.executionOwner).toBe(TEST_INSTANCE_ID);
    expect(born?.executionHeartbeatAt).not.toBeNull();
    expect(born?.executionAuthority).toBeTruthy();
    expect(born?.executionClaimedAt).toBeNull(); // granted but not yet claimed

    // Its owning process dies before claiming: the heartbeat freezes and goes
    // stale. Because it was leased AT GRANT, reconciliation CAN see it and drive it
    // to a receipt — the F1 wedge is recovered rather than orphaned forever.
    const T0 = new Date('2026-01-01T00:00:00.000Z');
    await handle.db.execute(
      sql`UPDATE sessions SET execution_heartbeat_at = ${T0.toISOString()}::timestamptz
          WHERE id = ${sessionId} AND room_id = ${room.roomId}`,
    );
    const result = await reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      staleAfterMs: 30_000,
      now: new Date(T0.getTime() + 31_000),
    });
    expect(result).toEqual({ found: 1, failed: 1, unreconciled: 0 });
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
  });
});

describe('a provider session terminal needs the capability, both spellings (#120 r6 F2/F6, red-on-revert)', () => {
  for (const outcome of ['settled', 'failed'] as const) {
    it(`REFUSES a room member's fabricated ${outcome} on a running provider session`, async () => {
      const planId = await openPlan();
      await fundPlan(planId);
      // A real granted provider session, still running. The OPENER itself tries to
      // write its terminal WITHOUT the capability token — the token is minted
      // row-only and a wire caller never holds it. REVERT-REDS: drop the
      // provider-capability gate in `settle_session` and the fabricated `failed`
      // (previously swallowed) or `settled` wins the one-exit race mid-run.
      const sessionId = await openGrantedSession(planId, agentSession);
      await expect(
        commandService().execute(agentSession, {
          name: 'settle_session',
          roomId: room.roomId,
          sessionId,
          outcome,
          exitSummary: 'I declare this done',
          spendMicros: null,
          contextPct: null,
          artifact: null,
          // No authority — the room member does not hold the token.
        }),
      ).rejects.toThrow(/owned by its execution provider/);

      // Nothing was written; the session is still open.
      const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row?.status).toBe('open');
      const [{ exits } = { exits: 0 }] = await handle.db
        .select({ exits: sql<number>`count(*)::int` })
        .from(coreEvents)
        .where(
          and(
            eq(coreEvents.roomId, room.roomId),
            sql`payload->>'sessionId' = ${sessionId}`,
            sql`${coreEvents.type} IN ('session_settled','session_failed')`,
          ),
        );
      expect(exits).toBe(0);
    });
  }

  it('HONORS a settle that presents the session capability token', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    // The same opener, now presenting the row's real token (as the coordinator or
    // reconciler would): the capability is satisfied and the failed terminal lands.
    const settled = await commandService().execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'failed',
      exitSummary: 'the run finished',
      spendMicros: null,
      contextPct: null,
      artifact: null,
      authority: await sessionAuthority(sessionId),
    });
    expect(settled.kind).toBe('appended');
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('failed');
  });
});

describe('the claim is once-only and returns stored context (#120 r6 F5, red-on-revert)', () => {
  it('claims a granted session exactly once, returning its stored plan/harness/model', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    const owns = ownership();

    const first = await owns.claim({ sessionId, roomId: room.roomId });
    // The STORED context, read off the row — never caller-supplied.
    expect(first).not.toBeNull();
    expect(first?.planId).toBe(planId);
    expect(first?.harness).toBe('omp');
    expect(first?.model).toBe('haiku');
    expect(first?.authority).toBeTruthy();

    // REVERT-REDS: drop the `execution_claimed_at IS NULL` guard from `claim` and a
    // second claim succeeds again — the re-entrant claim round 5 allowed. Once-only
    // returns null the second time.
    const second = await owns.claim({ sessionId, roomId: room.roomId });
    expect(second).toBeNull();
  });

  it('does not claim a session owned by a DIFFERENT instance', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    // A peer instance's ownership manager cannot claim THIS instance's granted
    // session (owner mismatch) — the guard that stops two boots racing a run.
    const peer = ownership('peer-instance');
    expect(await peer.claim({ sessionId, roomId: room.roomId })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ROUND 7 — the token is the settlement authority, decoupled from membership.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('a provider settle is the token, not the opener membership (#120 r7 F1, red-on-revert)', () => {
  /** Remove a member from the room, as a sign-out / removal / revocation would. */
  async function removeMembership(userId: string): Promise<void> {
    await handle.db.execute(
      sql`DELETE FROM memberships WHERE room_id = ${room.roomId} AND user_id = ${userId}`,
    );
  }

  it('settles a running provider session by its token AFTER the opener loses membership', async () => {
    const planId = await openPlan();
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession);
    const authority = await sessionAuthority(sessionId);

    // The opener loses room membership WHILE its harness is still running — the
    // exact race round 7 F1 is about: signed out, removed, or session revoked.
    await removeMembership(agentId);

    // A TOKENLESS manual settle by the now-ex-member is refused — membership is
    // checked first, exactly as for any command (a bystander-fabrication hole must
    // stay closed). Nothing is appended.
    await expect(
      commandService().execute(agentSession, {
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'failed',
        exitSummary: 'no token, no membership',
        spendMicros: null,
        contextPct: null,
        artifact: null,
      }),
    ).rejects.toThrow(/no membership/);
    const [stillOpen] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(stillOpen?.status).toBe('open');

    // The CAPABILITY settle — the coordinator's/reconciler's path — STILL lands,
    // membership notwithstanding: the token is the whole of the authority. This is
    // the coordinator settling as the opener whose membership just vanished.
    // REVERT-REDS: re-require the opener's current membership on the provider path
    // (drop the `tokenAuthorized` bypass) and this throws `/no membership/`, leaving
    // the granted session wedged open with its draw spent and no receipt.
    const settled = await commandService().execute(agentSession, {
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'failed',
      exitSummary: 'the run finished after the opener left the room',
      spendMicros: null,
      contextPct: null,
      artifact: null,
      authority,
    });
    expect(settled.kind).toBe('appended');
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
    expect(after?.settledByEventId).toBeTruthy();
  });

  it('reconciles a stale-leased wedge whose opener has since left the room', async () => {
    const T0 = new Date('2026-02-01T00:00:00.000Z');
    const STALE_MS = 30_000;
    const planId = await openPlan();
    await fundPlan(planId);
    // A granted provider session, leased at grant to this instance. Its owner dies
    // (heartbeat frozen and stale) AND its opener has left the room.
    const sessionId = await openGrantedSession(planId, agentSession);
    await handle.db.execute(
      sql`UPDATE sessions SET execution_heartbeat_at = ${T0.toISOString()}::timestamptz
          WHERE id = ${sessionId} AND room_id = ${room.roomId}`,
    );
    await removeMembership(agentId);

    // Reconciliation drives it to a receipt on the strength of the row's token,
    // attributed to the opener but NOT gated on the opener's (now absent) membership.
    // REVERT-REDS: re-require membership on the provider settle and this reconcile is
    // refused — `unreconciled: 1`, and the wedge stays `open` forever.
    const result = await reconcileWedgedSessions({
      db: handle.db,
      commands: commandService(),
      logger,
      staleAfterMs: STALE_MS,
      now: new Date(T0.getTime() + STALE_MS + 1_000),
    });
    expect(result).toEqual({ found: 1, failed: 1, unreconciled: 0 });
    const [after] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after?.status).toBe('failed');
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();
  });
});

describe('a garbage provider report still reaches a terminal receipt (#120 r7 F2, red-on-revert)', () => {
  it('does not wedge the session open when the report is out of range', async () => {
    const planId = await openPlan();
    await fundPlan(planId);

    // A provider whose report is well-shaped but OUT OF BOUNDS — `contextPct` above
    // 1, a negative spend. Round 6 parsed it, the primary settle rejected it at the
    // durable bounds, the fallback reused the same values and rejected too, and the
    // session was left `open` with no receipt. Round 7 bounds the report at parse,
    // so it is caught inside the coordinator's failure boundary and settled failed.
    const provider: ExecutionProvider = {
      kind: 'out-of-range',
      resolve: shimResolve,
      run: async () => ({
        terminal: { ok: true, exitCode: 0 },
        receipt: { exitSummary: 'garbage', spendMicros: -1, contextPct: 2, artifact: null },
      }),
      cancelAll: async () => {},
      deliver: async () => ({ kind: 'ignored', reason: 'not-running' }),
    };
    const commands = commandService();
    const coord = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: ownership(),
    });

    const outcome = await coord.openAndRun(agentSession, {
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });

    // REVERT-REDS: drop the bounds from `ReportSchema` (and the safe-value fallback)
    // and the out-of-range report is rejected at the durable boundary with NO
    // receipt — the session stays `open`. With the fix it reaches a `failed` receipt.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, outcome.sessionId));
    expect(row?.status).toBe('failed');
    expect(row?.settledByEventId).toBeTruthy();
  });
});

/**
 * A minimal real workspace resolver reused by the out-of-range report test — the
 * report is what is under test, not the git plumbing, so this resolves a real
 * scratch worktree exactly as the shim does and lets the coordinator dispose it.
 */
async function shimResolve(ctx: SessionContext): Promise<Workspace> {
  const checkout = await addWorktree(repo, ctx.sessionId);
  return {
    sessionId: ctx.sessionId,
    dir: checkout.dir,
    branch: checkout.branch,
    remote: artifactRepo.dir,
    dispose: () => removeWorktree(checkout),
  };
}

/**
 * #147 — DELIVERY of an already-authorized signal to the RUNNING harness, through
 * the REAL command boundary and the REAL git shim.
 *
 * #127 built `session_signaled {steer|interrupt|resume}` as ledger events with full
 * enforcement, but they did not REACH the running harness. This proves they do now:
 * a steer's guidance is observable in the session's next-turn artifact, an interrupt
 * drives the session terminal (`session_failed`, no artifact), a signal for a session
 * this coordinator is not running is a safe no-op, and an interrupt at an ALREADY
 * TERMINAL session is refused by the #127 guard and therefore delivers nothing.
 *
 * The steered/interrupted runs use the shim's await-steer directive so the run PARKS
 * at one turn boundary — the deterministic window the coordinator's resolve→run
 * leaves no room for otherwise.
 *
 * The retry below spans the PRE-RESOLVE claim gap only, NOT the resolve window: the
 * command wrapper drives `runGranted` fire-and-forget, so `claim` (a DB update) may
 * still be in flight when the test delivers, and until `resolve` is entered there is
 * no session to deliver to. Once `resolve` is entered the mailbox exists from its
 * FIRST line (#147 FIX 3), so a signal in the resolve window is NOT dropped — that
 * fix's red-on-revert is proven deterministically in the unit suites
 * (`shim.test.ts` / `worktree-provider.test.ts`), which deliver synchronously inside
 * the window with no retry. The retry here is not masking that guard; it only waits
 * out an async claim that has not reached `resolve` yet.
 */
describe('an authorized signal reaches the running shim (#147)', () => {
  /** Retry delivery until the run has ENTERED resolve (past the async claim gap). */
  async function deliverWhenRunning(
    coord: ReturnType<typeof coordinator>,
    signal: { sessionId: string; roomId: string; kind: 'steer' | 'interrupt'; body: string | null },
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const outcome = await coord.deliverSignal(signal);
      if (outcome.kind !== 'ignored' || outcome.reason !== 'not-running') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`delivery never reached a running session ${signal.sessionId}`);
  }

  /** Open a granted, provider-mode session and return its id (no run yet). */
  async function openGranted(commands: ReturnType<typeof commandService>, model: string) {
    const opened = await commands.execute(agentSession, {
      name: 'open_session',
      roomId: room.roomId,
      planId: await (async () => {
        const id = await openPlan(commands);
        await fundPlan(id);
        return id;
      })(),
      harness: 'omp',
      model,
      causeMessageId: null,
    });
    expect(opened.kind).toBe('appended');
    if (opened.kind !== 'appended' || opened.draw?.outcome !== 'granted') {
      throw new Error('open_session was not granted');
    }
    return { sessionId: opened.draw.sessionId, planId: '' };
  }

  it('a steer is delivered at the turn boundary and its text lands in the artifact, then settles', async () => {
    const commands = commandService();
    const coord = coordinator(commands);
    const { sessionId } = await openGranted(commands, EXECUTION_AWAIT_STEER_DIRECTIVE);

    // The run PARKS at its boundary; deliver the steer while parked, then let it run.
    const runP = coord.runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId: '',
      harness: 'omp',
      model: EXECUTION_AWAIT_STEER_DIRECTIVE,
    });
    await deliverWhenRunning(coord, {
      sessionId,
      roomId: room.roomId,
      kind: 'steer',
      body: 'prefer the smaller diff',
    });
    const outcome = await runP;

    expect(outcome.kind).toBe('settled');
    // The steer's guidance is observable in the next-turn artifact — the whole
    // point of #147. RED-ON-REVERT: remove the wrapper/coordinator delivery path
    // (or the shim's steer drain) and the artifact reverts to the unsteered bytes.
    const body = await readFileAtBranch(repo, sessionBranch(sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toContain('prefer the smaller diff');

    // The session settled cleanly, and no ~ became a ✓ — a steer cannot certify.
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('settled');
  });

  it('flip-the-input: a different steer changes the delivered/observed guidance', async () => {
    const commands = commandService();
    const coord = coordinator(commands);
    const { sessionId } = await openGranted(commands, EXECUTION_AWAIT_STEER_DIRECTIVE);
    const runP = coord.runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId: '',
      harness: 'omp',
      model: EXECUTION_AWAIT_STEER_DIRECTIVE,
    });
    await deliverWhenRunning(coord, {
      sessionId,
      roomId: room.roomId,
      kind: 'steer',
      body: 'use the OTHER migration order',
    });
    await runP;
    const body = await readFileAtBranch(repo, sessionBranch(sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toContain('use the OTHER migration order');
    expect(body).not.toContain('prefer the smaller diff');
  });

  it('an interrupt drives the session terminal: session_failed, no artifact', async () => {
    const commands = commandService();
    const coord = coordinator(commands);
    const { sessionId } = await openGranted(commands, EXECUTION_AWAIT_STEER_DIRECTIVE);
    const runP = coord.runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId: '',
      harness: 'omp',
      model: EXECUTION_AWAIT_STEER_DIRECTIVE,
    });
    await deliverWhenRunning(coord, {
      sessionId,
      roomId: room.roomId,
      kind: 'interrupt',
      body: 'stop, wrong approach',
    });
    const outcome = await runP;

    expect(outcome.kind).toBe('failed');
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('failed');
    // The terminal is a FAIL with NO artifact — an interrupt lands and certifies
    // nothing; the branch never advanced past the seed.
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();
    expect(await branchCommit(repo, sessionBranch(sessionId))).toBe(repo.seedCommit);
  });

  it('a signal for a session this coordinator is not running is a safe no-op', async () => {
    const coord = coordinator();
    const outcome = await coord.deliverSignal({
      sessionId: randomUUID(),
      roomId: room.roomId,
      kind: 'steer',
      body: 'nobody home',
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not-running' });
  });

  it('an interrupt at an ALREADY-TERMINAL session is refused (#127) and delivers nothing', async () => {
    const commands = commandService();
    // Run a session to a clean settle first (default model, no parking).
    const outcome = await coordinator(commands).openAndRun(agentSession, {
      roomId: room.roomId,
      planId: await (async () => {
        const id = await openPlan(commands);
        await fundPlan(id);
        return id;
      })(),
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    const sessionId = outcome.sessionId;

    // Appending an interrupt at a SETTLED session is refused at the command — the
    // #127 guard. Nothing appends, so the wrapper never routes anything to deliver:
    // a signal cannot exceed its authorization because only an APPENDED, authorized
    // row is ever delivered.
    await expect(
      commands.execute(agentSession, {
        name: 'signal_session',
        roomId: room.roomId,
        sessionId,
        kind: 'interrupt',
        body: 'too late',
        causeMessageId: null,
        supersedesEventId: null,
      }),
    ).rejects.toThrow(/not open/);

    // And no signal row was written for this session — nothing to deliver.
    const rows = await handle.db
      .select({ id: sessionSignals.id })
      .from(sessionSignals)
      .where(eq(sessionSignals.sessionId, sessionId));
    expect(rows).toHaveLength(0);
  });
});

/**
 * THE LIVE PROGRESS CHANNEL, through the REAL command boundary (#159, decided in
 * #152). The producer→command→snapshot→frame path, and the four covenant points:
 * the command is `open`-class and token-guarded, the snapshot write-set is
 * `sessions`-only, the ephemeral frames carry nothing durable, and the stream
 * converges to (is cleared by) the settle receipt.
 */
describe('the live progress channel streams a running session (#159)', () => {
  async function sessionProgress(sessionId: string) {
    const [row] = await handle.db
      .select({ progress: sessions.progress, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row;
  }
  async function progressWriteSet(planId: string) {
    const [plan] = await handle.db
      .select({ authorizedDraws: plans.authorizedDraws, rlimitSlice: plans.rlimitSlice })
      .from(plans)
      .where(eq(plans.id, planId));
    return { census: await census(), plan };
  }
  async function ledgerCount(): Promise<number> {
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId));
    return n;
  }
  async function phaseEventCount(sessionId: string): Promise<number> {
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(
        and(
          eq(coreEvents.roomId, room.roomId),
          eq(coreEvents.type, 'session_phase_changed'),
          sql`${coreEvents.payload} ->> 'sessionId' = ${sessionId}`,
        ),
      );
    return n;
  }

  it('appends a DURABLE session_phase_changed, refreshes the snapshot, and moves no covenant table', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);
    const authority = await sessionAuthority(sessionId);
    const before = await progressWriteSet(planId);

    const ack = await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId,
      authority,
      phase: 'planning',
    });
    expect(ack.kind).toBe('appended');
    expect(await phaseEventCount(sessionId)).toBe(1);

    const row = await sessionProgress(sessionId);
    expect(row?.progress?.phase).toBe('planning');
    expect(row?.progress?.progressSeq).toBe(0);

    // COVENANT point 1: a progress report moves no accepted_objects and no plan
    // column. Revert the `open` classification / the sessions-only projection and
    // this reddens.
    expect(await progressWriteSet(planId)).toEqual(before);
  });

  it('a heartbeat is EPHEMERAL — a server-minted frame + a snapshot refresh, and NO ledger row', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);
    const authority = await sessionAuthority(sessionId);
    const ledgerBefore = await ledgerCount();

    const ack = await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId,
      authority,
      heartbeat: { spendMicros: 1234, contextPct: 0.5 },
    });
    expect(ack.kind).toBe('progress');
    if (ack.kind === 'progress') {
      expect(ack.frames).toHaveLength(1);
      expect(ack.frames[0]?.type).toBe('session_heartbeat');
    }
    // No durable row — the ephemeral path never journals (covenant point 3).
    expect(await ledgerCount()).toBe(ledgerBefore);
    const row = await sessionProgress(sessionId);
    expect(row?.progress?.spendMicros).toBe(1234);
    expect(row?.progress?.contextPct).toBe(0.5);
  });

  it('NACKS a heartbeat less than a second after the last (#159 cadence, red-on-revert)', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);
    const authority = await sessionAuthority(sessionId);

    const first = await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId,
      authority,
      heartbeat: { spendMicros: 1, contextPct: null },
    });
    expect(first.kind).toBe('progress');
    // A second heartbeat in the same instant is refused — <1s apart.
    await expect(
      commands.execute(agentSession, {
        name: 'report_session_progress',
        roomId: room.roomId,
        sessionId,
        authority,
        heartbeat: { spendMicros: 2, contextPct: null },
      }),
    ).rejects.toThrow(/less than 1s/);
  });

  it('a real edit moves the streamed diff — the snapshot follows the input (#159 flip-the-input)', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId, 5);
    const s1 = await openGrantedSession(planId, agentSession, commands);
    const s2 = await openGrantedSession(planId, agentSession, commands);
    const a1 = await sessionAuthority(s1);
    const a2 = await sessionAuthority(s2);

    await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId: s1,
      authority: a1,
      diffDelta: {
        truncated: false,
        files: [{ path: 'ALPHA.ts', status: 'added', additions: 3, deletions: 0 }],
      },
    });
    await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId: s2,
      authority: a2,
      diffDelta: {
        truncated: false,
        files: [{ path: 'BETA.ts', status: 'added', additions: 7, deletions: 0 }],
      },
    });

    const r1 = await sessionProgress(s1);
    const r2 = await sessionProgress(s2);
    // The streamed diff is a function of the input — a different edit yields a
    // different snapshot. A stubbed constant would fail this.
    expect(r1?.progress?.diff?.files?.[0]?.path).toBe('ALPHA.ts');
    expect(r2?.progress?.diff?.files?.[0]?.path).toBe('BETA.ts');
    expect(r1?.progress?.diff?.additions).toBe(3);
    expect(r2?.progress?.diff?.additions).toBe(7);
  });

  it('REFUSES progress from a caller without the session capability token (#159)', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);

    await expect(
      commands.execute(agentSession, {
        name: 'report_session_progress',
        roomId: room.roomId,
        sessionId,
        authority: 'not-the-real-token',
        phase: 'writing',
      }),
    ).rejects.toThrow(/execution-authority capability/);
    // Nothing was written.
    const row = await sessionProgress(sessionId);
    expect(row?.progress ?? null).toBeNull();
  });

  it('REFUSES progress against a session that already exited, and the settle CLEARED the snapshot (#159 convergence)', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);
    const authority = await sessionAuthority(sessionId);

    // Report a phase, then drive the run to a terminal via the coordinator.
    await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId: room.roomId,
      sessionId,
      authority,
      phase: 'planning',
    });
    expect((await sessionProgress(sessionId))?.progress?.phase).toBe('planning');

    const outcome = await coordinator(commands).runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');

    // Convergence: the settle CLEARED the snapshot — the receipt replaces the stream.
    const settled = await sessionProgress(sessionId);
    expect(settled?.status).toBe('settled');
    expect(settled?.progress ?? null).toBeNull();

    // And progress against the exited session is refused.
    await expect(
      commands.execute(agentSession, {
        name: 'report_session_progress',
        roomId: room.roomId,
        sessionId,
        authority,
        phase: 'testing',
      }),
    ).rejects.toThrow(/not open/);
  });

  it('wires the producer end to end — a coordinator run streams the durable phase timeline (#159)', async () => {
    const commands = commandService();
    const planId = await openPlan(commands);
    await fundPlan(planId);
    const sessionId = await openGrantedSession(planId, agentSession, commands);

    const outcome = await coordinator(commands).runGranted(agentSession, {
      sessionId,
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('settled');

    // The shim streamed all three phases through the wired `onProgress` seam; those
    // durable events persist past the settle (only the ephemeral snapshot is cleared).
    // Revert the coordinator's `onProgress` wiring and this drops to zero.
    expect(await phaseEventCount(sessionId)).toBe(3);
  });
});
