import type { IncomingMessage } from 'node:http';
import type { AtriumAuth } from '@atrium/auth';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createSessionResolver, createUpgradeAuthenticator, toHeaders } from '../src/ws-auth.js';

/**
 * `authenticateUpgrade` is the only thing standing between a stranger and a
 * socket, so its failure modes are the interesting part: every one of them has
 * to end in `null`, never in "well, probably fine".
 */

const logger = createLogger('error');

function request(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** A stand-in for the Better Auth instance, with only the call we make. */
function fakeAuth(getSession: () => unknown): AtriumAuth {
  return { api: { getSession: async () => getSession() } } as unknown as AtriumAuth;
}

const verifiedUser = {
  session: { id: 'sess-1', userId: 'user-1', activeOrganizationId: 'ws-1' },
  user: { email: 'ada@example.com', name: 'ada', emailVerified: true },
};

describe('authenticateUpgrade', () => {
  it('returns the session for a valid cookie', async () => {
    const authenticate = createUpgradeAuthenticator({ auth: fakeAuth(() => verifiedUser), logger });
    const session = await authenticate(request({ cookie: 'atrium.session_token=abc' }));
    expect(session).toEqual({
      sessionId: 'sess-1',
      userId: 'user-1',
      email: 'ada@example.com',
      displayName: 'ada',
      emailVerified: true,
      activeWorkspaceId: 'ws-1',
    });
  });

  it('returns null when there is no session', async () => {
    const authenticate = createUpgradeAuthenticator({ auth: fakeAuth(() => null), logger });
    expect(await authenticate(request({}))).toBeNull();
  });

  it('returns null when the session has no user', async () => {
    const authenticate = createUpgradeAuthenticator({
      auth: fakeAuth(() => ({ session: { id: 's' }, user: null })),
      logger,
    });
    expect(await authenticate(request({ cookie: 'atrium.session_token=abc' }))).toBeNull();
  });

  it('refuses an unverified address even if a session somehow exists', async () => {
    const authenticate = createUpgradeAuthenticator({
      auth: fakeAuth(() => ({
        session: { id: 's', userId: 'u' },
        user: { email: 'e@x.test', name: 'e', emailVerified: false },
      })),
      logger,
    });
    expect(await authenticate(request({ cookie: 'atrium.session_token=abc' }))).toBeNull();
  });

  it('treats a thrown lookup as unauthenticated, not as an open door', async () => {
    const authenticate = createUpgradeAuthenticator({
      auth: fakeAuth(() => {
        throw new Error('database is on fire');
      }),
      logger,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await authenticate(request({ cookie: 'atrium.session_token=abc' }))).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/**
 * The same rules, applied to a socket that is already open. A connection is not
 * a permanent grant, and the check that let it exist has to be the check that
 * lets it continue — one function, used twice.
 */
describe('createSessionResolver', () => {
  it('returns the session for a still-valid cookie', async () => {
    const resolve = createSessionResolver({ auth: fakeAuth(() => verifiedUser), logger });
    const session = await resolve(new Headers({ cookie: 'atrium.session_token=abc' }));
    expect(session).toMatchObject({ sessionId: 'sess-1', userId: 'user-1' });
  });

  it('returns null once the session is gone', async () => {
    const resolve = createSessionResolver({ auth: fakeAuth(() => null), logger });
    expect(await resolve(new Headers({ cookie: 'atrium.session_token=abc' }))).toBeNull();
  });

  it('returns null when the address stops being verified', async () => {
    const resolve = createSessionResolver({
      auth: fakeAuth(() => ({
        session: { id: 's', userId: 'u' },
        user: { email: 'e@x.test', name: 'e', emailVerified: false },
      })),
      logger,
    });
    expect(await resolve(new Headers({ cookie: 'atrium.session_token=abc' }))).toBeNull();
  });

  it('treats a thrown lookup as unknown, not as still-valid', async () => {
    const resolve = createSessionResolver({
      auth: fakeAuth(() => {
        throw new Error('database is on fire');
      }),
      logger,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolve(new Headers({ cookie: 'atrium.session_token=abc' }))).toBeNull();
    error.mockRestore();
  });

  it('returns null even when the thrown value cannot be described', async () => {
    /**
     * The round-9 class sweep, at this site. The `catch` above is the one place
     * in the realtime stack that turns "the database did not answer" into "not
     * authenticated" — and round 8 wrote `(error as Error).message` on the line
     * *before* `return null`. A driver rejecting with a lazily-decoded error
     * object, a Proxy, or anything else with a throwing `message` getter made
     * the resolver **reject** instead of returning the fail-closed verdict.
     *
     * That rejection had somewhere to go. `handleUpgrade` awaits this and had no
     * catch, so the TCP socket was left neither upgraded nor refused — open,
     * attached to nothing — and the rejection reached `index.ts`, which exits the
     * process on an unhandled rejection by design.
     *
     * **Against `fix/auth-r8` this test fails**: the assertion below sees a
     * rejection rather than `null`.
     *
     * Catches: restoring `(error as Error).message` in `createSessionResolver`'s
     * catch — the `resolver-reads-error-message` entry in the mutation ledger.
     */
    const resolve = createSessionResolver({
      auth: fakeAuth(() => {
        throw {
          get message(): string {
            throw new Error('reading this rejection is itself a failure');
          },
        };
      }),
      logger,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(resolve(new Headers({ cookie: 'atrium.session_token=abc' }))).resolves.toBeNull();
    error.mockRestore();
  });
});

describe('toHeaders', () => {
  it('carries a single-valued header across', () => {
    const headers = toHeaders(request({ cookie: 'a=1' }));
    expect(headers.get('cookie')).toBe('a=1');
  });

  it('keeps a repeated header repeated instead of losing one', () => {
    const headers = toHeaders(request({ 'set-cookie': ['a=1', 'b=2'] }));
    expect(headers.get('set-cookie')).toContain('a=1');
    expect(headers.get('set-cookie')).toContain('b=2');
  });

  it('skips headers node reports as undefined', () => {
    const headers = toHeaders(request({ cookie: undefined as unknown as string, host: 'x' }));
    expect(headers.has('cookie')).toBe(false);
    expect(headers.get('host')).toBe('x');
  });
});
