import 'server-only';

/**
 * Server-side configuration for the web app.
 *
 * Deliberately tiny and lazy: `next build` imports every route module, so
 * anything that throws at module scope here turns a missing environment
 * variable into a broken build rather than a clear runtime error.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
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
