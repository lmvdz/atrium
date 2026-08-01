import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUrl, proxyStrategy, realtimeOrigin } from '../lib/env';

/**
 * The web app's boot conditions, which had no unit test until round 5.
 *
 * Every accessor here is deliberately lazy — `next build` imports every route
 * module, so a throw at module scope would turn a missing variable into a
 * broken build. That laziness is also what makes them testable: each one can be
 * called with a stubbed environment and asked what it refuses.
 *
 * The rules themselves live in `@atrium/auth` so `apps/server` applies exactly
 * the same ones; these tests are about this app actually *asking*.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Production, and not the `next build` compile phase. */
function serving(values: Record<string, string>): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PHASE', '');
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

describe('appUrl — HTTPS is a boot condition', () => {
  it('refuses an http:// origin in production', () => {
    /**
     * The round-4 delta's blocking finding, on this side. `APP_URL` is the
     * origin session cookies are minted for; on http:// every cookie and every
     * verification link crosses the network readable. Round 4 shipped a compose
     * stack that did exactly that with a comment asking the operator not to.
     *
     * Catches: deleting the `assertSecureTransport` call from `appUrl()`.
     */
    serving({ APP_URL: 'http://atrium.example.com' });
    expect(() => appUrl()).toThrow(/TLS/);
    expect(() => appUrl()).toThrow(/no override/);
  });

  it('accepts an https:// origin, and strips the trailing slash it may arrive with', () => {
    serving({ APP_URL: 'https://atrium.example.com/' });
    expect(appUrl()).toBe('https://atrium.example.com');
  });

  it('still refuses a missing APP_URL, with the other error', () => {
    // The two gates stay separate: "unset" is `required()`'s sentence and
    // "insecure" is the transport rule's. Catches: collapsing them into one
    // message that leaves an operator guessing which one they hit.
    serving({ APP_URL: '' });
    expect(() => appUrl()).toThrow(/required in production/);
  });

  it('leaves development on localhost, so the ordinary loop still signs in', () => {
    // Catches: applying the TLS rule outside production — a rule that fires on
    // a laptop is a rule somebody switches off.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', '');
    expect(appUrl()).toBe('http://localhost:3000');
  });

  it('exempts `next build`, which compiles routes and serves nothing', () => {
    // Catches: dropping the NEXT_PHASE exemption, which would mean an image
    // cannot be built without the production hostname on the build machine.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    expect(appUrl()).toBe('http://localhost:3000');
  });
});

describe('realtimeOrigin — the socket the browser is told to open', () => {
  it('refuses a ws:// realtime URL in production', () => {
    /**
     * A WebSocket carrying a session cookie over `ws://` is the same exposure
     * as a page served over `http://`, so the same rule applies. Judged on the
     * raw value: this function maps `wss:` → `https:` to build an origin, and
     * checking after that mapping would launder `ws://` into something that
     * passes.
     *
     * Catches: moving the assertion below the scheme mapping, or dropping it.
     */
    serving({
      APP_URL: 'https://atrium.example.com',
      NEXT_PUBLIC_WS_URL: 'ws://atrium.example.com/ws',
    });
    expect(() => realtimeOrigin()).toThrow(/TLS/);
  });

  it('accepts wss:// and hands back the https origin Better Auth trusts', () => {
    serving({
      APP_URL: 'https://atrium.example.com',
      NEXT_PUBLIC_WS_URL: 'wss://atrium.example.com/ws',
    });
    expect(realtimeOrigin()).toBe('https://atrium.example.com');
  });

  it('is null when there is no realtime URL at all, rather than throwing', () => {
    // One OAuth-shaped rule: an unset optional value is not a misconfiguration.
    serving({ APP_URL: 'https://atrium.example.com', NEXT_PUBLIC_WS_URL: '' });
    expect(realtimeOrigin()).toBeNull();
  });

  it('leaves a development ws:// URL alone', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'ws://localhost:4000/ws');
    expect(realtimeOrigin()).toBe('http://localhost:4000');
  });
});

describe('proxyStrategy — the rate limiter’s IP dimension', () => {
  it('refuses to serve production without being told what is in front', () => {
    // Round 3's gap, kept covered now that this module has a test at all.
    // Catches: returning `unconfigured` in production instead of throwing.
    serving({ APP_URL: 'https://atrium.example.com', ATRIUM_TRUSTED_PROXY_HOPS: '' });
    expect(() => proxyStrategy()).toThrow(/ATRIUM_TRUSTED_PROXY_HOPS/);
  });

  it('refuses a value it cannot parse, not merely an absent one', () => {
    // Catches: reverting to a presence check — every value below is present.
    for (const hops of ['lots', '-3', '1.5', '0x10']) {
      serving({ APP_URL: 'https://atrium.example.com', ATRIUM_TRUSTED_PROXY_HOPS: hops });
      expect(() => proxyStrategy(), hops).toThrow(/ATRIUM_TRUSTED_PROXY_HOPS/);
    }
  });

  it('accepts a real answer', () => {
    serving({ APP_URL: 'https://atrium.example.com', ATRIUM_TRUSTED_PROXY_HOPS: '1' });
    expect(proxyStrategy().kind).toBe('forwarded');
  });
});
