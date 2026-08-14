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
import { asc } from 'drizzle-orm';
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
  }, 60_000);
});
