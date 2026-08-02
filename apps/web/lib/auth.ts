import 'server-only';
import { type AtriumAuth, createAtriumAuth, resolveAuthSecret } from '@atrium/auth';
import { nextCookies } from 'better-auth/next-js';
import { db } from './db';
import { appUrl, githubOAuth, proxyStrategy, realtimeOrigin } from './env';

/**
 * The web app's Better Auth instance: the shared configuration from
 * `@atrium/auth` plus the one piece that is genuinely Next-specific.
 *
 * `nextCookies()` must be the last plugin. It is what lets a Server Action set
 * the session cookie — without it, signing in from a `<form action={...}>`
 * succeeds and then quietly leaves the browser signed out.
 */
const key = Symbol.for('atrium.web.auth');

interface Holder {
  [key]?: AtriumAuth;
}

export function auth(): AtriumAuth {
  const holder = globalThis as unknown as Holder;
  const github = githubOAuth();
  const realtime = realtimeOrigin();
  holder[key] ??= createAtriumAuth({
    db: db(),
    baseURL: appUrl(),
    secret: resolveAuthSecret(process.env),
    // Both processes pass their configured origins, so neither ends up with a
    // laxer notion of "us" than the other.
    trustedOrigins: realtime ? [realtime] : [],
    // The library's own limiter reads the same answer the Server Action
    // throttle does, so the two cannot bucket a caller differently.
    proxyStrategy: proxyStrategy(),
    ...(github ? { github } : {}),
    plugins: [nextCookies()],
  });
  return holder[key];
}

/** True when a GitHub button should be rendered at all. */
export function oauthEnabled(): boolean {
  return githubOAuth() !== null;
}
