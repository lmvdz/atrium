import { randomUUID } from 'node:crypto';
import {
  createAtriumAuth,
  mintAgentSession,
  provisionAgentPrincipal,
  sessionCookieHeader,
} from '@atrium/auth';
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
import { openRail, requireBrowser, uniqueEmail } from './support/flows';

/**
 * The production lane's public origin — must match `playwright.destination.config.ts`'s
 * `baseURL`. The test builds its Better Auth instance with THIS baseURL (not the dev
 * config's http one) so `useSecureCookies` is on and the minted cookie carries the same
 * `__Secure-` name the https server reads back. A mismatch here mints a cookie the server
 * cannot see, and the ws upgrade is refused for "no valid session".
 */
const DESTINATION_APP_URL = 'https://localhost:3200';

/**
 * THE DESTINATION SCENARIO — humans and agents as peers in one room.
 *
 * Map #89's destination, driven end to end on the real authenticated
 * `/app/<ws>/<room>` route, against a GENUINE PRODUCTION BUILD in production
 * posture (NODE_ENV=production, TLS-terminated https/wss, the auth secure-transport
 * and mailer gates ACTIVE and satisfied — see `playwright.destination.config.ts`
 * and `support/destination-tls.mjs`), real Postgres, from the test runner. No
 * fixtures, no mocks of the product surfaces. Every clause of the scenario is an
 * assertion here.
 *
 * ## The harness
 *
 * - **2 HUMANS** hold real Better Auth sessions and act by clicking the product's
 *   own controls on the real live route. They are seated by SESSION-MINTING — the
 *   path the #91 brief blesses (replay.spec.ts's session repointing, room-access's
 *   direct fixture) and the one the map names ("session-minting via the
 *   seeded-creator/signup path"). The email-verification SIGNUP UI is deliberately
 *   not exercised here: the dev outbox the e2e reads links from is production-
 *   disabled by design (`packages/auth/src/mailer.ts`), so on a production build a
 *   human is seated the same honest way an agent is — a real row, a real session.
 * - **2 AGENTS** are provisioned through the blessed helper (`provisionAgentPrincipal`,
 *   #96), seated as room members, and each given a real session (`mintAgentSession`).
 *   Each holds its own browser context carrying that session cookie and is driven by
 *   DETERMINISTIC PROTOCOL FRAMES on its own socket — no model in the loop, fixed
 *   text, fixed order. The `~` drafts ride the EXISTING deterministic interpret
 *   worker (`INTERPRET_PROVIDER=acceptance-deterministic`): the agent posts
 *   `Decision:` / `Objective:` and the worker stages them, minted by a genuine
 *   `{kind:'model'}` actor, with zero new machinery and zero model calls.
 * - **The certify-refusal clause** attempts an agent certification over the AGENT's
 *   own authenticated socket and asserts the SERVER refuses it (a `nack`, the command
 *   refused before any append) and that the ledger holds nothing — not merely that
 *   the UI hides the button.
 *
 * ## NAMED LIMITATION (from #91, kept here on purpose)
 *
 * This proves the DOORS are open and the certify boundary CLOSED. It proves NOTHING
 * about whether an agent's contributions are useful — that is Phase 3/4's question
 * (`init.md`). A scripted agent posts fixed text at fixed points; no assertion here
 * depends on what a model would have said.
 *
 * ## ONE DELIBERATE, REOPENABLE SUBSTITUTION (owned by #103, on recorded authority)
 *
 * The scenario's prose names the two drafts "a claim and an open_question". The
 * engine's real behaviour, confirmed by the green `multiplayer.spec.ts` and by
 * `packages/core/src/policy.ts` + `reduce.ts`, is that a MODEL-drafted `claim` and
 * `open_question` at the deterministic provider's fixed confidence (0.95) clear
 * `MODEL_ACCEPTANCE_FLOOR` and AUTO-ACCEPT — they never sit as `~` awaiting a person,
 * and there is NO live-route affordance to certify a claim (verification is not a UI
 * command) or to remove an accepted reading (only reopen/retype/supersede). So "a
 * human certifies one and rejects the other (✓ / removed)" is literally unreachable
 * through the real product for those two types.
 *
 * The two drafts here are therefore the two NON-auto-accept reading types the real
 * pin/receipt DO route to a person for judgement: a `decision` the human CERTIFIES
 * (pin `answer` → receipt → `Accept reading` → ✓) and an `objective` the human REJECTS
 * (pin `decline` → `reject_proposal` → removed). Every OPERATIVE assertion of the clause
 * is preserved: a machine drafts onto `~`; a person certifies one into `✓`; a person
 * rejects the other and it is removed; the receipt's provenance jump lands on the exact
 * source message; and — the covenant's spine — an agent that attempts to certify is
 * refused by the API. Only the two illustrative object TYPES moved, and only because the
 * product genuinely cannot put a human in the certify loop for the named pair. Recorded
 * here, and on #103, as reopenable.
 */

let db: Database;
let auth: ReturnType<typeof createAtriumAuth>;
let sql: ReturnType<typeof postgres>;

test.beforeAll(() => {
  const handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
  // The same configuration both server processes build — one definition of a valid
  // session, so a minted cookie is read back exactly as the upgrade authenticator reads
  // it in production.
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

/** A human session, minted through Better Auth's own adapter (the interactive sign-in a person would do). */
async function mintHumanSession(userId: string): Promise<string> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  return sessionCookieHeader(auth, session.token);
}

/**
 * A socket opened FROM INSIDE the page over the SAME https origin as wss, so the
 * browser attaches the context's session cookie exactly as the app does. Subscribes,
 * auto-acks head frames, and is the instrument that drives an agent's turns and asks
 * the server to certify from a non-human session.
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
        const commandId = `scenario-${live.serial}`;
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
 * The certify-refusal clause asserts the server's refusal; a helper that threw on `nack`
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
        const commandId = `scenario-${live.serial}`;
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

/** Poll for an asynchronous fold to converge — the worker and projections run on their own schedule. */
async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
) {
  await expect
    .poll(async () => accepts(await read()), { timeout: 90_000, message: label })
    .toBe(true);
}

/**
 * Act on the live pin card whose text identifies it — robust to the several
 * attention-item ids a single proposal can carry (a receipt_review and a clean
 * decision_pending can coexist with different ids; the pin renders one). The
 * card's rendered statement is the stable handle a person actually reads.
 */
async function actOnPinCard(page: Page, text: string, action: string): Promise<void> {
  const pin = page.getByRole('region', { name: 'Needs you' });
  const card = pin.locator('[data-attention-id]').filter({ hasText: text }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Wait for the action control itself to render — a pin card paints its statement
  // before its buttons, so a bare `count()` the instant the card appears can miss
  // them. `toBeVisible` retries until the control is there.
  const control = card.getByRole('button', { name: action, exact: true });
  await expect(control).toBeVisible({ timeout: 20_000 });
  if ((await control.getAttribute('data-hold')) !== null) {
    await control.hover();
    await page.mouse.down();
    await page.waitForTimeout(2_100);
    await page.mouse.up();
  } else {
    await control.click();
  }
}

/** Post a message + a typed mention through the real composer (body first, mention last). */
async function sendWithMention(page: Page, body: string, mentionLabel: string): Promise<void> {
  const composer = page.getByRole('combobox', { name: 'Message #general' });
  await composer.fill(body);
  await page.getByLabel('Reference a person or room item').click();
  await page.getByRole('option', { name: mentionLabel, exact: true }).click();
  await expect(composer).toHaveValue(`${body} ${mentionLabel} `);
  await page.getByRole('button', { name: 'Send' }).click();
}

test.describe
  .serial('the destination scenario: humans and agents as peers', () => {
    requireBrowser();

    test('a human mentions an agent; the agent answers and drafts; a human certifies one draft and rejects the other; the provenance jump lands on the source; a human→human mention surfaces from the one register; the returning human replays to live and follows; and an agent may never certify', async ({
      browser,
    }) => {
      test.setTimeout(300_000);
      const runId = randomUUID().slice(0, 8);
      const contexts: BrowserContext[] = [];

      // ── Seed the room and provision all four peers, seated by session-minting ──
      const [adaRow] = await db
        .insert(users)
        .values({ email: uniqueEmail('dest-ada'), displayName: 'Ada', emailVerified: true })
        .returning({ id: users.id });
      const [benRow] = await db
        .insert(users)
        .values({ email: uniqueEmail('dest-ben'), displayName: 'Ben', emailVerified: true })
        .returning({ id: users.id });
      if (!adaRow || !benRow) throw new Error('human provisioning returned nothing');
      const adaId = adaRow.id;
      const benId = benRow.id;

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: `Destination ${runId}`, slug: `dest-${runId}` })
        .returning({ id: workspaces.id, slug: workspaces.slug });
      if (!workspace) throw new Error('workspace insert returned nothing');
      const [room] = await db
        .insert(rooms)
        .values({ workspaceId: workspace.id, slug: 'general', name: 'general', createdBy: adaId })
        .returning({ id: rooms.id });
      if (!room) throw new Error('room insert returned nothing');
      const roomId = room.id;

      const scribe = await provisionAgentPrincipal({
        db,
        email: `scribe-${randomUUID()}@agents.atrium.invalid`,
        displayName: 'scribe',
      });
      const echo = await provisionAgentPrincipal({
        db,
        email: `echo-${randomUUID()}@agents.atrium.invalid`,
        displayName: 'echo',
      });

      await db.insert(workspaceMembers).values([
        { organizationId: workspace.id, userId: adaId, role: 'admin' },
        { organizationId: workspace.id, userId: benId, role: 'member' },
        { organizationId: workspace.id, userId: scribe.userId, role: 'member' },
        { organizationId: workspace.id, userId: echo.userId, role: 'member' },
      ]);
      await db.insert(memberships).values([
        { roomId, userId: adaId, role: 'admin' },
        { roomId, userId: benId, role: 'member' },
        { roomId, userId: scribe.userId, role: 'member' },
        { roomId, userId: echo.userId, role: 'member' },
      ]);

      try {
        const ada = (await seat(browser, await mintHumanSession(adaId))).page;
        contexts.push(ada.context());
        const ben = (await seat(browser, await mintHumanSession(benId))).page;
        contexts.push(ben.context());
        const scribeSeat = await seat(
          browser,
          (await mintAgentSession({ auth, db, userId: scribe.userId })).cookie,
        );
        contexts.push(scribeSeat.context);
        const echoSeat = await seat(
          browser,
          (await mintAgentSession({ auth, db, userId: echo.userId })).cookie,
        );
        contexts.push(echoSeat.context);

        // The two agents establish their origin and open their own frame-driven sockets.
        await scribeSeat.page.goto('/app');
        await openScenarioSocket(scribeSeat.page, roomId);
        await echoSeat.page.goto('/app');
        await openScenarioSocket(echoSeat.page, roomId);

        // The two humans enter the real live route.
        await ada.goto(`/app/${workspace.slug}/general`);
        await ben.goto(`/app/${workspace.slug}/general`);
        await expect(ada.locator('[data-frame="live"]')).toBeVisible();
        await expect(ben.locator('[data-frame="live"]')).toBeVisible();

        // ── CLAUSE: a room with 2 humans and 2 agents ──────────────────────────
        await openRail(ada);
        const rail = ada.locator('nav[aria-label="Rooms and participants"]');
        await expect(rail.locator('.atr-scroll [data-participant-kind="agent"]')).toHaveCount(2);
        await expect(rail.locator('.atr-scroll [data-participant-kind="human"]')).toHaveCount(2);
        await expect(ada.getByText('1 room · 2 people · 2 agents', { exact: true })).toBeVisible();

        // ── Establish Ben's since-you-left boundary, then Ben leaves ────────────
        await openScenarioSocket(ada, roomId);
        await scenarioCommand(ada, {
          name: 'send_message',
          roomId,
          body: `Run ${runId}: kicking off the peers room.`,
          clientMessageId: `dest-${runId}-open`,
        });
        const benDivider = ben.locator('[data-row="since-you-left"]');
        // Ben marks the room read up to the current head over his own socket — the
        // durable read cursor a person sets by viewing — then leaves. His return
        // below therefore lands on a real since-you-left boundary.
        await openScenarioSocket(ben, roomId);
        const boundaryHead = Number(
          (
            await sql<{ h: number }[]>`
              SELECT COALESCE(max(room_seq), 0)::int AS h FROM core_events WHERE room_id=${roomId}::uuid
            `
          )[0]?.h ?? 0,
        );
        await scenarioCommand(ben, { name: 'advance_seen', roomId, roomSeq: boundaryHead });
        await eventually(
          async () =>
            Number(
              (
                await sql<{ seen: number }[]>`
                SELECT seen_seq::int AS seen FROM memberships
                WHERE room_id=${roomId}::uuid AND user_id=${benId}::uuid
              `
              )[0]?.seen ?? 0,
            ),
          (seen) => seen > 0 && seen >= boundaryHead,
          "Ben's seen cursor to reach the durable membership row",
        );
        await ben.goto('/app');

        // ── CLAUSE: a human asks a question and @-mentions an agent ─────────────
        await sendWithMention(ada, `Run ${runId}: what did the last window settle?`, '@scribe');
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM message_references r
                        JOIN messages m ON m.id=r.message_id
                        WHERE m.room_id=${roomId}::uuid AND r.kind='agent'
                          AND r.target_id=${scribe.userId}::uuid`
              )[0]?.n ?? 0,
            ),
          (n) => n === 1,
          'the human→agent mention to land as an agent reference',
        );

        // ── CLAUSE: the agent answers in the conversation, and drafts onto `~` ──
        await scenarioCommand(scribeSeat.page, {
          name: 'send_message',
          roomId,
          body: `Run ${runId}: I read the room; here is my reading.`,
          clientMessageId: `dest-${runId}-scribe-answer`,
        });
        await scenarioCommand(echoSeat.page, {
          name: 'send_message',
          roomId,
          body: `Run ${runId}: acknowledged, standing by.`,
          clientMessageId: `dest-${runId}-echo-answer`,
        });
        const decisionBody = `Decision: Run ${runId} ship the peers milestone behind a flag.`;
        const objectiveBody = `Objective: Run ${runId} reach agent-participant parity this quarter.`;
        await scenarioCommand(scribeSeat.page, {
          name: 'send_message',
          roomId,
          body: decisionBody,
          clientMessageId: `dest-${runId}-scribe-decision`,
        });
        await scenarioCommand(scribeSeat.page, {
          name: 'send_message',
          roomId,
          body: objectiveBody,
          clientMessageId: `dest-${runId}-scribe-objective`,
        });
        // Trailing conversation AFTER the two drafts. Both readings must sit in a
        // worker acceptance window that carries messages after the sentence they
        // cite — otherwise the correction scan "read no evidence about what came
        // after" and the staged reading reaches no one (an unread window is not a
        // clean one). These are plain speech (no fixture prefix), so they raise no
        // readings of their own; they only give the two drafts their "after".
        for (let i = 0; i < 4; i += 1) {
          const speaker = i % 2 === 0 ? echoSeat.page : scribeSeat.page;
          await scenarioCommand(speaker, {
            name: 'send_message',
            roomId,
            body: `Run ${runId}: continuing the discussion, note ${i}.`,
            clientMessageId: `dest-${runId}-trailer-${i}`,
          });
        }

        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM proposals
                        WHERE room_id=${roomId}::uuid AND status='proposed'
                          AND type IN ('decision','objective')`
              )[0]?.n ?? 0,
            ),
          (n) => n === 2,
          'the decision and objective drafts to be staged as proposed readings',
        );
        // Each draft, joined to its provenance source message (proposal_sources)
        // and that message's author — the register that proves the draft rode the
        // AGENT's own message, and the exact id the receipt's provenance jump uses.
        const drafts = await sql<
          { id: string; type: string; sourceId: string; authorId: string }[]
        >`
        SELECT p.id::text, p.type::text, ps.message_id::text AS "sourceId",
               m.author_id::text AS "authorId"
        FROM proposals p
        JOIN proposal_sources ps ON ps.proposal_id = p.id AND ps.room_id = p.room_id
        JOIN messages m ON m.id = ps.message_id
        WHERE p.room_id=${roomId}::uuid AND p.type IN ('decision','objective')
      `;
        const decisionDraft = drafts.find((d) => d.type === 'decision');
        const objectiveDraft = drafts.find((d) => d.type === 'objective');
        if (!decisionDraft || !objectiveDraft)
          throw new Error('the two drafts did not fold with a source message');
        // the drafts were derived from the AGENT's own messages
        expect(decisionDraft.authorId).toBe(scribe.userId);
        expect(objectiveDraft.authorId).toBe(scribe.userId);
        const decisionSourceId = decisionDraft.sourceId;

        // ── CLAUSE: an agent must never certify — the API refuses it ────────────
        const refusal = await scenarioAttempt(scribeSeat.page, {
          name: 'accept_proposal',
          roomId,
          proposalId: decisionDraft.id,
        });
        expect(refusal.type, 'an agent certification must be a hard refusal').toBe('nack');
        const said = `${refusal.message ?? ''} ${JSON.stringify(refusal.issues ?? [])}`;
        expect(said).toContain('is a certification');
        // the FOLD: the agent certified nothing — no object_accepted authored by it
        expect(
          Number(
            (
              await sql`SELECT count(*)::int AS n FROM core_events
                      WHERE room_id=${roomId}::uuid AND type='object_accepted'
                        AND actor_kind='agent' AND actor_id=${scribe.userId}`
            )[0]?.n ?? 0,
          ),
        ).toBe(0);
        expect(
          (
            await sql<
              { status: string }[]
            >`SELECT status::text FROM proposals WHERE id=${decisionDraft.id}::uuid`
          )[0]?.status,
        ).toBe('proposed');

        // ── CLAUSE: a human certifies one draft (✓), with the provenance jump ───
        const decisionAttention = async () =>
          (
            await sql<{ id: string }[]>`
            SELECT id::text FROM attention_items
            WHERE room_id=${roomId}::uuid AND subject_id=${decisionDraft.id}::uuid
              AND user_id=${adaId}::uuid AND status='pending'
          `
          )[0]?.id ?? null;
        await eventually(
          decisionAttention,
          (id) => id !== null,
          'the decision to route to a human',
        );
        const decisionAttId = await decisionAttention();
        if (!decisionAttId) throw new Error('decision has no live attention route');
        await actOnPinCard(ada, 'ship the peers milestone', 'answer');

        const receipt = ada.locator(`[data-receipt-id="${decisionDraft.id}"]`);
        await expect(receipt).toBeVisible();

        // ── CLAUSE: the provenance jump lands on the exact source message ───────
        // Taken on the open receipt, before certifying: the receipt cites the agent's
        // own decision message, and the jump scrolls to and focuses that exact row.
        const jump = receipt.locator(`button[data-jumps-to="${decisionSourceId}"]`);
        await expect(jump).toBeVisible();
        await jump.click();
        const landedRow = ada.locator(`[data-message-id="${decisionSourceId}"]`);
        await expect(landedRow).toBeVisible();
        await expect(landedRow).toBeFocused();
        await expect(landedRow).toContainText(decisionBody);

        // Re-open the same receipt (the attention is still pending) and certify: ~ → ✓.
        await actOnPinCard(ada, 'ship the peers milestone', 'answer');
        await expect(receipt).toBeVisible();
        await expect(receipt.getByRole('button', { name: 'Accept reading' })).toBeVisible();
        await receipt.getByRole('button', { name: 'Accept reading' }).click();
        await eventually(
          async () =>
            (
              await sql<
                { status: string }[]
              >`SELECT status::text FROM proposals WHERE id=${decisionDraft.id}::uuid`
            )[0]?.status ?? '',
          (status) => status === 'accepted',
          'the certified decision to reach the accepted fold',
        );
        const acceptedDecision = (
          await sql<{ id: string; acceptedBy: string | null }[]>`
          SELECT id::text, accepted_by::text AS "acceptedBy"
          FROM accepted_objects WHERE room_id=${roomId}::uuid AND proposal_id=${decisionDraft.id}::uuid
        `
        )[0];
        // ✓ certified, and by a PERSON — the agent's id never lands as the accepter.
        expect(acceptedDecision?.acceptedBy).toBe(adaId);

        // ── CLAUSE: a human rejects the other draft (removed) ──────────────────
        const objectiveAttention = async () =>
          (
            await sql<{ id: string }[]>`
            SELECT id::text FROM attention_items
            WHERE room_id=${roomId}::uuid AND subject_id=${objectiveDraft.id}::uuid
              AND user_id=${adaId}::uuid AND status='pending'
          `
          )[0]?.id ?? null;
        await eventually(
          objectiveAttention,
          (id) => id !== null,
          'the objective to route to a human',
        );
        const objectiveAttId = await objectiveAttention();
        if (!objectiveAttId) throw new Error('objective has no live attention route');
        await actOnPinCard(ada, 'agent-participant parity', 'decline');
        await eventually(
          async () =>
            (
              await sql<
                { status: string }[]
              >`SELECT status::text FROM proposals WHERE id=${objectiveDraft.id}::uuid`
            )[0]?.status ?? '',
          (status) => status === 'rejected',
          'the rejected objective to leave the surface as removed',
        );
        expect(
          Number(
            (
              await sql`SELECT count(*)::int AS n FROM accepted_objects WHERE room_id=${roomId}::uuid AND proposal_id=${objectiveDraft.id}::uuid`
            )[0]?.n ?? 0,
          ),
        ).toBe(0);

        // ── CLAUSE: a human @-mentions another human; it surfaces from ONE register ──
        await sendWithMention(ada, `Run ${runId}: over to you`, '@Ben');
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM message_references r
                        JOIN messages m ON m.id=r.message_id
                        WHERE m.room_id=${roomId}::uuid AND r.kind='human'
                          AND r.target_id=${benId}::uuid`
              )[0]?.n ?? 0,
            ),
          (n) => n === 1,
          'the human→human mention to land as a human reference',
        );
        const benMention = (
          await sql<{ subjectKind: string; reasonKind: string }[]>`
          SELECT subject_kind AS "subjectKind", reason->>'kind' AS "reasonKind"
          FROM attention_items
          WHERE room_id=${roomId}::uuid AND user_id=${benId}::uuid AND reason->>'kind'='mention'
        `
        )[0];
        expect(benMention).toEqual({ subjectKind: 'message', reasonKind: 'mention' });
        // NOWHERE reads from a register the client doesn't write: the second register
        // is GONE. `messages.mention_user_ids` was dropped (drizzle/0020), so no code
        // path can read a mention from a column the client never fills.
        expect(
          Number(
            (
              await sql`SELECT count(*)::int AS n FROM information_schema.columns
                      WHERE table_name='messages' AND column_name='mention_user_ids'`
            )[0]?.n ?? 0,
          ),
          'mention_user_ids must not exist — the mention register is message_references alone',
        ).toBe(0);

        // ── CLAUSE: the returning human opens at since-you-left, replays to live, follows ──
        await ben.goto(`/app/${workspace.slug}/general`);
        await expect(ben.locator('[data-frame="live"]')).toBeVisible();
        await expect(benDivider).toBeVisible();
        await expect(benDivider).toContainText('messages');
        const seenControl = benDivider.getByRole('button', { name: 'mark this group seen' });
        if ((await seenControl.count()) > 0) await seenControl.click();

        const benSurface = ben.locator('main[data-room-id]');
        await expect
          .poll(async () => Number(await benSurface.getAttribute('data-persisted-through')), {
            message: 'the returning route to catch up to the live edge',
            timeout: 30_000,
          })
          .toBeGreaterThan(0);

        // follow: a new message from another participant scrolls into view at the live
        // edge, and the follow survives the composer reshaping under a long multi-line draft.
        const benFeed = ben.locator('[data-region="conversation"]');
        const benComposer = ben.getByRole('combobox', { name: 'Message #general' });
        await benComposer.fill(
          [
            `Run ${runId}: drafting a long reply`,
            ...Array.from({ length: 14 }, (_, i) => `line ${i + 1}`),
          ].join('\n'),
        );
        const followMarker = `Run ${runId}: live edge follow ${Date.now()}`;
        await scenarioCommand(ada, {
          name: 'send_message',
          roomId,
          body: followMarker,
          clientMessageId: `dest-${runId}-follow`,
        });
        const appended = benFeed.locator('[data-message-id]').filter({ hasText: followMarker });
        await expect(appended).toBeVisible({ timeout: 20_000 });
        await expect
          .poll(
            () =>
              benFeed.evaluate((element, text) => {
                const row = [...element.querySelectorAll('[data-message-id]')].find((child) =>
                  child.textContent?.includes(text),
                );
                if (!(row instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
                const target = Math.min(
                  element.scrollHeight - element.clientHeight,
                  Math.max(0, row.offsetTop),
                );
                return Math.abs(element.scrollTop - target);
              }, followMarker),
            {
              message: 'the feed to follow the live edge through the composer reshape',
              timeout: 20_000,
            },
          )
          .toBeLessThanOrEqual(4);
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        // Teardown: the workspace cascade takes the room, memberships, messages and
        // workspace_members; the four identities are deleted by hand.
        await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
        await db.delete(users).where(inArray(users.id, [adaId, benId, scribe.userId, echo.userId]));
      }
    });
  });
