/**
 * Where the signing secret comes from.
 *
 * `BETTER_AUTH_SECRET` signs session cookies and hashes verification tokens.
 * The web app and the realtime server must agree on it exactly — a mismatch
 * does not fail loudly, it just makes every WebSocket upgrade look unauthorized,
 * which is a miserable afternoon. Hence one resolver, used by both.
 */

export const MIN_SECRET_LENGTH = 32;

/**
 * Obviously-fake, and it says so. Used only when no secret is configured and we
 * are provably not serving production traffic.
 */
export const developmentSecret = 'atrium-development-secret-not-for-production';

export interface SecretSource {
  BETTER_AUTH_SECRET?: string | undefined;
  NODE_ENV?: string | undefined;
  /**
   * Next sets this to `phase-production-build` while `next build` runs. A build
   * compiles route modules — including the one that constructs the auth
   * instance — but serves no request and validates no session, so requiring a
   * production secret there would only mean "you cannot build an image without
   * the production secret on the build machine", which is worse security, not
   * better.
   */
  NEXT_PHASE?: string | undefined;
}

export function resolveAuthSecret(env: SecretSource = process.env): string {
  const secret = env.BETTER_AUTH_SECRET?.trim();

  if (secret) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `BETTER_AUTH_SECRET is ${secret.length} characters; at least ${MIN_SECRET_LENGTH} are ` +
          'required. Generate one with `openssl rand -base64 32`.',
      );
    }
    return secret;
  }

  const building = env.NEXT_PHASE === 'phase-production-build';
  if (env.NODE_ENV === 'production' && !building) {
    throw new Error(
      'BETTER_AUTH_SECRET is required in production. Generate one with ' +
        '`openssl rand -base64 32` and set it on every process that serves ' +
        'Atrium — the web app and the realtime server must share the same value.',
    );
  }

  if (env.NODE_ENV !== 'test') {
    console.warn(
      '[atrium/auth] BETTER_AUTH_SECRET is not set — falling back to the ' +
        'development secret. Sessions signed with it are not secret.',
    );
  }
  return developmentSecret;
}
