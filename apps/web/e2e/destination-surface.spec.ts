import { randomUUID } from 'node:crypto';
import {
  createAtriumAuth,
  mintAgentSession,
  provisionAgentConfig,
  provisionAgentPrincipal,
  sessionCookieHeader,
} from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  plans,
  rooms,
  type SessionArtifact,
  sessions,
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
 * THE DESTINATION ACCEPTANCE HARNESS — a real ticket supervised through the
 * MARRIED OPERATOR SURFACE (#160, map #150 capstone).
 *
 * This drives the married `/app/<ws>/<room>/surface` route (`data-frame="atrium"`
 * — the LIVE control-plane projection married to the decomposed prototype panes,
 * #168 go-live A/B2) against a GENUINE PRODUCTION BUILD in production posture
 * (NODE_ENV=production, TLS-terminated https/wss, `assertSecureTransport` and the
 * mailer gate ACTIVE and satisfied — see `playwright.destination.config.ts`), real
 * Postgres, from the test runner. It proves the SESSION-ARTIFACT COVENANT end to
 * end:
 *
 *   a seeded session with a REAL artifact (a structured `SessionDiff`) →
 *   FUNDED via the control-plane spend gate as a reserved HUMAN act →
 *   REVIEWED as an honest `~` diff in the married surface's ArtifactPane →
 *   CERTIFIED `✓` through the REAL `certifySession` server-timed arm→confirm hold
 *   driven on the live `HoldToAct` control →
 *   and the covenant HELD in the fold: the human's signature on the session row,
 *   the machine refused at every reserved door.
 *
 * ## STREAMING IS DEFERRED, ON PURPOSE (Lars's scope decision, #177 follow-up)
 *
 * The married surface reviews the STATIC live artifact diff (`usePRStream(false)`
 * — a mock stream the surface never asserts on). Binding the #159 live-progress
 * consumer is deferred follow-up #177. This spec reviews the injected settled
 * artifact's real `SessionDiff`, NOT a live stream. No assertion here depends on
 * anything streaming.
 *
 * ## WHY THE ARTIFACT IS INJECTED, NOT PRODUCED BY A LIVE RUN
 *
 * A real diff needs `apps/loop` + a live model, neither of which is stood up in
 * this lane. So the plan + session + a synthetic `SessionArtifact` carrying a real
 * `.diff` (`SessionDiff`, the SAME type `loadControlPlane` projects and the shipped
 * `DiffView` renders) are inserted directly into Postgres, exactly as
 * `control-plane.spec.ts` and `destination-scenario.spec.ts` seed their lifecycle
 * rows — the shape their projectors write. The married surface then projects that
 * row through `loadControlPlane` → `liveArtifactsFor` → `DiffView` with no mock,
 * and certify binds the row's real `artifactDigest = md5(artifact::text)`.
 *
 * ## THE RESERVED HUMAN ACTS ARE PERFORMED BY A TEST HUMAN, NEVER LARS
 *
 * Ada is a TEST human principal. She performs the two reserved acts the covenant
 * gates on a person:
 *
 *   - FUND (`set_plan_rlimit`, the human-only spend authorization, #118) — driven
 *     over the SAME authenticated command socket the control-plane PlanPane's fund
 *     control issues on (`issueRoomCommand` → `set_plan_rlimit`); the server's
 *     `certificationClassOf` refuses a non-human before any append
 *     (`nonHumanSpendAuthorizationRefusal`). This is a control-plane act, NOT wired
 *     into the married surface (per #160), so it is driven on the human socket the
 *     way `destination-scenario.spec.ts` drives its gated commands.
 *   - CERTIFY (`certifySession`, the server-timed arm→confirm hold) — driven on the
 *     married surface's real `HoldToAct` certify control (`ArtifactPane`
 *     `CertifyControl` → `armSessionCertificationAction` / `certifySessionAction`).
 *
 * The machine is refused at BOTH reserved doors, and every refusal here is
 * LOAD-BEARING — it isolates the ONE gate it targets, so removing that gate turns
 * this test red rather than leaving it green on an unrelated failure:
 *   - a certification of the SESSION LANDING can never carry a machine's name. The
 *     receipt written to attempt it is COMPLETE and INTERNALLY CONSISTENT (armer =
 *     certifier = the machine, a real over-gate arm→signature interval, an agreeing
 *     `certified_held_ms`, a reviewable artifact) so 0034/0035/0036/0038 are all
 *     satisfied and the SOLE defect is the non-human certifier — the write is refused
 *     by `sessions_certified_by_is_human` (0032) SPECIFICALLY, asserted by constraint
 *     name. The machine ARM is flip-tested the same way against 0033, the sub-2000ms
 *     hold against 0035's floor, and the reviewed-digest bind by driving the real
 *     arm→confirm control and moving the artifact between the two (`artifact_changed`).
 *     (`certifySession` has no socket door — it is a Server Action gated by
 *     `requireSession` + `principal_kind`, backstopped by those triggers; the table
 *     itself is the last, hardest refusal, which is what these assert.);
 *   - a `set_plan_rlimit` from the agent's OWN authenticated socket is refused with a
 *     `nack` before any append — proven not only by the nack and an unchanged ceiling
 *     but by asserting ZERO events reached the room ledger, so no machine raises a
 *     ceiling and none even writes a row trying.
 *
 * ## DISINTEREST
 *
 * Ada (the certifier + funder) is neither the plan's authoring agent nor the
 * session's producer — both are the agent `hexi`. Pinned from the seed, not assumed.
 */

const DESTINATION_APP_URL = 'https://localhost:3200';

let db: Database;
let auth: ReturnType<typeof createAtriumAuth>;
let sql: ReturnType<typeof postgres>;

test.beforeAll(() => {
  const handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
  auth = createAtriumAuth({
    db,
    baseURL: DESTINATION_APP_URL,
    secret: authSecret,
    mailer: async () => {},
  });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
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

/** A human session, minted through Better Auth's own adapter (the seat the production posture blesses). */
async function mintHumanSession(userId: string): Promise<string> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  return sessionCookieHeader(auth, session.token);
}

/**
 * A socket opened FROM INSIDE the page over the SAME https origin as wss, so the
 * browser attaches the context's session cookie exactly as the app does. This is
 * the instrument that performs the reserved SPEND act as a human and asks the
 * server to fund from a non-human session.
 */
async function openScenarioSocket(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    (roomId) =>
      new Promise<void>((resolve, reject) => {
        const url = `${location.origin.replace(/^http/, 'ws')}/ws`;
        const holder = window as unknown as {
          __atriumScenario?: { socket: WebSocket; roomId: string; serial: number };
        };
        const socket = new WebSocket(url);
        holder.__atriumScenario = { socket, roomId, serial: 0 };
        const timer = setTimeout(
          () => reject(new Error('scenario socket did not subscribe')),
          10_000,
        );
        socket.addEventListener('open', () =>
          socket.send(JSON.stringify({ type: 'subscribe', roomId })),
        );
        socket.addEventListener('message', (event: MessageEvent<string>) => {
          const frame = JSON.parse(event.data) as { type: string; roomId?: string; head?: number };
          if (frame.type === 'head' && frame.roomId === roomId) {
            socket.send(JSON.stringify({ type: 'ack_head', roomId, roomSeq: frame.head }));
          }
          if (frame.type === 'subscribed' && frame.roomId === roomId) {
            clearTimeout(timer);
            resolve();
          }
        });
        socket.addEventListener('error', () => reject(new Error('scenario socket failed')));
      }),
    roomId,
  );
}

/** Send a command over the scenario socket, resolving to its `roomSeq` or throwing on refusal. */
async function scenarioCommand(
  page: Page,
  command: Record<string, unknown>,
): Promise<number | null> {
  return page.evaluate(
    (command) =>
      new Promise<number | null>((resolve, reject) => {
        const holder = window as unknown as {
          __atriumScenario?: { socket: WebSocket; roomId: string; serial: number };
        };
        const live = holder.__atriumScenario;
        if (!live || live.socket.readyState !== WebSocket.OPEN) {
          reject(new Error('scenario command socket is not open'));
          return;
        }
        live.serial += 1;
        const commandId = `surface-${live.serial}`;
        const timer = setTimeout(() => {
          live.socket.removeEventListener('message', onMessage);
          reject(new Error(`timed out waiting for ${commandId}`));
        }, 10_000);
        const onMessage = (event: MessageEvent<string>) => {
          const frame = JSON.parse(event.data) as {
            type: string;
            commandId?: string;
            roomSeq?: number | null;
            message?: string;
            issues?: string[];
          };
          if (frame.commandId !== commandId) return;
          clearTimeout(timer);
          live.socket.removeEventListener('message', onMessage);
          if (frame.type === 'nack') reject(new Error(frame.message ?? `${commandId} was refused`));
          else if (frame.type !== 'ack')
            reject(new Error(`unexpected ${frame.type} for ${commandId}`));
          else if ((frame.issues?.length ?? 0) > 0) reject(new Error(frame.issues?.join(' | ')));
          else resolve(frame.roomSeq ?? null);
        };
        live.socket.addEventListener('message', onMessage);
        live.socket.send(JSON.stringify({ type: 'command', commandId, command }));
      }),
    command,
  );
}

/**
 * Send a command and resolve to the RAW reply frame — ack OR nack — without throwing.
 * The spend-refusal clause asserts the server's refusal; a helper that threw on `nack`
 * could not tell a refusal from a timeout.
 */
async function scenarioAttempt(
  page: Page,
  command: Record<string, unknown>,
): Promise<{ type: string; message?: string; issues?: string[] }> {
  return page.evaluate(
    (command) =>
      new Promise<{ type: string; message?: string; issues?: string[] }>((resolve, reject) => {
        const holder = window as unknown as {
          __atriumScenario?: { socket: WebSocket; roomId: string; serial: number };
        };
        const live = holder.__atriumScenario;
        if (!live || live.socket.readyState !== WebSocket.OPEN) {
          reject(new Error('scenario command socket is not open'));
          return;
        }
        live.serial += 1;
        const commandId = `surface-${live.serial}`;
        const timer = setTimeout(() => {
          live.socket.removeEventListener('message', onMessage);
          reject(new Error(`timed out waiting for ${commandId}`));
        }, 10_000);
        const onMessage = (event: MessageEvent<string>) => {
          const frame = JSON.parse(event.data) as {
            type: string;
            commandId?: string;
            message?: string;
            issues?: string[];
          };
          if (frame.commandId !== commandId) return;
          clearTimeout(timer);
          live.socket.removeEventListener('message', onMessage);
          resolve({ type: frame.type, message: frame.message, issues: frame.issues });
        };
        live.socket.addEventListener('message', onMessage);
        live.socket.send(JSON.stringify({ type: 'command', commandId, command }));
      }),
    command,
  );
}

/** Poll for an asynchronous fold to converge — the projections run on their own schedule. */
async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
) {
  await expect
    .poll(async () => accepts(await read()), { timeout: 60_000, message: label })
    .toBe(true);
}

/** Press and hold a control past its gate, so its `onAct` fires on the browser clock. */
async function holdPast(page: Page, selector: string, ms: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`the hold control ${selector} had no box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/**
 * The structured Postgres error a raw write RAISED, or `null` if the write did NOT
 * raise. The negative covenant clauses assert the SPECIFIC constraint the table
 * refused on (`constraint_name`), not merely that "something threw" — a broad
 * `catch {}` cannot tell the human-only trigger apart from an unrelated
 * receipt-completeness failure, so a broken gate would still read green. postgres-js
 * surfaces the trigger's `USING CONSTRAINT = …` verbatim on `.constraint_name`.
 */
async function raisedBy(
  write: Promise<unknown>,
): Promise<{ constraint: string | undefined; code: string | undefined; message: string } | null> {
  try {
    await write;
    return null;
  } catch (err) {
    const e = err as { constraint_name?: string; code?: string; message?: string };
    return {
      constraint: e.constraint_name,
      code: e.code,
      message: e.message ?? String(err),
    };
  }
}

test.describe
  .serial('the destination: a real ticket supervised through the married surface', () => {
    requireBrowser();

    test('a human funds the plan, reviews the honest ~ diff on the married surface, and certifies the session ✓ — while the machine is refused at every reserved door', async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const runId = randomUUID().slice(0, 8);
      const contexts: BrowserContext[] = [];

      // ── Seed: a room that is the agent's channel, a funded plan, a settled
      //    session carrying a REAL structured diff. Ada is the disinterested human. ──
      const [adaRow] = await db
        .insert(users)
        .values({ email: uniqueEmail('surf-ada'), displayName: 'Ada', emailVerified: true })
        .returning({ id: users.id });
      if (!adaRow) throw new Error('human provisioning returned nothing');
      const adaId = adaRow.id;

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: `Surface ${runId}`, slug: `surf-${runId}` })
        .returning({ id: workspaces.id, slug: workspaces.slug });
      if (!workspace) throw new Error('workspace insert returned nothing');

      // The room is the agent's CHANNEL — plans live in the room their agent owns
      // (the plans_room_matches_agent_channel trigger, #116). `provisionAgentConfig`
      // claims it below.
      const [room] = await db
        .insert(rooms)
        .values({ workspaceId: workspace.id, slug: 'general', name: 'general', createdBy: adaId })
        .returning({ id: rooms.id, slug: rooms.slug });
      if (!room) throw new Error('room insert returned nothing');
      const roomId = room.id;

      // hexi is the authoring agent — the plan's owner and the session's producer.
      const hexi = await provisionAgentPrincipal({
        db,
        email: `hexi-${randomUUID()}@agents.atrium.invalid`,
        displayName: 'hexi',
      });
      await provisionAgentConfig({
        db,
        userId: hexi.userId,
        ownerUserId: adaId,
        channelRoomId: roomId,
        host: 'fly-ord',
        harness: 'claude-code',
        model: 'opus',
        budgetLimitMicros: 20_000_000,
      });

      await db.insert(workspaceMembers).values([
        { organizationId: workspace.id, userId: adaId, role: 'admin' },
        { organizationId: workspace.id, userId: hexi.userId, role: 'member' },
      ]);
      await db.insert(memberships).values([
        { roomId, userId: adaId, role: 'admin' },
        { roomId, userId: hexi.userId, role: 'member' },
      ]);

      // A plan owned by the agent, seeded with a finite starting slice (a session
      // ran under it). The human's fund act below RAISES that ceiling through the
      // real spend gate — set_plan_rlimit handles a raise exactly as an initial
      // fund, and both take the identical human-only path (#118).
      const START_SLICE = 2;
      const RAISED_SLICE = 5;
      const [plan] = await db
        .insert(plans)
        .values({
          roomId,
          agentUserId: hexi.userId,
          title: `ship the invoice totals fix (${runId})`,
          status: 'open',
          rlimitSlice: START_SLICE,
          authorizedDraws: 1,
          budgetLimitMicros: 5_000_000,
          spentMicros: 1_200_000,
        })
        .returning({ id: plans.id });
      if (!plan) throw new Error('plan insert returned nothing');
      const planId = plan.id;

      // The injected settled artifact — a REAL `SessionArtifact` carrying a
      // structured `SessionDiff` (the shape `loadControlPlane` projects and the
      // shipped `DiffView` renders). branch + commit make it REVIEWABLE
      // (`isReviewableArtifact`), the minimum a human can put a signature on. The
      // file path carries the runId so the rendered diff is uniquely assertable.
      const diffFilePath = `src/billing/invoice-${runId}.ts`;
      const branch = `feat/invoice-totals-${runId}`;
      const commit = 'c0ffee1';
      const artifact: SessionArtifact = {
        branch,
        commit,
        diff: {
          fileCount: 1,
          additions: 3,
          deletions: 1,
          truncated: false,
          files: [
            {
              path: diffFilePath,
              status: 'modified',
              additions: 3,
              deletions: 1,
              binary: false,
              hunks: [
                {
                  header: '@@ -1,4 +1,6 @@',
                  lines: [
                    " import type { Invoice } from './types'",
                    '-  let total = 0',
                    '+  const totals = new StreamingTotal()',
                    '+  for (const line of invoice.lines) totals.add(line.amountMicros)',
                    '+  return totals.settle()',
                  ],
                },
              ],
            },
          ],
        },
        tests: {
          passed: 12,
          failed: 0,
          failures: [],
          failuresTruncated: false,
          command: 'pnpm --filter billing test',
        },
        summary: 'ready to land onto the invoice-totals branch',
      };

      const [session] = await db
        .insert(sessions)
        .values({
          roomId,
          planId,
          harness: 'claude-code',
          model: 'opus · diff',
          status: 'settled',
          contextPct: 0.58,
          spendMicros: 1_200_000,
          exitSummary: 'Streamed the invoice totals; suite green.',
          artifact,
        })
        .returning({ id: sessions.id });
      if (!session) throw new Error('session insert returned nothing');
      const sessionId = session.id;

      // A SECOND settled session under the same plan, carrying its own REVIEWABLE
      // artifact on a distinct branch. It exists ONLY to host the two negative
      // covenant flip-tests that must not touch the sound happy path:
      //   - the SERVER HOLD FLOOR (a sub-2000ms receipt, refused at the table);
      //   - the DIGEST BIND (arm over the reviewed revision, mutate it, confirm
      //     refused `artifact_changed`).
      // Both leave THIS row uncertified and never touch `sessionId`, so the happy
      // path still funds, reviews and certifies session #1 over a matching digest.
      // Its `createdAt` is pinned strictly LATER than session #1 so the projection's
      // `asc(createdAt)` (control-plane-data.ts) keeps session #1 the `firstSelection`
      // the review clause opens on; session #2 is reached by clicking its own row.
      const branch2 = `probe/stale-digest-${runId}`;
      const diffFilePath2 = `src/billing/refund-${runId}.ts`;
      const artifact2: SessionArtifact = {
        branch: branch2,
        commit: 'dec0de2',
        diff: {
          fileCount: 1,
          additions: 2,
          deletions: 0,
          truncated: false,
          files: [
            {
              path: diffFilePath2,
              status: 'modified',
              additions: 2,
              deletions: 0,
              binary: false,
              hunks: [
                {
                  header: '@@ -1,2 +1,4 @@',
                  lines: [
                    " import type { Refund } from './types'",
                    '+  const refunds = new StreamingTotal()',
                    '+  return refunds.settle()',
                  ],
                },
              ],
            },
          ],
        },
        tests: { passed: 4, failed: 0, failures: [], failuresTruncated: false, command: 'pnpm test' },
        summary: 'a second landing, held for the negative covenant proofs',
      };
      const [session2] = await db
        .insert(sessions)
        .values({
          roomId,
          planId,
          harness: 'claude-code',
          model: 'opus · diff',
          status: 'settled',
          contextPct: 0.4,
          spendMicros: 800_000,
          exitSummary: 'A second settled landing for the negative proofs.',
          artifact: artifact2,
          createdAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: sessions.id });
      if (!session2) throw new Error('second session insert returned nothing');
      const session2Id = session2.id;

      try {
        const ada = (await seat(browser, await mintHumanSession(adaId))).page;
        contexts.push(ada.context());
        const hexiSeat = await seat(
          browser,
          (await mintAgentSession({ auth, db, userId: hexi.userId })).cookie,
        );
        contexts.push(hexiSeat.context);

        // ── CLAUSE: the married surface renders LIVE ────────────────────────────
        // data-frame="atrium" (the married surface; the plain live route is
        // data-frame="live" and is NOT what this proves).
        await ada.goto(`/app/${workspace.slug}/${room.slug}/surface`);
        await expect(ada.locator('[data-frame="atrium"]')).toBeVisible();

        // the seeded agent + plan + session appear in the process tree (the LIVE
        // control-plane projection, not a fixture).
        const tree = ada.locator('nav[aria-label="agents, plans and sessions"]');
        await expect(tree).toBeVisible();
        // the agent's name is the always-visible tree label (its `@handle` is a
        // hover-reveal, so assert the name, not the handle).
        await expect(tree.getByText('hexi', { exact: true })).toBeVisible();
        await expect(tree.getByText(`ship the invoice totals fix (${runId})`)).toBeVisible();
        // the session row shows the branch the work LANDED on — derived from the
        // real artifact, never fabricated.
        const sessionRow = tree.getByRole('button').filter({ hasText: branch });
        await expect(sessionRow.first()).toBeVisible({ timeout: 20_000 });

        // ── CLAUSE: FUND — a reserved HUMAN act over the real spend gate ─────────
        // Ada opens her own command socket (the same authenticated transport the
        // control-plane PlanPane's fund control issues on) and raises the plan's
        // ceiling. This is a control-plane act, deliberately NOT wired into the
        // married surface (#160).
        await openScenarioSocket(ada, roomId);
        await scenarioCommand(ada, {
          name: 'set_plan_rlimit',
          roomId,
          planId,
          slice: RAISED_SLICE,
        });
        // the fold: the ceiling moved to the human's value, and the funding event
        // is authored by a HUMAN — Ada, specifically.
        await eventually(
          async () =>
            Number(
              (
                await sql<{ slice: number | null }[]>`
                  SELECT rlimit_slice AS slice FROM plans WHERE id=${planId}::uuid
                `
              )[0]?.slice ?? null,
            ),
          (slice) => slice === RAISED_SLICE,
          'the human fund to raise the plan ceiling through the real spend gate',
        );
        const funder = (
          await sql<{ actorKind: string; actorId: string | null }[]>`
            SELECT actor_kind::text AS "actorKind", actor_id AS "actorId"
            FROM core_events
            WHERE room_id=${roomId}::uuid AND type='plan_rlimit_set'
              AND payload->>'planId'=${planId}
            ORDER BY room_seq DESC LIMIT 1
          `
        )[0];
        expect(funder?.actorKind, 'the funding act must be authored by a human').toBe('human');
        expect(funder?.actorId, 'the funder of record must be Ada').toBe(adaId);

        // ── CLAUSE: no machine spend — an agent set_plan_rlimit is refused ───────
        // Over its OWN authenticated socket, the agent attempts to raise the
        // ceiling. The server refuses it before any append: a plan's budget is a
        // person's to set (human = init), and a machine may never.
        await hexiSeat.page.goto('/app');
        await openScenarioSocket(hexiSeat.page, roomId);
        // FLIP-TEST of the pre-append spend gate (server `certificationClassOf` /
        // `nonHumanSpendAuthorizationRefusal`): count the room's ledger BEFORE the
        // machine attempt so we can prove NOTHING was appended. A nack + an unchanged
        // ceiling alone would still read green if a machine `plan_rlimit_set` were
        // appended and then failed to move the slice; the refusal must land BEFORE
        // any row reaches the log. If that gate were removed, an agent fund would
        // append an event here and this count would rise — turning the test red.
        const roomEvents = async () =>
          Number(
            (
              await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM core_events WHERE room_id=${roomId}::uuid
              `
            )[0]?.n ?? 0,
          );
        const eventsBeforeMachineSpend = await roomEvents();
        const spendRefusal = await scenarioAttempt(hexiSeat.page, {
          name: 'set_plan_rlimit',
          roomId,
          planId,
          slice: 9,
        });
        expect(spendRefusal.type, 'an agent spend authorization must be a hard refusal').toBe(
          'nack',
        );
        const spendSaid = `${spendRefusal.message ?? ''} ${JSON.stringify(spendRefusal.issues ?? [])}`;
        expect(spendSaid).toContain('authorizes spend');
        // the fold: the agent moved nothing — the ceiling is still the human's value.
        expect(
          Number(
            (
              await sql<{ slice: number | null }[]>`
                SELECT rlimit_slice AS slice FROM plans WHERE id=${planId}::uuid
              `
            )[0]?.slice ?? null,
          ),
          'the agent must not have moved the ceiling',
        ).toBe(RAISED_SLICE);
        // the harder fold: the refusal appended ZERO events to the room's ledger —
        // the machine spend was refused before ANY row was written, not logged then
        // ignored.
        expect(
          await roomEvents(),
          'a refused machine spend must append no events to the room ledger',
        ).toBe(eventsBeforeMachineSpend);

        // ── CLAUSE: REVIEW — the honest ~ diff renders in the married ArtifactPane ─
        // Open the artifact pane (the right split). The session is already the
        // surface's opening selection (`firstSelection` opens on the plane's first
        // session), so the pane hosts THIS session's real injected diff.
        await ada.getByRole('button', { name: 'open artifact' }).click();
        // the shipped `DiffView` renders the server-pre-structured diff — the real
        // per-file hunks of the injected artifact, not a mock.
        await expect(ada.locator(`[data-diff-file-path="${diffFilePath}"]`)).toBeVisible({
          timeout: 20_000,
        });
        await expect(ada.locator('[data-diff-line="add"]').first()).toContainText(
          'const totals = new StreamingTotal()',
        );

        // ── CLAUSE: the diff is a machine `~` BEFORE any human acts ──────────────
        // Nothing certified: no human signature on the session row.
        const certState = async () =>
          (
            await sql<
              { certifiedBy: string | null; certifiedAt: string | null; heldMs: number | null }[]
            >`
              SELECT certified_by::text AS "certifiedBy",
                     certified_at::text AS "certifiedAt",
                     certified_held_ms AS "heldMs"
              FROM sessions WHERE id=${sessionId}::uuid
            `
          )[0];
        const before = await certState();
        expect(
          before?.certifiedBy,
          'the session must be an uncertified ~ before the human acts',
        ).toBeNull();
        // disinterest, pinned from the fold: the certifier (Ada) is neither the
        // plan's authoring agent nor the session's producer — both are hexi.
        const authoring = (
          await sql<{ agentUserId: string }[]>`
            SELECT agent_user_id::text AS "agentUserId" FROM plans WHERE id=${planId}::uuid
          `
        )[0];
        expect(authoring?.agentUserId, 'the authoring agent must not be the certifier').not.toBe(
          adaId,
        );
        expect(authoring?.agentUserId).toBe(hexi.userId);

        // ── CLAUSE: a machine can never certify a SESSION LANDING ────────────────
        // `certifySession` is a Server Action gated by `requireSession` +
        // `principal_kind`; there is no socket door for it. The table itself is the
        // last, hardest refusal: drizzle/0032's `sessions_certified_by_is_human`
        // refuses a non-human `certified_by` outright.
        //
        // FLIP-TEST of drizzle/0032 SPECIFICALLY. The earlier draft wrote only
        // `certified_by = hexi` with the whole hold receipt null — which the table
        // ALSO refuses on drizzle/0035 (receipt-incomplete), so deleting the
        // human-only trigger would NOT have turned this red: the write threw either
        // way (a blind gauntlet's finding). So the machine receipt built here is
        // COMPLETE and INTERNALLY CONSISTENT — armer = certifier = hexi, a real
        // arm→signature interval past the 2000ms gate, `certified_held_ms` that
        // agrees with it, a reviewable artifact — so 0034/0035/0036/0038 are all
        // SATISFIED and the ONLY thing wrong with the row is that its certifier is a
        // machine. The triggers fire alphabetically, so `sessions_certified_by_is_human`
        // (0032) raises FIRST; we assert on THAT constraint by name. Remove 0032 and
        // the same row is refused by `sessions_certify_armed_by_is_human` (0033) with
        // a DIFFERENT name — the name assertion fails and the test goes red, which is
        // exactly the load-bearing property the earlier draft lacked.
        const machineCertify = await raisedBy(
          sql`
            UPDATE sessions SET
              certify_armed_by = ${hexi.userId}::uuid,
              certify_armed_at = clock_timestamp() - interval '3 seconds',
              certify_arm_nonce = gen_random_uuid(),
              certify_armed_artifact_digest = md5(artifact::text),
              certified_by = ${hexi.userId}::uuid,
              certified_at = clock_timestamp(),
              certified_held_ms = 3000,
              updated_at = now()
            WHERE id = ${sessionId}::uuid
          `,
        );
        expect(
          machineCertify,
          'a complete, consistent machine receipt must still be refused by the table',
        ).not.toBeNull();
        expect(
          machineCertify?.constraint,
          'the refusal must be the HUMAN-CERTIFIER trigger (0032), not a receipt-shape error',
        ).toBe('sessions_certified_by_is_human');
        expect(
          (await certState())?.certifiedBy,
          'the machine certify attempt must have appended nothing',
        ).toBeNull();

        // ── CLAUSE: a machine can never ARM a certification either ────────────────
        // Arming is HALF of the human-only act (a machine that could arm would be
        // performing the very hold whose duration is the confirmation). drizzle/0033's
        // `sessions_certify_armed_by_is_human` refuses a non-human `certify_armed_by`.
        //
        // FLIP-TEST of drizzle/0033. `certified_by` is left NULL, so the receipt
        // triggers (0035/0036) and the humanity-of-certifier trigger (0032) all pass
        // by their own null guards — the ONLY thing this write does is name a machine
        // as the ARMER, so 0033 is the sole trigger that can refuse it. Remove 0033
        // and this write SUCCEEDS (no throw) and the test goes red.
        const machineArm = await raisedBy(
          sql`
            UPDATE sessions SET
              certify_armed_by = ${hexi.userId}::uuid,
              certify_armed_at = clock_timestamp(),
              certify_arm_nonce = gen_random_uuid(),
              certify_armed_artifact_digest = md5(artifact::text),
              updated_at = now()
            WHERE id = ${sessionId}::uuid
          `,
        );
        expect(machineArm, 'a machine arm must be refused by the table').not.toBeNull();
        expect(
          machineArm?.constraint,
          'the refusal must be the HUMAN-ARMER trigger (0033)',
        ).toBe('sessions_certify_armed_by_is_human');
        expect(
          (await certState())?.certifiedBy,
          'the machine arm attempt must have left the session uncertified',
        ).toBeNull();

        // ── CLAUSE: the human CERTIFIES the session ✓ on the married surface ─────
        // The real `HoldToAct` certify control (ArtifactPane `CertifyControl`): the
        // press ARMS the server (`armSessionCertificationAction`, binding the
        // signature to the row's real `md5(artifact::text)` digest), and the
        // completed hold CONFIRMS it (`certifySessionAction` → `certifySession`),
        // which measures its OWN arm→confirm interval in SQL and refuses anything
        // under the gate. The browser clock is never trusted.
        const certifyHold = ada.locator(`[data-hold-action="certify-${sessionId}"]`);
        await expect(certifyHold).toBeVisible();
        // Hold past the control's ask (2400ms) with margin, so the server-measured
        // arm→confirm interval clears its 2000ms floor through network jitter.
        await holdPast(ada, `[data-hold-action="certify-${sessionId}"]`, 3_400);

        // the covenant made tangible in the FOLD: a person put their name on the
        // session's landing — `certified_by` is Ada, a human, and the held duration
        // is the SERVER's own measurement (there is no field for the page to send it).
        await eventually(
          async () => (await certState())?.certifiedBy ?? null,
          (certifiedBy) => certifiedBy === adaId,
          'the held certification to reach certified_by = the human',
        );
        const receipt = await certState();
        expect(
          receipt?.certifiedAt,
          'the certification carries a server-stamped time',
        ).not.toBeNull();
        expect(
          Number(receipt?.heldMs ?? 0),
          'the recorded hold is the server-measured interval, past the gate',
        ).toBeGreaterThanOrEqual(2000);
        // the certifier of record is a HUMAN principal (the DB trigger guarantees it;
        // asserted here so the covenant clause reads its own proof).
        const certifierKind = (
          await sql<{ kind: string }[]>`
            SELECT principal_kind::text AS kind FROM users WHERE id=${adaId}::uuid
          `
        )[0]?.kind;
        expect(certifierKind, 'the certifier of record must be a human').toBe('human');

        // the married surface itself states, in words, that the human signature
        // landed — asserted on the DURABLE tree-row certified state, which the tree
        // DERIVES from live server state through `sessionCertified` (the full hold
        // receipt cohering: a present human armer = the human certifier, held past
        // the gate, and the two stamps agreeing) — never a local flag that fakes it.
        //
        // This is a STRONGER covenant proof than the CertifyControl's transient
        // "certified" ok-span the earlier draft asserted on, and it is not flaky:
        // that ok-span paints correctly on the server's awaited `result.reached`,
        // but the ArtifactPane footer correctly UNMOUNTS the whole CertifyControl
        // the instant the live projection reflects the certification (an already-
        // certified landing offers no certify affordance — the footer falls to its
        // "awaiting a human" shell and the derived `<Glyph>` carries the mark), so
        // the transient span is inherently racy to catch. The tree row updates from
        // the very server fold this test just proved in `certState()` above, and it
        // reads `✓` only when `sessionCertified` accepts the entire receipt.
        await expect(sessionRow.first()).toContainText('certified', { timeout: 15_000 });
        // the human-signature mark itself (rendered ONLY when `sessionCertified` is
        // true) — the surface's own `✓` on the row, not just the word.
        await expect(sessionRow.first().locator('[title="human-certified"]')).toBeVisible();

        // ── CLAUSE: the certification is IMMUTABLE — it cannot be un-made ────────
        // A held human signature is part of the receipt; drizzle/0033 refuses a
        // rewrite or a clear underneath everything.
        let unlandRefused = false;
        try {
          await db.update(sessions).set({ certifiedBy: null }).where(eq(sessions.id, sessionId));
        } catch {
          unlandRefused = true;
        }
        expect(unlandRefused, 'a landed certification must be immutable').toBe(true);
        expect((await certState())?.certifiedBy, 'the human signature still stands').toBe(adaId);

        // ── CLAUSE: the SERVER HOLD FLOOR is a TABLE fact, not the browser clock ──
        // The happy path proved an OVER-floor hold lands. This proves the floor is
        // enforced server-side even against a caller that BYPASSES the browser
        // entirely — which is the only way to attempt an under-floor confirm at all,
        // since the live `HoldToAct` control cannot fire its confirm before its own
        // 2400ms ask (> the 2000ms gate). On the SECOND session (so session #1's real
        // over-floor certify is untouched), write a COMPLETE, CONSISTENT receipt whose
        // only defect is a sub-2000ms hold: human armer=certifier=Ada, a reviewable
        // artifact, `certified_at − certify_armed_at ≈ 900ms` and `certified_held_ms`
        // that agrees with it. 0032/0033/0034/0038 all pass; the table refuses on
        // drizzle/0035's floor clause (`certified_held_ms < 2000`).
        //
        // FLIP-TEST of the drizzle/0035 floor. Remove that clause and the same row is
        // refused instead by drizzle/0036 (`interval < gate`) with a DIFFERENT
        // constraint name — the name assertion fails and the test goes red; remove
        // BOTH server floors and the sub-floor certification LANDS, so the
        // still-uncertified assertion goes red. The browser clock is nowhere in this
        // proof.
        const underFloor = await raisedBy(
          sql`
            UPDATE sessions SET
              certify_armed_by = ${adaId}::uuid,
              certify_armed_at = clock_timestamp() - interval '900 milliseconds',
              certify_arm_nonce = gen_random_uuid(),
              certify_armed_artifact_digest = md5(artifact::text),
              certified_by = ${adaId}::uuid,
              certified_at = clock_timestamp(),
              certified_held_ms = 900,
              updated_at = now()
            WHERE id = ${session2Id}::uuid
          `,
        );
        expect(underFloor, 'a sub-floor hold must be refused by the table').not.toBeNull();
        expect(
          underFloor?.constraint,
          'the refusal must be the RECEIPT-COMPLETE floor (0035) — the server-measured 2000ms gate',
        ).toBe('sessions_certify_receipt_complete');
        expect(
          (
            await sql<{ c: string | null }[]>`
              SELECT certified_by::text AS c FROM sessions WHERE id=${session2Id}::uuid
            `
          )[0]?.c ?? null,
          'the sub-floor attempt must not have landed a certification',
        ).toBeNull();

        // ── CLAUSE: CERTIFY BINDS THE REVIEWED DIGEST (the real arm→confirm door) ──
        // The happy path certified session #1 over an artifact that never moved. This
        // proves the OTHER half of that guarantee — that the signature is bound to the
        // revision that was on screen — by driving the REAL `HoldToAct` certify control
        // for session #2 and mutating its artifact BETWEEN the server arm and the
        // server confirm. `certifySession` stamped `certify_armed_artifact_digest =
        // md5(artifact)` at arm; at confirm it recomputes the digest and refuses
        // `artifact_changed` because the artifact moved underneath the hold. The `✓`
        // never lands, so drizzle/0034 never freezes a revision the person did not
        // review under a human signature.
        //
        // FLIP-TEST of the confirm-time digest bind (`certifySession`'s
        // `artifactChanged` guard). Remove it and the confirm certifies session #2 over
        // the mutated artifact — `certified_by` becomes Ada and the "still uncertified"
        // assertion below goes red.
        const session2Row = tree.getByRole('button').filter({ hasText: branch2 });
        await expect(session2Row.first()).toBeVisible({ timeout: 20_000 });
        await session2Row.first().click();
        const certify2Selector = `[data-hold-action="certify-${session2Id}"]`;
        await expect(ada.locator(certify2Selector)).toBeVisible({ timeout: 20_000 });

        // Arm on hold-BEGIN, wait for the server arm to land (it binds the digest of
        // the artifact as it is NOW — the original), then move the artifact underneath
        // the pending hold, then complete the hold so the CONFIRM measures a changed
        // artifact. Holding the mouse down across the mutation is the whole point: the
        // arm digested revision A, the confirm sees revision B.
        const mutatedArtifact2: SessionArtifact = {
          ...artifact2,
          summary: 'the artifact MOVED underneath the pending hold — the confirm must refuse it',
        };
        const box2 = await ada.locator(certify2Selector).boundingBox();
        if (!box2) throw new Error('the session-2 certify control had no box');
        await ada.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
        const holdBegan = Date.now();
        await ada.mouse.down();
        // the server arm has landed on the row (bound to the original digest).
        await eventually(
          async () =>
            (
              await sql<{ a: string | null }[]>`
                SELECT certify_armed_by::text AS a FROM sessions WHERE id=${session2Id}::uuid
              `
            )[0]?.a ?? null,
          (armer) => armer === adaId,
          'the session-2 certification arm to land server-side',
        );
        // MOVE the artifact underneath the hold — the reviewed digest no longer matches.
        await db
          .update(sessions)
          .set({ artifact: mutatedArtifact2 })
          .where(eq(sessions.id, session2Id));
        // finish the hold past the control's 2400ms ask, then release → the CONFIRM
        // fires and the server refuses `artifact_changed`.
        const heldFor = Date.now() - holdBegan;
        if (heldFor < 3200) await ada.waitForTimeout(3200 - heldFor);
        await ada.mouse.up();

        // the control paints the server's own refusal, in words, and NOTHING certifies:
        // the signature never bound to the revision the person did not review.
        await expect(ada.getByText(/not certified/i).first()).toBeVisible({ timeout: 15_000 });
        await eventually(
          async () =>
            (
              await sql<{ c: string | null }[]>`
                SELECT certified_by::text AS c FROM sessions WHERE id=${session2Id}::uuid
              `
            )[0]?.c ?? null,
          (certifiedBy) => certifiedBy === null,
          'the stale-digest confirm to leave session #2 uncertified',
        );
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        // Teardown: the workspace cascade takes the room, memberships, plan and
        // session; the two identities are deleted by hand.
        await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
        await db.delete(users).where(inArray(users.id, [adaId, hexi.userId]));
      }
    });
  });
