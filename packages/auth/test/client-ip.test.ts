import { describe, expect, it } from 'vitest';
import { clientIp, trustedProxyHops } from '../src/client-ip.js';

const headers = (values: Record<string, string>) => new Headers(values);

describe('clientIp with no trusted proxy', () => {
  it('uses the socket address and ignores the forwarded headers entirely', () => {
    // The headers are a lie until something in front of us rewrites them.
    // Believing them by default lets one attacker look like a million callers,
    // which is worse for a rate limiter than having no IP dimension at all.
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { socketAddress: '203.0.113.5' }),
    ).toBe('203.0.113.5');
  });

  it('is null when there is nothing trustworthy to go on', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {})).toBeNull();
  });
});

describe('clientIp behind trusted proxies', () => {
  it('counts from the right, so a spoofed prefix is skipped', () => {
    // The caller sent "1.1.1.1"; our own proxy appended the real address.
    expect(
      clientIp(headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5' }), { trustProxyHops: 1 }),
    ).toBe('203.0.113.5');
  });

  it('walks back one entry per trusted hop', () => {
    const chain = headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5, 10.0.0.1' });
    expect(clientIp(chain, { trustProxyHops: 1 })).toBe('10.0.0.1');
    expect(clientIp(chain, { trustProxyHops: 2 })).toBe('203.0.113.5');
  });

  it('clamps rather than falling off the left of a short chain', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.5' }), { trustProxyHops: 3 })).toBe(
      '203.0.113.5',
    );
  });

  it('falls back to x-real-ip, then to the socket', () => {
    expect(clientIp(headers({ 'x-real-ip': '198.51.100.7' }), { trustProxyHops: 1 })).toBe(
      '198.51.100.7',
    );
    expect(clientIp(headers({}), { trustProxyHops: 1, socketAddress: '203.0.113.5' })).toBe(
      '203.0.113.5',
    );
  });
});

describe('normalisation', () => {
  it('collapses the IPv4-mapped form so one caller is one bucket', () => {
    expect(clientIp(headers({}), { socketAddress: '::ffff:203.0.113.5' })).toBe('203.0.113.5');
  });

  it('strips a port without mangling a bare IPv6 address', () => {
    expect(clientIp(headers({}), { socketAddress: '203.0.113.5:51234' })).toBe('203.0.113.5');
    expect(clientIp(headers({}), { socketAddress: '[2001:db8::1]:443' })).toBe('2001:db8::1');
    expect(clientIp(headers({}), { socketAddress: '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('treats blank entries as absent', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '  ,  ' }), { trustProxyHops: 1 })).toBeNull();
    expect(clientIp(headers({}), { socketAddress: '   ' })).toBeNull();
  });
});

describe('trustedProxyHops', () => {
  it('trusts nothing unless the deployment says otherwise', () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ ATRIUM_TRUSTED_PROXY_HOPS: '' })).toBe(0);
    expect(trustedProxyHops({ ATRIUM_TRUSTED_PROXY_HOPS: 'lots' })).toBe(0);
    expect(trustedProxyHops({ ATRIUM_TRUSTED_PROXY_HOPS: '-3' })).toBe(0);
  });

  it('reads a real value and clamps an absurd one', () => {
    expect(trustedProxyHops({ ATRIUM_TRUSTED_PROXY_HOPS: '1' })).toBe(1);
    expect(trustedProxyHops({ ATRIUM_TRUSTED_PROXY_HOPS: '500' })).toBe(8);
  });
});
