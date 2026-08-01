import { describe, expect, it } from 'vitest';
import { ipHeadersFor } from '../src/auth.js';
import {
  clientIp,
  hasProxyStrategy,
  type ProxyStrategy,
  trustedProxyStrategy,
} from '../src/client-ip.js';

const headers = (values: Record<string, string>) => new Headers(values);

const unconfigured: ProxyStrategy = { kind: 'unconfigured' };
const socketOnly: ProxyStrategy = { kind: 'socket' };
const behind = (hops: number): ProxyStrategy => ({ kind: 'forwarded', hops });

/**
 * Three states, not two. Round 2 had `hops` as a number with 0 meaning both
 * "nobody configured this" and "there is nothing in front of me" — so the
 * compose deployment, which genuinely has nothing in front of it, got the
 * treatment meant for an undescribed one and counted nothing.
 */
describe('an unconfigured process believes nothing', () => {
  it('returns null even when it has a socket address', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: unconfigured,
        socketAddress: '203.0.113.5',
      }),
    ).toBeNull();
  });

  it('is the default, so a caller that forgets to say gets no address', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {})).toBeNull();
  });
});

describe('clientIp with nothing in front of it (hops=0)', () => {
  it('uses the socket address — which is the caller, on a bare host', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: socketOnly,
        socketAddress: '203.0.113.5',
      }),
    ).toBe('203.0.113.5');
  });

  it('ignores the forwarded headers entirely rather than half-believing them', () => {
    // The headers are a lie until something in front of us rewrites them.
    // Believing them here would let one attacker look like a million callers,
    // which is worse for a rate limiter than having no IP dimension at all.
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }), {
        strategy: socketOnly,
      }),
    ).toBeNull();
  });
});

describe('clientIp behind trusted proxies', () => {
  it('counts from the right, so a spoofed prefix is skipped', () => {
    // The caller sent "1.1.1.1"; our own proxy appended the real address.
    expect(
      clientIp(headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5' }), { strategy: behind(1) }),
    ).toBe('203.0.113.5');
  });

  it('walks back one entry per trusted hop', () => {
    const chain = headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5, 10.0.0.1' });
    expect(clientIp(chain, { strategy: behind(1) })).toBe('10.0.0.1');
    expect(clientIp(chain, { strategy: behind(2) })).toBe('203.0.113.5');
  });

  it('refuses a chain shorter than the configured hop count', () => {
    /**
     * Round 2 clamped the index to 0 here and returned the leftmost entry —
     * which is the *caller's* entry. A client sending `X-Forwarded-For: 9.9.9.9`
     * to a `hops=1` deployment whose proxy did not in fact append got to name
     * its own address, which is the forged dimension the whole file exists to
     * refuse. Short chain now means "unreadable", and unreadable falls back to
     * the socket, or to nothing.
     */
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: behind(3),
        socketAddress: '203.0.113.5',
      }),
    ).toBe('203.0.113.5');
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { strategy: behind(3) })).toBeNull();
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { strategy: behind(2) })).toBeNull();
  });

  it('falls back to x-real-ip, then to the socket', () => {
    expect(clientIp(headers({ 'x-real-ip': '198.51.100.7' }), { strategy: behind(1) })).toBe(
      '198.51.100.7',
    );
    expect(clientIp(headers({}), { strategy: behind(1), socketAddress: '203.0.113.5' })).toBe(
      '203.0.113.5',
    );
  });
});

describe('normalisation', () => {
  it('collapses the IPv4-mapped form so one caller is one bucket', () => {
    expect(
      clientIp(headers({}), { strategy: socketOnly, socketAddress: '::ffff:203.0.113.5' }),
    ).toBe('203.0.113.5');
  });

  it('strips a port without mangling a bare IPv6 address', () => {
    const at = (socketAddress: string) =>
      clientIp(headers({}), { strategy: socketOnly, socketAddress });
    expect(at('203.0.113.5:51234')).toBe('203.0.113.5');
    expect(at('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(at('2001:db8::1')).toBe('2001:db8::1');
  });

  it('treats blank entries as absent', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '  ,  ' }), { strategy: behind(1) })).toBeNull();
    expect(clientIp(headers({}), { strategy: socketOnly, socketAddress: '   ' })).toBeNull();
  });
});

describe('trustedProxyStrategy', () => {
  it('treats "nobody said" as unconfigured, not as zero', () => {
    for (const value of [undefined, '', '   ', 'lots', '-3', '1.5', '0x0']) {
      const env = value === undefined ? {} : { ATRIUM_TRUSTED_PROXY_HOPS: value };
      expect(trustedProxyStrategy(env), String(value)).toEqual({ kind: 'unconfigured' });
      expect(hasProxyStrategy(env)).toBe(false);
    }
  });

  it('reads an explicit zero as "trust the socket", which is a real configuration', () => {
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '0' })).toEqual({ kind: 'socket' });
    expect(hasProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '0' })).toBe(true);
  });

  it('reads a real hop count and clamps an absurd one', () => {
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '1' })).toEqual({
      kind: 'forwarded',
      hops: 1,
    });
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '500' })).toEqual({
      kind: 'forwarded',
      hops: 8,
    });
  });
});

/**
 * Better Auth's own limiter reads the same answer, from the same setting.
 *
 * Two limiters disagreeing about who the caller is would be the same defect
 * class as a guard disagreeing with a router: one of them ends up counting
 * something the other does not. `getIp` in `better-auth@1.6.x` trusts a
 * single-value `x-forwarded-for` outright when no `trustedProxies` are set, so
 * handing it that header while `client-ip.ts` refuses to believe it is exactly
 * the disagreement to avoid.
 */
describe('ipHeadersFor — what the library is allowed to read', () => {
  it('gives it nothing when nothing in front of us can be believed', () => {
    expect(ipHeadersFor(unconfigured)).toEqual([]);
    expect(ipHeadersFor(socketOnly)).toEqual([]);
  });

  it('gives it the forwarded chain only behind a real proxy', () => {
    expect(ipHeadersFor(behind(1))).toEqual(['x-forwarded-for', 'x-real-ip']);
  });
});
