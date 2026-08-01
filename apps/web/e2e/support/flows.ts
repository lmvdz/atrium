import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, expect, type Page } from '@playwright/test';
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
