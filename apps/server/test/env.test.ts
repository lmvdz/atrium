import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

/**
 * Configuration is the one place where "it worked on my laptop" ships a public
 * object store. These tests exist so the development fallback can never quietly
 * become the production value.
 *
 * `loadEnv` is called with an explicit source, so a developer's real `.env` on
 * disk cannot make a failing case pass here.
 */

const BASE = {
  DATABASE_URL: 'postgres://atrium:atrium@localhost:5432/atrium',
} as const;

describe('loadEnv — S3 credentials', () => {
  it('falls back to the dev credentials only under NODE_ENV=development', () => {
    const env = loadEnv({ ...BASE, NODE_ENV: 'development' });
    expect(env.S3_ACCESS_KEY_ID).toBe('atrium');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('atrium-dev-secret');
  });

  it('refuses to boot in production without them', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'production', S3_ACCESS_KEY_ID: 'real-key' }),
    ).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  it('names the variable and the reason, not just "invalid environment"', () => {
    try {
      loadEnv({ ...BASE, NODE_ENV: 'production' });
      expect.unreachable('production without S3 credentials must throw');
    } catch (error) {
      expect((error as Error).message).toContain('S3_ACCESS_KEY_ID');
      expect((error as Error).message).toContain('never applied outside development');
    }
  });

  it('accepts real credentials in production', () => {
    const env = loadEnv({
      ...BASE,
      NODE_ENV: 'production',
      S3_ACCESS_KEY_ID: 'AKIAREAL',
      S3_SECRET_ACCESS_KEY: 'a-real-secret',
    });
    expect(env.S3_ACCESS_KEY_ID).toBe('AKIAREAL');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('a-real-secret');
    expect(env.NODE_ENV).toBe('production');
  });

  it('does not apply the dev fallback under NODE_ENV=test either', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'test' })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('rejects an empty credential rather than treating it as unset-in-production', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        NODE_ENV: 'production',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
      }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });
});

describe('loadEnv — the rest of the contract', () => {
  it('still requires DATABASE_URL', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });

  it('coerces numeric and boolean settings', () => {
    const env = loadEnv({
      ...BASE,
      NODE_ENV: 'development',
      SERVER_PORT: '4100',
      INTERPRET_WORKER_CONCURRENCY: '4',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(env.SERVER_PORT).toBe(4100);
    expect(env.INTERPRET_WORKER_CONCURRENCY).toBe(4);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });
});
