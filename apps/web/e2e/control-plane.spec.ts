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
 *   - the certify is gated on a formal human HOLD-TO-ARM whose duration the
 *     SERVER measures: holding it past the gate certifies (a human's name reaches
 *     `certified_by`), a request with no server arm does NOT, and no non-human
 *     path can — the DB triggers refuse an agent certifier or armer outright.
 *
 * ## AND THE TICK IS THE COVENANT'S (#121 fix round, CS-1)
 *
 * The seeded settled-with-artifact session reads `■` before certification and
 * `✓` after, which the shipped build also did. What it did NOT do is read `~` for
 * a settled session with nothing to certify: that rendered `✓` off an exit code,
 * with no person involved. So this seeds a FOURTH session — settled, no artifact,
 * uncertified — and asserts the tree renders `~` on it, in a browser, against the
 * real projection. That is the case the whole fix round turns on.
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
  /** settled, NO artifact, uncertified — the row that used to lie with a ✓. */
  cleanExitSessionId: string;
  /** settled with the #145 enrichment — a real structured diff + failing tests. */
  richSessionId: string;
  /** settled whose producer reported an EMPTY diff — the honest-empty case. */
  emptyDiffSessionId: string;
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

  /* A CLEAN EXIT WITH NOTHING TO CERTIFY. The process says it finished; no
     person has looked at it; there is no artifact to review. Under the covenant
     that is `~` — the claimant's own account — and it is what shipped as `✓`. */
  const [cleanExitSession] = await db
    .insert(sessions)
    .values({
      roomId: room.id,
      planId: plan.id,
      harness: 'omp',
      model: 'sonnet · audit',
      status: 'settled',
      spendMicros: 90_000,
      exitSummary: 'read-only audit; nothing to land',
    })
    .returning({ id: sessions.id });

  /* A SETTLED SESSION CARRYING THE REAL #145 ENRICHMENT — a structured per-file
     diff (with a hunk whose line contains quotation marks and first person, to
     prove the render does NOT hold verbatim file content to the system-voice ban)
     and a structured test report with failing names. */
  const [richSession] = await db
    .insert(sessions)
    .values({
      roomId: room.id,
      planId: plan.id,
      harness: 'claude-code',
      model: 'opus · diff',
      status: 'settled',
      contextPct: 0.55,
      spendMicros: 1_200_000,
      exitSummary: 'Reworked the loader; two tests still red.',
      artifact: {
        branch: 'feat/loader',
        commit: 'deadbee',
        diff: {
          files: [
            {
              path: 'src/loader.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              binary: false,
              hunks: [
                {
                  header: '@@ -1,3 +1,4 @@',
                  lines: [
                    ' export function load() {',
                    '-  return null;',
                    '+  const msg = "I said we would ship";',
                    '+  return msg;',
                  ],
                },
              ],
            },
          ],
          fileCount: 1,
          additions: 2,
          deletions: 1,
          truncated: false,
        },
        tests: {
          passed: 39,
          failed: 2,
          failures: ['loader > returns the message', 'loader > handles empty input'],
          failuresTruncated: false,
          command: 'pnpm --filter loader test',
        },
      },
    })
    .returning({ id: sessions.id });

  /* A SETTLED SESSION WHOSE PRODUCER REPORTED AN EMPTY DIFF — the honest-empty
     case: present-but-empty, which must render "no changes", NOT the absent copy. */
  const [emptyDiffSession] = await db
    .insert(sessions)
    .values({
      roomId: room.id,
      planId: plan.id,
      harness: 'omp',
      model: 'sonnet · noop',
      status: 'settled',
      spendMicros: 40_000,
      exitSummary: 'settled without touching the tree',
      artifact: {
        branch: 'feat/noop',
        commit: 'cafef00',
        diff: { files: [], fileCount: 0, additions: 0, deletions: 0, truncated: false },
      },
    })
    .returning({ id: sessions.id });

  if (
    !openSession ||
    !settledSession ||
    !failedSession ||
    !cleanExitSession ||
    !richSession ||
    !emptyDiffSession
  ) {
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
    cleanExitSessionId: cleanExitSession.id,
    richSessionId: richSession.id,
    emptyDiffSessionId: emptyDiffSession.id,
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
      const cleanExitRow = page.locator(`[data-tree-session="${at.cleanExitSessionId}"]`);
      await expect(failedRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '✗');
      await expect(openRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '·');
      // settled-with-artifact, not yet certified → ■ (needs you, and written once)
      await expect(settledRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '■');

      /* CS-1, IN THE BROWSER. A settled session nobody has certified is `~`. It
         rendered `✓` — the covenant's own glyph, minted by an exit code. */
      await expect(cleanExitRow.locator('[data-glyph]').first()).toHaveAttribute('data-glyph', '~');
      // …and it wears no certified badge, because nobody certified it.
      await expect(page.locator(`[data-session-certified="${at.cleanExitSessionId}"]`)).toHaveCount(
        0,
      );

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

      /* ── THE COPY TELLS THE TRUTH ABOUT WHAT THE ACTION DOES ──────────────
         It used to read "Certifying lands this work onto <branch>", which is
         false: nothing here merges, pushes or deploys — it writes four columns.
         A person who acted on that sentence believed the branch had moved. */
      const certify = review.locator('[data-certify="ready"]');
      await expect(certify).toBeVisible();
      await expect(certify).not.toContainText(/lands this work onto/i);
      await expect(certify).toContainText(/moves no code/i);
      await expect(certify).toContainText(/written once/i);

      // ── the CERTIFY gate: a SERVER-measured human hold, and nothing else ─────
      const hold = certify.locator(`[data-hold-action="certify-${at.settledSessionId}"]`);
      await expect(hold).toBeVisible();

      // it is not yet certified, and nothing is armed
      const before = await db
        .select({ certifiedBy: sessions.certifiedBy, armedAt: sessions.certifyArmedAt })
        .from(sessions)
        .where(eq(sessions.id, at.settledSessionId));
      expect(before[0]?.certifiedBy).toBeNull();
      expect(before[0]?.armedAt).toBeNull();

      /* A TAP IS NOT A HOLD. Press and release immediately: the control arms on
         the server (that is what `onBegin` is for) and then cancels, so the
         confirm never fires — and even if something fired one, the server-measured
         interval would be milliseconds. Nothing may reach `certified_by`. */
      const box = await hold.boundingBox();
      if (!box) throw new Error('the hold control had no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(1_000);
      const afterTap = await db
        .select({ certifiedBy: sessions.certifiedBy })
        .from(sessions)
        .where(eq(sessions.id, at.settledSessionId));
      expect(afterTap[0]?.certifiedBy).toBeNull();

      // Now press and HOLD past the gate without releasing; onAct fires on the clock.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(3_200);
      await page.mouse.up();

      // a human's name reached certified_by — the session is certified
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

      /* AND THE RECORDED DURATION IS THE SERVER'S MEASUREMENT, not a number the
         page sent — there is no longer any field for the page to send it in. */
      const receipt = await db
        .select({ heldMs: sessions.certifiedHeldMs, certifiedAt: sessions.certifiedAt })
        .from(sessions)
        .where(eq(sessions.id, at.settledSessionId));
      expect(receipt[0]?.heldMs ?? 0).toBeGreaterThanOrEqual(2000);
      expect(receipt[0]?.certifiedAt).not.toBeNull();

      // ── no non-human path can certify: the DB triggers refuse an agent ───────
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

      // …and a certification, once made, cannot be un-made (drizzle/0033).
      let unlandRefused = false;
      try {
        await db
          .update(sessions)
          .set({ certifiedBy: null })
          .where(eq(sessions.id, at.settledSessionId));
      } catch {
        unlandRefused = true;
      }
      expect(unlandRefused).toBe(true);

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
      // and the certified session no longer needs a human — it left the pin
      await expect(page.locator(`[data-pin-item="${at.settledSessionId}"]`)).toHaveCount(0);
      /* THE FLIP THAT MOVES THE TICK: the certified session now reads ✓ and wears
         the badge, while the uncertified clean exit beside it still reads ~. One
         glyph, one signature, and the two rows disagree because the DATA does. */
      await expect(
        page.locator(`[data-tree-session="${at.settledSessionId}"] [data-glyph]`).first(),
      ).toHaveAttribute('data-glyph', '✓');
      await expect(page.locator(`[data-session-certified="${at.settledSessionId}"]`)).toHaveCount(
        1,
      );
      await expect(
        page.locator(`[data-tree-session="${at.cleanExitSessionId}"] [data-glyph]`).first(),
      ).toHaveAttribute('data-glyph', '~');
    } finally {
      await teardown(at);
    }
  });

  /**
   * THE REAL DIFF + TESTS, IN THE BROWSER (#145). The pane renders the actual
   * per-file hunks in a scroll box, a code line full of quotation marks and first
   * person survives the render (it is verbatim file content, not the system's
   * voice), the failing test names show, and a present-but-empty diff renders an
   * honest "no changes" rather than the absent copy. Checked in both themes,
   * because the diff colours are design tokens.
   */
  test('renders real diff hunks, failing tests, and an honest-empty diff', async ({ page }) => {
    const email = uniqueEmail('control-diff');
    await signUpAndVerify(page, { email, name: 'Ada' });
    const at = await seed(email);

    try {
      await openControl(page, at);

      // ── the RICH session: real hunks in a scroll box ────────────────────────
      await page.locator(`[data-tree-session="${at.richSessionId}"]`).click();
      const review = page.locator(`[data-review-session="${at.richSessionId}"]`);
      await expect(review).toBeVisible();

      const scroll = review.locator('[data-diff-scroll]');
      await expect(scroll).toBeVisible();
      await expect(review.locator('[data-diff-file-path="src/loader.ts"]')).toBeVisible();
      // The added line carries quotation marks AND first person — verbatim file
      // content the render must NOT hold to the system-voice ban. If `fileText`
      // regressed into a speech check, this line would have thrown the page.
      await expect(review.locator('[data-diff-line="add"]').first()).toContainText(
        'const msg = "I said we would ship";',
      );
      // FIX 4 (#145 r2): the +/− marker is the fixed GUTTER's chrome, so every
      // rendered row carries a gutter the content cannot forge — a line like
      // `+✓ certified by Ada` would show THIS `+` as chrome, marking it file content.
      await expect(
        review.locator('[data-diff-line="add"]').first().locator('[data-diff-gutter="add"]'),
      ).toHaveCount(1);
      // A real hunk carries context, not just the change.
      await expect(review.locator('[data-diff-line="context"]').first()).toContainText(
        'export function load()',
      );
      await expect(review.locator('[data-diff-file-count]')).toContainText('1 file');

      // ── the TESTS: a REPORTED ~ fact, never a bare green pass (#145 r2, FIX 2) ─
      // The block leads with the reported-not-verified marker and names what ran,
      // so a green pass count is never read as a ✓ the machine did not earn.
      const reported = review.locator('[data-tests-reported]');
      await expect(reported).toBeVisible();
      await expect(reported).toContainText('~');
      await expect(reported).toContainText(/not verified/i);
      await expect(review.locator('[data-tests-command]')).toContainText(
        'pnpm --filter loader test',
      );
      await expect(review.locator('[data-tests-failed]')).toContainText('2 failed');
      await expect(review.locator('[data-test-failure]')).toHaveCount(2);
      await expect(review.locator('[data-test-failure]').first()).toContainText(
        'returns the message',
      );

      // BOTH THEMES: the diff box is token-coloured, so flipping the theme keeps it
      // legible. The WIRE surface is single-palette, so this is the honest check.
      await page.evaluate(() => document.documentElement.classList.add('atr-dark'));
      await expect(scroll).toBeVisible();
      await expect(review.locator('[data-diff-line="add"]').first()).toBeVisible();

      // ── the HONEST-EMPTY diff: "no changes", not "no diff recorded" ─────────
      await page.locator(`[data-tree-session="${at.emptyDiffSessionId}"]`).click();
      const emptyReview = page.locator(`[data-review-session="${at.emptyDiffSessionId}"]`);
      await expect(emptyReview.locator('[data-diff-empty]')).toBeVisible();
      await expect(emptyReview.locator('[data-diff-empty]')).toContainText('no changes');
      await expect(emptyReview.locator('[data-diff-absent]')).toHaveCount(0);
      await expect(emptyReview.locator('[data-diff-structured]')).toHaveCount(0);
    } finally {
      await teardown(at);
    }
  });
});
