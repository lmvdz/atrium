import type { IncomingMessage } from 'node:http';
import {
  type AtriumAuth,
  type AtriumSession,
  describeUnknown,
  getAtriumSession,
  guardedErrorLog,
} from '@atrium/auth';
import type { Logger } from './logger.js';

/**
 * The WebSocket trust boundary.
 *
 * Exactly one function decides whether a socket may exist: `authenticateUpgrade`.
 * It runs *before* the handshake completes, so an unauthenticated client is
 * refused with an HTTP 401 and never becomes a connection at all — there is no
 * "connected but anonymous" state for a later handler to forget about.
 *
 * The session it returns is Better Auth's, validated by Better Auth. Nothing
 * here parses a cookie, checks a signature, or reads the session table. That is
 * the whole point: the realtime server and the web app agree on what a session
 * is because they ask the same library the same question.
 *
 * The realtime protocol (#22) builds on this seam and should not widen it.
 */

export type AuthenticateUpgrade = (request: IncomingMessage) => Promise<AtriumSession | null>;

/**
 * Re-asks "is this still a session?" for an already-open socket.
 *
 * A WebSocket is authenticated once, at the handshake, and then lives for as
 * long as the client keeps it open — hours. Round 1 stopped there, so signing
 * out, having a session revoked, or having an account disabled did nothing to a
 * socket that was already up. The connection kept the session object it was
 * born with and every command was judged against a snapshot.
 *
 * `null` means the session is gone and the socket should be closed.
 */
export type RevalidateSession = (headers: Headers) => Promise<AtriumSession | null>;

export interface UpgradeAuthOptions {
  auth: AtriumAuth;
  logger: Logger;
}

export function createUpgradeAuthenticator(options: UpgradeAuthOptions): AuthenticateUpgrade {
  const { logger } = options;
  const resolve = createSessionResolver(options);

  return async function authenticateUpgrade(request) {
    const session = await resolve(toHeaders(request));
    if (!session) {
      logger.warn('ws upgrade rejected: no valid session');
      return null;
    }
    return session;
  };
}

/**
 * The one place a session is turned into an `AtriumSession`, used both at the
 * handshake and on every re-validation, so a socket can never outlive the rules
 * that let it exist. Every failure mode ends in `null`.
 */
export function createSessionResolver(options: UpgradeAuthOptions): RevalidateSession {
  const { auth, logger } = options;
  const logSafely = guardedErrorLog(logger);

  return async function resolveSession(headers) {
    let session: AtriumSession | null;
    try {
      session = await getAtriumSession(auth, headers);
    } catch (error) {
      // A database blip must read as "not authenticated", never as "sure, come
      // in" — and never as "reject with whatever the driver threw", which is
      // what `(error as Error).message` allowed. `return null` is the verdict
      // this catch exists to produce; describing the failure must not be able to
      // stop it being reached. See `@atrium/auth`'s `errors.ts` for the class.
      logSafely('ws session lookup failed', () => ({ error: describeUnknown(error) }));
      return null;
    }

    if (!session) return null;

    // Better Auth already refuses to mint a session for an unverified address
    // (`requireEmailVerification`). Re-checking costs nothing and means the ws
    // surface does not silently inherit a future relaxation of that setting —
    // and because this runs on re-validation too, an address that *becomes*
    // unverified takes its live sockets with it.
    if (!session.emailVerified) {
      logger.warn('ws session rejected: email not verified', { userId: session.userId });
      return null;
    }

    return session;
  };
}

/**
 * Node's `IncomingMessage.headers` into the WHATWG `Headers` Better Auth wants.
 * Repeated headers arrive as arrays and must stay repeated, not be joined.
 */
export function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}
