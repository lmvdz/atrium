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
 *   `Claim:` / `Open question:` and the worker stages them, minted by a genuine
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
 * ## THE TWO DRAFTS ARE THE LITERAL SCENARIO TYPES — a claim and an open_question (#110)
 *
 * The scenario's prose names the two drafts "a claim and an open_question", and this
 * spec now drives exactly those. A MODEL-drafted `claim` and `open_question` AUTO-ACCEPT
 * (#4/#8, `policy.ts`): at the deterministic provider they clear the acceptance floor and
 * land as `~` readings — a claim `self_reported`, an open_question `open` — with no
 * proposal for a person to answer/decline. Before #110 the live route exposed certify and
 * reject for PROPOSALS only, so those two auto-accept types had no human-reachable
 * certify/remove affordance, and an earlier version of this spec substituted a `decision`
 * (certified via the pin) and an `objective` (rejected via the pin) to prove the covenant
 * machinery. **#110 closed that gap** — the live receipt now certifies a `~` claim
 * (`correct`/`amend {verification:'verified'}`, the #102-gated verify act) and removes a
 * `~` reading (`correct`/`retract`) — so the scenario runs on the LITERAL types:
 *
 * - the agent DRAFTS a `~` claim and a `~` open_question, cited to its own messages;
 * - a DISINTERESTED human (Ada — neither the claimant nor the author of the claim's
 *   source message, which is the agent; #102 refuses an interested certifier, proven at
 *   the human level in `certify-reading.spec.ts`) CERTIFIES the `~` claim → `✓`, asserted
 *   on the read-model (`verification=verified`, `human_touched_at` set);
 * - the same human REMOVES the `~` open_question, asserted retracted;
 * - the receipt's provenance jump lands on the agent's exact source message;
 * - and — the covenant's spine — the agent, over its OWN authenticated socket, attempts
 *   the very same certify (`correct`/`amend`) on the claim and the API REFUSES it (`nack`,
 *   nothing appended, the claim left `~`).
 *
 * The decision/objective substitution is GONE.
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
 * The persisted message id for a client-supplied id authored by a given user, or
 * `null` until the row lands. Keyed on `author_id` too so the assertion proves the
 * agent's OWN message, not merely a row with the right idempotency key.
 */
async function messageIdFor(
  roomId: string,
  clientMessageId: string,
  authorId: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id::text FROM messages
    WHERE room_id=${roomId}::uuid AND client_message_id=${clientMessageId}
      AND author_id=${authorId}::uuid
  `;
  return rows[0]?.id ?? null;
}

/**
 * Open a `~` reading's receipt from the current-state surface. The auto-accepted
 * claim/open_question renders as a row (`data-object-id`) with no pin to answer —
 * the person clicks the reading itself, and the receipt carries #110's certify /
 * remove affordances. A reload settles the refreshed persisted projection first.
 */
async function openReadingReceipt(page: Page, objectId: string): Promise<void> {
  await page.reload();
  await expect(page.locator('[data-frame="live"]')).toBeVisible();
  const row = page.locator(`[data-object-id="${objectId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator(`[data-receipt-id="${objectId}"]`)).toBeVisible();
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
        // ── CLAUSE: "the agent answers" is proven in the READ MODEL, not the ack ──
        // The command ack only says the server accepted the frame; the covenant is
        // that participants SEE the answer. So: the Scribe answer is a real message
        // row authored by the AGENT (a fold fact), and it renders in Ada's live
        // conversation feed by that exact id.
        let scribeAnswerId: string | null = null;
        await expect
          .poll(
            async () =>
              (scribeAnswerId = await messageIdFor(
                roomId,
                `dest-${runId}-scribe-answer`,
                scribe.userId,
              )),
            {
              message: "the agent's answer to persist as a message row it authored",
              timeout: 30_000,
            },
          )
          .not.toBeNull();
        await expect(
          ada.locator(`[data-region="conversation"] [data-message-id="${scribeAnswerId}"]`),
          "the agent's answer must render in a human's live feed, not just ack",
        ).toBeVisible({ timeout: 20_000 });

        // The agent DRAFTS the two LITERAL scenario types. A `claim` and an
        // `open_question` AUTO-ACCEPT (#4/#8): the deterministic provider reads a
        // whole-line `Claim: …` / `Open question: …` body, stages the reading, and
        // it clears the acceptance floor to land as a `~` reading — no proposal,
        // authored by (and cited to) the agent's own message.
        const claimBody = `Claim: Run ${runId} the staging deploy came back green.`;
        const questionBody = `Open question: Run ${runId} should the release ship before Monday?`;
        await scenarioCommand(scribeSeat.page, {
          name: 'send_message',
          roomId,
          body: claimBody,
          clientMessageId: `dest-${runId}-scribe-claim`,
        });
        await scenarioCommand(scribeSeat.page, {
          name: 'send_message',
          roomId,
          body: questionBody,
          clientMessageId: `dest-${runId}-scribe-question`,
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
                await sql`SELECT count(*)::int AS n FROM accepted_objects
                        WHERE room_id=${roomId}::uuid AND retracted_at IS NULL
                          AND type IN ('claim','open_question')`
              )[0]?.n ?? 0,
            ),
          (n) => n === 2,
          'the claim and open_question drafts to auto-accept as `~` readings',
        );
        // Each `~` reading, joined to its provenance source message (object_sources)
        // and that message's author — the register that proves the draft rode the
        // AGENT's own message, and the exact id the receipt's provenance jump uses.
        const drafts = await sql<
          { id: string; type: string; sourceId: string; authorId: string }[]
        >`
        SELECT o.id::text, o.type::text, os.message_id::text AS "sourceId",
               m.author_id::text AS "authorId"
        FROM accepted_objects o
        JOIN object_sources os ON os.object_id = o.id AND os.room_id = o.room_id
        JOIN messages m ON m.id = os.message_id
        WHERE o.room_id=${roomId}::uuid AND o.retracted_at IS NULL
          AND o.type IN ('claim','open_question')
      `;
        const claimReading = drafts.find((d) => d.type === 'claim');
        const questionReading = drafts.find((d) => d.type === 'open_question');
        if (!claimReading || !questionReading)
          throw new Error('the two `~` readings did not fold with a source message');
        // the drafts were derived from the AGENT's own messages
        expect(claimReading.authorId).toBe(scribe.userId);
        expect(questionReading.authorId).toBe(scribe.userId);
        const claimSourceId = claimReading.sourceId;

        // The claim is a `~` reading: no human has certified it, nothing verified.
        const claimState = async () =>
          (
            await sql<
              {
                verification: string | null;
                touched: string | null;
                acceptedByKind: string | null;
                claimant: string | null;
              }[]
            >`
              SELECT payload->>'verification' AS verification,
                     human_touched_at::text AS touched,
                     accepted_by_kind::text AS "acceptedByKind",
                     payload->>'claimant' AS claimant
              FROM accepted_objects WHERE id=${claimReading.id}::uuid
            `
          )[0];
        const questionState = async () =>
          (
            await sql<{ touched: string | null; acceptedByKind: string | null }[]>`
              SELECT human_touched_at::text AS touched,
                     accepted_by_kind::text AS "acceptedByKind"
              FROM accepted_objects WHERE id=${questionReading.id}::uuid
            `
          )[0];
        const before = await claimState();
        expect(before?.verification).toBe('unverified');
        expect(before?.touched).toBeNull();
        // clause 2: BOTH drafts are genuine MACHINE `~` BEFORE any human acts — accepted
        // by a `model`/`agent` actor and untouched by a human. `unverified` alone would
        // hold on an already-human-touched object; the accepter-kind is what proves the
        // certify and the remove below act on a real machine reading.
        expect(['model', 'agent']).toContain(before?.acceptedByKind);
        const questionBefore = await questionState();
        expect(['model', 'agent']).toContain(questionBefore?.acceptedByKind);
        expect(questionBefore?.touched).toBeNull();
        // clause 3: the certifier (Ada) is DISINTERESTED — she is neither the claim's
        // `claimant` nor the author of its source message (both are the agent). Pinned
        // from the fold, not assumed from the fixture: verification is a second pair of
        // eyes (#102), and this proves the eyes are genuinely a second pair.
        expect(before?.claimant, 'the claimant must not be the certifier').not.toBe(adaId);
        expect(before?.claimant).toBe(scribe.userId);
        expect(claimReading.authorId, 'the source author must not be the certifier').not.toBe(
          adaId,
        );

        // ── CLAUSE: an agent must never certify — the API refuses it ────────────
        // Over its OWN authenticated socket, the agent attempts the very act #110
        // gave the human — the #102-gated verify (`correct`/`amend
        // {verification:'verified'}`) on the `~` claim. The server refuses it before
        // any append: `correct` is in the certification class, and a machine may
        // draft (~) but never certify (✓).
        const refusal = await scenarioAttempt(scribeSeat.page, {
          name: 'correct',
          roomId,
          objectId: claimReading.id,
          action: 'amend',
          patch: { verification: 'verified' },
          toType: null,
          provenance: { messageIds: [], proposalId: null, interpretationId: null },
          note: null,
        });
        expect(refusal.type, 'an agent certification must be a hard refusal').toBe('nack');
        const said = `${refusal.message ?? ''} ${JSON.stringify(refusal.issues ?? [])}`;
        expect(said).toContain('is a certification');
        // the FOLD: the agent certified nothing — no object_corrected authored by it,
        // and the claim is left exactly as it was, a `~` no person has touched.
        expect(
          Number(
            (
              await sql`SELECT count(*)::int AS n FROM core_events
                      WHERE room_id=${roomId}::uuid AND type='object_corrected'
                        AND actor_kind='agent' AND actor_id=${scribe.userId}`
            )[0]?.n ?? 0,
          ),
        ).toBe(0);
        const afterRefusal = await claimState();
        expect(afterRefusal?.verification).toBe('unverified');
        expect(afterRefusal?.touched).toBeNull();

        // ── CLAUSE: a DISINTERESTED human certifies the `~` claim (✓) ───────────
        // Ada is neither the claim's claimant nor the author of its source message
        // (the agent is) — #102's disinterested second pair of eyes. On the live
        // route her receipt offers certify (not the refusal the source-author would
        // see; that refusal is proven at the human level in `certify-reading.spec`).
        await openReadingReceipt(ada, claimReading.id);
        const receipt = ada.locator(`[data-receipt-id="${claimReading.id}"]`);
        await expect(receipt.locator('[data-certify="refused"]')).toHaveCount(0);
        await expect(receipt.locator('[data-certify="ready"]')).toBeVisible();

        // ── CLAUSE: the provenance jump lands on the exact source message ───────
        // Taken on the open receipt, before certifying: the receipt cites the agent's
        // own claim message, and the jump scrolls to and focuses that exact row.
        const jump = receipt.locator(`button[data-jumps-to="${claimSourceId}"]`);
        await expect(jump).toBeVisible();
        await jump.click();
        const landedRow = ada.locator(`[data-message-id="${claimSourceId}"]`);
        await expect(landedRow).toBeVisible();
        await expect(landedRow).toBeFocused();
        await expect(landedRow).toContainText(claimBody);

        // Re-open the receipt (the jump moved focus) and certify: the two-stage vouch
        // #110 wires — the trigger arms a confirm, the confirm commits the `~`→`✓`.
        await openReadingReceipt(ada, claimReading.id);
        await receipt.locator('[data-certify="ready"]').click();
        await receipt.locator('[data-confirm-certify="true"]').click();
        // the covenant made tangible: a person put their name on the sentence, so the
        // claim is now `✓ verified` and a human has touched it.
        await eventually(
          async () => (await claimState())?.verification ?? '',
          (verification) => verification === 'verified',
          'the certified claim to reach `✓ verified`',
        );
        const afterCertify = await claimState();
        expect(afterCertify?.touched).not.toBeNull();
        // clause 3: the certifying event itself was AUTHORED by the disinterested human.
        // The `~`→`✓` came from a `object_corrected {verification: verified}` whose actor
        // is Ada — a human, and specifically her — not the agent, not the claimant.
        const certifier = (
          await sql<{ actorKind: string; actorId: string | null }[]>`
            SELECT actor_kind::text AS "actorKind", actor_id AS "actorId"
            FROM core_events
            WHERE room_id=${roomId}::uuid AND type='object_corrected'
              AND payload->>'objectId'=${claimReading.id}
              AND payload->'patch'->>'verification'='verified'
            ORDER BY room_seq DESC LIMIT 1
          `
        )[0];
        expect(certifier?.actorKind, 'the certifying act must be by a human').toBe('human');
        expect(certifier?.actorId, 'the certifier of record must be Ada').toBe(adaId);

        // ── CLAUSE: a human rejects (removes) the `~` open_question ─────────────
        // An open_question is not "certified"; the scenario rejects it, and removal
        // is that act — #110's remove affordance retracts the `~` reading (withdrawn
        // from current state, kept on the append-only record).
        await openReadingReceipt(ada, questionReading.id);
        const questionReceipt = ada.locator(`[data-receipt-id="${questionReading.id}"]`);
        await questionReceipt.locator('[data-remove="ready"]').click();
        await questionReceipt.locator('[data-confirm-remove="true"]').click();
        await eventually(
          async () =>
            (
              await sql<{ retracted: string | null }[]>`
                SELECT retracted_at::text AS retracted
                FROM accepted_objects WHERE id=${questionReading.id}::uuid
              `
            )[0]?.retracted ?? null,
          (retracted) => retracted !== null,
          'the removed open_question to be retracted',
        );
        await expect(ada.locator(`[data-object-id="${questionReading.id}"]`)).toHaveCount(0);

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
        // clause 5: the attention comes FROM the reference, not a coincidence of two
        // independent rows. Its `subject_id` IS the message that carries the human
        // reference to Ben — join them and require exactly one. A body-parse mention, or
        // an attention keyed to some other message, drops this to zero.
        const mentionFromReference = Number(
          (
            await sql`
              SELECT count(*)::int AS n
              FROM attention_items a
              JOIN message_references r ON r.message_id = a.subject_id AND r.room_id = a.room_id
              WHERE a.room_id=${roomId}::uuid AND a.user_id=${benId}::uuid
                AND a.subject_kind='message' AND a.reason->>'kind'='mention'
                AND r.kind='human' AND r.target_id=${benId}::uuid
            `
          )[0]?.n ?? 0,
        );
        expect(
          mentionFromReference,
          "Ben's mention attention must be keyed to the reference's own message",
        ).toBe(1);
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
        // The KNOWN head after Ben's absence: the last room event before he returns. The
        // whole window he missed sits between his `boundaryHead` seen-cursor and this.
        // Replay-to-live has to carry BOTH cursors to THIS head — not merely past zero.
        const knownHead = Number(
          (
            await sql<{ h: number }[]>`
              SELECT COALESCE(max(room_seq), 0)::int AS h FROM core_events WHERE room_id=${roomId}::uuid
            `
          )[0]?.h ?? 0,
        );
        expect(
          knownHead,
          'the absence must have advanced the head past where Ben last saw',
        ).toBeGreaterThan(boundaryHead);
        // The exact ids on the two sides of the boundary: the last message Ben SAW before
        // leaving (Ada's opener, at/under `boundaryHead`) and the first he MISSED (the
        // Scribe answer, the first event after it).
        const openMsgId = await messageIdFor(roomId, `dest-${runId}-open`, adaId);
        if (!openMsgId || !scribeAnswerId)
          throw new Error('the boundary message ids did not resolve');

        await ben.goto(`/app/${workspace.slug}/general`);
        await expect(ben.locator('[data-frame="live"]')).toBeVisible();
        await expect(benDivider).toBeVisible();
        await expect(benDivider).toContainText('messages');
        // clause 1a: the divider sits at the GENUINE since-you-left boundary — the last
        // message Ben saw is ABOVE it and the first he missed is BELOW it. `toBeVisible`
        // alone passes on a divider stranded anywhere in the feed; this fails unless it
        // divides exactly the seen window from the unseen one.
        const lastSeenRow = ben.locator(
          `[data-region="conversation"] [data-message-id="${openMsgId}"]`,
        );
        const firstMissedRow = ben.locator(
          `[data-region="conversation"] [data-message-id="${scribeAnswerId}"]`,
        );
        await expect(lastSeenRow).toBeVisible({ timeout: 30_000 });
        await expect(firstMissedRow).toBeVisible({ timeout: 30_000 });
        const boundaryOrder = await ben.locator('[data-region="conversation"]').evaluate(
          (region, ids) => {
            const divider = region.querySelector('[data-row="since-you-left"]');
            const lastSeen = region.querySelector(`[data-message-id="${ids.lastSeen}"]`);
            const firstMissed = region.querySelector(`[data-message-id="${ids.firstMissed}"]`);
            if (!divider || !lastSeen || !firstMissed) return null;
            const precedes = (a: Element, b: Element) =>
              (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
            return {
              lastSeenAbove: precedes(lastSeen, divider),
              missedBelow: precedes(divider, firstMissed),
            };
          },
          { lastSeen: openMsgId, firstMissed: scribeAnswerId },
        );
        expect(
          boundaryOrder,
          'the since-you-left divider must sit between the last-seen and first-missed message',
        ).toEqual({ lastSeenAbove: true, missedBelow: true });

        const seenControl = benDivider.getByRole('button', { name: 'mark this group seen' });
        if ((await seenControl.count()) > 0) await seenControl.click();

        // clause 1b: replay-to-live is proven by BOTH cursors reaching the KNOWN head, not
        // by `data-persisted-through > 0` — which is true from the initial SSR head even if
        // WS catch-up never runs. The persisted cursor (server-component projection) AND the
        // live cursor (the durable WS client's `lastSeq`) must both catch the post-absence
        // head; a broken catch-up strands `data-live-through` below it.
        const benSurface = ben.locator('main[data-room-id]');
        await expect
          .poll(async () => Number(await benSurface.getAttribute('data-persisted-through')), {
            message: 'the persisted projection to catch up to the known post-absence head',
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(knownHead);
        await expect
          .poll(async () => Number(await benSurface.getAttribute('data-live-through')), {
            message: 'the live WS cursor to catch up to the known post-absence head',
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(knownHead);

        // follow: a new message from another participant scrolls into view at the live
        // edge, and the follow survives the composer reshaping under a long multi-line draft.
        // The echo agent posts it — a participant whose own socket is still live (Ada's
        // in-page scenario socket was torn down by the receipt reloads above, and Ada is
        // the one who was just acting through the real UI anyway; the follow clause is
        // about Ben's feed, and any participant but Ben is a valid live-edge sender).
        const benFeed = ben.locator('[data-region="conversation"]');
        const benComposer = ben.getByRole('combobox', { name: 'Message #general' });
        await benComposer.fill(
          [
            `Run ${runId}: drafting a long reply`,
            ...Array.from({ length: 14 }, (_, i) => `line ${i + 1}`),
          ].join('\n'),
        );
        // Where the feed sits BEFORE the new message exists — and proof it is genuinely
        // scrollable. A feed that cannot scroll (`maxScroll <= 0`) satisfies any
        // scroll-distance tolerance without ever moving, which is the exact hollowness a
        // bare distance check hides.
        const beforeFollow = await benFeed.evaluate((element) => ({
          scrollTop: element.scrollTop,
          maxScroll: element.scrollHeight - element.clientHeight,
        }));
        expect(
          beforeFollow.maxScroll,
          'the returning feed must be scrollable for "follow the live edge" to mean anything',
        ).toBeGreaterThan(0);

        const followMarker = `Run ${runId}: live edge follow ${Date.now()}`;
        await scenarioCommand(echoSeat.page, {
          name: 'send_message',
          roomId,
          body: followMarker,
          clientMessageId: `dest-${runId}-follow`,
        });
        const appended = benFeed.locator('[data-message-id]').filter({ hasText: followMarker });
        await expect(appended).toBeVisible({ timeout: 20_000 });
        // clause 1c: the feed ACTUALLY MOVED to the live edge on the new message. Poll
        // returns both the pin distance AND the feed's new geometry; a scroll-distance
        // identity that holds on an unmoved feed cannot satisfy all three assertions.
        let followState = {
          distance: Number.POSITIVE_INFINITY,
          scrollTop: beforeFollow.scrollTop,
          target: 0,
        };
        await expect
          .poll(
            async () => {
              followState = await benFeed.evaluate((element, text) => {
                const row = [...element.querySelectorAll('[data-message-id]')].find((child) =>
                  child.textContent?.includes(text),
                );
                if (!(row instanceof HTMLElement))
                  return {
                    distance: Number.POSITIVE_INFINITY,
                    scrollTop: element.scrollTop,
                    target: 0,
                  };
                const target = Math.min(
                  element.scrollHeight - element.clientHeight,
                  Math.max(0, row.offsetTop),
                );
                return {
                  distance: Math.abs(element.scrollTop - target),
                  scrollTop: element.scrollTop,
                  target,
                };
              }, followMarker);
              return followState.distance;
            },
            {
              message: 'the feed to follow the live edge through the composer reshape',
              timeout: 20_000,
            },
          )
          .toBeLessThanOrEqual(4);
        // The new message's live edge is genuinely BELOW where the feed sat before it
        // arrived, and the feed travelled there — so this cannot pass on a feed that never
        // moved (target === old scrollTop) or a degenerate zero-scroll feed.
        expect(
          followState.target,
          'the new message must define a live edge past where the feed already was',
        ).toBeGreaterThan(beforeFollow.scrollTop);
        expect(
          followState.scrollTop,
          'the feed must have scrolled down to reach the new live edge',
        ).toBeGreaterThan(beforeFollow.scrollTop);
      } finally {
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        // Teardown: the workspace cascade takes the room, memberships, messages and
        // workspace_members; the four identities are deleted by hand.
        await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
        await db.delete(users).where(inArray(users.id, [adaId, benId, scribe.userId, echo.userId]));
      }
    });
  });
