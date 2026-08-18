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
 * ## THE COVENANT FLIP — rubric 12 + the covenant half of 16 (#220 / T6)
 *
 * T6 composed the covenant onto this surface, so the second test below now proves what
 * the first cannot: on a `'yjs'` room, a HUMAN certifies a span (through the real
 * human-gated `certifyYjsSpanAction`), the live `✓` glyph appears in BOTH browsers,
 * and a peer edit of that span flips `✓`→`~` in both within a render tick, an exact
 * UNDO flips it back, and an out-of-range edit leaves `✓` standing:
 *
 *   - **rubric 12 (two browsers agree on COVENANT state).** `LiveConversationDoc` now
 *     mounts T4's `useLiveGlyphResolver` over the `covenant_status` Electric shape and
 *     the E8 span-certify affordance wired to `certifyObjectSpanAction`'s sibling
 *     `certifyYjsSpanAction` (which derives the one-accepted-object-per-span binding).
 *     The glyph is keyed by object id = message id (the T6 binding), so both browsers
 *     read the same verdict and flip together.
 *   - **rubric 16, covenant half.** B disconnects, a peer edits the certified span, B
 *     reconnects → B converges to the correct `~` with NO transient false `✓` during
 *     resync (the liveness invariant: the resolver starts NOT-live ⇒ `~`, and the
 *     drifted verdict is `~`).
 *
 * The peer edit + exact undo are driven by the acceptance HARNESS as a legitimate peer,
 * through a `?covenant-e2e=1`-gated window seam on the live doc (in-body co-editing is
 * not yet a shipped user affordance — a follow-on); the certify itself goes through the
 * REAL human-gated server action. The CARDINAL (no false `✓`) is sampled throughout:
 * `✓` appears ONLY over content still byte-identical to what the human signed.
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

/** Seed a fresh yjs-substrate room with two human members. Returns ids + the ws slug. */
async function seedYjsRoom(
  runId: string,
): Promise<{
  workspaceId: string;
  workspaceSlug: string;
  roomId: string;
  adaId: string;
  benId: string;
}> {
  const [adaRow] = await db
    .insert(users)
    .values({ email: uniqueEmail(`t6-ada-${runId}`), displayName: 'Ada', emailVerified: true })
    .returning({ id: users.id });
  const [benRow] = await db
    .insert(users)
    .values({ email: uniqueEmail(`t6-ben-${runId}`), displayName: 'Ben', emailVerified: true })
    .returning({ id: users.id });
  if (!adaRow || !benRow) throw new Error('human provisioning returned nothing');

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `T6 ${runId}`, slug: `t6-${runId}` })
    .returning({ id: workspaces.id, slug: workspaces.slug });
  if (!workspace) throw new Error('workspace insert returned nothing');

  const [room] = await db
    .insert(rooms)
    .values({
      workspaceId: workspace.id,
      slug: 'general',
      name: 'general',
      createdBy: adaRow.id,
      conversationSubstrate: 'yjs',
    })
    .returning({ id: rooms.id, conversationSubstrate: rooms.conversationSubstrate });
  if (!room) throw new Error('room insert returned nothing');
  expect(room.conversationSubstrate).toBe('yjs');

  await db.insert(workspaceMembers).values([
    { organizationId: workspace.id, userId: adaRow.id, role: 'admin' },
    { organizationId: workspace.id, userId: benRow.id, role: 'member' },
  ]);
  await db.insert(memberships).values([
    { roomId: room.id, userId: adaRow.id, role: 'admin' },
    { roomId: room.id, userId: benRow.id, role: 'member' },
  ]);

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    roomId: room.id,
    adaId: adaRow.id,
    benId: benRow.id,
  };
}

/** The live-doc surface, waited to its `live` status with a composer ready to type. */
async function openYjsRoom(
  page: Page,
  workspaceSlug: string,
  options?: { readonly covenantE2e?: boolean },
): Promise<void> {
  // `?covenant-e2e=1` exposes the harness peer-edit / certify seam on the live doc
  // (a legitimate peer capability, gated so it is never on the normal surface).
  const query = options?.covenantE2e ? '?covenant-e2e=1' : '';
  await page.goto(`/app/${workspaceSlug}/general${query}`);
  await expect(page.locator('main[data-substrate="yjs"]')).toBeVisible();
  const doc = page.locator('[data-live-doc]');
  await expect(doc).toBeVisible();
  // The surface must reach a LIVE Electric mount — not `no-fabric` (Electric down)
  // and not stuck `connecting`. A composer only exists once live + writable.
  await expect(doc).toHaveAttribute('data-live-doc-status', 'live', { timeout: 30_000 });
  await expect(page.locator('[data-live-doc-input]')).toBeVisible({ timeout: 30_000 });
  if (options?.covenantE2e) await waitForCovenantHook(page);
}

/** The harness seam the covenant surface exposes under `?covenant-e2e=1`. */
interface CovenantHook {
  messages(): Array<{ id: string; text: string }>;
  edit(messageId: string, index: number, text: string): boolean;
  deleteRange(messageId: string, index: number, len: number): boolean;
  remapMid(victimId: string, hostile: string): boolean;
  certify(messageId: string, start: number, end: number): Promise<{ ok: boolean; reason?: string }>;
}

/** Wait until the `?covenant-e2e=1` harness seam is bound on the live doc. */
async function waitForCovenantHook(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => typeof (window as unknown as { __atriumYjsTest?: unknown }).__atriumYjsTest,
        ),
      { message: 'the covenant-e2e harness seam to bind', timeout: 30_000 },
    )
    .toBe('object');
}

/** The id of the message whose body text contains `marker`, via the harness seam. */
async function messageIdContaining(page: Page, marker: string): Promise<string> {
  const id = await page.evaluate((needle) => {
    const hook = (window as unknown as { __atriumYjsTest?: CovenantHook }).__atriumYjsTest;
    return hook?.messages().find((message) => message.text.includes(needle))?.id ?? null;
  }, marker);
  if (id === null) throw new Error(`no message body contains "${marker}"`);
  return id;
}

/** Certify a span through the REAL human-gated action (scaffolding mint via the seam). */
async function certifySpan(
  page: Page,
  messageId: string,
  start: number,
  end: number,
): Promise<{ ok: boolean; reason?: string }> {
  return page.evaluate(
    ({ messageId, start, end }) => {
      const hook = (window as unknown as { __atriumYjsTest?: CovenantHook }).__atriumYjsTest;
      if (!hook) throw new Error('covenant-e2e seam missing');
      return hook.certify(messageId, start, end);
    },
    { messageId, start, end },
  );
}

/** Drive the F1 mid-remap forge as a peer with ydoc write access (via the harness seam). */
async function remapMid(page: Page, victimId: string, hostile: string): Promise<void> {
  await page.evaluate(
    ({ victimId, hostile }) => {
      const hook = (window as unknown as { __atriumYjsTest?: CovenantHook }).__atriumYjsTest;
      if (!hook?.remapMid(victimId, hostile)) throw new Error('mid-remap attack failed to apply');
    },
    { victimId, hostile },
  );
}

/** A harness peer edit: insert `text` at char `index` inside a message body. */
async function peerInsert(
  page: Page,
  messageId: string,
  index: number,
  text: string,
): Promise<void> {
  await page.evaluate(
    ({ messageId, index, text }) => {
      const hook = (window as unknown as { __atriumYjsTest?: CovenantHook }).__atriumYjsTest;
      if (!hook?.edit(messageId, index, text)) throw new Error('peer edit failed');
    },
    { messageId, index, text },
  );
}

/** The exact undo of a harness insert: delete `len` chars at `index` (restores items). */
async function peerDelete(
  page: Page,
  messageId: string,
  index: number,
  len: number,
): Promise<void> {
  await page.evaluate(
    ({ messageId, index, len }) => {
      const hook = (window as unknown as { __atriumYjsTest?: CovenantHook }).__atriumYjsTest;
      if (!hook?.deleteRange(messageId, index, len)) throw new Error('peer delete failed');
    },
    { messageId, index, len },
  );
}

/** The covenant glyph a specific line renders now (`✓` / `~`), or null if not shown. */
async function lineGlyph(page: Page, messageId: string): Promise<string | null> {
  return page
    .locator(`[data-live-doc-message-id="${messageId}"] [data-glyph]`)
    .first()
    .getAttribute('data-glyph')
    .catch(() => null);
}

/** Poll until BOTH browsers render the given glyph for the line — the covenant converged. */
async function expectBothGlyph(
  pages: readonly Page[],
  messageId: string,
  glyph: string,
  message: string,
): Promise<void> {
  for (const page of pages) {
    await expect
      .poll(async () => lineGlyph(page, messageId), { message, timeout: 30_000 })
      .toBe(glyph);
  }
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
 * THE CARDINAL INVARIANT, sampled: NO `✓` glyph anywhere on either surface. Called at
 * every checkpoint where nothing has been certified (or the certified span has since
 * drifted), so a false `✓` at ANY observed frame fails the run. A `~` glyph on a line is
 * the honest not-certified/drifted state and is expected; only `✓` is the cardinal sin.
 * (T6 adds a covenant surface, so `✓` legitimately appears over UNDRIFTED certified
 * content — asserted separately with {@link expectBothGlyph}; this helper is only ever
 * called when no valid `✓` should exist.)
 */
async function assertNoFalseCertification(pages: readonly Page[]): Promise<void> {
  for (const page of pages) {
    await expect(page.locator('[data-glyph="✓"]')).toHaveCount(0);
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
        await expect.poll(async () => (await lineTexts(ben)).length, { timeout: 30_000 }).toBe(2);
        await expect.poll(async () => (await lineTexts(ada)).length, { timeout: 30_000 }).toBe(2);
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
        await expect.poll(async () => (await lineTexts(ada)).length, { timeout: 30_000 }).toBe(3);
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

    test('a human certifies a yjs span → ✓ in both browsers → a peer edit flips ✓→~ in both → exact undo → ✓; an out-of-range edit leaves ✓; and a disconnect/resync converges with no false ✓ (rubric 12 + 16-covenant)', async ({
      browser,
    }, testInfo) => {
      test.setTimeout(240_000);
      const runId = randomUUID().slice(0, 8);
      const contexts: BrowserContext[] = [];
      const seed = await seedYjsRoom(runId);

      try {
        const adaSeat = await seat(browser, await mintHumanSession(seed.adaId));
        contexts.push(adaSeat.context);
        const ada = adaSeat.page;
        const benSeat = await seat(browser, await mintHumanSession(seed.benId));
        contexts.push(benSeat.context);
        let ben = benSeat.page;

        // Both browsers enter the covenant surface (the harness seam is available).
        await openYjsRoom(ada, seed.workspaceSlug, { covenantE2e: true });
        await openYjsRoom(ben, seed.workspaceSlug, { covenantE2e: true });
        // CARDINAL, pre-certify: no `✓` anywhere on a room where nothing is certified.
        await assertNoFalseCertification([ada, ben]);

        // ── A types the line to be certified; both browsers converge on it ──────
        // A known body so the span offsets are exact: "Ready ship it now".
        const body = `Ready ship it now ${runId}`;
        await typeLine(ada, body);
        await convergenceLatency(ben, body);
        // Resolve the message id from the durable doc (same id on both replicas).
        const messageId = await messageIdContaining(ada, body);

        // ── rubric 12: A certifies the span "Ready" [0,5] — a HUMAN act ──────────
        const certifyOutcome = await certifySpan(ada, messageId, 0, 5);
        expect(
          certifyOutcome.ok,
          `certify must succeed, got: ${certifyOutcome.reason ?? 'ok'}`,
        ).toBe(true);
        // The live `✓` converges to BOTH browsers over the covenant_status shape.
        await expectBothGlyph([ada, ben], messageId, '✓', 'the certified span to show ✓ in both');
        await ada.screenshot({ path: join(ARTIFACTS, `t6-certified-A-${runId}.png`) });
        await ben.screenshot({ path: join(ARTIFACTS, `t6-certified-B-${runId}.png`) });

        // ── rubric 5/12: an OUT-OF-RANGE edit leaves ✓ standing in both ─────────
        // Insert after the certified [0,5) span — the span's rendered content is
        // unchanged, so it settles back to ✓ (a transient ~ during the sweep is fine).
        await peerInsert(ada, messageId, 12, 'ZZ');
        await expectBothGlyph([ada, ben], messageId, '✓', 'an out-of-range edit to leave ✓');

        // ── rubric 3/12: an IN-RANGE peer edit flips ✓→~ in BOTH ────────────────
        await peerInsert(ben, messageId, 2, 'X'); // inside "Ready"
        await expectBothGlyph([ada, ben], messageId, '~', 'an in-range edit to flip ✓→~ in both');
        // CARDINAL during drift: no `✓` anywhere while the certified span is drifted.
        await assertNoFalseCertification([ada, ben]);

        // ── rubric 6/12: an EXACT UNDO restores the original items → ✓ in both ───
        await peerDelete(ben, messageId, 2, 1); // delete the exact inserted char
        await expectBothGlyph([ada, ben], messageId, '✓', 'the exact undo to restore ✓ in both');
        testInfo.annotations.push({
          type: 'rubric-12 flip',
          description: '✓→~→✓ converged in both browsers',
        });

        // ── rubric 16 (covenant half): disconnect B, drift the span, reconnect ──
        await ben.close();
        await peerInsert(ada, messageId, 1, 'Q'); // drift the certified span while B is gone
        await expectBothGlyph([ada], messageId, '~', 'the span to drift to ~ on A while B is gone');

        // B reconnects: a fresh page re-subscribes the covenant shape.
        ben = await benSeat.context.newPage();
        await openYjsRoom(ben, seed.workspaceSlug, { covenantE2e: true });
        // During resync B must converge to `~` (the drifted truth) with NO transient
        // false `✓` — sampled as it converges. The liveness invariant starts B at `~`.
        await expect
          .poll(
            async () => {
              if ((await ben.locator('[data-glyph="✓"]').count()) > 0) return 'FALSE-CHECKMARK';
              return (await lineGlyph(ben, messageId)) === '~' ? 'converged' : 'converging';
            },
            {
              message: 'B to converge to ~ after reconnect, with no false ✓',
              timeout: 45_000,
            },
          )
          .toBe('converged');
        await ben.screenshot({ path: join(ARTIFACTS, `t6-resynced-B-${runId}.png`) });

        // And the exact undo of the while-gone drift re-validates ✓ in both — the
        // covenant survives the transport interruption end to end.
        await peerDelete(ada, messageId, 1, 1);
        await expectBothGlyph(
          [ada, ben],
          messageId,
          '✓',
          'the covenant to re-validate ✓ after resync',
        );
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        await db.delete(workspaces).where(eq(workspaces.id, seed.workspaceId));
        await db.delete(users).where(inArray(users.id, [seed.adaId, seed.benId]));
      }
    });

    test('the F1 mid-remap forge cannot paint a ✓ over unsigned content: after a certified span is remapped to hostile text, BOTH browsers show ~ (never ✓) (#220 fix round)', async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const runId = randomUUID().slice(0, 8);
      const contexts: BrowserContext[] = [];
      const seed = await seedYjsRoom(runId);

      try {
        const adaSeat = await seat(browser, await mintHumanSession(seed.adaId));
        contexts.push(adaSeat.context);
        const ada = adaSeat.page;
        const benSeat = await seat(browser, await mintHumanSession(seed.benId));
        contexts.push(benSeat.context);
        const ben = benSeat.page;

        await openYjsRoom(ada, seed.workspaceSlug, { covenantE2e: true });
        await openYjsRoom(ben, seed.workspaceSlug, { covenantE2e: true });
        await assertNoFalseCertification([ada, ben]);

        // A types + certifies a real span; the live ✓ converges to both browsers.
        const body = `Ready ship it now ${runId}`;
        await typeLine(ada, body);
        await convergenceLatency(ben, body);
        const messageId = await messageIdContaining(ada, body);
        const certifyOutcome = await certifySpan(ada, messageId, 0, 5); // "Ready"
        expect(certifyOutcome.ok, `certify: ${certifyOutcome.reason ?? 'ok'}`).toBe(true);
        await expectBothGlyph([ada, ben], messageId, '✓', 'the certified span to show ✓ in both');

        // THE FORGE (F1): a peer with ydoc write access appends hostile text with the
        // victim's `mid` and retargets the genuine block's `mid` away — so `body(A)` now
        // DISPLAYS hostile content while the anchor still resolves the untouched genuine
        // span. Pre-fix this painted a `✓` over the hostile text in BOTH browsers.
        const hostile = `DELETE PRODUCTION NOW ${runId}`;
        await remapMid(ada, messageId, hostile);

        // THE FIX: the display↔sign identity guard makes the server sweep project `drift`,
        // and the client freshness gate withholds `✓` the instant the displayed body
        // changes — so BOTH browsers converge to `~`, and no `✓` appears at ANY frame.
        await expect
          .poll(
            async () => {
              if ((await ada.locator('[data-glyph="✓"]').count()) > 0) return 'FALSE-CHECKMARK';
              if ((await ben.locator('[data-glyph="✓"]').count()) > 0) return 'FALSE-CHECKMARK';
              const glyphs = await Promise.all([
                lineGlyph(ada, messageId),
                lineGlyph(ben, messageId),
              ]);
              return glyphs.every((g) => g === '~') ? 'converged' : 'converging';
            },
            {
              message: 'the mid-remap forge to show ~ in both browsers, never a ✓',
              timeout: 45_000,
            },
          )
          .toBe('converged');

        // The hostile text really is what is displayed for the line now — proving the
        // forge LANDED as content but could not steal the `✓` (it shows `~`, not `✓`).
        await expect
          .poll(async () => (await lineTexts(ada)).some((t) => t.includes(hostile)), {
            message: 'the hostile remapped body to be what the line displays',
            timeout: 30_000,
          })
          .toBe(true);
        await assertNoFalseCertification([ada, ben]);
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        await db.delete(workspaces).where(eq(workspaces.id, seed.workspaceId));
        await db.delete(users).where(inArray(users.id, [seed.adaId, seed.benId]));
      }
    });
  });
