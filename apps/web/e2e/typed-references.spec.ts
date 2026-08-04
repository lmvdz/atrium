import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl } from './support/config.mjs';
import {
  createWorkspace,
  invite,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

test.describe('durable typed room references', () => {
  requireBrowser();

  /**
   * Mutations caught:
   * - replace the selected human id with a display-name lookup;
   * - omit authored UTF-16 spans/surface or rewrite the body after a rename;
   * - omit the normalized attachment row or bind its reference to the storage key;
   * - acknowledge a human reference without committing its durable attention row;
   * - publish references only on the sender socket, or drop them during catch-up;
   * - make the reference path depend on an interpretation result.
   *
   * The assertions judge the committed database rows and the other participant's
   * production UI. The command acknowledgement is deliberately not evidence.
   */
  test('human and attachment references survive rename, replay, and socket reconnect', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
    const ownerContext = await newCallerContext(browser);
    const readerContext = await newCallerContext(browser);
    const owner = await ownerContext.newPage();
    const reader = await readerContext.newPage();
    const run = randomUUID().slice(0, 8);
    const ownerEmail = uniqueEmail(`typed-owner-${run}`);
    const readerEmail = uniqueEmail(`typed-reader-${run}`);
    const originalName = `Reader ${run}`;
    const renamedName = `Renamed ${run}`;

    try {
      await signUpAndVerify(owner, { email: ownerEmail, name: `Owner ${run}` });
      const workspace = await createWorkspace(owner, `Typed references ${run}`);
      const invitation = await invite(owner, {
        slug: workspace,
        email: readerEmail,
        role: 'member',
      });
      await signUpAndVerify(reader, { email: readerEmail, name: originalName });
      await reader.goto(invitation);
      await reader.getByTestId('accept-invitation').click();
      await reader.waitForURL('**/app');

      // Track the real realtime client before the room mounts. Closing these
      // sockets below exercises its reconnect/catch-up path, not a test socket.
      await readerContext.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const sockets: WebSocket[] = [];
        (window as unknown as { __typedReferenceSockets?: WebSocket[] }).__typedReferenceSockets =
          sockets;
        window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols ?? []);
            sockets.push(this);
          }
        };
      });

      await Promise.all([
        owner.goto(`/app/${workspace}/general`),
        reader.goto(`/app/${workspace}/general`),
      ]);
      await expect(owner.locator('[data-frame="live"]')).toBeVisible();
      await expect(reader.locator('[data-frame="live"]')).toBeVisible();
      await expect(owner.locator('[data-presence="here"]')).toHaveCount(2);

      const roomId = await owner.locator('main[data-room-id]').getAttribute('data-room-id');
      if (!roomId) throw new Error('live route did not expose its room id');
      const [readerIdentity] = await sql<{ id: string }[]>`
        SELECT id::text FROM users WHERE email = ${readerEmail}
      `;
      if (!readerIdentity) throw new Error('invited reader did not reach users');
      const [ownerIdentity] = await sql<{ id: string }[]>`
        SELECT id::text FROM users WHERE email = ${ownerEmail}
      `;
      if (!ownerIdentity) throw new Error('owner did not reach users');

      // These are persisted semantic projection facts, not fixtures passed to
      // the component. This scenario is about addressing existing facts; their
      // creation and acceptance have their own command/ledger acceptance suite.
      const proposalId = randomUUID();
      const objectId = randomUUID();
      const proposalStatement = `Proposal ${run}`;
      const objectStatement = `Accepted object ${run}`;
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO proposals
            (id, room_id, type, payload, confidence, proposer_kind, proposer_user_id,
             staged_by_kind, staged_by_id, status)
          VALUES
            (${proposalId}::uuid, ${roomId}::uuid, 'decision',
             ${JSON.stringify({ statement: proposalStatement })}::jsonb,
             1, 'human', ${ownerIdentity.id}::uuid, 'human', ${ownerIdentity.id}, 'proposed')
        `;
        await tx`
          INSERT INTO accepted_objects
            (id, room_id, type, payload, revision, accepted_by)
          VALUES
            (${objectId}::uuid, ${roomId}::uuid, 'objective',
             ${JSON.stringify({ title: objectStatement, status: 'open' })}::jsonb,
             0, ${ownerIdentity.id}::uuid)
        `;
      });
      await owner.reload();
      await expect(owner.locator(`[data-objective-id="${objectId}"]`)).toContainText(
        objectStatement,
      );

      const composer = owner.getByRole('combobox', { name: /Message #/ });
      await composer.fill('@Read');
      const humanChoice = owner.locator(
        `[data-reference-kind="human"][data-reference-target="${readerIdentity.id}"]`,
      );
      await expect(humanChoice).toBeVisible();
      await humanChoice.click();
      await expect(composer).toHaveValue(`@${originalName} `);

      const imageName = `diagram-${run}.svg`;
      await owner.getByLabel('Choose an attachment').setInputFiles({
        name: imageName,
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#f60"/></svg>',
        ),
      });
      await expect(owner.locator('[data-attachment-note="true"]')).toContainText('attached');
      await expect(owner.locator('img[src^="blob:"]')).toBeVisible();

      await composer.fill(`@${originalName} and @diagram`);
      // Editing after selection retains the human reference because the edit is
      // wholly after its span. Selecting the uploaded file adds a second typed
      // reference whose target is its server-minted attachment id.
      const attachmentChoice = owner.locator('[data-reference-kind="attachment"]', {
        hasText: imageName,
      });
      await expect(attachmentChoice).toBeVisible();
      const attachmentId = await attachmentChoice.getAttribute('data-reference-target');
      if (!attachmentId) throw new Error('uploaded attachment target has no stable id');
      await attachmentChoice.click();
      const authored = `@${originalName} and @${imageName} `;
      await expect(composer).toHaveValue(authored);
      await composer.press('Enter');

      await expect
        .poll(
          async () => {
            const [row] = await sql<Array<{ referenceCount: number }>>`
              SELECT m.id::text,
                     count(DISTINCT mr.id)::int AS "referenceCount"
              FROM messages m
              LEFT JOIN message_references mr ON mr.message_id = m.id
              WHERE m.room_id = ${roomId}::uuid AND m.body = ${authored}
              GROUP BY m.id
            `;
            return row?.referenceCount ?? 0;
          },
          { message: 'the authored message, attachment, and references commit together' },
        )
        .toBe(2);
      const [message] = await sql<
        Array<{ id: string; body: string; attachmentIds: string[]; referenceCount: number }>
      >`
        SELECT m.id::text,
               m.body,
               coalesce(array_agg(DISTINCT a.id::text) FILTER (WHERE a.id IS NOT NULL), '{}') AS "attachmentIds",
               count(DISTINCT mr.id)::int AS "referenceCount"
        FROM messages m
        LEFT JOIN attachments a ON a.claimed_by_message_id = m.id
        LEFT JOIN message_references mr ON mr.message_id = m.id
        WHERE m.room_id = ${roomId}::uuid AND m.body = ${authored}
        GROUP BY m.id, m.body
      `;
      if (!message) throw new Error('committed typed-reference message disappeared');
      expect(message.body).toBe(authored);
      expect(message.attachmentIds).toEqual([attachmentId]);
      expect(message.referenceCount).toBe(2);

      const references = await sql<
        Array<{
          ordinal: number;
          kind: string;
          targetId: string;
          start: number;
          end: number;
          surface: string;
        }>
      >`
        SELECT ordinal, kind::text, target_id::text AS "targetId", start, "end", surface
        FROM message_references
        WHERE message_id = ${message.id}::uuid
        ORDER BY ordinal
      `;
      expect(references).toEqual([
        {
          ordinal: 0,
          kind: 'human',
          targetId: readerIdentity.id,
          start: 0,
          end: originalName.length + 1,
          surface: `@${originalName}`,
        },
        {
          ordinal: 1,
          kind: 'attachment',
          targetId: attachmentId,
          start: originalName.length + 6,
          end: authored.length - 1,
          surface: `@${imageName}`,
        },
      ]);

      const [attention] = await sql<Array<{ id: string; userId: string; subjectId: string }>>`
        SELECT id::text, user_id::text AS "userId", subject_id::text AS "subjectId"
        FROM attention_items
        WHERE room_id = ${roomId}::uuid
          AND user_id = ${readerIdentity.id}::uuid
          AND subject_kind = 'message'
          AND subject_id = ${message.id}::uuid
      `;
      expect(attention).toMatchObject({ userId: readerIdentity.id, subjectId: message.id });

      const readerRow = reader.locator(`[data-message-id="${message.id}"]`);
      await expect(readerRow).toBeVisible();
      await expect(readerRow.locator('[data-row-body]')).toHaveText(authored);
      await expect(
        readerRow.locator(
          `[data-reference-kind="human"][data-reference-target="${readerIdentity.id}"]`,
        ),
      ).toHaveText(`@${originalName}`);
      await expect(
        readerRow.locator(
          `[data-reference-kind="attachment"][data-reference-target="${attachmentId}"]`,
        ),
      ).toHaveText(`@${imageName}`);
      await expect(reader.locator(`[data-attention-id="${attention?.id}"]`)).toBeVisible();

      await sql`
        UPDATE users SET display_name = ${renamedName} WHERE id = ${readerIdentity.id}::uuid
      `;
      await reader.reload();
      const replayed = reader.locator(`[data-message-id="${message.id}"]`);
      await expect(replayed).toBeVisible();
      await expect(replayed.locator('[data-row-body]')).toHaveText(authored);
      await expect(
        replayed.locator(
          `[data-reference-kind="human"][data-reference-target="${readerIdentity.id}"]`,
        ),
      ).toHaveAttribute('title', new RegExp(renamedName));

      await reader.evaluate(() => {
        const sockets = (window as unknown as { __typedReferenceSockets?: WebSocket[] })
          .__typedReferenceSockets;
        for (const socket of sockets ?? []) socket.close(4001, 'typed-reference reconnect');
      });
      await expect
        .poll(
          () =>
            reader.evaluate(
              () =>
                (
                  window as unknown as { __typedReferenceSockets?: WebSocket[] }
                ).__typedReferenceSockets?.filter((socket) => socket.readyState === WebSocket.OPEN)
                  .length ?? 0,
            ),
          { message: 'the production realtime client reconnects' },
        )
        .toBeGreaterThan(0);
      await expect(reader.locator(`[data-message-id="${message.id}"] [data-row-body]`)).toHaveText(
        authored,
      );
      await expect(reader.locator(`[data-attention-id="${attention?.id}"]`)).toBeVisible();

      const semanticComposer = owner.getByRole('combobox', { name: /Message #/ });
      await semanticComposer.fill('@');
      const proposalChoice = owner.locator(
        `[data-reference-kind="proposal"][data-reference-target="${proposalId}"]`,
      );
      await expect(proposalChoice).toBeVisible();
      await proposalChoice.click();
      const afterProposal = await semanticComposer.inputValue();
      await semanticComposer.fill(`${afterProposal}and @${objectStatement.slice(0, 8)}`);
      const objectChoice = owner.locator(
        `[data-reference-kind="object"][data-reference-target="${objectId}"]`,
      );
      await expect(objectChoice).toBeVisible();
      await objectChoice.click();
      const semanticAuthored = await semanticComposer.inputValue();
      await semanticComposer.press('Enter');

      await expect
        .poll(async () => {
          const [row] = await sql<Array<{ kinds: string[] }>>`
            SELECT array_agg(mr.kind::text ORDER BY mr.ordinal) AS kinds
            FROM messages m
            JOIN message_references mr ON mr.message_id = m.id
            WHERE m.room_id = ${roomId}::uuid AND m.body = ${semanticAuthored}
            GROUP BY m.id
          `;
          return row?.kinds ?? [];
        })
        .toEqual(['proposal', 'object']);
      const semanticRow = reader.locator('[data-row="message"]', { hasText: semanticAuthored });
      await expect(semanticRow).toBeVisible();
      await expect(
        semanticRow.locator(
          `[data-reference-kind="proposal"][data-reference-target="${proposalId}"]`,
        ),
      ).toHaveCount(1);
      await expect(
        semanticRow.locator(`[data-reference-kind="object"][data-reference-target="${objectId}"]`),
      ).toHaveCount(1);
      await expect(reader.locator(`[data-objective-id="${objectId}"]`)).toContainText(
        objectStatement,
      );
    } finally {
      await Promise.all([ownerContext.close(), readerContext.close()]);
      await sql.end();
    }
  });
});
