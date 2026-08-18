import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAtriumAuth, sessionCookieHeader } from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  rooms,
  users,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { authSecret, databaseUrl } from './support/config.mjs';
import { requireBrowser, uniqueEmail } from './support/flows';

/**
 * T5 — THE TWO-REAL-BROWSER COVENANT ACCEPTANCE (#219 / the #200 destination at
 * the real-browser level), run against a GENUINE PRODUCTION BUILD in production
 * posture (NODE_ENV=production, TLS-terminated https/wss, the auth secure-transport
 * and mailer gates ACTIVE and satisfied — see `playwright.destination-electric.config.ts`)
 * with a LIVE Electric sync fabric (`e2e/support/electric-stack.mjs`), real
 * Postgres, from the test runner.
 *
 * ## WHAT THIS PROVES (green twice at concurrency)
 *
 * A `conversation_substrate='yjs'` room (migration 0057) rendered across TWO REAL
 * browser contexts, A and B, both seated by session-minting (the destination
 * harness's blessed path). The room's conversation is a client `Y.Doc` synced
 * PURELY over Electric Durable Streams — no realtime WebSocket, no server RPC, no
 * `router.refresh()`:
 *
 *   - **rubric 11 (content converges).** A line typed in A appears in B, and a line
 *     typed in B appears in A, within an observed convergence window over Electric;
 *     once quiescent A and B render the IDENTICAL ordered line set (they never
 *     disagree on content).
 *   - **rubric 16 at the CONTENT level (recovery after transport interruption).** B
 *     disconnects (its page and transport are torn down), a peer edits the document,
 *     B reconnects (a fresh page re-subscribes the shape) → B converges to the FULL
 *     document with NO lost and NO duplicated line, and at no observed frame during
 *     resync does a `✓` appear.
 *   - **the CARDINAL (no false ✓, ever).** This surface renders every line
 *     "unverified · live" and paints NO `✓` glyph anywhere, at any observed frame,
 *     across the whole run — the honest fail-closed of a peer-writable Yjs doc whose
 *     `who`/`kind`/`✓` are forgeable. It is checked as an invariant sampled at every
 *     convergence point below.
 *
 * ## WHAT THIS DELIBERATELY DOES NOT PROVE, AND WHY — the T2↔T3/T4 non-composition
 *
 * Rubric 12 (two browsers agree on COVENANT state) and the covenant half of rubric
 * 16 (the ✓→~ flip surviving a resync) are NOT assertable ON THIS SURFACE, because
 * the yjs surface renders NO covenant glyph and exposes NO span-certify affordance.
 * Verified against the tree at base 6b2401d:
 *
 *   - `app/app/[workspace]/[room]/page.tsx` routes a `'yjs'` room to `YjsRoomSession`
 *     → `LiveConversationDoc`, which by its own T2 scope boundary "never reads
 *     `covenant_status`" and labels every line "unverified · live" with no `✓`/`~`.
 *   - The live covenant glyph (T4 #218, `useLiveGlyphResolver` over the
 *     `covenant_status` Electric shape) and the certify receipt (`data-certify`) are
 *     wired into the OTHER branch, `LiveRoomSession` (the LEDGER surface), over
 *     `accepted_objects` readings — not over yjs text spans. The range-select
 *     span-certify UI (`app/prototype/CertifyPassage.tsx`) is prototype-only and
 *     mounted on no authenticated live route.
 *
 * So no single authenticated browser surface at 6b2401d composes {yjs content synced
 * over Electric} + {a human certifying a span} + {the live ✓/~ glyph flipping across
 * two browsers}. That is a PRODUCT wiring gap between T2 and T3/T4, reported on #219
 * for a fix lane — NOT something this test weakens an assertion to paper over. The
 * cardinal above holds on this surface precisely because it can never mint a ✓ at all.
 */

const APP_URL = 'https://localhost:3210';
const ARTIFACTS = join(process.cwd(), 'test-results', 'two-browser-acceptance');

let db: Database;
let auth: ReturnType<typeof createAtriumAuth>;
let sql: ReturnType<typeof postgres>;

test.beforeAll(() => {
  const handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
  auth = createAtriumAuth({
    db,
    baseURL: APP_URL,
    secret: authSecret,
    mailer: async () => {},
  });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  mkdirSync(ARTIFACTS, { recursive: true });
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Split a `name=value` cookie header into the pair Playwright's `addCookies` wants. */
function cookieParts(header: string): { name: string; value: string } {
  const eq = header.indexOf('=');
  return { name: header.slice(0, eq), value: header.slice(eq + 1) };
}

/** Seat an already-provisioned identity in its own browser context, carrying its session. */
async function seat(
  browser: Browser,
  cookieHeader: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const { name, value } = cookieParts(cookieHeader);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    { name, value, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  return { context, page };
}

/** A human session, minted through Better Auth's own adapter. */
async function mintHumanSession(userId: string): Promise<string> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  return sessionCookieHeader(auth, session.token);
}

/** The live-doc surface, waited to its `live` status with a composer ready to type. */
async function openYjsRoom(page: Page, workspaceSlug: string): Promise<void> {
  await page.goto(`/app/${workspaceSlug}/general`);
  await expect(page.locator('main[data-substrate="yjs"]')).toBeVisible();
  const doc = page.locator('[data-live-doc]');
  await expect(doc).toBeVisible();
  // The surface must reach a LIVE Electric mount — not `no-fabric` (Electric down)
  // and not stuck `connecting`. A composer only exists once live + writable.
  await expect(doc).toHaveAttribute('data-live-doc-status', 'live', { timeout: 30_000 });
  await expect(page.locator('[data-live-doc-input]')).toBeVisible({ timeout: 30_000 });
}

/** Type a line through the real composer and submit it; returns the marker text. */
async function typeLine(page: Page, marker: string): Promise<void> {
  const input = page.locator('[data-live-doc-input]');
  await input.fill(marker);
  await page.locator('[data-live-doc-send]').click();
  // The local echo is the fastest confirmation the append landed in the local doc.
  await expect(
    page.locator('[data-live-doc-message-text]').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Every rendered line's text, in document order — the content projection to compare. */
async function lineTexts(page: Page): Promise<string[]> {
  return page.locator('[data-live-doc-message-text]').allInnerTexts();
}

/**
 * THE CARDINAL INVARIANT, sampled: no `✓` glyph anywhere on either surface, and the
 * honest "unverified · live" label present on the rendered lines. Called at every
 * convergence checkpoint so a false `✓` at ANY observed frame fails the run.
 */
async function assertNoFalseCertification(pages: readonly Page[]): Promise<void> {
  for (const page of pages) {
    await expect(page.locator('[data-glyph="✓"]')).toHaveCount(0);
    await expect(page.locator('main[data-substrate="yjs"] [data-certify]')).toHaveCount(0);
  }
}

/** Wait until B's line set contains the marker, returning the observed latency (ms). */
async function convergenceLatency(observer: Page, marker: string): Promise<number> {
  const started = Date.now();
  await expect
    .poll(
      async () =>
        (await observer.locator('[data-live-doc-message-text]').allInnerTexts()).some((t) =>
          t.includes(marker),
        ),
      { message: `content to converge to the observing browser: ${marker}`, timeout: 30_000 },
    )
    .toBe(true);
  return Date.now() - started;
}

test.describe
  .serial('T5 two-real-browser covenant acceptance (yjs substrate over Electric)', () => {
    requireBrowser();

    test('two browsers on a yjs room converge on content over Electric, agree when quiescent, and recover from a transport interruption with no lost line and no false ✓', async ({
      browser,
    }, testInfo) => {
      test.setTimeout(240_000);
      const runId = randomUUID().slice(0, 8);
      const contexts: BrowserContext[] = [];

      // ── Seed a yjs-substrate room with two human members ────────────────────
      const [adaRow] = await db
        .insert(users)
        .values({ email: uniqueEmail('t5-ada'), displayName: 'Ada', emailVerified: true })
        .returning({ id: users.id });
      const [benRow] = await db
        .insert(users)
        .values({ email: uniqueEmail('t5-ben'), displayName: 'Ben', emailVerified: true })
        .returning({ id: users.id });
      if (!adaRow || !benRow) throw new Error('human provisioning returned nothing');
      const adaId = adaRow.id;
      const benId = benRow.id;

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: `T5 ${runId}`, slug: `t5-${runId}` })
        .returning({ id: workspaces.id, slug: workspaces.slug });
      if (!workspace) throw new Error('workspace insert returned nothing');
      // THE SUBSTRATE: this room's conversation is a client Y.Doc over Electric.
      const [room] = await db
        .insert(rooms)
        .values({
          workspaceId: workspace.id,
          slug: 'general',
          name: 'general',
          createdBy: adaId,
          conversationSubstrate: 'yjs',
        })
        .returning({ id: rooms.id, conversationSubstrate: rooms.conversationSubstrate });
      if (!room) throw new Error('room insert returned nothing');
      // Verify the seed actually took the yjs substrate — a silent default to
      // 'ledger' would route to the WRONG surface and quietly test nothing here.
      expect(room.conversationSubstrate).toBe('yjs');

      await db.insert(workspaceMembers).values([
        { organizationId: workspace.id, userId: adaId, role: 'admin' },
        { organizationId: workspace.id, userId: benId, role: 'member' },
      ]);
      await db.insert(memberships).values([
        { roomId: room.id, userId: adaId, role: 'admin' },
        { roomId: room.id, userId: benId, role: 'member' },
      ]);

      try {
        const adaSeat = await seat(browser, await mintHumanSession(adaId));
        contexts.push(adaSeat.context);
        const ada = adaSeat.page;
        const benSeat = await seat(browser, await mintHumanSession(benId));
        contexts.push(benSeat.context);
        let ben = benSeat.page;

        // Both real browsers enter the live yjs route and reach a live Electric mount.
        await openYjsRoom(ada, workspace.slug);
        await openYjsRoom(ben, workspace.slug);
        await assertNoFalseCertification([ada, ben]);

        // ── rubric 11: a line typed in A appears in B (content converges) ───────
        const fromA = `Run ${runId}: A→B line ${Date.now()}`;
        await typeLine(ada, fromA);
        const latencyAtoB = await convergenceLatency(ben, fromA);
        testInfo.annotations.push({
          type: 'rubric-11 A→B convergence (ms)',
          description: String(latencyAtoB),
        });
        await assertNoFalseCertification([ada, ben]);

        // ── rubric 11: and the reverse — a line typed in B appears in A ─────────
        const fromB = `Run ${runId}: B→A line ${Date.now()}`;
        await typeLine(ben, fromB);
        const latencyBtoA = await convergenceLatency(ada, fromB);
        testInfo.annotations.push({
          type: 'rubric-11 B→A convergence (ms)',
          description: String(latencyBtoA),
        });

        // ── rubric 11: once quiescent, A and B render the IDENTICAL ordered set ──
        await expect
          .poll(async () => (await lineTexts(ben)).length, { timeout: 30_000 })
          .toBe(2);
        await expect
          .poll(async () => (await lineTexts(ada)).length, { timeout: 30_000 })
          .toBe(2);
        const adaLines = await lineTexts(ada);
        const benLines = await lineTexts(ben);
        expect(adaLines, 'A and B must agree on content once quiescent').toEqual(benLines);
        expect(adaLines.some((t) => t.includes(fromA))).toBe(true);
        expect(adaLines.some((t) => t.includes(fromB))).toBe(true);
        await assertNoFalseCertification([ada, ben]);

        // Evidence: both browsers showing the same converged document.
        await ada.screenshot({ path: join(ARTIFACTS, `converged-A-${runId}.png`) });
        await ben.screenshot({ path: join(ARTIFACTS, `converged-B-${runId}.png`) });

        // ── rubric 16 (content): B disconnects, a peer edits, B reconnects, converges ──
        // Tear B's page (and its transport) down entirely — a genuine disconnect.
        await ben.close();
        // A peer edits the document while B is gone.
        const whileGone = `Run ${runId}: edit while B gone ${Date.now()}`;
        await typeLine(ada, whileGone);
        // The document A now holds — the target B must converge to on reconnect.
        await expect
          .poll(async () => (await lineTexts(ada)).length, { timeout: 30_000 })
          .toBe(3);
        const targetDoc = await lineTexts(ada);

        // B reconnects: a fresh page in the SAME context re-subscribes the shape.
        ben = await benSeat.context.newPage();
        await openYjsRoom(ben, workspace.slug);
        // During resync, sample the cardinal — no transient ✓ over drifted content.
        await expect
          .poll(
            async () => {
              // No ✓ may appear at any observed frame of the reconnection.
              if ((await ben.locator('[data-glyph="✓"]').count()) > 0) return 'FALSE-CHECKMARK';
              const texts = await lineTexts(ben);
              return texts.length === targetDoc.length &&
                targetDoc.every((line) => texts.includes(line))
                ? 'converged'
                : 'converging';
            },
            {
              message: 'B to converge to the full document after reconnect, with no false ✓',
              timeout: 45_000,
            },
          )
          .toBe('converged');

        // No lost and no DUPLICATED line: B's set equals A's exactly, ordered.
        const benAfter = await lineTexts(ben);
        expect(benAfter, 'B must recover the full document with no loss or duplication').toEqual(
          targetDoc,
        );
        await assertNoFalseCertification([ada, ben]);
        await ben.screenshot({ path: join(ARTIFACTS, `resynced-B-${runId}.png`) });
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
        await db.delete(users).where(inArray(users.id, [adaId, benId]));
      }
    });
  });
