import 'server-only';

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

/** Where the browser reaches this app. Better Auth derives cookie rules from it. */
export function appUrl(): string {
  return required('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
}

export function databaseUrl(): string {
  return required('DATABASE_URL', 'postgres://atrium:atrium@localhost:5432/atrium');
}

/**
 * The realtime server's public origin, if it differs from the app's.
 *
 * Passed to Better Auth as a trusted origin in both processes so the two agree
 * about who "us" is; derived from `NEXT_PUBLIC_WS_URL` because that is the value
 * the browser is actually told to connect to.
 */
export function realtimeOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (!raw) return null;
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
