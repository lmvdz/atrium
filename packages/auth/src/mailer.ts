import { appendFileSync } from 'node:fs';
import { describeUnknown } from './errors.js';

/**
 * The mailer. In development it is a console transport: every message Atrium
 * would have sent is printed, link and all, so a developer can finish a signup
 * or accept an invitation without an SMTP server anywhere in the picture.
 *
 * There is no production transport yet, and that is on purpose — wiring one
 * belongs with the notification work, not with auth. `createMailer` takes a
 * `send` function so swapping the console for Postmark/SES later is a one-line
 * change at the composition root and nothing in this package moves.
 */

export type MailKind = 'email-verification' | 'workspace-invitation';

export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  /** The one link the recipient is meant to click. */
  url: string;
  body: string;
}

export type Mailer = (message: MailMessage) => Promise<void>;

/**
 * A file the console transport also appends to, one JSON object per line, when
 * `ATRIUM_MAIL_OUTBOX` points somewhere. This is the seam the end-to-end tests
 * read verification and invitation links out of — scraping server stdout is
 * flaky, and a mail server in CI is a service to keep alive for no benefit.
 *
 * Two guards, because an outbox is a plaintext copy of every link Atrium sends:
 * it is written only when the variable is set, and never when NODE_ENV is
 * production, no matter what the variable says.
 */
function outboxPath(): string | null {
  const path = process.env.ATRIUM_MAIL_OUTBOX;
  if (!path) return null;
  if (process.env.NODE_ENV === 'production') {
    warnOnce(
      'ATRIUM_MAIL_OUTBOX is set but NODE_ENV=production — refusing to write ' +
        'a plaintext copy of outgoing links to disk.',
    );
    return null;
  }
  return path;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[atrium/auth] ${message}`);
}

/**
 * Prints the message and, if an outbox is configured, records it.
 *
 * The console format is deliberately boring and greppable rather than pretty:
 * a developer scanning `pnpm dev` output should find the link on one line.
 */
export const consoleMailer: Mailer = async (message) => {
  console.info(
    [
      '',
      '  ┌─ atrium dev mailer ─────────────────────────────────────────────',
      `  │ to      ${message.to}`,
      `  │ subject ${message.subject}`,
      `  │ link    ${message.url}`,
      '  └─────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );

  const path = outboxPath();
  if (!path) return;
  const record = { ...message, sentAt: new Date().toISOString() };
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    // A broken outbox must never break a signup — and `(error as Error).message`
    // was how it could. `appendFileSync` throws whatever the platform hands it;
    // a `message` getter that throws made the *description* of the failure the
    // thing that propagated, out of a `catch` written to guarantee it would not.
    // `describeUnknown` is total. See `errors.ts` for the class.
    warnOnce(`could not write the mail outbox at ${path}: ${describeUnknown(error)}`);
  }
};

/** Drops everything. Used by tests that assert on their own transport. */
export const nullMailer: Mailer = async () => {};

/**
 * Which transport Atrium is allowed to run with.
 *
 * The console transport prints verification and invitation links. That is
 * exactly right in development and exactly wrong in production, where those
 * links are single-use account takeovers sitting in a log aggregator that far
 * more people can read than can read the recipient's inbox — and with
 * `autoSignInAfterVerification` on, opening one *is* signing in as them.
 *
 * So this refuses to boot. Not a warning: a warning in a log is read by the
 * same nobody who was going to notice the links.
 *
 * Two exemptions, both narrow:
 *  - `next build` (`NEXT_PHASE=phase-production-build`) compiles route modules
 *    with `NODE_ENV=production` but serves no request and sends no mail, so
 *    failing there would only mean "you cannot build an image without SMTP
 *    credentials on the build machine".
 *  - An explicit transport passed by the composition root wins outright; that
 *    is the seam a real Postmark/SES sender lands on.
 */
export interface MailerSource {
  NODE_ENV?: string | undefined;
  NEXT_PHASE?: string | undefined;
}

export class MailerNotConfiguredError extends Error {
  constructor() {
    super(
      'No mail transport is configured and NODE_ENV=production. Atrium refuses ' +
        'to start: the console transport prints verification and invitation ' +
        'links, and in production those links belong in an inbox, not in a log. ' +
        'Pass a real transport to createAtriumAuth({ mailer }), or do not run ' +
        'with NODE_ENV=production.',
    );
    this.name = 'MailerNotConfiguredError';
  }
}

/**
 * The transport for this process, or a thrown error.
 *
 * @param explicit a transport supplied by the composition root, if any.
 * @param env      the environment to judge against.
 */
export function resolveMailer(
  explicit: Mailer | undefined,
  env: MailerSource = process.env,
): Mailer {
  if (explicit) return explicit;

  const building = env.NEXT_PHASE === 'phase-production-build';
  if (env.NODE_ENV === 'production' && !building) throw new MailerNotConfiguredError();

  return consoleMailer;
}
