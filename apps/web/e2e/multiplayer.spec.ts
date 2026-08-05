import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl, serverPort } from './support/config.mjs';
import {
  createWorkspace,
  invite,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';
import { multiplayerManifest, type ScenarioMessage } from './support/multiplayer-manifest';

const socketUrl = `ws://localhost:${serverPort}/ws`;

async function openScenarioSocket(page: Page, roomId: string): Promise<void> {
  await page.evaluate(
    ({ roomId, socketUrl }) =>
      new Promise<void>((resolve, reject) => {
        const holder = window as unknown as {
          __atriumScenario?: { socket: WebSocket; roomId: string; serial: number };
        };
        const socket = new WebSocket(socketUrl);
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
    { roomId, socketUrl },
  );
}

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

async function sendManifestMessage(page: Page, roomId: string, message: ScenarioMessage) {
  return scenarioCommand(page, {
    name: 'send_message',
    roomId,
    body: message.body,
    clientMessageId: message.clientMessageId,
  });
}

async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
) {
  await expect
    .poll(async () => accepts(await read()), { timeout: 30_000, message: label })
    .toBe(true);
}

async function actOnAttention(page: Page, attentionId: string, action: string): Promise<void> {
  const pin = page.getByRole('region', { name: 'Needs you' });
  const visited = new Set<string>();
  for (;;) {
    const item = pin.locator(`[data-attention-id="${attentionId}"]`);
    if ((await item.count()) > 0) {
      let control = item.getByRole('button', { name: action, exact: true });
      if ((await control.count()) === 0) {
        await item.locator('button[data-truncates="control"]').first().click();
        control = pin
          .locator(`[data-attention-id="${attentionId}"]`)
          .getByRole('button', { name: action, exact: true });
      }
      if (action === 'dismiss') {
        await expect(item).not.toContainText('semantic record is unavailable');
        await expect(item.getByRole('button', { name: 'open source', exact: true })).toBeVisible();
      }
      await expect(control).toBeVisible();
      if ((await control.getAttribute('data-hold')) !== null) {
        await control.hover();
        await page.mouse.down();
        await page.waitForTimeout(2_100);
        await page.mouse.up();
      } else {
        await control.click();
      }
      return;
    }
    const next = pin.locator('[data-pin-overflow]');
    if ((await next.count()) === 0) break;
    const pageNumber = await next.getAttribute('data-pin-page');
    if (pageNumber === null || visited.has(pageNumber)) break;
    visited.add(pageNumber);
    await next.click();
  }
  throw new Error(`attention item ${attentionId} is not reachable through the live pin`);
}

test.describe
  .serial('Phase 2 multiplayer acceptance', () => {
    requireBrowser();

    /**
     * Mutation: replace five independent cookie jars with pages in one context;
     * let the absence cursor float to the new head; count acknowledgements rather
     * than persisted messages; reconnect through the test socket instead of the
     * production client; or omit any required semantic action. The manifest/DB,
     * frozen-divider and rendered catch-up assertions below fail independently.
     */
    test('five participants preserve a 200-message room through absence and reconnect', async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
      const contexts = await Promise.all(
        Array.from({ length: 5 }, () => newCallerContext(browser)),
      );
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const emails = Array.from({ length: 5 }, (_, index) => uniqueEmail(`multi-${index}`));
      const names = ['Aster', 'Birch', 'Cedar', 'Dahlia', 'Elm'];
      /* STILL RED, and now on ONE precise assertion rather than a 240s timeout.
         The mention attention row is projected — it was missing entirely before
         — but the query below reads its `statement` as null where this expects
         the sent body. The row is `subjectKind: 'proposal'`,
         `proposalStatus: 'accepted'`, and the COALESCE covers
         `statement`/`question`/`title` on both the proposal and the accepted
         object; `open_question` payloads use `question`
         (packages/core/src/semantic-command.ts:48), so one of those two things
         is not what it appears. NOT resolved: whether the projection should
         carry a statement for a mention row at all is a product question about
         what the pin can show, and it is not answerable from this spec alone.
         What the row's statement SHOULD be is the ground truth still missing.

         THE BODY A MENTIONED MESSAGE IS ACTUALLY SENT WITH.
         The mention has to be IN the text. `reconcileMessageReferences` drops
         any reference whose span an edit touches, which is correct and
         deliberate: a structured mention whose text the author removed is a
         claim about a message that does not mention them. This scenario used to
         pick a mention and then `fill(message.body)` over the top of it, which
         deleted the `@Name ` and took the certified user id with it — so no
         `mention` attention row was projected and the equality below came up
         exactly one item short. Written against the pre-typed-references
         composer, where a mention rode beside the draft rather than in it.
         Appending leaves the reference's span untouched, so it survives to the
         fold. One expression, used by the send, by the expected attention set,
         and by the persisted-body check, so the three cannot drift. */
      const sentBody = (message: ScenarioMessage) =>
        message.mention === null ? message.body : `${message.body} @${names[message.mention]} `;
      const runId = randomUUID().slice(0, 8);

      try {
        await signUpAndVerify(pages[0] as Page, {
          email: emails[0] as string,
          name: names[0] as string,
        });
        const workspace = await createWorkspace(pages[0] as Page, `Multiplayer ${runId}`);
        const invitations: string[] = [];
        for (let index = 1; index < 5; index += 1) {
          invitations.push(
            await invite(pages[0] as Page, {
              slug: workspace,
              email: emails[index] as string,
              role: 'member',
            }),
          );
        }
        for (let index = 1; index < 5; index += 1) {
          const page = pages[index] as Page;
          await signUpAndVerify(page, {
            email: emails[index] as string,
            name: names[index] as string,
          });
          await page.goto(invitations[index - 1] as string);
          await page.getByTestId('accept-invitation').click();
          await page.waitForURL('**/app');
        }

        // Install before the designated participant enters the room. It tracks
        // that context's real sockets and can hold reconnect attempts closed for
        // one deterministic interval; no production client method is replaced.
        await contexts[3]?.addInitScript(() => {
          const holder = window as unknown as {
            __atriumDisconnect?: { blocked: boolean; sockets: WebSocket[] };
          };
          const NativeWebSocket = window.WebSocket;
          const control = { blocked: false, sockets: [] as WebSocket[] };
          holder.__atriumDisconnect = control;
          window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols ?? []);
              control.sockets.push(this);
              this.addEventListener('open', () => {
                if (control.blocked) this.close(4001, 'scripted reconnect interval');
              });
            }
          };
        });

        await Promise.all(pages.map((page) => page.goto(`/app/${workspace}/general`)));
        for (const page of pages) {
          await expect(page.locator('[data-frame="live"]')).toBeVisible();
          await expect(page.locator('[data-presence="here"]')).toHaveCount(5);
        }
        const roomId = await (pages[0] as Page)
          .locator('main[data-room-id]')
          .getAttribute('data-room-id');
        if (!roomId) throw new Error('live route did not expose its room id');
        const userRows = await sql<{ id: string; email: string }[]>`
        SELECT id::text, email FROM users WHERE email IN ${sql(emails)}
      `;
        const byEmail = new Map(userRows.map((row) => [row.email, row.id]));
        const userIds = emails.map((email) => byEmail.get(email));
        if (userIds.some((id) => !id)) throw new Error('not every scenario account reached users');
        const users = userIds as [string, string, string, string, string];
        const manifest = multiplayerManifest(runId, users);

        await Promise.all(pages.map((page) => openScenarioSocket(page, roomId)));
        for (const message of manifest.messages.slice(0, 40)) {
          await sendManifestMessage(pages[message.author] as Page, roomId, message);
        }
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM interpretations i JOIN messages m ON m.id=i.message_id WHERE m.room_id=${roomId}::uuid AND i.status='succeeded'`
              )[0]?.n ?? 0,
            ),
          (count) => count === 40,
          'the first forty messages to traverse the worker',
        );

        const absentee = pages[manifest.absentee] as Page;
        await absentee.reload();
        const firstDivider = absentee.locator('[data-row="since-you-left"]');
        // Eight of the first forty are Elm's own rows. The divider never tells
        // somebody their own activity is unseen, so the truthful count is 32.
        await expect(firstDivider).toContainText('32 messages');
        await firstDivider.getByRole('button', { name: 'mark this group seen' }).click();
        await eventually(
          async () =>
            Number(
              (
                await sql<{ seen: number }[]>`
                  SELECT seen_seq::int AS seen FROM memberships
                  WHERE room_id=${roomId}::uuid AND user_id=${users[manifest.absentee]}::uuid
                `
              )[0]?.seen ?? 0,
            ),
          (seen) => seen > 0,
          'mark-seen to reach the durable membership cursor',
        );
        await absentee.goto('/app');

        for (const message of manifest.messages.slice(40, 160)) {
          if (message.mention !== null) {
            const sender = pages[message.author] as Page;
            const composer = sender.getByRole('combobox', { name: 'Message #general' });
            /* THE CONTROL'S REAL NAME, AND THE REAL ROLE OF WHAT IT OPENS.
               This asked for `getByLabel('Mention a person or agent')` and then
               for a `button` named `@name`. Neither has ever existed in this
               tree: the composer's control is labelled "Reference a person or
               room item", and the targets it opens carry `role="option"` in a
               listbox, not `role=button`. So this waited the full 240s test
               budget on a locator that could not resolve, and the failure was
               filed as flaky-under-load. It is not load — it fails identically
               in isolation at two workers, because the name is simply wrong.
               `auth.spec.ts` drives the same control correctly and is the
               reference for both of these.

               WHAT THE OLD ONE CAUGHT, in principle: a mention inserted by
               clicking rather than typing failing to reach the draft.
               WHAT THIS ONE CATCHES: the same thing, now that it can reach the
               control at all. The assertion below is untouched — the draft still
               has to end up exactly `@name `. */
            /* BODY FIRST, MENTION LAST — the order matters twice over.
               Picking the mention first and then filling the body over it
               deletes the reference (see `sentBody`). Filling `@Name ` + body
               keeps the reference but moves the mention to the FRONT of the
               text, and the semantic fixtures are classified from the body:
               prefixing seq 75 stopped "Open question:" leading its own
               sentence and the run failed on "all eight semantic fixtures to
               become proposals" instead. Typing the body and then inserting the
               mention at the caret leaves both intact — the sentence still
               opens the way the classifier reads, and the reference's span is
               at the end where no later edit touches it. */
            await composer.fill(message.body);
            await sender.getByLabel('Reference a person or room item').click();
            await sender
              .getByRole('option', { name: `@${names[message.mention]}`, exact: true })
              .click();
            await expect(composer).toHaveValue(sentBody(message));
            await sender.getByRole('button', { name: 'Send' }).click();
          } else if (message.attachment) {
            const sender = pages[message.author] as Page;
            await sender.getByLabel('Choose an attachment').setInputFiles({
              name: `trace-${runId}.txt`,
              mimeType: 'text/plain',
              buffer: Buffer.from(`trace ${runId}\n`, 'utf8'),
            });
            await expect(sender.locator('[data-attachment-note="true"]')).toContainText('attached');
            await sender.getByRole('combobox', { name: 'Message #general' }).fill(message.body);
            await sender.getByRole('button', { name: 'Send' }).click();
          } else {
            await sendManifestMessage(pages[message.author] as Page, roomId, message);
          }
          if (message.seq === 60) {
            /**
             * Mutation: let receipt-write latency choose whether the mentioned
             * question is the last line in its worker window. Its correction
             * scan then alternates between staged and accepted without any room
             * fact changing. Drain through the preceding decision first; the
             * next coalesced pass receives the question with its authored tail.
             */
            await eventually(
              async () =>
                Number(
                  (
                    await sql`
                      SELECT count(*)::int AS n
                      FROM interpretations i JOIN messages m ON m.id=i.message_id
                      WHERE m.room_id=${roomId}::uuid AND i.status='succeeded'
                    `
                  )[0]?.n ?? 0,
                ),
              (count) => count === 60,
              'the preceding semantic window to finish before the mentioned question burst',
            );
          }
        }
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM interpretations i JOIN messages m ON m.id=i.message_id WHERE m.room_id=${roomId}::uuid AND i.status='succeeded'`
              )[0]?.n ?? 0,
            ),
          (count) => count === 160,
          'all absent-window messages to traverse the worker',
        );
        await eventually(
          async () =>
            Number(
              (await sql`SELECT count(*)::int AS n FROM proposals WHERE room_id=${roomId}::uuid`)[0]
                ?.n ?? 0,
            ),
          (count) => count === 8,
          'all eight semantic fixtures to become proposals',
        );

        await absentee.goto(`/app/${workspace}/general`);
        await expect(absentee.locator('[data-row="since-you-left"]')).toContainText('120 messages');
        for (const [kind, count] of [
          ['need', 0],
          ['change', 0],
          ['discussion', 120],
          ['routine', 0],
        ] as const) {
          await expect(
            absentee.locator(`[data-row="since-you-left"] [data-count-class="${kind}"]`),
          ).toContainText(`${count}`);
        }
        const absenteeAttention = absentee.getByRole('region', { name: 'Needs you' });
        const pendingAttention = await sql<
          {
            id: string;
            subjectKind: string;
            proposalId: string | null;
            proposalStatus: string | null;
            reasonKind: string;
            statement: string | null;
          }[]
        >`
          SELECT a.id::text, a.subject_kind AS "subjectKind", p.id::text AS "proposalId",
                 p.status::text AS "proposalStatus", a.reason->>'kind' AS "reasonKind",
                 COALESCE(p.payload->>'statement', p.payload->>'question', p.payload->>'title',
                          o.payload->>'statement', o.payload->>'question', o.payload->>'title')
                   AS statement
          FROM attention_items a
          LEFT JOIN proposals p ON p.room_id=a.room_id AND p.id=a.subject_id
          LEFT JOIN accepted_objects o ON o.room_id=a.room_id AND o.id=a.subject_id
          WHERE a.room_id=${roomId}::uuid AND a.user_id=${users[4]}::uuid
            AND a.status='pending'
          ORDER BY a.id
        `;
        /**
         * Mutation: project one expected commitment card but retain an extra
         * pending card for the returning member. A positive lookup still passes;
         * equality against the complete persisted and rendered set does not.
         */
        const expectedAttention = manifest.messages
          .filter(
            (message) =>
              message.semantic === 'commitment' ||
              message.semantic === 'decision' ||
              message.semantic === 'objective',
          )
          .map((message) => ({
            reasonKind:
              message.semantic === 'commitment'
                ? 'commitment_confirm'
                : message.semantic === 'decision'
                  ? 'decision_pending'
                  : 'reading_pending',
            statement: message.body,
          }))
          .concat(
            manifest.messages
              .filter((message) => message.mention === manifest.absentee)
              .map((message) => ({ reasonKind: 'mention', statement: sentBody(message) })),
          )
          .sort((left, right) => left.statement.localeCompare(right.statement));
        expect(
          pendingAttention
            .map(({ reasonKind, statement }) => ({ reasonKind, statement }))
            .sort((left, right) => (left.statement ?? '').localeCompare(right.statement ?? '')),
        ).toEqual(expectedAttention);
        const commitmentAttention = pendingAttention.find(
          (item) => item.reasonKind === 'commitment_confirm',
        );
        expect(commitmentAttention).toMatchObject({
          subjectKind: 'proposal',
          proposalStatus: 'proposed',
          reasonKind: 'commitment_confirm',
        });
        if (!commitmentAttention?.id || !commitmentAttention.proposalId) {
          throw new Error('the owner commitment attention has no proposal subject');
        }
        const renderedAttentionIds = new Set<string>();
        let renderedCommitment = false;
        const visitedPages = new Set<string>();
        for (;;) {
          const visibleCards = absenteeAttention.locator('[data-attention-id]');
          for (const id of await visibleCards.evaluateAll((cards) =>
            cards.map((card) => card.getAttribute('data-attention-id')),
          )) {
            if (id !== null) renderedAttentionIds.add(id);
          }
          const commitmentCard = absentee.locator(
            `[data-attention-id="${commitmentAttention.id}"]`,
          );
          if ((await commitmentCard.count()) > 0) {
            await expect(commitmentCard).toContainText(
              `Commitment for ${users[4]}: Run ${runId} review the reconnect trace.`,
            );
            renderedCommitment = true;
          }

          const next = absenteeAttention.locator('[data-pin-overflow]');
          if ((await next.count()) === 0) break;
          const page = await next.getAttribute('data-pin-page');
          if (page === null || visitedPages.has(page)) break;
          visitedPages.add(page);
          await next.click();
        }
        expect(renderedCommitment).toBe(true);
        expect([...renderedAttentionIds].sort()).toEqual(
          pendingAttention.map((item) => item.id).sort(),
        );
        const mentionAttention = pendingAttention.find((item) => item.reasonKind === 'mention');
        expect(mentionAttention).toMatchObject({
          subjectKind: 'proposal',
          proposalStatus: 'accepted',
          reasonKind: 'mention',
        });
        if (!mentionAttention?.id) throw new Error('the structured mention has no attention row');
        await actOnAttention(absentee, mentionAttention.id, 'dismiss');
        await eventually(
          async () =>
            String(
              (
                await sql`SELECT status::text FROM attention_items WHERE id=${mentionAttention.id}::uuid`
              )[0]?.status ?? '',
            ),
          (status) => status === 'dismissed',
          'one-click mention dismissal to reach the persisted attention fold',
        );
        await openScenarioSocket(absentee, roomId);

        const pending = await sql<{ id: string; type: string; statement: string }[]>`
        SELECT id::text, type::text,
          COALESCE(payload->>'statement', payload->>'question', payload->>'title') AS statement
        FROM proposals WHERE room_id=${roomId}::uuid AND status='proposed' ORDER BY created_at
      `;
        const objectiveProposals = pending.filter((proposal) => proposal.type === 'objective');
        expect(objectiveProposals).toHaveLength(2);
        for (const proposal of objectiveProposals) {
          const actor = pages[0] as Page;
          const [attention] = await sql<{ id: string }[]>`
            SELECT id::text FROM attention_items
            WHERE room_id=${roomId}::uuid AND subject_id=${proposal.id}::uuid
              AND user_id=${users[0]}::uuid AND status='pending'
          `;
          if (!attention) throw new Error(`objective ${proposal.id} has no live attention route`);
          await actOnAttention(actor, attention.id, 'answer');
          await eventually(
            async () =>
              String(
                (
                  await sql`SELECT status::text FROM proposals WHERE room_id=${roomId}::uuid AND id=${proposal.id}::uuid`
                )[0]?.status ?? '',
              ),
            (status) => status === 'accepted',
            `objective ${proposal.id} to be accepted through the live receipt`,
          );
        }
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM accepted_objects WHERE room_id=${roomId}::uuid AND type='objective'`
              )[0]?.n ?? 0,
            ),
          (count) => count === 2,
          'both objectives to reach the accepted fold before their children',
        );
        const acceptedObjectives = await sql<{ id: string; statement: string }[]>`
          SELECT id::text,
            COALESCE(payload->>'statement', payload->>'question', payload->>'title') AS statement
          FROM accepted_objects
          WHERE room_id=${roomId}::uuid AND type='objective'
        `;
        const objectiveMessages = manifest.messages.filter(
          (message) => message.semantic === 'objective',
        );
        const objectiveIds = objectiveMessages.map(
          (message) => acceptedObjectives.find((object) => object.statement === message.body)?.id,
        );
        if (objectiveIds.some((id) => !id)) {
          throw new Error('both authored objectives did not reach the accepted fold');
        }
        for (const proposal of pending.filter((candidate) => candidate.type !== 'objective')) {
          const fixture = manifest.messages.find((message) => message.body === proposal.statement);
          if (!fixture)
            throw new Error(
              `semantic fixture has no objective ground truth: ${proposal.statement}`,
            );
          const actor = proposal.type === 'commitment' ? absentee : (pages[0] as Page);
          const expectedObjectiveId =
            fixture.objective === null ? null : (objectiveIds[fixture.objective] as string);
          const actorId = proposal.type === 'commitment' ? users[manifest.absentee] : users[0];
          const [attention] = await sql<{ id: string }[]>`
            SELECT id::text FROM attention_items
            WHERE room_id=${roomId}::uuid AND subject_id=${proposal.id}::uuid
              AND user_id=${actorId}::uuid AND status='pending'
          `;
          if (!attention)
            throw new Error(`${proposal.type} ${proposal.id} has no live attention route`);
          await actOnAttention(
            actor,
            attention.id,
            proposal.type === 'commitment' ? 'confirm' : 'answer',
          );
          const receipt = actor.locator(`[data-receipt-id="${proposal.id}"]`);
          await expect(receipt).toBeVisible();
          if (expectedObjectiveId !== null) {
            await receipt
              .getByRole('combobox', { name: 'File accepted reading under' })
              .selectOption(expectedObjectiveId);
          }
          await receipt.getByRole('button', { name: 'Accept reading' }).click();
          await eventually(
            async () =>
              (
                await sql<{ objectiveId: string | null }[]>`
                  SELECT objective_id::text AS "objectiveId"
                  FROM accepted_objects
                  WHERE room_id=${roomId}::uuid AND proposal_id=${proposal.id}::uuid
                `
              )[0]?.objectiveId,
            (objectiveId) => objectiveId === expectedObjectiveId,
            `${proposal.type} acceptance to retain objective ${expectedObjectiveId ?? 'null'}`,
          );
        }
        await eventually(
          async () =>
            Number(
              (
                await sql`SELECT count(*)::int AS n FROM accepted_objects WHERE room_id=${roomId}::uuid`
              )[0]?.n ?? 0,
            ),
          (count) => count === 8,
          'all semantic fixtures to reach the accepted fold',
        );

        const mentionedFixture = manifest.messages[74];
        if (!mentionedFixture) throw new Error('structured mention fixture is missing');
        const [mentionedMessage] = await sql<{ body: string; mentionUserIds: string[] }[]>`
          SELECT body, mention_user_ids::text[] AS "mentionUserIds"
          FROM messages
          WHERE room_id=${roomId}::uuid AND body=${sentBody(mentionedFixture)}
        `;
        expect(mentionedMessage).toEqual({
          body: sentBody(mentionedFixture),
          mentionUserIds: [users[manifest.absentee]],
        });

        const objects = await sql<
          { id: string; type: string; statement: string; objectiveId: string | null }[]
        >`
        SELECT id::text, type::text,
          COALESCE(payload->>'statement', payload->>'question', payload->>'title') AS statement,
          objective_id::text AS "objectiveId"
        FROM accepted_objects WHERE room_id=${roomId}::uuid ORDER BY created_at
      `;
        /**
         * Mutation: accept every child with objectiveId null or attach every
         * child to the first objective. The fold can still contain eight valid
         * objects, but it no longer exercises state across two objectives.
         */
        for (const object of objects.filter((candidate) => candidate.type !== 'objective')) {
          const fixture = manifest.messages.find((message) => message.body === object.statement);
          if (!fixture) {
            throw new Error(`accepted object has no objective ground truth: ${object.statement}`);
          }
          if (fixture.objective === null) {
            expect(
              object.objectiveId,
              `${object.type} ${JSON.stringify(object.statement)} was machine-accepted before a person could file it`,
            ).toBeNull();
            continue;
          }
          expect(
            object.objectiveId,
            `${object.type} ${JSON.stringify(object.statement)} must retain its selected objective`,
          ).toBe(objectiveIds[fixture.objective]);
        }
        expect(
          new Set(
            objects
              .filter((object) => object.objectiveId !== null)
              .map((object) => object.objectiveId),
          ),
        ).toEqual(new Set(objectiveIds));
        const firstDecision = objects.find((object) => object.statement.includes('durable cursor'));
        const claims = objects.filter((object) => object.type === 'claim');
        if (!firstDecision || claims.length !== 2)
          throw new Error('correction/supersession fixtures did not fold');
        await scenarioCommand(pages[0] as Page, {
          name: 'correct',
          roomId,
          objectId: firstDecision.id,
          action: 'retype',
          patch: { claimant: users[0] },
          toType: 'claim',
          provenance: { messageIds: [] },
          note: `Run ${runId} measured this as a claim, not a decision.`,
        });
        await scenarioCommand(pages[0] as Page, {
          name: 'supersede_object',
          roomId,
          replacementObjectId: (claims[1] as { id: string }).id,
          retiredObjectId: (claims[0] as { id: string }).id,
          clientSupersessionId: `${runId}-supersession`,
          note: `Run ${runId} second trace replaces the first.`,
        });

        for (const message of manifest.messages.slice(160, 170)) {
          await sendManifestMessage(pages[message.author] as Page, roomId, message);
        }
        const disconnectedPage = pages[manifest.disconnected] as Page;
        const disconnectedComposer = disconnectedPage.getByRole('combobox', {
          name: 'Message #general',
        });
        await disconnectedPage.evaluate(() => {
          const control = (
            window as unknown as {
              __atriumDisconnect?: { blocked: boolean; sockets: WebSocket[] };
            }
          ).__atriumDisconnect;
          if (!control) throw new Error('disconnect control was not installed');
          control.blocked = true;
          for (const socket of control.sockets) {
            if (socket.readyState === WebSocket.OPEN)
              socket.close(4001, 'scripted reconnect interval');
          }
        });
        await expect(disconnectedComposer).toBeDisabled({ timeout: 20_000 });
        let reconnectThrough = 0;
        for (const message of manifest.messages.slice(170, 180)) {
          reconnectThrough =
            (await sendManifestMessage(pages[message.author] as Page, roomId, message)) ??
            reconnectThrough;
        }
        await disconnectedPage.evaluate(() => {
          const control = (
            window as unknown as {
              __atriumDisconnect?: { blocked: boolean; sockets: WebSocket[] };
            }
          ).__atriumDisconnect;
          if (!control) throw new Error('disconnect control was not installed');
          control.blocked = false;
        });
        await expect(disconnectedComposer).toBeEnabled({ timeout: 20_000 });
        await openScenarioSocket(disconnectedPage, roomId);
        /**
         * Mutation: stop after the client's catch-up cursor advances, without
         * proving the authenticated Server Component projection committed the
         * reconnect interval's ledger prefix. The socket then looks healthy while its visible
         * transcript can remain ten messages behind.
         */
        await expect
          .poll(
            async () => {
              const surface = disconnectedPage.locator('main[data-room-id]');
              return {
                live: await surface.getAttribute('data-live-through'),
                persisted: await surface.getAttribute('data-persisted-through'),
              };
            },
            {
              message: 'server-rendered room cursor to catch the reconnected client cursor',
              timeout: 20_000,
            },
          )
          .toMatchObject({ live: expect.any(String), persisted: expect.any(String) });
        await expect
          .poll(
            async () => {
              const surface = disconnectedPage.locator('main[data-room-id]');
              return Number(await surface.getAttribute('data-persisted-through'));
            },
            {
              message: 'committed route cursor to include the reconnect interval',
              timeout: 20_000,
            },
          )
          .toBeGreaterThanOrEqual(reconnectThrough);
        const conversation = disconnectedPage.getByRole('region', { name: 'Conversation' });
        for (const message of manifest.messages.slice(170, 180)) {
          await expect(conversation.getByText(message.body, { exact: true })).toHaveCount(1);
        }
        let finalMessageThrough = reconnectThrough;
        for (const message of manifest.messages.slice(180)) {
          finalMessageThrough =
            (await sendManifestMessage(pages[message.author] as Page, roomId, message)) ??
            finalMessageThrough;
        }

        /**
         * Mutation: persist commands but stop or misorder production-client
         * event/catch-up application. The database can still hold the exact
         * transcript, but the always-connected client's cursor cannot cross the
         * final message event and its rendered 200-line receipt stays incomplete.
         */
        const connectedSurface = (pages[0] as Page).locator('main[data-room-id]');
        await expect
          .poll(() => connectedSurface.getAttribute('data-live-through').then(Number), {
            message: 'the always-connected production client to apply the final message event',
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(finalMessageThrough);
        await expect
          .poll(() => connectedSurface.getAttribute('data-persisted-through').then(Number), {
            message: 'the always-connected route to render through the final message event',
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(finalMessageThrough);
        const connectedConversation = (pages[0] as Page).getByRole('region', {
          name: 'Conversation',
        });
        for (const message of manifest.messages) {
          await expect(connectedConversation.getByText(message.body, { exact: true })).toHaveCount(
            1,
          );
        }

        const persisted = await sql<
          { id: string; body: string; authorId: string; attachments: unknown[] }[]
        >`
        SELECT id::text, body, author_id::text AS "authorId", attachments
        FROM messages WHERE room_id=${roomId}::uuid ORDER BY seq
      `;
        expect(persisted).toHaveLength(200);
        expect(persisted.map(({ body, authorId }) => ({ body, authorId }))).toEqual(
          manifest.messages.map((message) => ({
            body: message.body,
            authorId: users[message.author],
          })),
        );
        expect(persisted[144]?.attachments).toHaveLength(1);
        const foldReceipt = await sql<{ corrections: number; relations: number }[]>`
        SELECT
          (SELECT count(*)::int FROM corrections WHERE room_id=${roomId}::uuid) AS corrections,
          (SELECT count(*)::int FROM relations WHERE room_id=${roomId}::uuid AND kind='supersedes') AS relations
      `;
        expect(foldReceipt[0]).toEqual({ corrections: 1, relations: 1 });
      } finally {
        await Promise.all(contexts.map((context) => context.close().catch(() => {})));
        await sql.end({ timeout: 5 });
      }
    });
  });
