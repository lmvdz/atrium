import { createTransport } from 'nodemailer';
import type { Mailer, MailMessage } from './mailer.js';

/**
 * The real mail transport, and the environment contract that selects it.
 *
 * `mailer.ts` is the *gate*: in production it refuses to hand out the console
 * transport, because the console transport prints verification links and a
 * verification link is a single-use account takeover. Issue #26 round 4 found
 * the consequence of a gate with nothing behind it — the shipped compose stack
 * answered 500 to every request, and had done since the gate landed. This file
 * is the half that was missing. It does not weaken the gate and it is not
 * reachable around it: `createAtriumAuth` still calls `resolveMailer`, and this
 * module's job is only to *produce a transport when one is configured*.
 *
 * ## The contract
 *
 * | variable                  | meaning                                              |
 * | ------------------------- | ---------------------------------------------------- |
 * | `ATRIUM_MAIL_TRANSPORT`   | `smtp` selects this file. `console` selects nothing. |
 * | `SMTP_URL`                | `smtp://user:pass@host:port` or `smtps://…`          |
 * | `SMTP_HOST`/`SMTP_PORT`   | the same connection, spelled out                      |
 * | `SMTP_USER`/`SMTP_PASSWORD` | credentials, when the relay wants them             |
 * | `SMTP_REQUIRE_TLS`        | `true` to refuse a session that never reaches STARTTLS |
 * | `ATRIUM_MAIL_FROM`        | the envelope/header From. Required for `smtp`.       |
 *
 * ## Why `console` returns nothing rather than the console transport
 *
 * Because the gate has to stay the only thing that decides. If this function
 * answered `ATRIUM_MAIL_TRANSPORT=console` with `consoleMailer`, then setting
 * one variable in a production environment would hand `resolveMailer` an
 * "explicit transport", and the explicit branch wins outright — the boot refusal
 * would have an environment-variable bypass, which is exactly the shape
 * `transport.ts` refuses for HTTPS ("there is no `ATRIUM_ALLOW_INSECURE=1`").
 * So `console` means *nothing configured*: development gets the console
 * transport from `resolveMailer`'s own default, and production still refuses to
 * start. The variable exists so a deployment can say "yes, I meant to have no
 * relay" in a `.env` without that sentence meaning anything different from
 * silence.
 *
 * A value that is neither is a hard error rather than a fallback:
 * `ATRIUM_MAIL_TRANSPORT=smpt` must not quietly become "no transport", because
 * in development that types as working and in production it types as the boot
 * refusal for a reason nobody would guess.
 *
 * ## About TLS on this link
 *
 * The message this transport carries contains the verification link. Where the
 * relay is off-box, that link crosses a network and the connection has to be
 * encrypted: write `smtps://` (implicit TLS, usually port 465) or set
 * `SMTP_REQUIRE_TLS=true` (STARTTLS, and a refusal if the server does not offer
 * it). Plain `smtp://` without that flag is opportunistic, and it is the right
 * setting for exactly one topology — a relay on the deployment's own private
 * network, which is the same trust assumption `docker-compose.yml` already makes
 * for Postgres and MinIO. It is deliberately not defaulted to "require": a
 * default that breaks the sidecar case would be turned off by whoever hits it,
 * and a knob that gets turned off is worse than one that was asked for.
 */

/** What the resolver was told to do. */
export type MailTransportKind = 'smtp' | 'console';

export class MailTransportConfigError extends Error {
  constructor(message: string) {
    super(
      `${message} See packages/auth/src/smtp.ts for the full variable contract. ` +
        'Atrium refuses to start on a half-configured mail transport rather than ' +
        'discovering it at the first signup.',
    );
    this.name = 'MailTransportConfigError';
  }
}

/** The fields `smtp.ts` reads. A plain object so tests need no process state. */
export interface SmtpSource {
  ATRIUM_MAIL_TRANSPORT?: string | undefined;
  ATRIUM_MAIL_FROM?: string | undefined;
  SMTP_URL?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  SMTP_REQUIRE_TLS?: string | undefined;
}

/** A fully-resolved SMTP connection, with nothing left to default. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (`smtps://`, conventionally port 465). */
  secure: boolean;
  /** Refuse a session that never gets to STARTTLS. */
  requireTls: boolean;
  auth?: { user: string; pass: string };
  /** The `From:` header and envelope sender. */
  from: string;
}

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Which transport this environment asks for.
 *
 * Unset is `console` — "nobody said" — and `resolveMailer` is what decides
 * whether that is a working development default or a refusal to start. This
 * function never makes that call.
 */
export function mailTransportKind(env: SmtpSource): MailTransportKind {
  const raw = trim(env.ATRIUM_MAIL_TRANSPORT)?.toLowerCase();
  if (raw === undefined || raw === 'console') return 'console';
  if (raw === 'smtp') return 'smtp';
  throw new MailTransportConfigError(
    `ATRIUM_MAIL_TRANSPORT=${env.ATRIUM_MAIL_TRANSPORT} is not a transport this build knows. ` +
      'The values are `smtp` (a real relay, configured with SMTP_URL or SMTP_HOST) and ' +
      '`console` (no relay — which in production means this process refuses to start).',
  );
}

const booleanish = new Set(['true', '1', 'yes', 'on']);

function parseBoolean(name: string, value: string | undefined): boolean {
  const raw = trim(value)?.toLowerCase();
  if (raw === undefined) return false;
  if (booleanish.has(raw)) return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  throw new MailTransportConfigError(
    `${name}=${value} is not a boolean. Write \`true\` or \`false\`; a value nobody can read is ` +
      'not a configuration, it is the unset case wearing a word.',
  );
}

/**
 * The connection, from a URL or from the spelled-out variables.
 *
 * Both spellings are accepted because both are what a deployment actually has:
 * a managed relay hands out one URL, and a secrets manager hands out four
 * fields. They are not merged — `SMTP_URL` wins outright when it is set, and
 * the discrete variables are read only when it is not, so there is no arithmetic
 * anybody has to do in their head to work out which port is in effect.
 */
export function smtpConfig(env: SmtpSource): SmtpConfig {
  const from = trim(env.ATRIUM_MAIL_FROM);
  if (!from) {
    throw new MailTransportConfigError(
      'ATRIUM_MAIL_FROM is required when ATRIUM_MAIL_TRANSPORT=smtp. Every relay rejects or ' +
        'silently quarantines mail with no sender, and an address nobody chose is one nobody ' +
        'can reply to.',
    );
  }
  const requireTls = parseBoolean('SMTP_REQUIRE_TLS', env.SMTP_REQUIRE_TLS);

  const url = trim(env.SMTP_URL);
  if (url) return { ...fromUrl(url), requireTls, from };

  const host = trim(env.SMTP_HOST);
  if (!host) {
    throw new MailTransportConfigError(
      'ATRIUM_MAIL_TRANSPORT=smtp but neither SMTP_URL nor SMTP_HOST is set, so there is no ' +
        'relay to send through.',
    );
  }
  const port = parsePort(trim(env.SMTP_PORT) ?? '587');
  const user = trim(env.SMTP_USER);
  const pass = env.SMTP_PASSWORD;
  if ((user === undefined) !== (pass === undefined || pass === '')) {
    throw new MailTransportConfigError(
      'SMTP_USER and SMTP_PASSWORD must be set together. One without the other is an ' +
        'authentication attempt that cannot succeed, or a credential nobody sends.',
    );
  }

  return {
    host,
    port,
    // 465 is implicit TLS by convention; everything else negotiates.
    secure: port === 465,
    requireTls,
    ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
    from,
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MailTransportConfigError(
      `SMTP_PORT=${raw} is not a TCP port. Give a whole number between 1 and 65535.`,
    );
  }
  return port;
}

function fromUrl(raw: string): Omit<SmtpConfig, 'requireTls' | 'from'> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailTransportConfigError(
      `SMTP_URL is not a URL. Write it as smtp://user:password@host:port (or smtps:// for ` +
        'implicit TLS).',
    );
  }
  const secure = url.protocol === 'smtps:';
  if (!secure && url.protocol !== 'smtp:') {
    throw new MailTransportConfigError(
      `SMTP_URL has scheme ${url.protocol} — the schemes are smtp: and smtps:.`,
    );
  }
  if (!url.hostname) {
    throw new MailTransportConfigError('SMTP_URL has no host.');
  }
  const port = url.port ? parsePort(url.port) : secure ? 465 : 587;
  const user = url.username ? decodeURIComponent(url.username) : undefined;
  const pass = url.password ? decodeURIComponent(url.password) : undefined;
  if ((user === undefined) !== (pass === undefined)) {
    throw new MailTransportConfigError(
      'SMTP_URL carries a username without a password (or the reverse). Give both, or neither.',
    );
  }
  return {
    host: url.hostname,
    port,
    secure,
    ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
  };
}

/**
 * A `Mailer` that sends through a real relay.
 *
 * Text only, deliberately: #40's scope boundary rules out an email templating
 * system, and `MailMessage` already carries the one line that matters (`url`)
 * inside `body`. A recipient whose client shows plain text sees the whole
 * message; a recipient whose client shows HTML sees the same words. There is no
 * second rendering of the link to fall out of step with the first.
 *
 * The send is **not** swallowed. `consoleMailer` tolerates a broken outbox
 * because an outbox is a debugging convenience; a failed *send* is a signup that
 * did not happen, and the caller — Better Auth's `sendVerificationEmail`, or the
 * invitation hook — has to see it rather than redirect somebody to a
 * "check your email" page for mail nobody sent.
 */
export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    ...(config.auth ? { auth: config.auth } : {}),
  });

  return async (message: MailMessage): Promise<void> => {
    await transporter.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
  };
}

/**
 * The transport this environment configures, or `undefined` when it configures
 * none.
 *
 * `undefined` is the important return value: it is what hands the decision back
 * to `resolveMailer`, which prints in development and refuses to start in
 * production. Nothing here returns `consoleMailer`, so nothing here can turn the
 * production refusal into a warning.
 */
export function mailerFromEnv(env: SmtpSource = process.env): Mailer | undefined {
  if (mailTransportKind(env) === 'console') return undefined;
  return createSmtpMailer(smtpConfig(env));
}
