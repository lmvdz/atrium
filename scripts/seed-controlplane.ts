/**
 * Dev seed for the Phase-3 control plane — an agent → funded plan → four
 * sessions, viewable on the authenticated /app route. Mirrors the shapes the
 * e2e (apps/web/e2e/control-plane.spec.ts) mints, plus a loggable human.
 *
 * Run:  DATABASE_URL=... APP_URL=http://localhost:3000 tsx scripts/seed-controlplane.ts
 */
import { eq, sql } from 'drizzle-orm';
import {
  createAtriumAuth,
  provisionAgentConfig,
  provisionAgentPrincipal,
} from '../packages/auth/src/index.js';
import {
  createDatabase,
  memberships,
  plans,
  rooms,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../packages/db/src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const EMAIL = process.env.SEED_EMAIL ?? 'operator@atrium.dev';
const PASSWORD = process.env.SEED_PASSWORD ?? 'atrium-preview-2026';
const NAME = 'Operator';
const WS_SLUG = 'control-operator';
const ROOM_SLUG = 'fleet';

const handle = createDatabase({ url: DATABASE_URL, max: 4 });
const db = handle.db;

async function findUser(email: string): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return u?.id ?? null;
}

async function ensureHuman(): Promise<string> {
  let id = await findUser(EMAIL);
  if (!id) {
    // Better Auth's HTTP endpoints are behind a mounted-path allowlist; the app
    // signs up through a Server Action calling `auth.api.*` in-process. Do the
    // same — build the shared instance and call it directly.
    const authInstance = createAtriumAuth({ db, baseURL: APP_URL });
    try {
      await authInstance.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: NAME } });
    } catch (e) {
      // requireEmailVerification means no session is minted; the user row is
      // still written. Only re-throw if the user genuinely didn't appear.
      if (!(await findUser(EMAIL))) throw e;
    }
    id = await findUser(EMAIL);
    if (!id) throw new Error(`sign-up did not create ${EMAIL}`);
  }
  // requireEmailVerification is on; a seeded operator never reads mail, so verify it directly.
  await db.execute(sql`UPDATE users SET email_verified = true WHERE email = ${EMAIL}`);
  return id;
}

/** Remove any prior seed of this workspace so the script is re-runnable. */
async function wipePrior(): Promise<void> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, WS_SLUG))
    .limit(1);
  if (!ws) return;
  const roomRows = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.workspaceId, ws.id));
  for (const r of roomRows) {
    await db.delete(sessions).where(eq(sessions.roomId, r.id));
    await db.delete(plans).where(eq(plans.roomId, r.id));
    await db.delete(memberships).where(eq(memberships.roomId, r.id));
  }
  // Drop the agent's channel FK before the rooms it points at.
  for (const r of roomRows) {
    await db.execute(sql`UPDATE rooms SET agent_user_id = NULL WHERE id = ${r.id}`);
  }
  await db.delete(rooms).where(eq(rooms.workspaceId, ws.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.organizationId, ws.id));
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
}

async function main() {
  const viewerId = await ensureHuman();
  await wipePrior();

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Control — Operator', slug: WS_SLUG })
    .returning({ id: workspaces.id, slug: workspaces.slug });
  if (!workspace) throw new Error('workspace insert returned nothing');

  const [room] = await db
    .insert(rooms)
    .values({ workspaceId: workspace.id, slug: ROOM_SLUG, name: 'fleet', createdBy: viewerId })
    .returning({ id: rooms.id, slug: rooms.slug });
  if (!room) throw new Error('room insert returned nothing');

  const agent = await provisionAgentPrincipal({
    db,
    email: 'agent-operator@agents.atrium.invalid',
    displayName: 'hexi',
  });
  await provisionAgentConfig({
    db,
    userId: agent.userId,
    ownerUserId: viewerId,
    channelRoomId: room.id,
    host: 'fly-ord',
    harness: 'claude-code',
    model: 'opus',
    budgetLimitMicros: 20_000_000,
  });

  await db.insert(workspaceMembers).values([
    { organizationId: workspace.id, userId: viewerId, role: 'admin' },
    { organizationId: workspace.id, userId: agent.userId, role: 'member' },
  ]);
  await db.insert(memberships).values([
    { roomId: room.id, userId: viewerId, role: 'admin' },
    { roomId: room.id, userId: agent.userId, role: 'member' },
  ]);

  // A funded plan: ceiling 4 draws, 3 granted, $5 budget, $3.60 spent.
  const [plan] = await db
    .insert(plans)
    .values({
      roomId: room.id,
      agentUserId: agent.userId,
      title: 'the users migration',
      status: 'open',
      rlimitSlice: 4,
      authorizedDraws: 3,
      budgetLimitMicros: 5_000_000,
      spentMicros: 3_600_000,
    })
    .returning({ id: plans.id });
  if (!plan) throw new Error('plan insert returned nothing');

  await db.insert(sessions).values([
    {
      roomId: room.id,
      planId: plan.id,
      harness: 'claude-code',
      model: 'sonnet · backfill',
      status: 'open',
      contextPct: 0.41,
      spendMicros: 360_000,
    },
    {
      roomId: room.id,
      planId: plan.id,
      harness: 'claude-code',
      model: 'opus · tests',
      status: 'settled',
      contextPct: 0.62,
      spendMicros: 1_800_000,
      exitSummary: 'Added the backfill and its tests; suite green.',
      artifact: {
        branch: 'feat/users-migration',
        commit: 'a1b2c3d',
        diffStat: '+128 −34 · 6 files',
        testsPassed: 41,
        testsFailed: 0,
        summary: 'ready to land onto feat/users-migration',
      },
    },
    {
      roomId: room.id,
      planId: plan.id,
      harness: 'omp',
      model: 'haiku · flaky-hunt',
      status: 'failed',
      spendMicros: 220_000,
      exitSummary: 'fixtures contain production emails — halted, owed triage',
    },
    {
      roomId: room.id,
      planId: plan.id,
      harness: 'omp',
      model: 'sonnet · audit',
      status: 'settled',
      spendMicros: 90_000,
      exitSummary: 'read-only audit; nothing to land',
    },
  ]);

  console.log('\n  control plane seeded ✓');
  console.log('  ────────────────────────────────────────────');
  console.log(`  sign in : ${APP_URL}/sign-in`);
  console.log(`  email   : ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  open    : ${APP_URL}/app/${workspace.slug}/${room.slug}/control`);
  console.log('  ────────────────────────────────────────────');
  console.log('  pin: a FAILED session on top (✗), a settled artifact awaiting landing (■).');
  console.log('  tree: agent hexi → plan "the users migration" → 4 sessions.');
  console.log('  the clean-exit session reads ~ (nothing to certify), never a false ✓.\n');
}

main()
  .then(() => handle.close())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await handle.close();
    process.exit(1);
  });
