import type { IncomingMessage } from 'node:http';
import { type AtriumAuth, type AtriumSession, getAtriumSession } from '@atrium/auth';
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

export interface UpgradeAuthOptions {
  auth: AtriumAuth;
  logger: Logger;
}

export function createUpgradeAuthenticator(options: UpgradeAuthOptions): AuthenticateUpgrade {
  const { auth, logger } = options;

  return async function authenticateUpgrade(request) {
    let session: AtriumSession | null;
    try {
      session = await getAtriumSession(auth, toHeaders(request));
    } catch (error) {
      // A database blip must read as "not authenticated", never as "sure, come in".
      logger.error('ws upgrade auth failed', { error: (error as Error).message });
      return null;
    }

    if (!session) return null;

    // Better Auth already refuses to mint a session for an unverified address
    // (`requireEmailVerification`). Re-checking costs nothing and means the ws
    // surface does not silently inherit a future relaxation of that setting.
    if (!session.emailVerified) {
      logger.warn('ws upgrade rejected: email not verified', { userId: session.userId });
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
