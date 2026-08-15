import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAtriumAuth,
  mintAgentSession,
  provisionAgentConfig,
  provisionAgentPrincipal,
} from '@atrium/auth';
import { type DatabaseHandle, workspaceMembers } from '@atrium/db';
import {
  coreEvents,
  fundedArms,
  memberships,
  messages,
  plans,
  rooms,
  users,
  workspaces,
} from '@atrium/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isFundedArmRefusal,
  isPlanClaimedRefusal,
  LoopDaemon,
} from '../../apps/loop/src/daemon.js';
import { type LoopCommand, parseServerFrame } from '../../apps/loop/src/protocol.js';
import {
  Command,
  type CommandInput,
  type CommandService,
  createCommandService,
} from '../../apps/server/src/commands.js';
import {
  createArtifactVerifier,
  createExecutionOwnership,
  wireExecutionCoordinator,
} from '../../apps/server/src/execution/configure.js';
import {
  type ArtifactRepo,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  type ScratchRepo,
} from '../../apps/server/src/execution/git.js';
import { createDeterministicShimProvider } from '../../apps/server/src/execution/shim.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMembershipAuthorizer, type Session } from '../../apps/server/src/session.js';
import { createUpgradeAuthenticator } from '../../apps/server/src/ws-auth.js';
import { createRealtimeServer, type RealtimeServer } from '../../apps/server/src/ws-server.js';
import { openDatabase, resetDatabase, TestClient, until } from '../support/harness.js';

/**
 * THE CHANNEL-LOOP DAEMON ACCEPTANCE TEST (#148, #139).
 *
 * The daemon (`apps/loop`) is driven as a SEPARATE CLIENT — it connects to a real
 * RealtimeServer over a real socket, authenticating with a real agent session
 * cookie minted the way the #142 seed mints it (`mintAgentSession` +
 * `provisionAgentPrincipal`/`provisionAgentConfig`, the exact functions the seed
 * calls). The server is wired for execution EXACTLY as `apps/server/src/index.ts`
 * wires it (shim provider, artifact verifier, `executionInstanceId`, the
 * coordinator wrapper), so a granted `open_session` really runs on the shim and
 * settles with a real, verified artifact.
 *
 * What is proven, each guard with its own disjoint witness:
 *  1. HAPPY PATH — a goal opens a plan the human funds, whose session runs on the
 *     shim and settles with a real artifact; the daemon issues settle_plan.
 *  2. CRASH-REPLAY, NO DOUBLE FUND (the headline) — a crash injected between the
 *     draw's grant and its journal write; on restart the funded-arm claim REFUSES
 *     the re-routed draw, so authorized_draws stays 1 and funded_arms stays one row.
 *  3. COVENANT — the agent credential is refused set_plan_rlimit (spend/slice-raise),
 *     accept_proposal (certify), and settle_session (no session token). The daemon's
 *     own `LoopCommand` type cannot even express those verbs.
 *  4. FLIP-THE-INPUT — two goals become two plans, one funded arm per cause.
 *  5. CONTRACT-DRIFT PIN — the daemon's re-declared wire types are cross-checked
 *     against the server's real `Command` zod and a real server frame.
 */

const APP_URL = 'http://localhost:3000';
const AUTH_SECRET = 'channel-loop-daemon-integration-secret-0000000000';
const logger = createLogger('error');
const INSTANCE_ID = 'loop-test-instance';

let handle: DatabaseHandle;
const auth = () =>
  createAtriumAuth({
    db: handle.db,
    baseURL: APP_URL,
    secret: AUTH_SECRET,
    mailer: async () => {},
  });

interface Provisioned {
  roomId: string;
  humanId: string;
  agentId: string;
  cookie: string;
}

async function provision(): Promise<Provisioned> {
  const [human] = await handle.db
    .insert(users)
    .values({
      email: `human-${randomUUID()}@example.test`,
      displayName: 'Lars',
      emailVerified: true,
      principalKind: 'human',
    })
    .returning({ id: users.id });
  const humanId = (human as { id: string }).id;

  const agent = await provisionAgentPrincipal({
    db: handle.db,
    email: `agent-${randomUUID()}@agents.atrium.invalid`,
    displayName: 'atrium-agent',
  });
  const agentId = agent.userId;

  const workspaceId = randomUUID();
  await handle.db.insert(workspaces).values({
    id: workspaceId,
    name: 'loop workspace',
    slug: `ws-${workspaceId.slice(0, 8)}`,
  });
  const roomId = randomUUID();
  await handle.db.insert(rooms).values({
    id: roomId,
    workspaceId,
    slug: `chan-${roomId.slice(0, 8)}`,
    name: 'atrium-agent',
    createdBy: humanId,
    agentUserId: agentId,
  });
  for (const userId of [humanId, agentId]) {
    await handle.db
      .insert(workspaceMembers)
      .values({ organizationId: workspaceId, userId, role: 'member' });
    await handle.db.insert(memberships).values({ roomId, userId, role: 'member' });
  }
  await provisionAgentConfig({
    db: handle.db,
    userId: agentId,
    ownerUserId: humanId,
    channelRoomId: roomId,
    host: 'unconfigured',
    harness: 'unconfigured',
    model: 'unconfigured',
  });
  const { cookie } = await mintAgentSession({ auth: auth(), db: handle.db, userId: agentId });
  return { roomId, humanId, agentId, cookie };
}

interface RunningServer {
  url: string;
  commands: CommandService;
  artifactRepo: ArtifactRepo;
  realtime: RealtimeServer;
  repo: ScratchRepo;
  artifactDir: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const ledger: Ledger = createLedger({ db: handle.db, logger });
  await ledger.hydrate();
  const repo = await createScratchRepo();
  const artifactDir = await mkdtemp(join(tmpdir(), 'atrium-loop-durable-'));
  const artifactRepo = await createArtifactRepo(artifactDir);
  const provider = createDeterministicShimProvider({ repo, artifactRepo });
  const verifyArtifact = createArtifactVerifier(artifactRepo, logger);
  const baseCommands = createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    verifyArtifact,
    executionInstanceId: INSTANCE_ID,
  });
  const ownership = createExecutionOwnership({ db: handle.db, instanceId: INSTANCE_ID, logger });
  const wiring = wireExecutionCoordinator({ provider, commands: baseCommands, logger, ownership });
  const realtime = createRealtimeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 30_000,
    logger,
    isReady: () => true,
    commands: wiring.commands,
    ledger,
    reconcileIntervalMs: 100,
    membershipRevalidateIntervalMs: 60_000,
    session: {
      authenticateUpgrade: createUpgradeAuthenticator({ auth: auth(), db: handle.db, logger }),
    },
    allowedOrigins: [],
    allowOriginless: true,
  });
  await realtime.listen();
  const address = realtime.httpServer.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    commands: wiring.commands,
    artifactRepo,
    realtime,
    repo,
    artifactDir,
    close: async () => {
      await wiring.drainExecutions(5_000);
      await realtime.close();
      await disposeScratchRepo(repo);
      await rm(artifactDir, { recursive: true, force: true });
    },
  };
}

function human(humanId: string): Session {
  return { userId: humanId, principalKind: 'human' };
}

/** Run a command in-process (out-of-band relative to the daemon's socket), through
 *  the server's real `Command` zod so its defaults are applied exactly as the wire
 *  path applies them. */
function execute(session: Session, input: CommandInput) {
  return server.commands.execute(session, Command.parse(input));
}

/** Post a goal as the human (out-of-band append; the daemon sees it via fan-out).
 *  Returns the message's own id — the causeMessageId a routed loop turn cites. */
async function postGoal(p: Provisioned, body: string, clientMessageId: string): Promise<string> {
  await execute(human(p.humanId), {
    name: 'send_message',
    roomId: p.roomId,
    body,
    clientMessageId,
  });
  const [row] = await handle.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.roomId, p.roomId), eq(messages.clientMessageId, clientMessageId)))
    .limit(1);
  if (!row) throw new Error('goal message did not persist');
  return row.id;
}

async function planForCause(
  roomId: string,
  cause: string,
): Promise<
  { id: string; status: string; authorizedDraws: number; slice: number | null } | undefined
> {
  const [row] = await handle.db
    .select({
      id: plans.id,
      status: plans.status,
      authorizedDraws: plans.authorizedDraws,
      slice: plans.rlimitSlice,
    })
    .from(plans)
    .where(and(eq(plans.roomId, roomId), eq(plans.causeMessageId, cause)))
    .limit(1);
  return row;
}

async function countPlansForCause(roomId: string, cause: string): Promise<number> {
  const rows = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.roomId, roomId), eq(plans.causeMessageId, cause)));
  return rows.length;
}

async function fund(p: Provisioned, planId: string, slice = 5): Promise<void> {
  const result = await execute(human(p.humanId), {
    name: 'set_plan_rlimit',
    roomId: p.roomId,
    planId,
    slice,
  });
  if (result.kind !== 'appended') throw new Error(`funding did not append: ${result.kind}`);
}

async function fundedArmRows(
  roomId: string,
): Promise<Array<{ causeMessageId: string; arm: string; sessionId: string }>> {
  return handle.db
    .select({
      causeMessageId: fundedArms.causeMessageId,
      arm: fundedArms.arm,
      sessionId: fundedArms.sessionId,
    })
    .from(fundedArms)
    .where(eq(fundedArms.roomId, roomId));
}

async function settledArtifact(
  roomId: string,
): Promise<{ branch: string; commit: string; remote: string } | null> {
  const [row] = await handle.db
    .select({ payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, roomId), eq(coreEvents.type, 'session_settled')))
    .orderBy(desc(coreEvents.seq))
    .limit(1);
  const payload = row?.payload as
    | { artifact?: { branch: string; commit: string; remote: string } | null }
    | undefined;
  return payload?.artifact ?? null;
}

const daemons: LoopDaemon[] = [];
function makeDaemon(
  p: Provisioned,
  server: RunningServer,
  journalPath: string,
  hooks?: {
    beforeDrawJournal?: (info: { cause: string; planId: string }) => void | Promise<void>;
    beforePlanJournal?: (info: { cause: string }) => void | Promise<void>;
  },
): LoopDaemon {
  const daemon = new LoopDaemon({
    url: server.url,
    cookie: p.cookie,
    roomId: p.roomId,
    journalPath,
    log: () => {},
    ...(hooks ? { hooks } : {}),
  });
  daemons.push(daemon);
  return daemon;
}

let server: RunningServer;
let scratchDir: string;

beforeAll(() => {
  handle = openDatabase(10);
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDatabase(handle);
  server = await startServer();
  scratchDir = await mkdtemp(join(tmpdir(), 'atrium-loop-journal-'));
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });
});

describe('1. happy path — a goal runs on the shim and settles, and the plan is settled', () => {
  it('opens a plan, funds it, runs the session, settles with a real artifact, and settles the plan', async () => {
    const p = await provision();
    const daemon = makeDaemon(p, server, join(scratchDir, 'happy.journal'));
    await daemon.start();

    const cause = await postGoal(p, 'please build #148', 'goal-happy');

    // The daemon opens a plan for the goal, and its unfunded draw is refused.
    await until(
      async () => (await planForCause(p.roomId, cause)) !== undefined,
      15_000,
      'plan opened',
    );
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');
    expect(plan.slice).toBeNull(); // unfunded — the human has not funded yet

    // The human funds; the daemon re-routes the refused draw exactly once.
    await fund(p, plan.id, 5);

    // The session runs on the shim and settles with a REAL, verified artifact.
    await until(
      async () => (await settledArtifact(p.roomId)) !== null,
      30_000,
      'session settled with artifact',
    );
    const artifact = await settledArtifact(p.roomId);
    expect(artifact?.branch).toContain('session/');
    expect(artifact?.remote).toBe(server.artifactRepo.dir);
    expect(artifact?.commit).toMatch(/^[0-9a-f]{40}$/);

    // Exactly one funded arm for the cause, one authorized draw.
    const arms = await fundedArmRows(p.roomId);
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ causeMessageId: cause, arm: 'spawn' });
    const funded = await planForCause(p.roomId, cause);
    expect(funded?.authorizedDraws).toBe(1);

    // The daemon issues settle_plan once the child session is terminal.
    await until(
      async () => (await planForCause(p.roomId, cause))?.status === 'settled',
      15_000,
      'plan settled',
    );
  });
});

describe('2. crash-replay — the funded-arm claim refuses the re-route, so no double fund', () => {
  it('crashes between the grant and the journal write; on restart authorized_draws stays 1', async () => {
    const p = await provision();
    const journalPath = join(scratchDir, 'crash.journal');

    // Daemon 1 crashes the instant the draw is granted, before it journals it.
    let crashed = false;
    const daemon1 = makeDaemon(p, server, journalPath, {
      beforeDrawJournal: () => {
        crashed = true;
        throw new Error('injected crash: grant committed, journal not yet written');
      },
    });
    await daemon1.start();
    const cause = await postGoal(p, 'build #148 under a crash', 'goal-crash');
    await until(
      async () => (await planForCause(p.roomId, cause)) !== undefined,
      15_000,
      'plan opened',
    );
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');

    await fund(p, plan.id, 5);
    await Promise.race([daemon1.whenHalted, until(() => crashed, 15_000, 'crash injected')]);
    await until(() => crashed, 15_000, 'crash injected');
    // The server funded the arm before the crash — one authorized draw already.
    await until(
      async () => (await planForCause(p.roomId, cause))?.authorizedDraws === 1,
      15_000,
      'first draw funded',
    );
    await daemon1.stop();

    // Daemon 2 replays the SAME journal. The re-routed draw hits the funded-arm
    // claim and is refused — the refusal IS the idempotency.
    const daemon2 = makeDaemon(p, server, journalPath);
    await daemon2.start();

    // No double fund: authorized_draws never exceeds 1, funded_arms never exceeds
    // one row. Poll for a while to be sure the re-route really happened and was
    // refused rather than simply not attempted.
    await until(
      async () => (await settledArtifact(p.roomId)) !== null,
      30_000,
      'the pre-crash session still settles',
    );
    // Give any (wrongful) second draw ample time to have appeared.
    await new Promise((r) => setTimeout(r, 500));
    const funded = await planForCause(p.roomId, cause);
    expect(funded?.authorizedDraws).toBe(1);
    const arms = await fundedArmRows(p.roomId);
    expect(arms).toHaveLength(1);

    // POSITIVE witness that the re-route actually happened and was REFUSED (not
    // merely skipped): the recovered journal carries a funded_terminal record for
    // the cause — the daemon re-issued the draw and the funded-arm claim refused it.
    await until(
      async () => (await readFile(journalPath, 'utf8')).includes('"kind":"funded_terminal"'),
      15_000,
      'funded-arm refusal journaled',
    );
    const journalText = await readFile(journalPath, 'utf8');
    const fundedTerminal = journalText
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('"v":1'))
      .map((line) => JSON.parse(line) as { outcome: { kind: string; cause?: string } })
      .find((record) => record.outcome.kind === 'funded_terminal');
    expect(fundedTerminal?.outcome.cause).toBe(cause);

    // And the plan still reaches settled — the crash-recovered session is tracked.
    await until(
      async () => (await planForCause(p.roomId, cause))?.status === 'settled',
      15_000,
      'plan settled after recovery',
    );
  });

  it('the funded-arm refusal really is a nack the daemon recognizes (message pin)', async () => {
    // Pins the daemon's coupling to the server's refusal wording. If the server
    // rewords fundedArmRefusal, isFundedArmRefusal must be updated with it.
    const p = await provision();
    // Fund a plan and open one session directly, so the cause has funded an arm.
    const cause = await postGoal(p, 'seed a funded cause #1', 'goal-pin');
    const planResult = await execute(human(p.humanId), {
      name: 'open_plan',
      roomId: p.roomId,
      agentUserId: p.agentId,
      title: 'pin plan',
      causeMessageId: cause,
    } as CommandInput);
    if (planResult.kind !== 'appended') throw new Error('open_plan failed');
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');
    await fund(p, plan.id, 5);

    const agentClient = await TestClient.connect(server.url, p.agentId, {
      headers: { cookie: p.cookie },
    });
    try {
      await agentClient.subscribe(p.roomId);
      const first = await agentClient.command({
        name: 'open_session',
        roomId: p.roomId,
        planId: plan.id,
        harness: 'atrium-loop',
        model: 'run-zero',
        causeMessageId: cause,
      } as CommandInput);
      expect(first.type).toBe('ack');
      const second = await agentClient.command({
        name: 'open_session',
        roomId: p.roomId,
        planId: plan.id,
        harness: 'atrium-loop',
        model: 'run-zero',
        causeMessageId: cause,
      } as CommandInput);
      expect(second.type).toBe('nack');
      if (second.type !== 'nack') throw new Error('expected nack');
      expect(isFundedArmRefusal(second)).toBe(true);
      expect(second.message).toContain('has already funded a draw');
    } finally {
      await agentClient.close();
    }
  });
});

describe('3. covenant — the agent credential can do only what an agent may', () => {
  it('refuses set_plan_rlimit (spend / slice-raise), accept_proposal (certify), and settle_session (no token)', async () => {
    const p = await provision();
    const cause = await postGoal(p, 'covenant #1', 'goal-cov');
    const planResult = await execute(human(p.humanId), {
      name: 'open_plan',
      roomId: p.roomId,
      agentUserId: p.agentId,
      title: 'covenant plan',
      causeMessageId: cause,
    } as CommandInput);
    if (planResult.kind !== 'appended') throw new Error('open_plan failed');
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');

    const agentClient = await TestClient.connect(server.url, p.agentId, {
      headers: { cookie: p.cookie },
    });
    try {
      await agentClient.subscribe(p.roomId);

      // W1 — spend authorization / slice-raise is human-only.
      const rlimit = await agentClient.command({
        name: 'set_plan_rlimit',
        roomId: p.roomId,
        planId: plan.id,
        slice: 99,
      } as CommandInput);
      expect(rlimit.type).toBe('nack');
      if (rlimit.type === 'nack') expect(rlimit.code).toBe('invalid');

      // W2 — certification is refused to a machine.
      const certify = await agentClient.command({
        name: 'accept_proposal',
        roomId: p.roomId,
        proposalId: randomUUID(),
      } as CommandInput);
      expect(certify.type).toBe('nack');
      if (certify.type === 'nack') expect(certify.code).toBe('invalid');

      // W3 — the agent holds no session token, so it cannot settle a session.
      const settle = await agentClient.command({
        name: 'settle_session',
        roomId: p.roomId,
        sessionId: randomUUID(),
        outcome: 'settled',
      } as CommandInput);
      expect(settle.type).toBe('nack');

      // The plan's slice is still unset — the refused rlimit changed nothing.
      const after = await planForCause(p.roomId, cause);
      expect(after?.slice).toBeNull();
    } finally {
      await agentClient.close();
    }
  });
});

describe('4. flip-the-input — two goals become two plans, one funded arm per cause', () => {
  it('funds two distinct causes and gets two funded arms, one draw each', async () => {
    const p = await provision();
    const daemon = makeDaemon(p, server, join(scratchDir, 'flip.journal'));
    await daemon.start();

    const causeA = await postGoal(p, 'build #148 (a)', 'goal-a');
    const causeB = await postGoal(p, 'build #148 (b)', 'goal-b');

    await until(
      async () =>
        (await planForCause(p.roomId, causeA)) !== undefined &&
        (await planForCause(p.roomId, causeB)) !== undefined,
      15_000,
      'two plans opened',
    );
    const planA = await planForCause(p.roomId, causeA);
    const planB = await planForCause(p.roomId, causeB);
    if (!planA || !planB) throw new Error('missing plan');
    expect(planA.id).not.toBe(planB.id); // two goals → two plans

    await fund(p, planA.id, 5);
    await fund(p, planB.id, 5);

    await until(
      async () => (await fundedArmRows(p.roomId)).length === 2,
      30_000,
      'two funded arms',
    );
    const arms = await fundedArmRows(p.roomId);
    const causes = new Set(arms.map((a) => a.causeMessageId));
    expect(causes).toEqual(new Set([causeA, causeB]));
    expect((await planForCause(p.roomId, causeA))?.authorizedDraws).toBe(1);
    expect((await planForCause(p.roomId, causeB))?.authorizedDraws).toBe(1);
  });
});

describe('5. contract-drift pin — the re-declared wire types agree with the server', () => {
  it('the daemon’s outgoing commands parse against the SERVER’s real Command zod', () => {
    const roomId = randomUUID();
    const outgoing: LoopCommand[] = [
      {
        name: 'open_plan',
        roomId,
        agentUserId: randomUUID(),
        title: 'x',
        causeMessageId: randomUUID(),
      },
      {
        name: 'open_session',
        roomId,
        planId: randomUUID(),
        harness: 'atrium-loop',
        model: 'run-zero',
        causeMessageId: randomUUID(),
      },
      { name: 'settle_plan', roomId, planId: randomUUID() },
      {
        name: 'signal_session',
        roomId,
        sessionId: randomUUID(),
        kind: 'steer',
        body: 'go',
        causeMessageId: randomUUID(),
      },
      {
        name: 'send_message',
        roomId,
        body: 'hi',
        clientMessageId: 'k',
        causeMessageId: randomUUID(),
      },
    ];
    for (const command of outgoing) {
      const parsed = Command.safeParse(command);
      expect(
        parsed.success,
        `server rejects the daemon's ${command.name}: ${parsed.error?.message}`,
      ).toBe(true);
    }
  });

  it('a real server ack frame parses against the daemon’s ServerFrame reader', async () => {
    const p = await provision();
    const agentClient = await TestClient.connect(server.url, p.agentId, {
      headers: { cookie: p.cookie },
    });
    try {
      await agentClient.subscribe(p.roomId);
      const ack = await agentClient.command({
        name: 'send_message',
        roomId: p.roomId,
        body: 'hi',
      } as CommandInput);
      // The exact bytes the server sent for this ack — re-parsed by the daemon's schema.
      const frame = parseServerFrame(JSON.stringify(ack));
      expect(frame.type).toBe('ack');
    } finally {
      await agentClient.close();
    }
  });
});

describe('6. FIX 1 — a crash after open_plan ack, before its journal, opens exactly one plan', () => {
  it('the server plan-claim refuses the replay re-send; one board, one session, one settle', async () => {
    const p = await provision();
    const journalPath = join(scratchDir, 'plan-crash.journal');

    // Daemon 1 crashes the instant `open_plan` is acked, before it journals the
    // request — the exact window that, unclaimed, opens a SECOND orphan board.
    let crashed = false;
    const daemon1 = makeDaemon(p, server, journalPath, {
      beforePlanJournal: () => {
        crashed = true;
        throw new Error('injected crash: open_plan acked, request not yet journaled');
      },
    });
    await daemon1.start();
    const cause = await postGoal(p, 'build #148 (crash before plan journal)', 'goal-plan-crash');

    // The server opened the plan before the crash; the daemon then halted.
    await until(
      async () => (await planForCause(p.roomId, cause)) !== undefined,
      15_000,
      'plan opened server-side',
    );
    await until(() => crashed, 15_000, 'crash injected');
    await daemon1.stop();
    expect(await countPlansForCause(p.roomId, cause)).toBe(1);
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');

    // Daemon 2 replays the SAME journal. Its re-sent `open_plan` hits the per-cause
    // plan claim and is REFUSED — the refusal IS the idempotency — and it resumes
    // toward the draw against the SAME plan rather than opening a second board.
    const daemon2 = makeDaemon(p, server, journalPath);
    await daemon2.start();
    await fund(p, plan.id, 5);

    await until(
      async () => (await settledArtifact(p.roomId)) !== null,
      30_000,
      'the recovered session settles',
    );
    // Give any (wrongful) second plan ample time to have appeared.
    await new Promise((r) => setTimeout(r, 500));
    // EXACTLY ONE plan for the cause (revert of FIX 1 → two: the orphan board).
    expect(await countPlansForCause(p.roomId, cause)).toBe(1);

    // POSITIVE witness the re-send happened and was refused (not merely skipped):
    // the recovered journal carries a plan_requested for the cause, written by the
    // plan-claim refusal path, and the single plan reaches settled.
    const journalText = await readFile(journalPath, 'utf8');
    const planRequested = journalText
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('"v":1'))
      .map((line) => JSON.parse(line) as { outcome: { kind: string; cause?: string } })
      .find((record) => record.outcome.kind === 'plan_requested' && record.outcome.cause === cause);
    expect(planRequested).toBeDefined();
    await until(
      async () => (await planForCause(p.roomId, cause))?.status === 'settled',
      15_000,
      'plan settled after recovery',
    );
  });

  it('the plan-claim refusal really is a nack the daemon recognizes (message pin)', async () => {
    // Pins the daemon's coupling to the server's refusal wording. If the server
    // rewords planCauseRefusal, isPlanClaimedRefusal must be updated with it.
    const p = await provision();
    const cause = await postGoal(p, 'seed a routed plan #148', 'goal-plan-pin');
    const first = await execute(human(p.humanId), {
      name: 'open_plan',
      roomId: p.roomId,
      agentUserId: p.agentId,
      title: 'pin plan',
      causeMessageId: cause,
    } as CommandInput);
    if (first.kind !== 'appended') throw new Error('first open_plan failed');

    const agentClient = await TestClient.connect(server.url, p.agentId, {
      headers: { cookie: p.cookie },
    });
    try {
      await agentClient.subscribe(p.roomId);
      const second = await agentClient.command({
        name: 'open_plan',
        roomId: p.roomId,
        agentUserId: p.agentId,
        title: 'second board from one cause',
        causeMessageId: cause,
      } as CommandInput);
      expect(second.type).toBe('nack');
      if (second.type !== 'nack') throw new Error('expected nack');
      expect(isPlanClaimedRefusal(second)).toBe(true);
      expect(second.message).toContain('has already opened a plan');
      // And no second board was appended.
      expect(await countPlansForCause(p.roomId, cause)).toBe(1);
    } finally {
      await agentClient.close();
    }
  });

  it('a hand-opened plan cites no cause and stays FREE — two null-cause boards coexist', async () => {
    // The partial index binds only routed (non-null) causes; the "many free
    // boards" case the resolution named is untouched.
    const p = await provision();
    for (const title of ['board one', 'board two']) {
      const r = await execute(human(p.humanId), {
        name: 'open_plan',
        roomId: p.roomId,
        agentUserId: p.agentId,
        title,
      } as CommandInput);
      expect(r.kind).toBe('appended');
    }
    const rows = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, p.roomId));
    expect(rows.length).toBe(2);
  });
});

describe('7. FIX 4 — the server refuses raw forged frames from the agent cookie, against REAL targets', () => {
  it('set_plan_rlimit on a real plan, settle_session on a real session, and certify — each nacked', async () => {
    const p = await provision();
    const daemon = makeDaemon(p, server, join(scratchDir, 'forge.journal'));
    await daemon.start();

    const cause = await postGoal(p, 'build #148 (forged-frame witness)', 'goal-forge');
    await until(
      async () => (await planForCause(p.roomId, cause)) !== undefined,
      15_000,
      'plan opened',
    );
    const plan = await planForCause(p.roomId, cause);
    if (!plan) throw new Error('no plan');
    await fund(p, plan.id, 5);

    // Wait until a REAL session exists — one the daemon opened via a real draw.
    await until(
      async () => (await fundedArmRows(p.roomId)).length === 1,
      30_000,
      'a real session was drawn',
    );
    const realSessionId = (await fundedArmRows(p.roomId))[0]?.sessionId;
    if (!realSessionId) throw new Error('no real session');

    // The daemon's OWN agent cookie, driving RAW frames the LoopCommand type can
    // never express, against the real plan and the real session it just opened.
    const agentClient = await TestClient.connect(server.url, p.agentId, {
      headers: { cookie: p.cookie },
    });
    try {
      await agentClient.subscribe(p.roomId);

      // set_plan_rlimit on the REAL plan — spend authorization is human-only, and
      // the server refuses the agent regardless of the plan being real.
      const rlimit = await agentClient.command({
        name: 'set_plan_rlimit',
        roomId: p.roomId,
        planId: plan.id,
        slice: 999,
      } as CommandInput);
      expect(rlimit.type).toBe('nack');
      if (rlimit.type === 'nack') expect(rlimit.code).toBe('invalid');

      // settle_session against the REAL session the daemon opened. The refusal is
      // the SERVER's authority gate, not "no such session": the exit is owned by
      // the execution provider on a capability the agent never holds. This is the
      // strengthened witness — the weak one settled a nonexistent session.
      const settle = await agentClient.command({
        name: 'settle_session',
        roomId: p.roomId,
        sessionId: realSessionId,
        outcome: 'settled',
      } as CommandInput);
      expect(settle.type).toBe('nack');

      // accept_proposal / certify — refused to a machine principal by the server's
      // fold, never reachable by the agent cookie.
      const certify = await agentClient.command({
        name: 'accept_proposal',
        roomId: p.roomId,
        proposalId: randomUUID(),
      } as CommandInput);
      expect(certify.type).toBe('nack');
      if (certify.type === 'nack') expect(certify.code).toBe('invalid');

      // The forgeries changed nothing: the plan's slice is still the human's 5,
      // and no forged settle wrote the session's exit from the outside.
      const after = await planForCause(p.roomId, cause);
      expect(after?.slice).toBe(5);
    } finally {
      await agentClient.close();
    }
  });
});
