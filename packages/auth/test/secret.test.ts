import { describe, expect, it } from 'vitest';
import { developmentSecret, MIN_SECRET_LENGTH, resolveAuthSecret } from '../src/secret.js';

const good = 'x'.repeat(MIN_SECRET_LENGTH);

describe('resolveAuthSecret', () => {
  it('uses a configured secret', () => {
    expect(resolveAuthSecret({ BETTER_AUTH_SECRET: good, NODE_ENV: 'production' })).toBe(good);
  });

  it('trims surrounding whitespace, which .env files love to add', () => {
    expect(resolveAuthSecret({ BETTER_AUTH_SECRET: `  ${good}  `, NODE_ENV: 'test' })).toBe(good);
  });

  it('rejects a secret too short to be worth signing with', () => {
    expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: 'short', NODE_ENV: 'test' })).toThrow(
      /at least 32/,
    );
  });

  it('refuses to serve production traffic without one', () => {
    expect(() => resolveAuthSecret({ NODE_ENV: 'production' })).toThrow(/required in production/);
    // Whitespace is not a secret.
    expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: '   ', NODE_ENV: 'production' })).toThrow(
      /required in production/,
    );
  });

  it('allows a production *build* without one — a build serves no session', () => {
    expect(
      resolveAuthSecret({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }),
    ).toBe(developmentSecret);
  });

  it('falls back to the development secret in development', () => {
    expect(resolveAuthSecret({ NODE_ENV: 'development' })).toBe(developmentSecret);
  });

  it('ships a fallback that says out loud what it is', () => {
    expect(developmentSecret).toMatch(/development/);
    expect(developmentSecret).toMatch(/not-for-production/);
    expect(developmentSecret.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
  });
});
