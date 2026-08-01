import { describe, expect, it } from 'vitest';
import { assertProductionSafe, loadEnv, loadMigrationEnv } from '../src/env.js';

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

/**
 * What a production process must state out loud beyond the connection string.
 * `APP_URL` has no safe default there (see `assertProductionSafe`), so a case
 * that means to test *S3* credentials in production has to supply it or it
 * fails on the wrong variable.
 */
const PROD_ORIGIN = { APP_URL: 'https://atrium.example' } as const;

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
      ...PROD_ORIGIN,
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

describe('loadEnv — an unset NODE_ENV is production', () => {
  /**
   * The failure this closes: `docker run atrium-server` on a bare host, no
   * NODE_ENV anywhere, booting happily on a password published in this
   * repository. "Nobody said" is not "development".
   */
  it('refuses to boot with no NODE_ENV and no credentials', () => {
    expect(() => loadEnv({ ...BASE })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => loadEnv({ ...BASE })).toThrow(/unset NODE_ENV is treated as production/);
  });

  it('never hands back the published dev credential without an explicit opt-in', () => {
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'test' }]) {
      let value: string | undefined;
      try {
        value = loadEnv({ ...BASE, ...env }).S3_SECRET_ACCESS_KEY;
      } catch {
        value = undefined;
      }
      expect(value).not.toBe('atrium-dev-secret');
    }
    expect(loadEnv({ ...BASE, NODE_ENV: 'development' }).S3_SECRET_ACCESS_KEY).toBe(
      'atrium-dev-secret',
    );
  });

  it('reports production as the effective environment when none was set', () => {
    const env = loadEnv({
      ...BASE,
      ...PROD_ORIGIN,
      S3_ACCESS_KEY_ID: 'AKIAREAL',
      S3_SECRET_ACCESS_KEY: 'a-real-secret',
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('treats an empty NODE_ENV as unset, not as development', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: '' })).toThrow();
    expect(() => loadEnv({ ...BASE, NODE_ENV: '   ' })).toThrow();
  });
});

describe('loadEnv — whitespace is not a value', () => {
  it('rejects a whitespace-only credential', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        NODE_ENV: 'production',
        S3_ACCESS_KEY_ID: '   ',
        S3_SECRET_ACCESS_KEY: '\t\n',
      }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('rejects a whitespace-only DATABASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: '  ', NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
    expect(() => loadMigrationEnv({ DATABASE_URL: '\n' })).toThrow(/DATABASE_URL/);
  });

  it('trims a credential that arrived with the newline it was pasted with', () => {
    const env = loadEnv({
      ...BASE,
      ...PROD_ORIGIN,
      NODE_ENV: 'production',
      S3_ACCESS_KEY_ID: ' AKIAREAL\n',
      S3_SECRET_ACCESS_KEY: 'a-real-secret ',
    });
    expect(env.S3_ACCESS_KEY_ID).toBe('AKIAREAL');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('a-real-secret');
  });

  it('trims the connection string and the enums too', () => {
    const env = loadEnv({
      DATABASE_URL: ` ${BASE.DATABASE_URL} `,
      NODE_ENV: ' development ',
      LOG_LEVEL: ' debug ',
    });
    expect(env.DATABASE_URL).toBe(BASE.DATABASE_URL);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('rejects a whitespace-only setting that has a default rather than silently blanking it', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        NODE_ENV: 'development',
        S3_BUCKET: '   ',
      }),
    ).toThrow(/S3_BUCKET/);
  });
});

describe('loadMigrationEnv — narrower on purpose', () => {
  it('boots in production on a connection string alone', () => {
    // The migrate service runs the production image with no S3 config at all.
    const env = loadMigrationEnv({ ...BASE, NODE_ENV: 'production' });
    expect(env.DATABASE_URL).toBe(BASE.DATABASE_URL);
    expect(env.NODE_ENV).toBe('production');
  });

  it('still refuses to run without a database', () => {
    expect(() => loadMigrationEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
  });

  it('does not carry S3 settings at all', () => {
    const env = loadMigrationEnv({ ...BASE, NODE_ENV: 'production', S3_BUCKET: 'ignored' });
    expect(env).not.toHaveProperty('S3_BUCKET');
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

/**
 * The auth-shaped half of the same rule.
 *
 * A development default is a convenience in development and a silent
 * misconfiguration in production: a server that starts, reports healthy, and is
 * pointed at the wrong place. `APP_URL` is the sharp one — Better Auth derives
 * cookie rules from it and the WebSocket upgrade checks browsers' `Origin`
 * against it, so a production process defaulted to `http://localhost:3000`
 * refuses every real client while looking configured.
 */
const DEV = { ...BASE, NODE_ENV: 'development' } as const;
const PROD = {
  ...BASE,
  NODE_ENV: 'production',
  S3_ACCESS_KEY_ID: 'AKIAREAL',
  S3_SECRET_ACCESS_KEY: 'a-real-secret',
} as const;

describe('loadEnv — auth and realtime settings', () => {
  it('fills the development defaults in development', () => {
    const env = loadEnv({ ...DEV });
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.SERVER_PORT).toBe(4000);
  });

  it('refuses to fall back to a localhost APP_URL in production', () => {
    expect(() => loadEnv({ ...PROD })).toThrow(/APP_URL/);
  });

  it('is satisfied when production says what its origin is', () => {
    const env = loadEnv({ ...PROD, APP_URL: 'https://atrium.example' });
    expect(env.APP_URL).toBe('https://atrium.example');
  });

  it('refuses origin-less websocket clients unless told otherwise', () => {
    expect(loadEnv({ ...DEV }).WS_ALLOW_ORIGINLESS).toBe(false);
    expect(loadEnv({ ...DEV, WS_ALLOW_ORIGINLESS: 'true' }).WS_ALLOW_ORIGINLESS).toBe(true);
    // Not a boolean-ish free-for-all: an unrecognised value is an error, not a
    // quiet "false" that hides a typo in a security setting.
    expect(() => loadEnv({ ...DEV, WS_ALLOW_ORIGINLESS: 'yes' })).toThrow();
  });

  it('bounds the session revalidation window', () => {
    expect(loadEnv({ ...DEV }).WS_REVALIDATE_TTL_MS).toBe(5_000);
    expect(loadEnv({ ...DEV, WS_REVALIDATE_TTL_MS: '0' }).WS_REVALIDATE_TTL_MS).toBe(0);
    // A socket must not be trustable for an hour on one check.
    expect(() => loadEnv({ ...DEV, WS_REVALIDATE_TTL_MS: '3600000' })).toThrow();
  });
});

describe('assertProductionSafe', () => {
  it('says nothing outside production', () => {
    expect(() =>
      assertProductionSafe({}, { ...loadEnv({ ...DEV }), NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('names the variable rather than failing vaguely', () => {
    expect(() =>
      assertProductionSafe({}, { ...loadEnv({ ...DEV }), NODE_ENV: 'production' }),
    ).toThrow(/APP_URL/);
  });
});
