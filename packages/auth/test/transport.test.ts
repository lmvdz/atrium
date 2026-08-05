import type { Database } from '@atrium/db';
import { getCookies } from 'better-auth/cookies';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtriumAuth } from '../src/auth.js';
import {
  assertSecureTransport,
  InsecureTransportError,
  isSecureUrl,
  requiresSecureTransport,
  useSecureCookies,
} from '../src/transport.js';

/**
 * HTTPS as a boot condition.
 *
 * Round 4 shipped a compose stack serving production auth over plaintext, with
 * a comment in `deploy/Caddyfile` asking the operator to fix it. These are the
 * tests for the control that replaced the comment; each one names the source
 * mutation it fails against, per the standing rule.
 */

const production = { NODE_ENV: 'production' };

describe('isSecureUrl', () => {
  it('accepts the two schemes a browser treats as a secure context', () => {
    expect(isSecureUrl('https://atrium.example.com')).toBe(true);
    expect(isSecureUrl('wss://atrium.example.com/ws')).toBe(true);
  });

  it('refuses the cleartext pair', () => {
    // Catches: checking only `https:` and forgetting `ws:` — the realtime URL
    // carries the same session cookie the page does.
    expect(isSecureUrl('http://atrium.example.com')).toBe(false);
    expect(isSecureUrl('ws://atrium.example.com/ws')).toBe(false);
  });

  it('refuses a value nobody can parse rather than passing it through', () => {
    // Catches: `!value.startsWith('http://')`, which reads every unparseable
    // string — and every `HTTP://` — as secure.
    expect(isSecureUrl('atrium.example.com')).toBe(false);
    expect(isSecureUrl('')).toBe(false);
    expect(isSecureUrl('//atrium.example.com')).toBe(false);
  });

  it('accepts what the URL parser accepts, sloppy slashes included', () => {
    /**
     * Measured, not assumed: WHATWG parsing of a *special* scheme tolerates a
     * missing slash, so `https:/host` is `https://host` and this returns true.
     * Written down because the first draft of this test asserted the opposite
     * and was wrong — the rule is "ask the parser", and the parser's answer is
     * the one that matters. Compose derives the URL from a hostname anyway, so
     * nobody hand-types this form.
     */
    expect(isSecureUrl('https:/atrium.example.com')).toBe(true);
    expect(isSecureUrl('http:/atrium.example.com')).toBe(false);
  });

  it('is not fooled by an https-looking host or path', () => {
    // Catches: a substring test (`value.includes('https')`).
    expect(isSecureUrl('http://https.example.com')).toBe(false);
    expect(isSecureUrl('http://atrium.example.com/https://x')).toBe(false);
  });

  it('reads the scheme case-insensitively, because URL parsing does', () => {
    expect(isSecureUrl('HTTPS://atrium.example.com')).toBe(true);
    expect(isSecureUrl('HTTP://atrium.example.com')).toBe(false);
  });
});

describe('requiresSecureTransport', () => {
  it('applies in production and nowhere else', () => {
    expect(requiresSecureTransport(production)).toBe(true);
    expect(requiresSecureTransport({ NODE_ENV: 'development' })).toBe(false);
    expect(requiresSecureTransport({ NODE_ENV: 'test' })).toBe(false);
    expect(requiresSecureTransport({})).toBe(false);
  });

  it('exempts `next build`, which compiles modules and serves no request', () => {
    // Catches: dropping the NEXT_PHASE exemption, which would mean a build
    // machine needs the production hostname to compile a route module. Same
    // exemption `resolveMailer` makes, for the same reason.
    expect(
      requiresSecureTransport({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }),
    ).toBe(false);
  });
});

describe('assertSecureTransport', () => {
  it('refuses to start a production deployment on an http:// origin', () => {
    // Catches: deleting the call from `createAtriumAuth`/`appUrl()`, or
    // downgrading the throw to a console warning. Round 4's version of this
    // rule was a sentence in a Caddyfile.
    expect(() =>
      assertSecureTransport([{ name: 'APP_URL', value: 'http://atrium.example.com' }], production),
    ).toThrow(InsecureTransportError);
  });

  it('refuses a ws:// realtime origin as readily as an http:// page origin', () => {
    // Catches: checking `baseURL` only. The web app declares
    // NEXT_PUBLIC_WS_URL as a trusted origin, and a socket over ws:// carries
    // the same cookie.
    expect(() =>
      assertSecureTransport(
        [
          { name: 'APP_URL', value: 'https://atrium.example.com' },
          { name: 'NEXT_PUBLIC_WS_URL', value: 'ws://atrium.example.com/ws' },
        ],
        production,
      ),
    ).toThrow(InsecureTransportError);
  });

  it('names every offending setting and its value, not just the first', () => {
    // Catches: reporting one problem and stopping, which sends an operator
    // round the loop once per variable.
    let caught: InsecureTransportError | null = null;
    try {
      assertSecureTransport(
        [
          { name: 'APP_URL', value: 'http://a.example' },
          { name: 'NEXT_PUBLIC_WS_URL', value: 'ws://b.example/ws' },
        ],
        production,
      );
    } catch (error) {
      caught = error as InsecureTransportError;
    }
    expect(caught?.problems.map((problem) => problem.name)).toEqual([
      'APP_URL',
      'NEXT_PUBLIC_WS_URL',
    ]);
    expect(caught?.message).toContain('http://a.example');
    expect(caught?.message).toContain('ws://b.example/ws');
  });

  it('lets a secure production deployment through', () => {
    expect(() =>
      assertSecureTransport(
        [
          { name: 'APP_URL', value: 'https://atrium.example.com' },
          { name: 'NEXT_PUBLIC_WS_URL', value: 'wss://atrium.example.com/ws' },
        ],
        production,
      ),
    ).not.toThrow();
  });

  it('leaves development and test alone, so localhost still signs in', () => {
    // Catches: keying the rule on anything other than NODE_ENV — a rule that
    // fires on a laptop gets switched off, and a switched-off rule is the
    // comment again.
    for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, {}]) {
      expect(() =>
        assertSecureTransport([{ name: 'APP_URL', value: 'http://localhost:3000' }], env),
      ).not.toThrow();
    }
  });

  it('skips absent values instead of inventing a second missing-variable error', () => {
    // Catches: treating undefined/'' as insecure, which would produce two
    // different sentences for one unset APP_URL — `required()` in
    // apps/web/lib/env.ts and `productionRequired` in apps/server own that.
    expect(() =>
      assertSecureTransport(
        [
          { name: 'APP_URL', value: undefined },
          { name: 'NEXT_PUBLIC_WS_URL', value: null },
          { name: 'OTHER', value: '' },
        ],
        production,
      ),
    ).not.toThrow();
  });

  it('has no override, and the error says so', () => {
    /**
     * Catches: adding an `ATRIUM_ALLOW_INSECURE` escape hatch. There is no
     * assertion that can prove a variable does not exist, so this asserts the
     * next best thing — that setting every plausible spelling of one changes
     * nothing — and the message states the intent for whoever reads the error.
     */
    const escapes = {
      ...production,
      ATRIUM_ALLOW_INSECURE: '1',
      ALLOW_INSECURE: 'true',
      ATRIUM_INSECURE: 'yes',
    };
    expect(() =>
      assertSecureTransport([{ name: 'APP_URL', value: 'http://a.example' }], escapes),
    ).toThrow(InsecureTransportError);
    expect(() =>
      assertSecureTransport([{ name: 'APP_URL', value: 'http://a.example' }], escapes),
    ).toThrow(/no override/);
  });
});

/**
 * The cookie itself, asked of the library rather than of our own config object.
 *
 * Same shape as `client-ip.test.ts`'s agreement test, and one step stronger:
 * it builds the **real instance** and hands Better Auth's own `getCookies` the
 * options that instance is actually carrying. Rebuilding the `advanced` block
 * inside the test would only prove that the test can compute the same value —
 * mutating `auth.ts` to `useSecureCookies: false` would sail past it, which is
 * the class of theatre this ticket's standing rule exists to stop.
 *
 * No database is needed: `betterAuth` builds its adapter lazily.
 */
describe('session cookies assert Secure', () => {
  const sessionCookieFor = (baseURL: string) => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-secret-long-enough-to-be-accepted-000000');
    const auth = createAtriumAuth({ db: {} as Database, baseURL });
    return getCookies(auth.options).sessionToken;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks the session cookie Secure on an https deployment', () => {
    // Catches: `useSecureCookies: false`, or dropping the option and having a
    // future library default decide it. Both leave the session cookie legal to
    // send over cleartext.
    const cookie = sessionCookieFor('https://atrium.example.com');
    expect(cookie.attributes.secure).toBe(true);
    expect(cookie.name).toContain('__Secure-');
  });

  it('does not, on a development http:// origin — the divergence, on the record', () => {
    // The value of the setting, stated as a difference rather than a claim: a
    // Secure cookie is not sent over http, so hard-coding `true` would break
    // `pnpm dev` on localhost. The production side of that fork is closed by
    // `assertSecureTransport`, not by this flag.
    const cookie = sessionCookieFor('http://localhost:3000');
    expect(cookie.attributes.secure).toBe(false);
    expect(cookie.name).not.toContain('__Secure-');
  });

  it('follows the URL, so a production deployment cannot reach the insecure branch', () => {
    // Catches: deriving the flag from NODE_ENV instead of from the URL. Keyed
    // on NODE_ENV it would be true on a laptop running a production build and
    // sign nobody in; keyed on the URL, the only way to get `false` in
    // production is an http:// origin, which does not boot.
    expect(useSecureCookies('wss://atrium.example.com/ws')).toBe(true);
    expect(useSecureCookies('http://atrium.example.com')).toBe(false);
  });
});

/**
 * The composition root, which is the control that actually holds.
 *
 * `apps/web/lib/env.ts` and `apps/server/src/env.ts` each apply the rule early,
 * where the error can name the variable. This is the one neither app can skip:
 * both build their instance from `createAtriumAuth`, so a process that reaches
 * the point of having an auth instance has passed this check. It sits beside
 * `resolveMailer` on purpose — two refusals to boot, same shape, same reason.
 */
describe('createAtriumAuth refuses to build an insecure production instance', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The db is never touched: the assertion runs before anything else. */
  const noDatabase = {} as Database;

  function serving(): void {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', '');
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-secret-long-enough-to-be-accepted-000000');
  }

  it('refuses an http:// baseURL', () => {
    // Catches: deleting the `assertSecureTransport` call from
    // `createAtriumAuth`. Both apps then boot on cleartext even with their own
    // env gates intact, because a deployment can set APP_URL correctly and pass
    // an insecure origin some other way.
    serving();
    expect(() =>
      createAtriumAuth({ db: noDatabase, baseURL: 'http://atrium.example.com' }),
    ).toThrow(InsecureTransportError);
  });

  it('refuses an insecure trusted origin even when the baseURL is fine', () => {
    // The web app declares NEXT_PUBLIC_WS_URL here and the realtime server
    // declares APP_URL. Catches: checking `baseURL` only.
    serving();
    expect(() =>
      createAtriumAuth({
        db: noDatabase,
        baseURL: 'https://atrium.example.com',
        trustedOrigins: ['ws://atrium.example.com'],
      }),
    ).toThrow(InsecureTransportError);
  });

  it('refuses before it asks for a mailer, so the error names the real problem', () => {
    /**
     * Both boot conditions fail for an insecure production process with no mail
     * transport, and only one of them is the one the operator has to fix first.
     * Catches: ordering `resolveMailer` ahead of the transport assertion, which
     * would report a missing mailer for a deployment whose actual defect is
     * that it is serving over http.
     */
    serving();
    expect(() =>
      createAtriumAuth({ db: noDatabase, baseURL: 'http://atrium.example.com' }),
    ).toThrow(/TLS/);
  });

  it('says nothing about any of this in development', () => {
    // Catches: keying the rule on anything but NODE_ENV. The construction is
    // allowed to fail later for its own reasons; what matters is that it does
    // not fail *here*.
    vi.stubEnv('NODE_ENV', 'development');
    let thrown: unknown = null;
    try {
      createAtriumAuth({ db: noDatabase, baseURL: 'http://localhost:3000' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(InsecureTransportError);
  });
});
