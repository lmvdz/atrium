import type { DatabaseHandle } from '@atrium/db';
import { acceptedObjects, coreEvents, plans, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../../apps/server/src/commands.js';
import { createExecutionCoordinator } from '../../apps/server/src/execution/coordinator.js';
import {
  branchCommit,
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
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMembershipAuthorizer, type Session } from '../../apps/server/src/session.js';
import { openDatabase, resetDatabase, type SeededRoom, seedRoom } from '../support/harness.js';

/**
 * THE EXECUTIONPROVIDER ACCEPTANCE TEST (#120), through the REAL command
 * boundary and a REAL git shim.
 *
 * A session under a funded plan runs the deterministic shim, produces a real
 * artifact (a branch/commit in a scratch git the shim controls), and settles to
 * `session_settled` INDEXING that artifact. The flips: a failing harness settles
 * to `session_failed` with the receipt and no artifact; a session whose plan
 * budget REFUSES the draw never starts the adapter — no workspace, no branch,
 * no artifact — and no session rows up.
 *
 * The two guards proven red-on-revert here:
 *  - **Budget (#118):** the refused-draw case asserts the coordinator never
 *    resolved a workspace (zero session branches in the scratch repo). Revert
 *    the granted-guard in `coordinator.ts` and a refused draw runs the harness.
 *  - **Covenant:** the global certified-object census is byte-unchanged across a
 *    full run, and trunk (`main`) never moves — the artifact is a branch a human
 *    lands, never one the adapter certifies.
 */

let handle: DatabaseHandle;
let ledger: Ledger;
let repo: ScratchRepo;
let room: SeededRoom;
let agentId: string;
let humanId: string;
let agentSession: Session;
const logger = createLogger('error');

function commandService() {
  return createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
  });
}

function coordinator(commands = commandService()) {
  const provider = createDeterministicShimProvider({ repo });
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
});

afterAll(async () => {
  await handle?.close();
});

describe('a funded session runs the shim, produces an artifact, and settles indexing it', () => {
  it('settles to session_settled referencing a real branch/commit', async () => {
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

    // The exit event INDEXES the artifact — a real branch/commit in the scratch
    // git the shim controls.
    const artifact = await exitArtifact(sessionId, 'session_settled');
    expect(artifact).not.toBeNull();
    expect(artifact?.branch).toBe(sessionBranch(sessionId));
    expect(artifact?.remote).toBe(repo.dir);
    // The commit the receipt names actually exists on that branch.
    expect(await branchCommit(repo, sessionBranch(sessionId))).toBe(artifact?.commit);
    expect(artifact?.commit).not.toBe(repo.seedCommit);

    // THE COVENANT: no ~ became a ✓ anywhere, and trunk never moved — the
    // artifact is a branch waiting for a human `✓`, not one the adapter landed.
    expect(await census()).toEqual(censusBefore);
    expect(await mainCommit(repo)).toBe(trunkBefore);

    // Exactly the two lifecycle rows landed — an open and a clean exit. Nothing
    // that certifies.
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
      harness: 'omp',
      // The reserved directive flips the deterministic harness to a failure.
      model: EXECUTION_FAIL_DIRECTIVE,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    const sessionId = outcome.sessionId;

    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('failed');
    expect(row?.exitSummary).toContain('failed');

    // A failed exit carries the receipt but NO artifact — no verifiable object
    // was produced.
    expect(await exitArtifact(sessionId, 'session_failed')).toBeNull();
    // The branch exists (worktree-add forks it) but never advanced past trunk.
    expect(await branchCommit(repo, sessionBranch(sessionId))).toBe(repo.seedCommit);
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
    // resolved in the scratch repo, and no session_opened landed. Revert the
    // `draw.outcome !== 'granted'` guard in coordinator.ts and this reds: a
    // refused draw resolves a workspace and runs a harness Atrium never
    // authorized.
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
