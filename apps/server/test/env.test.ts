import { describe, expect, it } from 'vitest';
import { assertProductionSafe, loadEnv } from '../src/env.js';

/**
 * Configuration that fails closed.
 *
 * A development default is a convenience in development and a silent
 * misconfiguration in production: a server that starts, reports healthy, and is
 * pointed at the wrong place. `APP_URL` is the sharp one — Better Auth derives
 * cookie rules from it and the WebSocket upgrade checks browsers' `Origin`
 * against it, so a production process defaulted to `http://localhost:3000`
 * refuses every real client while looking configured.
 */

const base = { DATABASE_URL: 'postgres://atrium:atrium@localhost:5432/atrium' };

describe('loadEnv', () => {
  it('fills the development defaults in development', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.SERVER_PORT).toBe(4000);
  });

  it('refuses a missing DATABASE_URL in any environment', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });

  it('refuses to fall back to a localhost APP_URL in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/APP_URL/);
  });

  it('is satisfied when production says what its origin is', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production', APP_URL: 'https://atrium.example' });
    expect(env.APP_URL).toBe('https://atrium.example');
  });

  it('refuses origin-less websocket clients unless told otherwise', () => {
    expect(loadEnv({ ...base }).WS_ALLOW_ORIGINLESS).toBe(false);
    expect(loadEnv({ ...base, WS_ALLOW_ORIGINLESS: 'true' }).WS_ALLOW_ORIGINLESS).toBe(true);
    // Not a boolean-ish free-for-all: an unrecognised value is an error, not a
    // quiet "false" that hides a typo in a security setting.
    expect(() => loadEnv({ ...base, WS_ALLOW_ORIGINLESS: 'yes' })).toThrow();
  });

  it('bounds the session revalidation window', () => {
    expect(loadEnv({ ...base }).WS_REVALIDATE_TTL_MS).toBe(5_000);
    expect(loadEnv({ ...base, WS_REVALIDATE_TTL_MS: '0' }).WS_REVALIDATE_TTL_MS).toBe(0);
    // A socket must not be trustable for an hour on one check.
    expect(() => loadEnv({ ...base, WS_REVALIDATE_TTL_MS: '3600000' })).toThrow();
  });
});

describe('assertProductionSafe', () => {
  it('says nothing outside production', () => {
    expect(() =>
      assertProductionSafe({}, { ...loadEnv({ ...base }), NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('names the variable rather than failing vaguely', () => {
    expect(() =>
      assertProductionSafe({}, { ...loadEnv({ ...base }), NODE_ENV: 'production' }),
    ).toThrow(/APP_URL/);
  });
});
