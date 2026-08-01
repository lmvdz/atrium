import { describe, expect, it } from 'vitest';
import { checkOrigin, normaliseOrigin } from '../src/origin.js';

const policy = { allowed: ['http://localhost:3000'], allowOriginless: false };

describe('checkOrigin', () => {
  it('allows the app’s own origin', () => {
    expect(checkOrigin('http://localhost:3000', policy)).toBe('allowed');
    // Case and a trailing slash are spelling, not identity.
    expect(checkOrigin('http://LOCALHOST:3000/', policy)).toBe('allowed');
  });

  it('refuses anybody else — this is the cross-site hijack', () => {
    // A WebSocket handshake is not same-origin-protected and carries cookies,
    // so without this any page a signed-in person visits could open an
    // authenticated socket as them.
    expect(checkOrigin('https://evil.test', policy)).toBe('forbidden');
    expect(checkOrigin('http://localhost:3001', policy)).toBe('forbidden');
    expect(checkOrigin('https://localhost:3000', policy)).toBe('forbidden');
    expect(checkOrigin('http://localhost:3000.evil.test', policy)).toBe('forbidden');
  });

  it('refuses the literal "null" origin a sandboxed frame sends', () => {
    // It is a value, not an absence: it must not take the origin-less branch.
    expect(checkOrigin('null', policy)).toBe('forbidden');
    expect(checkOrigin('null', { ...policy, allowOriginless: true })).toBe('forbidden');
  });

  it('reports a missing origin separately, and refuses it by default', () => {
    expect(checkOrigin(undefined, policy)).toBe('missing');
    expect(checkOrigin(null, policy)).toBe('missing');
    expect(checkOrigin('   ', policy)).toBe('missing');
  });

  it('lets a deployment opt in to non-browser clients explicitly', () => {
    expect(checkOrigin(undefined, { ...policy, allowOriginless: true })).toBe('allowed');
  });

  it('refuses garbage rather than parsing it optimistically', () => {
    expect(checkOrigin('not-a-url', policy)).toBe('forbidden');
    expect(checkOrigin('//localhost:3000', policy)).toBe('forbidden');
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(checkOrigin('http://localhost:3000', { allowed: [], allowOriginless: false })).toBe(
      'forbidden',
    );
  });
});

describe('normaliseOrigin', () => {
  it('reduces an origin to scheme and host', () => {
    // The default port for the scheme is dropped, which is what a browser puts
    // in the header too — `https://x` and `https://x:443` are one origin.
    expect(normaliseOrigin('https://Atrium.test:443/path?q=1')).toBe('https://atrium.test');
    expect(normaliseOrigin('http://atrium.test')).toBe('http://atrium.test');
    expect(normaliseOrigin('http://atrium.test:8080/')).toBe('http://atrium.test:8080');
  });

  it('is null for anything that is not one', () => {
    expect(normaliseOrigin('')).toBeNull();
    expect(normaliseOrigin('null')).toBeNull();
    expect(normaliseOrigin('atrium.test')).toBeNull();
  });
});
