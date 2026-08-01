import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, expect, type Page, test } from '@playwright/test';
import { serverPort } from './config.mjs';
import { waitForMail } from './mail';

const wsUrl = `ws://localhost:${serverPort}/ws`;

/**
 * The onboarding flow, as a few named steps.
 *
 * Each test builds its own users and workspace from scratch with unique
 * addresses, so the suite can run fully parallel against one database without
 * tests reaching into each other's state.
 */

/** A password comfortably over the 12-character floor. */
export const password = 'correct-horse-battery-staple';

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@atrium.test`;
}

/**
 * Playwright downloads its browsers into a cache outside the repo. In sandboxes
 * where that download is blocked, skip with a reason instead of failing the
 * suite — a red suite would say "the app is broken" when the truth is "no
 * browser is installed".
 */
export function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const isCI = !!process.env.CI;

/**
 * The browser guard, and the reason it is a function rather than a `test.skip`
 * copied into every spec.
 *
 * That courtesy stops at CI. Round 1 used a bare `test.skip(!browserAvailable())`
 * in all three auth specs, which meant a CI runner with no browser produced a
 * fully skipped suite and a **green** run — zero authentication flows exercised,
 * reported as a pass. A skipped suite that proves nothing is the exact failure
 * CI exists to catch, so in CI the missing browser is a hard error.
 *
 * `apps/web/e2e/smoke.spec.ts` on the CI branch already had this shape; the auth
 * specs now share it, from one place, so the next spec cannot forget the second
 * half of it.
 *
 * Call it inside a `test.describe` body.
 */
export function requireBrowser(): void {
  test.skip(
    !isCI && !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  test.beforeAll(() => {
    if (!browserAvailable()) {
      throw new Error(
        'Playwright browsers are not installed. In CI this is a failure, not a skip: ' +
          'a browser suite that silently declines to run reports success it never earned. ' +
          'Run `pnpm exec playwright install chromium`.',
      );
    }
  });
}

/** Signs up, opens the emailed link, and lands signed in on /app. */
export async function signUpAndVerify(
  page: Page,
  { email, name }: { email: string; name: string },
): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByTestId('check-email-lede')).toContainText(email);

  const mail = await waitForMail(email, 'email-verification');
  await page.goto(mail.url);
  await page.waitForURL('**/app');
  await expect(page.getByTestId('account-name')).toHaveText(name);
}

/** Creates a workspace and returns the slug it landed on. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/app');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId('workspace-name')).toHaveText(name);
  const slug = new URL(page.url()).pathname.split('/').pop();
  if (!slug) throw new Error(`could not read a workspace slug from ${page.url()}`);
  return slug;
}

/** Invites an address and returns the link that was mailed to it. */
export async function invite(
  page: Page,
  { slug, email, role }: { slug: string; email: string; role: 'member' | 'admin' },
): Promise<string> {
  await page.goto(`/app/${slug}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Role').selectOption(role);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByTestId('invite-sent')).toContainText(email);

  const mail = await waitForMail(email, 'workspace-invitation');
  return mail.url;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Opens a WebSocket from inside the page — so the browser attaches the session
 * cookie exactly as the app does — sends one frame, and returns what came back.
 * Resolves to null if the socket never opened, which is what an upgrade the
 * server refused looks like from JavaScript.
 */
export async function sendCommand(
  page: Page,
  frame: { command: string; roomId: string },
): Promise<{ opened: boolean; reply: Record<string, unknown> | null }> {
  return page.evaluate(
    ({ command, roomId, url }) =>
      new Promise<{ opened: boolean; reply: Record<string, unknown> | null }>((resolve) => {
        const socket = new WebSocket(url);
        let opened = false;
        const done = (reply: Record<string, unknown> | null) => {
          clearTimeout(timer);
          socket.close();
          resolve({ opened, reply });
        };
        const timer = setTimeout(() => done(null), 8000);

        socket.addEventListener('open', () => {
          opened = true;
          socket.send(JSON.stringify({ type: 'command', command, roomId, requestId: 'probe' }));
        });
        socket.addEventListener('message', (event: MessageEvent<string>) => {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === 'welcome' || message.type === 'presence') return;
          done(message);
        });
        socket.addEventListener('close', () => {
          if (!opened) done(null);
        });
        socket.addEventListener('error', () => {
          if (!opened) done(null);
        });
      }),
    { ...frame, url: wsUrl },
  );
}

/**
 * A socket that stays open across several commands.
 *
 * `sendCommand` opens one socket per call, which answers "would this be
 * refused?" and nothing about "does an *already open* socket lose its authority
 * when the person behind it is removed?" — a fresh socket would just be refused
 * at the handshake, which proves nothing about the live one. So this keeps the
 * connection on `window` and lets a test send, revoke, and send again.
 */
export async function openLiveSocket(page: Page): Promise<boolean> {
  return page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const holder = window as unknown as {
          __atriumLive?: { socket: WebSocket; replies: Record<string, unknown>[] };
        };
        const socket = new WebSocket(url);
        const replies: Record<string, unknown>[] = [];
        holder.__atriumLive = { socket, replies };

        socket.addEventListener('message', (event: MessageEvent<string>) => {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          // Roster broadcasts arrive unprompted; they are not answers.
          if (message.type === 'welcome' || message.type === 'presence') return;
          replies.push(message);
        });
        socket.addEventListener('open', () => resolve(true));
        socket.addEventListener('error', () => resolve(false));
        socket.addEventListener('close', () => resolve(false));
      }),
    wsUrl,
  );
}

/** Sends one command over the socket `openLiveSocket` left open. */
export async function sendOnLiveSocket(
  page: Page,
  frame: { command: string; roomId: string },
): Promise<{ closed: boolean; reply: Record<string, unknown> | null }> {
  return page.evaluate(
    ({ command, roomId }) =>
      new Promise<{ closed: boolean; reply: Record<string, unknown> | null }>((resolve) => {
        const holder = window as unknown as {
          __atriumLive?: { socket: WebSocket; replies: Record<string, unknown>[] };
        };
        const live = holder.__atriumLive;
        if (!live || live.socket.readyState !== WebSocket.OPEN) {
          resolve({ closed: true, reply: null });
          return;
        }

        live.replies.length = 0;
        live.socket.send(JSON.stringify({ type: 'command', command, roomId, requestId: 'live' }));

        const startedAt = Date.now();
        const tick = setInterval(() => {
          const next = live.replies.shift();
          if (next) {
            clearInterval(tick);
            resolve({ closed: false, reply: next });
          } else if (live.socket.readyState !== WebSocket.OPEN) {
            clearInterval(tick);
            resolve({ closed: true, reply: null });
          } else if (Date.now() - startedAt > 8000) {
            clearInterval(tick);
            resolve({ closed: false, reply: null });
          }
        }, 25);
      }),
    frame,
  );
}
