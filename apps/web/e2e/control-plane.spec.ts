import { provisionAgentConfig, provisionAgentPrincipal } from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  plans,
  rooms,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { databaseUrl } from './support/config.mjs';
import { requireBrowser, signUpAndVerify, uniqueEmail } from './support/flows';

/**
 * THE CONTROL PLANE, END TO END — the pin, the tree, the surfaces, the review
 * pane, and the human-only land, on the authenticated /app route (#121).
 *
 * A room with an agent → a funded plan → three sessions (open, settled-with-
 * artifact, failed), seeded the way the product mints them (`provisionAgent*`
 * for the identity + channel; the lifecycle projections written directly, the
 * same shape their projectors write). Then the acceptance test, in one pass:
 *
 *   - the PIN shows only what needs a human, the FAILED session on top;
 *   - the TREE renders agent → plan → session with glyphs derived from state;
 *   - the three SURFACES read real projection data, and FLIPPING the input (a
 *     plan's budget, a session's status) moves them;
 *   - the REVIEW pane shows a session's diff + tests + receipt + artifact;
 *   - the certify/land is gated on a formal human HOLD-TO-ARM: holding it lands
 *     the session (a human's name reaches `certified_by`), and NO non-human path
 *     can — the DB trigger refuses an agent certifier outright.
 */

let handle: ReturnType<typeof createDatabase>;
let db: Database;

test.beforeAll(() => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
});

test.afterAll(async () => {
  await handle.close();
});

interface Seeded {
  workspaceSlug: string;
  roomSlug: string;
  roomId: string;
  viewerId: string;
  agentId: string;
  planId: string;
  openSessionId: string;
  settledSessionId: string;
  failedSessionId: string;
}

/** One room that is an agent's channel, a funded plan, and three sessions. */
async function seed(viewerEmail: string): Promise<Seeded> {
  const tag = viewerEmail.split('@')[0] ?? 'control';
  const [viewer] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, viewerEmail))
    .limit(1);
  if (!viewer) throw new Error(`the signed-up viewer ${viewerEmail} was not found`);

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `control ${tag}`, slug: `control-${tag}` })
    .returning({ id: workspaces.id, slug: workspaces.slug });
  if (!workspace) throw new Error('workspace insert returned nothing');

  // The room is the agent's CHANNEL — plans live in the room their agent owns
  // (the plans_room_matches_agent_channel trigger, #116).
  const [room] = await db
    .insert(rooms)
    .values({ workspaceId: workspace.id, slug: 'fleet', name: 'fleet', createdBy: viewer.id })
    .returning({ id: rooms.id, slug: rooms.slug });
  if (!room) throw new Error('room insert returned nothing');

  const agent = await provisionAgentPrincipal({
    db,
    email: `agent-${tag}@agents.atrium.invalid`,
    displayName: 'hexi',
  });
  // Claim the channel and write the config: the room now names the agent, and
  // the agents sidecar carries its host/harness/model/budget.
  await provisionAgentConfig({
    db,
    userId: agent.userId,
    ownerUserId: viewer.id,
    channelRoomId: room.id,
    host: 'fly-ord',
    harness: 'claude-code',
    model: 'opus',
    budgetLimitMicros: 20_000_000,
  });

  await db.insert(workspaceMembers).values([
    { organizationId: workspace.id, userId: viewer.id, role: 'admin' },
    { organizationId: workspace.id, userId: agent.userId, role: 'member' },
  ]);
  await db.insert(memberships).values([
    { roomId: room.id, userId: viewer.id, role: 'admin' },
    { roomId: room.id, userId: agent.userId, role: 'member' },
  ]);

  // A FUNDED plan: a ceiling of 4 draws, 3 granted, $5 budget, $3.60 spent.
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

  const [openSession] = await db
    .insert(sessions)
    .values({
      roomId: room.id,
      planId: plan.id,
      harness: 'claude-code',
      model: 'sonnet · backfill',
      status: 'open',
      contextPct: 0.41,
      spendMicros: 360_000,
    })
    .returning({ id: sessions.id });

  const [settledSession] = await db
    .insert(sessions)
    .values({
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
    })
    .returning({ id: sessions.id });

  const [failedSession] = await db
    .insert(sessions)
    .values({
      roomId: room.id,
      planId: plan.id,
      harness: 'omp',
      model: 'haiku · flaky-hunt',
      status: 'failed',
      spendMicros: 220_000,
      exitSummary: 'fixtures contain production emails — halted, owed triage',
    })
    .returning({ id: sessions.id });

  if (!openSession || !settledSession || !failedSession) {
    throw new Error('session inserts returned nothing');
  }

  return {
    workspaceSlug: workspace.slug,
    roomSlug: room.slug,
    roomId: room.id,
    viewerId: viewer.id,
    agentId: agent.userId,
    planId: plan.id,
    openSessionId: openSession.id,
    settledSessionId: settledSession.id,
    failedSessionId: failedSession.id,
  };
}

async function teardown(at: Seeded): Promise<void> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, at.workspaceSlug))
    .limit(1);
  if (ws) await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  await db.delete(users).where(eq(users.id, at.agentId));
}

async function openControl(page: Page, at: Seeded): Promise<void> {
  await page.goto(`/app/${at.workspaceSlug}/${at.roomSlug}/control`);
  await expect(page.locator('[data-frame="control"]')).toBeVisible();
}

test.describe('the control plane renders the pin, tree, surfaces and a human-gated land', () => {
  requireBrowser();

  test('pin filters to needs-a-human, the tree glyphs are real, the surfaces flip, and only a human hold lands a session', async ({
    page,
  }) => {
    const email = uniqueEmail('control');
    await signUpAndVerify(page, { email, name: 'Ada' });
    const at = await seed(email);

    try {
      await openControl(page, at);

      // ── the PIN: only needs-a-human, the failed session on top ──────────────
      const firstPinItem = page.locator('[data-pin-item]').first();
      await expect(firstPinItem).toHaveAttribute('data-pin-item', at.failedSessionId);
      // its head glyph announces the hardest thing in the pin — a failure
      await expect(page.locator('[data-pin-glyph] [data-glyph]')).toHaveAttribute(
        'data-glyph',
        '✗',
      );
      // the running session is NOT in the pin — it owes nobody anything
      await expect(page.locator(`[data-pin-item="${at.openSessionId}"]`)).toHaveCount(0);

      // ── the TREE: agent → plan → session, glyphs derived from state ──────────
      await expect(page.locator(`[data-tree-agent="${at.agentId}"]`)).toBeVisible();
      await expect(page.locator(`[data-tree-plan="${at.planId}"]`)).toBeVisible();
      const failedRow = page.locator(`[data-tree-session="${at.failedSessionId}"]`);
      const settledRow = page.locator(`[data-tree-session="${at.settledSessionId}"]`);
      const openRow = page.locator(`[data-tree-session="${at.openSessionId}"]`);
      await expect(failedRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '✗');
      await expect(openRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '·');
      // settled-with-artifact, not yet landed → ■ (needs you, destructive)
      await expect(settledRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '■');

      // ── the SURFACES read real data ─────────────────────────────────────────
      await expect(page.locator('[data-surface="decisions"] [data-surface-count]')).not.toHaveText(
        '0',
      );
      await expect(page.locator('[data-surface="unseen"]')).toBeVisible();
      await expect(page.locator(`[data-cost-plan="${at.planId}"] [data-cost-draws]`)).toHaveText(
        '3/4 draws',
      );

      // ── the REVIEW pane: diff + tests + receipt + artifact ───────────────────
      await settledRow.click();
      const review = page.locator(`[data-review-session="${at.settledSessionId}"]`);
      await expect(review).toBeVisible();
      await expect(review.locator('[data-diff-stat]')).toHaveText('+128 −34 · 6 files');
      await expect(review.locator('[data-tests-passed]')).toHaveText('41 passed');
      await expect(review.locator('[data-exit-summary]')).toContainText('suite green');
      await expect(review.locator('[data-artifact-branch]')).toHaveText('feat/users-migration');
      await expect(review.locator('[data-artifact-commit]')).toHaveText('a1b2c3d');

      // ── the CERTIFY gate: a human hold-to-arm, and nothing else, lands it ────
      const certify = review.locator('[data-certify="ready"]');
      await expect(certify).toBeVisible();
      const hold = certify.locator(`[data-hold-action="certify-${at.settledSessionId}"]`);
      await expect(hold).toBeVisible();

      // it is not yet landed
      const before = await db
        .select({ certifiedBy: sessions.certifiedBy })
        .from(sessions)
        .where(eq(sessions.id, at.settledSessionId));
      expect(before[0]?.certifiedBy).toBeNull();

      // press and HOLD past the 2s gate without releasing; onAct fires on the clock
      const box = await hold.boundingBox();
      if (!box) throw new Error('the hold control had no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(2400);
      await page.mouse.up();

      // a human's name reached certified_by — the session is landed
      await expect
        .poll(
          async () =>
            (
              await db
                .select({ certifiedBy: sessions.certifiedBy })
                .from(sessions)
                .where(eq(sessions.id, at.settledSessionId))
            )[0]?.certifiedBy ?? null,
          { timeout: 15_000, message: 'the held certification to reach certified_by' },
        )
        .toBe(at.viewerId);

      // ── no non-human path can land: the DB trigger refuses an agent ──────────
      let refused = false;
      try {
        await db
          .update(sessions)
          .set({ certifiedBy: at.agentId })
          .where(eq(sessions.id, at.failedSessionId));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      const failedStill = await db
        .select({ certifiedBy: sessions.certifiedBy })
        .from(sessions)
        .where(eq(sessions.id, at.failedSessionId));
      expect(failedStill[0]?.certifiedBy).toBeNull();

      // ── FLIP THE INPUT: lower the plan's ceiling below its draws → cost warns ─
      await db.update(plans).set({ rlimitSlice: 1 }).where(eq(plans.id, at.planId));
      // ── FLIP THE INPUT: the running session fails → the pin gains a failure ───
      await db
        .update(sessions)
        .set({ status: 'failed', exitSummary: 'lost its host' })
        .where(eq(sessions.id, at.openSessionId));

      await page.reload();
      await expect(page.locator('[data-frame="control"]')).toBeVisible();
      // cost moved: the draws label now reads over its lowered ceiling
      await expect(page.locator(`[data-cost-plan="${at.planId}"] [data-cost-draws]`)).toHaveText(
        '3/1 draws',
      );
      // the once-running session is now a failure in the pin
      await expect(page.locator(`[data-pin-item="${at.openSessionId}"]`)).toBeVisible();
      // and the landed session no longer needs a human — it left the pin
      await expect(page.locator(`[data-pin-item="${at.settledSessionId}"]`)).toHaveCount(0);
    } finally {
      await teardown(at);
    }
  });
});
