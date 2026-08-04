import { expect, test, type WebSocketRoute } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl } from './support/config.mjs';
import {
  createWorkspace,
  newCallerContext,
  requireBrowser,
  signUpAndVerify,
  uniqueEmail,
} from './support/flows';

type Fault = 'before-server' | 'after-commit' | null;

function closeRoute(route: WebSocketRoute): void {
  void route.close({ code: 1011, reason: 'scripted uncertain commit interval' });
}

test.describe('outbound reconnect recovery', () => {
  requireBrowser();

  /**
   * Mutation: clear the optimistic row without exposing retry, mint a new
   * clientMessageId on retry, or let the server append the same retry key
   * twice. The first fault then loses the authored send or the second produces
   * duplicates. This drives both sides of the uncertain commit interval: a
   * frame dropped before the server receives it and a committed frame whose ack
   * never reaches the browser.
   */
  test('one exact message survives a socket drop on either side of commit', async ({ browser }) => {
    test.setTimeout(90_000);
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const context = await newCallerContext(browser);
    const page = await context.newPage();
    let nextFault: Fault = null;

    await page.routeWebSocket(/\/ws$/, (pageSocket) => {
      const serverSocket = pageSocket.connectToServer();
      let closeAfterAck: string | null = null;

      pageSocket.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type?: string;
          commandId?: string;
          command?: { name?: string; body?: string };
        };
        const target =
          frame.type === 'command' &&
          frame.command?.name === 'send_message' &&
          frame.command.body?.startsWith('uncertain e2e') === true;
        if (target && nextFault === 'before-server') {
          nextFault = null;
          closeRoute(pageSocket);
          closeRoute(serverSocket);
          return;
        }
        if (target && nextFault === 'after-commit') {
          closeAfterAck = frame.commandId ?? null;
        }
        serverSocket.send(message);
      });

      serverSocket.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { type?: string; commandId?: string };
        if (frame.type === 'ack' && frame.commandId === closeAfterAck) {
          closeAfterAck = null;
          nextFault = null;
          closeRoute(pageSocket);
          closeRoute(serverSocket);
          return;
        }
        pageSocket.send(message);
      });
    });

    try {
      await signUpAndVerify(page, {
        email: uniqueEmail('uncertain-send'),
        name: 'Retry Witness',
      });
      const workspace = await createWorkspace(page, `Uncertain ${Date.now()}`);
      await page.goto(`/app/${workspace}/general`);
      const composer = page.getByRole('textbox', { name: 'Message #general' });
      await expect(composer).toBeEnabled();
      const roomId = await page.locator('main[data-room-id]').getAttribute('data-room-id');
      if (!roomId) throw new Error('the live route did not expose its room id');

      const uncommitted = `uncertain e2e before commit ${Date.now()}`;
      nextFault = 'before-server';
      await composer.fill(uncommitted);
      await page.getByRole('button', { name: 'Send' }).click();
      const retry = page.getByRole('button', { name: 'retry exact send', exact: true });
      await expect(retry).toBeVisible();
      await expect(composer).toBeEnabled();
      await retry.click();
      await expect
        .poll(
          async () =>
            sql<{ count: number }[]>`
              SELECT count(*)::int AS count FROM messages
              WHERE room_id=${roomId}::uuid AND body=${uncommitted}
            `.then((rows) => rows[0]?.count ?? 0),
          { message: 'the retried uncommitted frame reaches one durable row' },
        )
        .toBe(1);
      await expect(retry).toHaveCount(0);

      const committed = `uncertain e2e after commit ${Date.now()}`;
      nextFault = 'after-commit';
      await composer.fill(committed);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(
          async () =>
            sql<{ count: number }[]>`
              SELECT count(*)::int AS count FROM messages
              WHERE room_id=${roomId}::uuid AND body=${committed}
            `.then((rows) => rows[0]?.count ?? 0),
          { message: 'the committed frame remains exactly once after its ack is lost' },
        )
        .toBe(1);
      await expect(composer).toBeEnabled();
      const durableRow = page.locator('[data-message-id]').filter({ hasText: committed });
      await expect(durableRow).toHaveCount(1);
      await expect(durableRow).not.toHaveAttribute('data-message-id', /^pending:/);
    } finally {
      await context.close();
      await sql.end();
    }
  });
});
