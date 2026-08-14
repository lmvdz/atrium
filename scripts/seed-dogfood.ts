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
 * Also read, and not optional in the way a default makes them look:
 *
 *   BETTER_AUTH_SECRET=...  signs the cookie this script writes. Unset, the
 *     process this seed runs in falls back to `developmentSecret` — a constant
 *     published in `packages/auth/src/secret.ts` — and mints an agent session
 *     anyone holding this repository can forge. `resolveAuthSecret` refuses that
 *     when it can see `NODE_ENV=production`, but a seed is usually run as a
 *     one-off shell command against a production database with no NODE_ENV set
 *     at all, which is exactly the case its refusal cannot see. Set it here to
 *     the same value the web app and the realtime server hold; a cookie signed
 *     with a different secret is rejected by both.
 *
 *   APP_URL=...  (default `http://localhost:3000`) decides the cookie's NAME,
 *     not just its audience: `useSecureCookies` reads the scheme, so an
 *     `https://` deployment's session cookie is `__Secure-better-auth.
 *     session_token` and an `http://` one is `better-auth.session_token`. Seed
 *     with the wrong scheme and the daemon presents a correctly-signed cookie
 *     under a name the server never looks for. That fails closed — nothing is
 *     authorized that should not be — and it fails silently enough to cost an
 *     afternoon, so pass the deployment's real public origin.
 *
 * Run: pnpm seed:dogfood
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
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
  type Database,
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

/**
 * The handle drizzle hands a `transaction` callback.
 *
 * Structurally it is the pool handle minus one property — `$client`, the raw
 * postgres-js socket — which is why `transactional` below can hand it to helpers
 * typed `Database` by putting that one property back. The client it puts back is
 * the client this very transaction runs on, so the type is not being talked out
 * of anything: every query issued through the result really does land inside the
 * open transaction.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function transactional(tx: Tx): Database {
  return Object.assign(tx, { $client: handle.sql });
}

/**
 * Say so, once, when a production run is about to use a default that is not one.
 *
 * Not a refusal. `resolveAuthSecret` already refuses a missing secret when it
 * can see `NODE_ENV=production`, and the case this catches is the one where
 * NODE_ENV *is* set and the operator still forgot — a short warning ahead of the
 * work is worth more than the same error thrown from inside a cookie mint. The
 * far more common shape, a seed run against production with no NODE_ENV at all,
 * cannot be detected from inside this process; the header comment is the only
 * control there, and it says so.
 */
function warnAboutProductionDefaults(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const defaulted: string[] = [];
  if (!process.env.BETTER_AUTH_SECRET?.trim()) defaulted.push('BETTER_AUTH_SECRET');
  if (!process.env.APP_URL?.trim()) defaulted.push('APP_URL');
  if (defaulted.length === 0) return;
  console.warn(
    `[seed:dogfood] NODE_ENV=production and ${defaulted.join(' and ')} ` +
      `${defaulted.length === 1 ? 'is' : 'are'} not set. ` +
      'BETTER_AUTH_SECRET signs the agent cookie — defaulted, it is the published ' +
      'development secret and the session is forgeable. APP_URL decides the ' +
      "cookie's name — defaulted to http://localhost:3000, an https:// deployment " +
      'is served a cookie it will never look for. See the header of ' +
      'scripts/seed-dogfood.ts.',
  );
}

async function ownerId(db: Database): Promise<string> {
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

async function ensureWorkspace(db: Database): Promise<{ id: string; slug: string }> {
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
  db: Database,
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

async function ensureAgentPrincipal(db: Database) {
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

async function ensureAgentConfig(
  db: Database,
  userId: string,
  ownerUserId: string,
  channelRoomId: string,
) {
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
  db: Database,
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
  db: Database,
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

/**
 * The agent's session cookie: reuse the live one, sweep the dead ones, mint if
 * there is nothing left.
 *
 * ## What this cookie actually is
 *
 * A **full 30-day agent session** — the same row, in the same table, read back
 * by the same `auth.api.getSession` call as a person's. It is not a read-only or
 * subscribe-only credential and there is no such thing in Atrium: holding it,
 * the daemon can do everything its memberships allow, which in its own channel
 * is post, propose, open a session, settle it and resume it, once a human has
 * funded a plan. What it cannot do is fund one — that is the human act this seed
 * deliberately leaves undone — and it can act nowhere it is not a member.
 *
 * Rotation on demand is **out of scope** here and stays that way. A seed runs
 * when an operator provisions; revoking a leaked cookie, or cycling one before
 * it lapses, is daemon operations, and building either into a provisioning
 * script would mean the script has to be running when the incident happens.
 * Today the operator's revoke is `DELETE FROM auth_sessions WHERE user_id = …`
 * followed by another run of this seed.
 *
 * ## Why expired rows are deleted
 *
 * The reuse branch only matches a session that has not lapsed, so past day 30
 * this function mints a second one and the old row stays forever — a table that
 * grows one dead credential per run, and, more immediately, a seed that is no
 * longer byte-idempotent: two runs a month apart would leave two rows where the
 * test asserts one. Deleting this agent's expired sessions first makes the
 * post-expiry run replace rather than accumulate. It touches only rows that are
 * already unusable (`expires_at <= now`), and only this agent's.
 */
async function agentCookie(db: Database, userId: string): Promise<string> {
  const auth = createAtriumAuth({ db, baseURL: APP_URL });
  const now = new Date();
  await db
    .delete(authSessions)
    .where(and(eq(authSessions.userId, userId), lte(authSessions.expiresAt, now)));
  const [existing] = await db
    .select({ token: authSessions.token })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, now)))
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

/**
 * Every row this seed writes, in ONE transaction — because its refusals are the
 * point of it.
 *
 * The checks below are not validation, they are the seed's contract: "seeding a
 * second, different agent over the first one is not idempotency, it is a
 * mistake, and I will not do it." Round 1 spread those checks through the run —
 * the workspace and the room were upserted BEFORE the agent identity was even
 * looked at — so flipping `DOGFOOD_WORKSPACE_SLUG` (or the room slug, or the
 * agent email) produced the refusal *and* an orphan workspace and room that
 * nothing subsequently owned or cleaned up. A refusal that has already written
 * half of what it is refusing is not a refusal.
 *
 * So the ordering question is answered by making it irrelevant: all-or-nothing.
 * Anything that throws — the owner lookup, any of the six identity checks, the
 * cookie mint, a database constraint — rolls the whole thing back, and the
 * database is byte-identical to what it was before the run.
 *
 * The cookie FILE is deliberately outside. It is not a database row and it
 * cannot join the transaction; writing it after the commit means the file can
 * only ever name a session that really exists, and the failure it leaves behind
 * (rows committed, file not written) is repaired by running the seed again,
 * which reuses that same session rather than minting another.
 */
async function main(): Promise<void> {
  warnAboutProductionDefaults();

  const seeded = await handle.db.transaction(async (transaction) => {
    const db = transactional(transaction);
    const humanUserId = await ownerId(db);
    const workspace = await ensureWorkspace(db);
    const room = await ensureRoom(db, workspace.id, humanUserId);
    const agent = await ensureAgentPrincipal(db);
    await ensureAgentConfig(db, agent.userId, humanUserId, room.id);

    await ensureWorkspaceMembership(db, workspace.id, humanUserId, 'owner');
    await ensureRoomMembership(db, room.id, humanUserId, 'owner');
    // Channel ownership is not room authorization. Membership is what every
    // room join reads, so these two rows are what let the agent participate in
    // its own channel at all — see `agentCookie` for what participating means.
    await ensureWorkspaceMembership(db, workspace.id, agent.userId, 'member');
    await ensureRoomMembership(db, room.id, agent.userId, 'member');

    return { workspace, room, agent, cookie: await agentCookie(db, agent.userId) };
  });

  await writeCookieFile(seeded.cookie);
  const { workspace, room, agent } = seeded;

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
