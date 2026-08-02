import { existsSync, readFileSync } from 'node:fs';
import { mailOutbox } from './config.mjs';

/**
 * Reading the dev mailer's outbox.
 *
 * The console transport also appends one JSON object per message to a file when
 * `ATRIUM_MAIL_OUTBOX` is set (packages/auth/src/mailer.ts). Tests read the link
 * from there rather than scraping server stdout, which is racy, or standing up
 * an SMTP server in CI, which is a service to keep alive for no benefit.
 */

export interface OutboxMessage {
  kind: 'email-verification' | 'workspace-invitation';
  to: string;
  subject: string;
  url: string;
  body: string;
  sentAt: string;
}

function readOutbox(): OutboxMessage[] {
  if (!existsSync(mailOutbox)) return [];
  return readFileSync(mailOutbox, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OutboxMessage);
}

/**
 * The most recent message of a kind sent to an address. Polls, because the mail
 * is written during a Server Action that the browser has already been redirected
 * away from — the redirect can land before the append does.
 */
export async function waitForMail(
  to: string,
  kind: OutboxMessage['kind'],
  timeoutMs = 15_000,
): Promise<OutboxMessage> {
  const deadline = Date.now() + timeoutMs;
  const wanted = to.toLowerCase();

  for (;;) {
    const matches = readOutbox().filter(
      (message) => message.kind === kind && message.to.toLowerCase() === wanted,
    );
    const latest = matches.at(-1);
    if (latest) return latest;

    if (Date.now() > deadline) {
      throw new Error(`no ${kind} mail for ${to} within ${timeoutMs}ms (outbox: ${mailOutbox})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** How many messages of a kind an address has been sent. */
export function countMail(to: string, kind: OutboxMessage['kind']): number {
  const wanted = to.toLowerCase();
  return readOutbox().filter((m) => m.kind === kind && m.to.toLowerCase() === wanted).length;
}
