import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
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
 * A distinct client address per browser context.
 *
 * The suite creates dozens of accounts, and `signUpAction` caps sign-ups at 20
 * per hour *per IP* — so with every context arriving from `::1` the suite
 * eventually throttles itself and a test fails at "check your email" for a
 * reason that has nothing to do with what it was testing. That is not the
 * limiter misbehaving; it is the limiter working, on a suite pretending to be
 * one very busy person.
 *
 * So each context says who it is. `ATRIUM_TRUSTED_PROXY_HOPS=1` is set for the
 * run (see `config.mjs`), and Next preserves a client-supplied
 * `X-Forwarded-For`, so this is the address the throttle buckets on — which
 * means the IP dimension is genuinely exercised, with genuinely different
 * callers, instead of being either inert or self-inflicted.
 *
 * TEST-NET-3 (203.0.113.0/24, RFC 5737) with a random host part: reserved for
 * documentation, so it can never collide with a real address.
 */
export function callerAddress(): string {
  return `203.0.113.${randomInt(1, 255)}`;
}

/** `browser.newContext()`, plus an address of its own. */
export function newCallerContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': callerAddress() } });
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
  frame: Record<string, unknown>,
): Promise<{ opened: boolean; reply: Record<string, unknown> | null }> {
  return page.evaluate(
    ({ frame, url }) =>
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
          socket.send(JSON.stringify(frame));
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
    { frame, url: wsUrl },
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
 *
 * It also counts the *unprompted* frames — the presence broadcasts a room sends
 * to everybody on its roster — and records the close code. Round 2 could only
 * ask "is my next command refused?"; a socket that never sends one was never
 * asked anything, and went on receiving the room. `liveSocketStatus` is how a
 * test asks what this socket is still being told.
 */
export async function openLiveSocket(page: Page): Promise<boolean> {
  return page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const holder = window as unknown as {
          __atriumLive?: {
            socket: WebSocket;
            replies: Record<string, unknown>[];
            frames: Record<string, unknown>[];
            closeCode: number | null;
          };
        };
        const socket = new WebSocket(url);
        const live = {
          socket,
          replies: [] as Record<string, unknown>[],
          frames: [] as Record<string, unknown>[],
          closeCode: null as number | null,
        };
        holder.__atriumLive = live;

        socket.addEventListener('message', (event: MessageEvent<string>) => {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === 'welcome') return;
          live.frames.push(message);
          live.replies.push(message);
        });
        socket.addEventListener('close', (event: CloseEvent) => {
          live.closeCode = event.code;
          resolve(false);
        });
        socket.addEventListener('open', () => resolve(true));
        socket.addEventListener('error', () => resolve(false));
      }),
    wsUrl,
  );
}

/** What the socket `openLiveSocket` left open is still being told, and whether it lives. */
export async function liveSocketStatus(
  page: Page,
): Promise<{ open: boolean; closeCode: number | null; frames: Record<string, unknown>[] }> {
  return page.evaluate(() => {
    const holder = window as unknown as {
      __atriumLive?: {
        socket: WebSocket;
        frames: Record<string, unknown>[];
        closeCode: number | null;
      };
    };
    const live = holder.__atriumLive;
    if (!live) return { open: false, closeCode: null, frames: [] };
    return {
      open: live.socket.readyState === WebSocket.OPEN,
      closeCode: live.closeCode,
      frames: live.frames,
    };
  });
}

/** Sends one command over the socket `openLiveSocket` left open. */
export async function sendOnLiveSocket(
  page: Page,
  frame: Record<string, unknown>,
): Promise<{ closed: boolean; reply: Record<string, unknown> | null }> {
  return page.evaluate(
    (frame) =>
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
        live.socket.send(JSON.stringify(frame));

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
