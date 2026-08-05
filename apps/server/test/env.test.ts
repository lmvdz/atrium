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
const PROD_ORIGIN = {
  APP_URL: 'https://atrium.example',
  ATRIUM_TRUSTED_PROXY_HOPS: '1',
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
 * The interpretation worker's configuration (#23), and the one value in this
 * schema that deliberately has no default at all.
 */
describe('loadEnv — the interpretation worker', () => {
  /**
   * Mutation: give either model id a `.default(…)`. A model id compiled into
   * this file is one a deployment cannot see and cannot override, and its wrong
   * value is the invisible kind: the worker keeps running and bills a model
   * nobody chose. `index.ts` reads `undefined` as "do not schedule
   * interpretation, and say so at error level" — a degradation an operator can
   * find, which a silently-wrong default is not.
   *
   * Asserted as `toBeUndefined` on a fully-populated development environment,
   * because that is the case a default would quietly satisfy.
   */
  it('has no default model id, in development or anywhere else', () => {
    const env = loadEnv({ ...BASE, NODE_ENV: 'development' });
    expect(env.INTERPRET_MODEL_DEFAULT).toBeUndefined();
    expect(env.INTERPRET_MODEL_ESCALATION).toBeUndefined();
  });

  it('takes both ids from the environment when they are given', () => {
    const env = loadEnv({
      ...BASE,
      NODE_ENV: 'development',
      INTERPRET_MODEL_DEFAULT: 'vendor/cheap',
      INTERPRET_MODEL_ESCALATION: 'vendor/strong',
    });
    expect(env.INTERPRET_MODEL_DEFAULT).toBe('vendor/cheap');
    expect(env.INTERPRET_MODEL_ESCALATION).toBe('vendor/strong');
  });

  /**
   * Mutation: select the deterministic provider with only one environment
   * switch. A typo in deployment would then replace semantic interpretation
   * with a fixture parser while the process still reported healthy.
   */
  it('requires an explicit acceptance opt-in and the exact receipt model', () => {
    const selected = {
      ...BASE,
      NODE_ENV: 'development',
      INTERPRET_PROVIDER: 'acceptance-deterministic',
      INTERPRET_MODEL_DEFAULT: 'acceptance/deterministic-v1',
      INTERPRET_MODEL_ESCALATION: 'acceptance/deterministic-v1',
    } as const;
    expect(() => loadEnv(selected)).toThrow(/ATRIUM_ACCEPTANCE_MODE/);
    expect(() =>
      loadEnv({ ...selected, ATRIUM_ACCEPTANCE_MODE: 'enabled', INTERPRET_MODEL_DEFAULT: 'other' }),
    ).toThrow(/both must be acceptance\/deterministic-v1/);
    expect(() =>
      loadEnv({
        ...selected,
        ATRIUM_ACCEPTANCE_MODE: 'enabled',
        AI_GATEWAY_API_KEY: 'configured-but-must-not-be-usable-here',
      }),
    ).toThrow(/AI_GATEWAY_API_KEY.*must be unset/);
    expect(loadEnv({ ...selected, ATRIUM_ACCEPTANCE_MODE: 'enabled' }).INTERPRET_PROVIDER).toBe(
      'acceptance-deterministic',
    );
  });

  /**
   * Mutation: let `INTERPRET_CONTEXT_MESSAGES` be 0. Zero history is not "less
   * context" — it is the `reply_blockquote` trigger unable to name which
   * earlier message a quote-reply points at, and a receipt window that starts
   * at the first unread line. Both degrade silently while looking configured,
   * which is the shape every other bound in this file refuses.
   */
  it('refuses a zero-length history window rather than treating it as "off"', () => {
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'development', INTERPRET_CONTEXT_MESSAGES: '0' }),
    ).toThrow(/INTERPRET_CONTEXT_MESSAGES/);
  });

  /**
   * Mutation: allow a zero-second coalescing window. pg-boss's debounce is
   * whole seconds, so zero is "run immediately on the first message" — one
   * provider call per message, which is the cost profile the whole queue design
   * exists to avoid, reached by setting one number to a plausible value.
   */
  it('refuses a zero-second coalescing window', () => {
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'development', INTERPRET_COALESCE_SECONDS: '0' }),
    ).toThrow(/INTERPRET_COALESCE_SECONDS/);
    expect(
      loadEnv({ ...BASE, NODE_ENV: 'development', INTERPRET_COALESCE_SECONDS: '30' })
        .INTERPRET_COALESCE_SECONDS,
    ).toBe(30);
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
    const env = loadEnv({ ...PROD, ...PROD_ORIGIN });
    expect(env.APP_URL).toBe('https://atrium.example');
  });

  /**
   * The rate limiter's second dimension, made honest.
   *
   * A process that binds a port has a peer address for every caller, but only
   * the deployment can say whether that address is the caller or a proxy's.
   * Round 2 read "unset" as 0 and 0 as "dimension off", so the compose stack
   * shipped a limiter counting one dimension while looking like it had two.
   */
  it('refuses to start in production without being told what is in front of it', () => {
    expect(() => loadEnv({ ...PROD, APP_URL: 'https://atrium.example' })).toThrow(
      /ATRIUM_TRUSTED_PROXY_HOPS/,
    );
    expect(() => loadEnv({ ...PROD, APP_URL: 'https://atrium.example' })).toThrow(/Unset is not 0/);
  });

  /**
   * Blocking finding, round 4 delta: the shipped compose served production auth
   * over plaintext, and `deploy/Caddyfile` asked the operator to fix it in a
   * comment. `APP_URL` is where that reaches this process — it is the origin
   * session cookies are minted for and the origin the WebSocket upgrade checks
   * a browser's `Origin` against, so `http://` there means every session cookie
   * crosses the network readable.
   *
   * The rule itself lives in `@atrium/auth` (`isSecureUrl`), so this process and
   * `apps/web` cannot end up with two definitions of "secure enough to serve".
   */
  it('refuses an http:// APP_URL in production, set or not', () => {
    // Catches: deleting the scheme check from `assertProductionSafe` — every
    // value below is present and non-empty, so the presence gate above passes
    // all three.
    for (const url of ['http://atrium.example', 'http://localhost:3000', 'ws://atrium.example']) {
      expect(() => loadEnv({ ...PROD, APP_URL: url, ATRIUM_TRUSTED_PROXY_HOPS: '1' })).toThrow(
        /APP_URL/,
      );
      expect(() => loadEnv({ ...PROD, APP_URL: url, ATRIUM_TRUSTED_PROXY_HOPS: '1' })).toThrow(
        /https:\/\//,
      );
    }
  });

  it('says which value it refused, so the fix is one read of the error', () => {
    // Catches: a generic "invalid environment" that makes an operator go
    // looking. Same standard the proxy-hops message already meets.
    expect(() =>
      loadEnv({ ...PROD, APP_URL: 'http://atrium.example', ATRIUM_TRUSTED_PROXY_HOPS: '1' }),
    ).toThrow(/got http:\/\/atrium\.example/);
  });

  it('leaves development alone, so a laptop still boots on localhost', () => {
    // Catches: applying the TLS rule outside production, which would break
    // `pnpm dev` and get the rule switched off.
    expect(loadEnv({ ...DEV }).APP_URL).toBe('http://localhost:3000');
  });

  it('accepts 0 as a real answer — a published port has nothing in front of it', () => {
    const env = loadEnv({
      ...PROD,
      APP_URL: 'https://atrium.example',
      ATRIUM_TRUSTED_PROXY_HOPS: '0',
    });
    expect(env.NODE_ENV).toBe('production');
  });

  /**
   * Blocking finding 2, half one: the gate has to ask the *parser*.
   *
   * Round 3's check was `!source[name]?.trim()` — presence. Every value below is
   * present, truthy, and refused by `trustedProxyStrategy`, which degrades to
   * `unconfigured`. So a production process booted, called itself configured,
   * and ran with `clientIp` returning null for every caller: the exact failure
   * the gate exists to make loud, reached through the gate itself. grok found it
   * in round 3's gauntlet. `apps/web/lib/env.ts` has always asked the parser.
   *
   * Catches: reverting `assertProductionSafe` to a presence check — every case
   * here starts passing.
   */
  it('refuses a value it cannot parse, not just a missing one', () => {
    for (const value of ['lots', '-3', '1.5', '0x10', 'one', '3 hops']) {
      expect(
        () =>
          loadEnv({
            ...PROD,
            APP_URL: 'https://atrium.example',
            ATRIUM_TRUSTED_PROXY_HOPS: value,
          }),
        value,
      ).toThrow(/ATRIUM_TRUSTED_PROXY_HOPS/);
      expect(
        () =>
          loadEnv({
            ...PROD,
            APP_URL: 'https://atrium.example',
            ATRIUM_TRUSTED_PROXY_HOPS: value,
          }),
        value,
      ).toThrow(/set but unreadable/);
    }
  });

  it('accepts the values that do parse, including a large clamped one', () => {
    for (const value of ['0', '1', '2', '500']) {
      expect(() =>
        loadEnv({
          ...PROD,
          APP_URL: 'https://atrium.example',
          ATRIUM_TRUSTED_PROXY_HOPS: value,
        }),
      ).not.toThrow();
    }
  });

  it('says nothing about it outside production', () => {
    expect(() => loadEnv({ ...DEV })).not.toThrow();
    // …including for a value production would refuse: development is where
    // somebody is mid-way through typing one.
    expect(() => loadEnv({ ...DEV, ATRIUM_TRUSTED_PROXY_HOPS: 'lots' })).not.toThrow();
  });

  /**
   * Major finding 4's configuration half. Both bounds exist so the sweep's
   * tolerance for a dependency that will not answer is finite; neither has an
   * "off" value, for the same reason `WS_SWEEP_INTERVAL_MS` does not.
   *
   * Catches: giving either field a `.optional()` or a zero floor.
   */
  it('bounds how long an unverifiable socket is tolerated', () => {
    expect(loadEnv({ ...DEV }).WS_SWEEP_FAILURE_LIMIT).toBe(3);
    expect(loadEnv({ ...DEV }).WS_SWEEP_UNVERIFIED_MS).toBe(60_000);
    expect(loadEnv({ ...DEV, WS_SWEEP_FAILURE_LIMIT: '5' }).WS_SWEEP_FAILURE_LIMIT).toBe(5);
    expect(loadEnv({ ...DEV, WS_SWEEP_UNVERIFIED_MS: '5000' }).WS_SWEEP_UNVERIFIED_MS).toBe(5_000);
    expect(() => loadEnv({ ...DEV, WS_SWEEP_FAILURE_LIMIT: '0' })).toThrow();
    expect(() => loadEnv({ ...DEV, WS_SWEEP_UNVERIFIED_MS: '0' })).toThrow();
  });

  it('bounds the idle sweep instead of offering a way to turn it off', () => {
    expect(loadEnv({ ...DEV }).WS_SWEEP_INTERVAL_MS).toBe(15_000);
    expect(loadEnv({ ...DEV, WS_SWEEP_INTERVAL_MS: '2000' }).WS_SWEEP_INTERVAL_MS).toBe(2_000);
    // A sweep nobody runs is the behaviour this exists to close, so 0 is not a
    // value — and neither is an interval long enough to be one.
    expect(() => loadEnv({ ...DEV, WS_SWEEP_INTERVAL_MS: '0' })).toThrow();
    expect(() => loadEnv({ ...DEV, WS_SWEEP_INTERVAL_MS: '600000' })).toThrow();
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
