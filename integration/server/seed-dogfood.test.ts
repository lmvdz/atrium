import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAtriumAuth } from '@atrium/auth';
import {
  agents,
  authSessions,
  fundedArms,
  memberships,
  plans,
  proposals,
  rooms,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../apps/server/src/logger.js';
import { createUpgradeAuthenticator } from '../../apps/server/src/ws-auth.js';
import { databaseUrl } from '../support/env.js';
import { openDatabase, resetDatabase, startTestServer, TestClient } from '../support/harness.js';

const run = promisify(execFile);
const ROOT = new URL('../../', import.meta.url).pathname;
const APP_URL = 'http://localhost:3000';
const AUTH_SECRET = 'dogfood-seed-integration-secret-long-enough-00';
const OWNER_EMAIL = 'lars-dogfood@example.test';

const handle = openDatabase(6);

async function runSeed(cookieFile: string, extraEnv: Record<string, string> = {}) {
  return run(
    'pnpm',
    ['--filter', '@atrium/server', 'exec', 'tsx', '../../scripts/seed-dogfood.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl(),
        APP_URL,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        DOGFOOD_OWNER_EMAIL: OWNER_EMAIL,
        DOGFOOD_COOKIE_FILE: cookieFile,
        ...extraEnv,
      },
      maxBuffer: 1024 * 1024,
    },
  );
}

async function snapshotDatabase() {
  const [
    userRows,
    agentRows,
    workspaceRows,
    roomRows,
    workspaceMemberRows,
    membershipRows,
    authSessionRows,
    planRows,
    executionSessionRows,
    proposalRows,
    fundedArmRows,
  ] = await Promise.all([
    handle.db.select().from(users).orderBy(asc(users.id)),
    handle.db.select().from(agents).orderBy(asc(agents.userId)),
    handle.db.select().from(workspaces).orderBy(asc(workspaces.id)),
    handle.db.select().from(rooms).orderBy(asc(rooms.id)),
    handle.db.select().from(workspaceMembers).orderBy(asc(workspaceMembers.id)),
    handle.db.select().from(memberships).orderBy(asc(memberships.id)),
    handle.db.select().from(authSessions).orderBy(asc(authSessions.id)),
    handle.db.select().from(plans).orderBy(asc(plans.id)),
    handle.db.select().from(sessions).orderBy(asc(sessions.id)),
    handle.db.select().from(proposals).orderBy(asc(proposals.id)),
    handle.db.select().from(fundedArms).orderBy(asc(fundedArms.roomId)),
  ]);
  return {
    counts: {
      users: userRows.length,
      agents: agentRows.length,
      workspaces: workspaceRows.length,
      rooms: roomRows.length,
      workspaceMembers: workspaceMemberRows.length,
      memberships: membershipRows.length,
      authSessions: authSessionRows.length,
      plans: planRows.length,
      sessions: executionSessionRows.length,
      proposals: proposalRows.length,
      fundedArms: fundedArmRows.length,
    },
    agent: agentRows[0],
    rows: {
      users: userRows,
      workspaces: workspaceRows,
      rooms: roomRows,
      workspaceMembers: workspaceMemberRows,
      memberships: membershipRows,
      authSessions: authSessionRows,
    },
  };
}

beforeAll(async () => {
  await resetDatabase(handle);
  await handle.db.insert(users).values({
    email: OWNER_EMAIL,
    displayName: 'Lars',
    emailVerified: true,
    principalKind: 'human',
  });
  // The seed imports workspace packages through their published entry points.
  // Build once here; each subprocess below then runs only the seed itself.
  await run('pnpm', ['--filter', './packages/*', 'build'], {
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
}, 60_000);

afterAll(async () => {
  await handle.close();
});

describe('the minimal dogfood seed', () => {
  it('is byte-idempotent, leaves funding empty, and writes a usable 0600 agent cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atrium-dogfood-seed-'));
    const cookieFile = join(directory, 'agent.cookie');

    await runSeed(cookieFile);
    const first = await snapshotDatabase();

    expect(first.counts).toEqual({
      users: 2,
      agents: 1,
      workspaces: 1,
      rooms: 1,
      workspaceMembers: 2,
      memberships: 2,
      authSessions: 1,
      plans: 0,
      sessions: 0,
      proposals: 0,
      fundedArms: 0,
    });
    expect(first.agent).toMatchObject({
      host: 'unconfigured',
      harness: 'unconfigured',
      model: 'unconfigured',
      budgetLimitMicros: null,
    });

    await runSeed(cookieFile);
    const second = await snapshotDatabase();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const cookie = (await readFile(cookieFile, 'utf8')).trim();
    expect(cookie).toMatch(/^better-auth\.session_token=/);
    expect((await stat(cookieFile)).mode & 0o777).toBe(0o600);

    const agentUser = second.rows.users.find((row) => row.principalKind === 'agent');
    const ownerUser = second.rows.users.find((row) => row.email === OWNER_EMAIL);
    const channel = second.rows.rooms[0];
    expect(agentUser).toBeDefined();
    expect(ownerUser).toBeDefined();
    expect(channel).toMatchObject({ agentUserId: agentUser?.id });

    const auth = createAtriumAuth({
      db: handle.db,
      baseURL: APP_URL,
      secret: AUTH_SECRET,
      mailer: async () => {},
    });
    const server = await startTestServer(handle, {
      session: {
        authenticateUpgrade: createUpgradeAuthenticator({
          auth,
          db: handle.db,
          logger: createLogger('error'),
        }),
      },
    });
    let client: TestClient | undefined;
    try {
      // Deliberately supply the human's id through the integration stub's old
      // header. The production authenticator must ignore that foreign lineage
      // and resolve the cookie as the agent principal.
      client = await TestClient.connect(server.url, ownerUser?.id as string, {
        headers: { cookie },
      });
      const welcome = client.frames.find((frame) => frame.type === 'welcome');
      expect(welcome).toMatchObject({ type: 'welcome', userId: agentUser?.id });
      await expect(client.subscribe(channel?.id as string)).resolves.toMatchObject({
        roomId: channel?.id,
        head: 0,
      });
    } finally {
      await client?.close();
      await server.close();
    }

    // Flip one provisioning input. Idempotency must not mean silently treating
    // different intent as the same seed; refuse it and leave every byte alone.
    const beforeFlip = await snapshotDatabase();
    await expect(runSeed(cookieFile, { DOGFOOD_AGENT_NAME: 'different-agent' })).rejects.toThrow(
      /DOGFOOD_AGENT_NAME/,
    );
    expect(JSON.stringify(await snapshotDatabase())).toBe(JSON.stringify(beforeFlip));

    // DOGFOOD_AGENT_NAME is the one input checked before anything is written, so
    // the assertion above holds even for a seed with no transaction at all — it
    // pins the ordering rather than the guarantee. Flip an input the seed WRITES
    // from instead: a new workspace slug is inserted (no conflict), a new room is
    // inserted under it, and only then does the agent's existing config
    // contradict its new channel. Round 1 refused here having already committed
    // an orphan workspace and an orphan room.
    await expect(
      runSeed(cookieFile, { DOGFOOD_WORKSPACE_SLUG: 'dogfood-elsewhere' }),
    ).rejects.toThrow(/already has different config/);
    expect(JSON.stringify(await snapshotDatabase())).toBe(JSON.stringify(beforeFlip));

    // And the far end of the same run: a seed that would legitimately provision
    // a whole second agent — new workspace, room, identity, config, four
    // memberships — and then fails at the very last step, the cookie mint. A
    // too-short BETTER_AUTH_SECRET is a real configuration fault that throws
    // exactly there, from `resolveAuthSecret` inside `createAtriumAuth`, with
    // every row already inserted. Zero of them may survive.
    await expect(
      runSeed(cookieFile, {
        DOGFOOD_WORKSPACE_SLUG: 'dogfood-aborted',
        DOGFOOD_WORKSPACE_NAME: 'Atrium dogfood (aborted)',
        DOGFOOD_ROOM_SLUG: 'aborted-agent',
        DOGFOOD_ROOM_NAME: 'aborted-agent',
        DOGFOOD_AGENT_EMAIL: 'aborted-agent@agents.atrium.invalid',
        DOGFOOD_AGENT_NAME: 'aborted-agent',
        BETTER_AUTH_SECRET: 'too-short',
      }),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
    expect(JSON.stringify(await snapshotDatabase())).toBe(JSON.stringify(beforeFlip));

    // The two environment variables the header now names are the two whose
    // defaults are not defaults: one signs the cookie, the other decides its
    // name. A production run that leaves both unset says so before it touches
    // the database — and then refuses outright further down, because an
    // http:// origin is not a production origin, writing nothing on the way.
    const productionRun = await runSeed(cookieFile, {
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: '',
      APP_URL: '',
    }).catch((error: unknown) => error as { stderr?: string });
    expect(productionRun.stderr ?? '').toMatch(
      /NODE_ENV=production and BETTER_AUTH_SECRET and APP_URL are not set/,
    );
    expect(JSON.stringify(await snapshotDatabase())).toBe(JSON.stringify(beforeFlip));

    // Byte-idempotence has a clock in it. The reuse branch matches only a session
    // that has not lapsed, so a run past day 30 mints a second one — and without
    // the sweep the first row stays, and "run it twice, get the same bytes"
    // quietly becomes "run it twice a month apart, get two credentials". Expire
    // the agent's session by hand and re-run: exactly one row, a different token.
    const [live] = second.rows.authSessions;
    expect(live).toBeDefined();
    await handle.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(authSessions.userId, agentUser?.id as string),
          eq(authSessions.id, live?.id as string),
        ),
      );

    await runSeed(cookieFile);
    const afterExpiry = await snapshotDatabase();
    expect(afterExpiry.counts.authSessions).toBe(1);
    expect(afterExpiry.rows.authSessions[0]?.token).not.toBe(live?.token);
    expect((await readFile(cookieFile, 'utf8')).trim()).toMatch(/^better-auth\.session_token=/);
  }, 60_000);
});
