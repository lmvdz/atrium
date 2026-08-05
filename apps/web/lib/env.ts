import 'server-only';

import { assertSecureTransport, type ProxyStrategy, trustedProxyStrategy } from '@atrium/auth';

/**
 * Server-side configuration for the web app.
 *
 * Deliberately lazy: `next build` imports every route module, so anything that
 * throws at module scope turns a missing environment variable into a broken
 * build rather than a clear runtime error. Each accessor is called on the
 * request path instead.
 *
 * **Fail closed in production.** Round 1 gave `APP_URL` and `DATABASE_URL`
 * localhost defaults in every environment, which is a much worse failure than a
 * missing variable: a production web app silently minting cookies for
 * `http://localhost:3000` does not error, it just quietly signs nobody in — and
 * a `DATABASE_URL` default is a production process pointed at whatever happens
 * to answer on 5432. `apps/server` already refuses to start without them; this
 * file now matches it, including how it decides what "production" is.
 */

/**
 * The environment name, from the process environment only.
 *
 * Not from a `.env` file, not from an argument, and not overridable by a
 * caller: "am I in production?" is the question every fail-closed rule below
 * hangs on, so it must not be answerable by anything that a request could
 * influence. `next build` sets `NODE_ENV=production` while compiling, which is
 * why `NEXT_PHASE` is checked alongside it.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** True while `next build` is compiling route modules, serving no request. */
export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * A required value, with a development-only fallback.
 *
 * The fallback applies in development and test. In production it does not
 * exist, and the process says which variable is missing rather than pretending
 * to have one — except during `next build`, which compiles this module without
 * ever serving a request and must not need production credentials to do it.
 */
function required(name: string, developmentFallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;

  if (isProduction() && !isBuildPhase()) {
    throw new Error(
      `${name} is required in production. Atrium will not fall back to a ` +
        'development default here: a localhost default in production is a ' +
        'process that starts, looks healthy, and is wrong.',
    );
  }

  if (developmentFallback !== undefined) return developmentFallback;
  throw new Error(`${name} is required — copy .env.example to .env`);
}

/**
 * Where the browser reaches this app. Better Auth derives cookie rules from it.
 *
 * In production it must be `https://`. That is not a preference about
 * deployment style — it is the origin session cookies are minted for, and an
 * `http://` value means every cookie, verification link and invitation link
 * this app issues crosses the network in the clear. Round 4 shipped exactly
 * that (`deploy/Caddyfile` on `:80`, this default) with a comment asking the
 * operator to change it; `assertSecureTransport` is the control that comment
 * was pretending to be. See `packages/auth/src/transport.ts` — the rule is
 * shared with `apps/server` so the two processes cannot disagree, and there is
 * no override.
 */
export function appUrl(): string {
  const value = required('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
  assertSecureTransport([{ name: 'APP_URL', value }]);
  return value;
}

export function databaseUrl(): string {
  return required('DATABASE_URL', 'postgres://atrium:atrium@localhost:5432/atrium');
}

/**
 * What is in front of this process, for the rate limiter's IP dimension.
 *
 * Required in production, exactly like `APP_URL`, and for the same reason: an
 * unset value is not a safe default, it is a limiter running on one dimension
 * while looking like it has two. This asks the *parser*, not whether the
 * variable is present — `hops=lots` is an answer nobody can act on, and
 * `apps/server/src/env.ts` now asks the same question the same way after round
 * 3 shipped a presence-only gate there.
 *
 * Thrown from here rather than at module load for the reason the whole file is
 * lazy: `next build` imports every route module, and a build machine must not
 * need production configuration to compile one.
 *
 * **The honest limit, said out loud rather than buried.** Under `hops=0` the
 * caller's address is the socket's peer address, and a Next Server Action has no
 * way to see it — `headers()` is the whole request, and Next fills
 * `x-forwarded-for` from the peer *only when the client sent none*, so a present
 * value is either the peer or entirely attacker-written with no way to tell.
 * Reading it would be the forged dimension `client-ip.ts` refuses.
 *
 * So `hops=0` on this path means no address is resolvable — and round 3's
 * mistake was letting that mean *no limit*. It does not any more: an
 * unresolvable caller is counted against one shared bucket (`unresolvedIpKey`,
 * see `app/(auth)/actions.ts`), so the dimension degrades from per-address to
 * one global cap instead of degrading to nothing. `docker-compose.yml` puts a
 * reverse proxy in front of this process and sets `hops=1` precisely so the
 * shipped deployment gets the per-address version. `apps/server`'s WebSocket
 * upgrade has a genuine socket address and never had this limitation.
 */
export function proxyStrategy(): ProxyStrategy {
  const strategy = trustedProxyStrategy(process.env);
  if (strategy.kind !== 'unconfigured') return strategy;

  if (isProduction() && !isBuildPhase()) {
    throw new Error(
      'ATRIUM_TRUSTED_PROXY_HOPS is required in production. Say what is in front of this ' +
        'process: 0 for a directly published port, or the number of reverse proxies that ' +
        'append to X-Forwarded-For. Leaving it unset silently disables the rate limiter’s ' +
        'IP dimension, which is the failure this check exists to make loud.',
    );
  }
  return strategy;
}

/**
 * The realtime server's public origin, if it differs from the app's.
 *
 * Passed to Better Auth as a trusted origin in both processes so the two agree
 * about who "us" is; derived from `ATRIUM_WS_URL` because that is the value
 * the browser is actually told to connect to.
 *
 * And judged on the raw value, before the scheme is mapped: `wss://` is the
 * secure form, and mapping it to `https://` first would launder a `ws://`
 * setting into an origin that passes the check. A socket carrying a session
 * cookie over `ws://` is the same exposure as a page served over `http://`, so
 * in production this refuses to start too.
 */
export function realtimeOrigin(): string | null {
  const raw = process.env.ATRIUM_WS_URL?.trim();
  if (!raw) return null;
  assertSecureTransport([{ name: 'ATRIUM_WS_URL', value: raw }]);
  try {
    const url = new URL(raw);
    const scheme = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${scheme}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * GitHub OAuth, if it is configured. Returning null rather than throwing is the
 * point: one OAuth provider is a feature, not a prerequisite, and a fresh clone
 * must be able to sign up with an email address and nothing else.
 */
export function githubOAuth(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
