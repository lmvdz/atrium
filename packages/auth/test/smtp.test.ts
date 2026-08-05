import { describe, expect, it } from 'vitest';
import { consoleMailer, MailerNotConfiguredError, resolveMailer } from '../src/mailer.js';
import {
  MailTransportConfigError,
  mailerFromEnv,
  mailTransportKind,
  smtpConfig,
} from '../src/smtp.js';

/**
 * The transport #40 supplies, and — more importantly — the thing it must not do
 * to the gate in front of it.
 *
 * Every test below states the source mutation it catches, per the standing rule.
 * The ones that matter most are in the last block: this file's whole risk is
 * that adding a transport quietly turns the production boot refusal into
 * something an environment variable can switch off.
 */

describe('mailTransportKind — what the environment asked for', () => {
  it('reads an unset variable as `console`, which is "nobody said"', () => {
    // Catches: defaulting to `smtp` and turning a missing variable into a
    // connection error, or throwing here and making an unset variable fatal in
    // development.
    expect(mailTransportKind({})).toBe('console');
    expect(mailTransportKind({ ATRIUM_MAIL_TRANSPORT: '   ' })).toBe('console');
  });

  it('accepts `smtp` and `console`, in any case', () => {
    expect(mailTransportKind({ ATRIUM_MAIL_TRANSPORT: 'SMTP' })).toBe('smtp');
    expect(mailTransportKind({ ATRIUM_MAIL_TRANSPORT: 'Console' })).toBe('console');
  });

  it('refuses a value it does not know rather than falling back', () => {
    /**
     * A typo must not become "no transport". In development that types as
     * working; in production it types as the boot refusal, for a reason nobody
     * would guess from the message.
     *
     * Catches: `return raw === 'smtp' ? 'smtp' : 'console'`, which is the
     * obvious one-liner and swallows `smpt`.
     */
    expect(() => mailTransportKind({ ATRIUM_MAIL_TRANSPORT: 'smpt' })).toThrow(
      MailTransportConfigError,
    );
    expect(() => mailTransportKind({ ATRIUM_MAIL_TRANSPORT: 'postmark' })).toThrow(
      /not a transport this build knows/,
    );
  });
});

const from = { ATRIUM_MAIL_FROM: 'Atrium <no-reply@atrium.test>' };

describe('smtpConfig — the connection', () => {
  it('reads a URL, with credentials and an explicit port', () => {
    expect(smtpConfig({ ...from, SMTP_URL: 'smtp://ada:hunter2@relay.example:2525' })).toEqual({
      host: 'relay.example',
      port: 2525,
      secure: false,
      requireTls: false,
      auth: { user: 'ada', pass: 'hunter2' },
      from: from.ATRIUM_MAIL_FROM,
    });
  });

  it('percent-decodes credentials, because passwords contain `@` and `/`', () => {
    // Catches: reading `url.username` without decoding, which turns `a%40b`
    // into a username that authenticates against nothing.
    const config = smtpConfig({ ...from, SMTP_URL: 'smtp://a%40b:p%2Fw@relay.example' });
    expect(config.auth).toEqual({ user: 'a@b', pass: 'p/w' });
  });

  it('defaults the port from the scheme: 465 for smtps, 587 for smtp', () => {
    expect(smtpConfig({ ...from, SMTP_URL: 'smtps://relay.example' })).toMatchObject({
      port: 465,
      secure: true,
    });
    expect(smtpConfig({ ...from, SMTP_URL: 'smtp://relay.example' })).toMatchObject({
      port: 587,
      secure: false,
    });
  });

  it('treats port 465 as implicit TLS however it was spelled', () => {
    // Catches: deriving `secure` only from the scheme, so the discrete-variable
    // spelling of a 465 relay negotiates cleartext and fails at connect time.
    expect(smtpConfig({ ...from, SMTP_HOST: 'relay.example', SMTP_PORT: '465' })).toMatchObject({
      secure: true,
    });
  });

  it('refuses a scheme that is not smtp or smtps', () => {
    // Catches: passing SMTP_URL straight to nodemailer, which would accept
    // `http://` and produce a runtime error at the first signup instead.
    expect(() => smtpConfig({ ...from, SMTP_URL: 'https://relay.example' })).toThrow(
      /schemes are smtp/,
    );
  });

  it('refuses a URL that is not a URL, and a port that is not a port', () => {
    /**
     * `relay.example:25` — the shape somebody types when they mean host:port —
     * is measured rather than assumed here, and the measurement corrected the
     * first draft of this test. WHATWG parsing *accepts* it: `relay.example:`
     * becomes the scheme and `25` the path, so `new URL` does not throw and the
     * refusal comes from the scheme check rather than from the parse. Both
     * refusals are asserted, each with the message it really produces.
     */
    expect(() => smtpConfig({ ...from, SMTP_URL: 'relay.example:25' })).toThrow(
      /has scheme relay\.example:/,
    );
    expect(() => smtpConfig({ ...from, SMTP_URL: 'not a relay' })).toThrow(/not a URL/);
    expect(() => smtpConfig({ ...from, SMTP_URL: 'smtp://' })).toThrow(/has no host/);
    expect(() => smtpConfig({ ...from, SMTP_HOST: 'relay.example', SMTP_PORT: '0' })).toThrow(
      /not a TCP port/,
    );
    expect(() => smtpConfig({ ...from, SMTP_HOST: 'relay.example', SMTP_PORT: '70000' })).toThrow(
      /not a TCP port/,
    );
  });

  it('refuses half a credential, in either direction', () => {
    /**
     * A username with no password is an authentication attempt that cannot
     * succeed; a password with no username is a secret nobody sends. Both are
     * far more likely to be a half-finished deployment than an intention.
     *
     * Catches: `...(user ? { auth: { user, pass: pass ?? '' } } : {})`.
     */
    expect(() => smtpConfig({ ...from, SMTP_HOST: 'relay.example', SMTP_USER: 'ada' })).toThrow(
      /must be set together/,
    );
    expect(() =>
      smtpConfig({ ...from, SMTP_HOST: 'relay.example', SMTP_PASSWORD: 'hunter2' }),
    ).toThrow(/must be set together/);
    expect(() => smtpConfig({ ...from, SMTP_URL: 'smtp://ada@relay.example' })).toThrow(
      /without a password/,
    );
  });

  it('requires a From address', () => {
    // Catches: defaulting the sender to something like `atrium@localhost`,
    // which every relay quarantines and nobody can reply to.
    expect(() => smtpConfig({ SMTP_URL: 'smtp://relay.example' })).toThrow(/ATRIUM_MAIL_FROM/);
  });

  it('requires somewhere to send', () => {
    expect(() => smtpConfig({ ...from })).toThrow(/neither SMTP_URL nor SMTP_HOST/);
  });

  it('lets SMTP_URL win outright rather than merging the two spellings', () => {
    /**
     * Merging would mean the effective port is arithmetic somebody has to do in
     * their head — and get right — while reading two blocks of a compose file.
     *
     * Catches: `port: parsePort(env.SMTP_PORT ?? …)` applied after the URL.
     */
    const config = smtpConfig({
      ...from,
      SMTP_URL: 'smtp://relay.example:2525',
      SMTP_HOST: 'other.example',
      SMTP_PORT: '25',
    });
    expect(config).toMatchObject({ host: 'relay.example', port: 2525 });
  });

  it('reads SMTP_REQUIRE_TLS as a boolean and refuses a word that is not one', () => {
    expect(
      smtpConfig({ ...from, SMTP_URL: 'smtp://r.example', SMTP_REQUIRE_TLS: 'true' }),
    ).toMatchObject({ requireTls: true });
    expect(
      smtpConfig({ ...from, SMTP_URL: 'smtp://r.example', SMTP_REQUIRE_TLS: 'false' }),
    ).toMatchObject({ requireTls: false });
    expect(() =>
      smtpConfig({ ...from, SMTP_URL: 'smtp://r.example', SMTP_REQUIRE_TLS: 'yes please' }),
    ).toThrow(/not a boolean/);
  });
});

/**
 * The part that has to stay true no matter what else changes here.
 *
 * `resolveMailer` refuses to start a production process with no transport. #40
 * was adjudicated: that gate is correct and must not be weakened. The way it
 * would be weakened by accident is precisely this file — a resolver that
 * answered `ATRIUM_MAIL_TRANSPORT=console` with `consoleMailer` would be handing
 * `resolveMailer` an *explicit* transport, and the explicit branch wins
 * outright. One environment variable, and the boot refusal has an override.
 */
describe('mailerFromEnv — and the gate it must not become an override for', () => {
  it('returns nothing when no transport is configured', () => {
    expect(mailerFromEnv({})).toBeUndefined();
    expect(mailerFromEnv({ ATRIUM_MAIL_TRANSPORT: 'console' })).toBeUndefined();
  });

  it('never returns the console transport, whatever the environment says', () => {
    /**
     * The mutation this exists for: `if (kind === 'console') return consoleMailer`.
     * Every other test in this file passes with that line in place.
     */
    for (const value of ['console', 'CONSOLE', undefined]) {
      const mailer = mailerFromEnv(value === undefined ? {} : { ATRIUM_MAIL_TRANSPORT: value });
      expect(mailer).not.toBe(consoleMailer);
      expect(mailer).toBeUndefined();
    }
  });

  it('still refuses to boot in production when the transport is `console`', () => {
    // The two halves composed, exactly as `createAtriumAuth` composes them.
    expect(() =>
      resolveMailer(mailerFromEnv({ ATRIUM_MAIL_TRANSPORT: 'console' }), {
        NODE_ENV: 'production',
      }),
    ).toThrow(MailerNotConfiguredError);
  });

  it('satisfies the gate in production once a real relay is configured', () => {
    const mailer = mailerFromEnv({
      ...from,
      ATRIUM_MAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://relay.example:2525',
    });
    expect(typeof mailer).toBe('function');
    expect(resolveMailer(mailer, { NODE_ENV: 'production' })).toBe(mailer);
  });

  it('throws on a half-configured relay rather than degrading to no transport', () => {
    /**
     * Degrading would mean a deployment that *meant* to send mail silently
     * becomes one that refuses to boot for the "no transport" reason, and the
     * operator goes looking at the wrong variable. Worse, in development it
     * would silently print links while the operator believed a relay was live.
     *
     * Catches: wrapping `smtpConfig` in a try/catch that returns undefined.
     */
    expect(() => mailerFromEnv({ ATRIUM_MAIL_TRANSPORT: 'smtp' })).toThrow(
      MailTransportConfigError,
    );
  });
});
