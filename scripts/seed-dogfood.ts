/**
 * Minimal Phase-4 dogfood seed: one existing human owns one agent, and the
 * agent owns one empty channel. It deliberately creates no plan or execution
 * session; funding and work are acts that happen after provisioning.
 *
 * Required:
 *   DATABASE_URL=...
 *   DOGFOOD_OWNER_EMAIL=...       an existing, human Atrium identity
 *   DOGFOOD_COOKIE_FILE=...       file the agent daemon will read
 *
 * Run: pnpm seed:dogfood
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, desc, eq, gt } from 'drizzle-orm';
import {
  createAtriumAuth,
  mintAgentSession,
  provisionAgentConfig,
  provisionAgentPrincipal,
  sessionCookieHeader,
} from '../packages/auth/src/index.js';
import {
  agents,
  authSessions,
  createDatabase,
  memberships,
  rooms,
  users,
  workspaceMembers,
  workspaces,
} from '../packages/db/src/index.js';

function required(name: 'DATABASE_URL' | 'DOGFOOD_COOKIE_FILE' | 'DOGFOOD_OWNER_EMAIL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const DATABASE_URL = required('DATABASE_URL');
const COOKIE_FILE = required('DOGFOOD_COOKIE_FILE');
const OWNER_EMAIL = required('DOGFOOD_OWNER_EMAIL');
const APP_URL = process.env.APP_URL?.trim() || 'http://localhost:3000';
const WORKSPACE_SLUG = process.env.DOGFOOD_WORKSPACE_SLUG?.trim() || 'dogfood';
const WORKSPACE_NAME = process.env.DOGFOOD_WORKSPACE_NAME?.trim() || 'Atrium dogfood';
const ROOM_SLUG = process.env.DOGFOOD_ROOM_SLUG?.trim() || 'atrium-agent';
const ROOM_NAME = process.env.DOGFOOD_ROOM_NAME?.trim() || 'atrium-agent';
const AGENT_EMAIL = process.env.DOGFOOD_AGENT_EMAIL?.trim() || 'atrium-agent@agents.atrium.invalid';
const AGENT_NAME = process.env.DOGFOOD_AGENT_NAME?.trim() || 'atrium-agent';

// `agents.host/harness/model` are required placeholders in the current schema.
// These values state that no execution provider (and, in particular, no repo)
// has been selected by this seed.
const UNCONFIGURED = 'unconfigured';

const handle = createDatabase({ url: DATABASE_URL, max: 4 });
const db = handle.db;

async function ownerId(): Promise<string> {
  const [owner] = await db
    .select({ id: users.id, principalKind: users.principalKind })
    .from(users)
    .where(eq(users.email, OWNER_EMAIL))
    .limit(1);
  if (!owner) {
    throw new Error(
      `DOGFOOD_OWNER_EMAIL names no existing identity: ${JSON.stringify(OWNER_EMAIL)}`,
    );
  }
  if (owner.principalKind !== 'human') {
    throw new Error(
      `DOGFOOD_OWNER_EMAIL must name a human principal; ${JSON.stringify(OWNER_EMAIL)} is ${owner.principalKind}`,
    );
  }
  return owner.id;
}

async function ensureWorkspace(): Promise<{ id: string; slug: string }> {
  const [inserted] = await db
    .insert(workspaces)
    .values({ name: WORKSPACE_NAME, slug: WORKSPACE_SLUG })
    .onConflictDoNothing({ target: workspaces.slug })
    .returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
  const row =
    inserted ??
    (
      await db
        .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.slug, WORKSPACE_SLUG))
        .limit(1)
    )[0];
  if (!row) throw new Error('workspace upsert returned no row');
  if (row.name !== WORKSPACE_NAME) {
    throw new Error(
      `workspace ${JSON.stringify(WORKSPACE_SLUG)} already exists with name ${JSON.stringify(row.name)}, not DOGFOOD_WORKSPACE_NAME ${JSON.stringify(WORKSPACE_NAME)}`,
    );
  }
  return { id: row.id, slug: row.slug };
}

async function ensureRoom(
  workspaceId: string,
  createdBy: string,
): Promise<{ id: string; slug: string }> {
  const [inserted] = await db
    .insert(rooms)
    .values({ workspaceId, slug: ROOM_SLUG, name: ROOM_NAME, createdBy })
    .onConflictDoNothing({ target: [rooms.workspaceId, rooms.slug] })
    .returning({
      id: rooms.id,
      workspaceId: rooms.workspaceId,
      slug: rooms.slug,
      name: rooms.name,
      createdBy: rooms.createdBy,
    });
  const row =
    inserted ??
    (
      await db
        .select({
          id: rooms.id,
          workspaceId: rooms.workspaceId,
          slug: rooms.slug,
          name: rooms.name,
          createdBy: rooms.createdBy,
        })
        .from(rooms)
        .where(and(eq(rooms.workspaceId, workspaceId), eq(rooms.slug, ROOM_SLUG)))
        .limit(1)
    )[0];
  if (!row) throw new Error('room upsert returned no row');
  if (row.name !== ROOM_NAME || row.createdBy !== createdBy) {
    throw new Error(
      `room ${JSON.stringify(ROOM_SLUG)} already exists with different name or creator`,
    );
  }
  return { id: row.id, slug: row.slug };
}

async function ensureAgentPrincipal() {
  const [existing] = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      principalKind: users.principalKind,
    })
    .from(users)
    .where(eq(users.email, AGENT_EMAIL))
    .limit(1);
  if (!existing) {
    return provisionAgentPrincipal({ db, email: AGENT_EMAIL, displayName: AGENT_NAME });
  }
  if (existing.principalKind !== 'agent' || existing.displayName !== AGENT_NAME) {
    throw new Error(
      `agent ${JSON.stringify(AGENT_EMAIL)} already exists as ${existing.principalKind} with display_name ${JSON.stringify(existing.displayName)}, not DOGFOOD_AGENT_NAME ${JSON.stringify(AGENT_NAME)}`,
    );
  }
  return { ...existing, principalKind: 'agent' as const };
}

async function ensureAgentConfig(userId: string, ownerUserId: string, channelRoomId: string) {
  const [existing] = await db
    .select({
      userId: agents.userId,
      ownerUserId: agents.ownerUserId,
      channelRoomId: agents.channelRoomId,
      host: agents.host,
      harness: agents.harness,
      model: agents.model,
      budgetLimitMicros: agents.budgetLimitMicros,
    })
    .from(agents)
    .where(eq(agents.userId, userId))
    .limit(1);
  if (!existing) {
    return provisionAgentConfig({
      db,
      userId,
      ownerUserId,
      channelRoomId,
      host: UNCONFIGURED,
      harness: UNCONFIGURED,
      model: UNCONFIGURED,
    });
  }
  const expected = {
    userId,
    ownerUserId,
    channelRoomId,
    host: UNCONFIGURED,
    harness: UNCONFIGURED,
    model: UNCONFIGURED,
    budgetLimitMicros: null,
  };
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(`agent ${JSON.stringify(AGENT_EMAIL)} already has different config`);
  }
  return existing;
}

async function ensureWorkspaceMembership(
  organizationId: string,
  userId: string,
  role: 'owner' | 'member',
): Promise<void> {
  await db
    .insert(workspaceMembers)
    .values({ organizationId, userId, role })
    .onConflictDoNothing({ target: [workspaceMembers.organizationId, workspaceMembers.userId] });
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.organizationId, organizationId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);
  if (row?.role !== role) {
    throw new Error(
      `workspace membership for ${userId} exists with role ${row?.role}, not ${role}`,
    );
  }
}

async function ensureRoomMembership(
  roomId: string,
  userId: string,
  role: 'owner' | 'member',
): Promise<void> {
  await db
    .insert(memberships)
    .values({ roomId, userId, role })
    .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.roomId, roomId), eq(memberships.userId, userId)))
    .limit(1);
  if (row?.role !== role) {
    throw new Error(`room membership for ${userId} exists with role ${row?.role}, not ${role}`);
  }
}

async function agentCookie(userId: string): Promise<string> {
  const auth = createAtriumAuth({ db, baseURL: APP_URL });
  const [existing] = await db
    .select({ token: authSessions.token })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.createdAt))
    .limit(1);
  if (existing) return sessionCookieHeader(auth, existing.token);
  return (await mintAgentSession({ auth, db, userId })).cookie;
}

async function writeCookieFile(cookie: string): Promise<void> {
  const parent = dirname(COOKIE_FILE);
  await mkdir(parent, { recursive: true });
  const temporary = `${COOKIE_FILE}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${cookie}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, COOKIE_FILE);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const humanUserId = await ownerId();
  const workspace = await ensureWorkspace();
  const room = await ensureRoom(workspace.id, humanUserId);
  const agent = await ensureAgentPrincipal();
  await ensureAgentConfig(agent.userId, humanUserId, room.id);

  await ensureWorkspaceMembership(workspace.id, humanUserId, 'owner');
  await ensureRoomMembership(room.id, humanUserId, 'owner');
  // Channel ownership is not room authorization. The daemon needs these two
  // rows to subscribe and read, through the same joins every participant uses.
  await ensureWorkspaceMembership(workspace.id, agent.userId, 'member');
  await ensureRoomMembership(room.id, agent.userId, 'member');

  await writeCookieFile(await agentCookie(agent.userId));

  console.log('dogfood agent provisioned');
  console.log(`workspace: ${workspace.slug}`);
  console.log(`channel: ${room.slug}`);
  console.log(`agent: ${agent.email}`);
  console.log(`cookie file: ${COOKIE_FILE}`);
}

main()
  .then(() => handle.close())
  .catch(async (error) => {
    console.error(error);
    await handle.close();
    process.exitCode = 1;
  });
