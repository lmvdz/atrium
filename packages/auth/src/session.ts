import type { AtriumAuth } from './auth.js';

/**
 * The only session shape the rest of Atrium is allowed to care about.
 *
 * Better Auth's own session object carries more than any caller needs and its
 * exact type moves between minor versions. Narrowing it here means a Better Auth
 * upgrade touches this file and nothing downstream.
 */
export interface AtriumSession {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  /** The workspace this browser last switched to, if any. */
  activeWorkspaceId: string | null;
}

/**
 * Resolve a session from raw request headers, or null.
 *
 * `headers` is whatever the caller has: `next/headers` in a server component,
 * a `Headers` built from `IncomingMessage.headers` at a WebSocket upgrade. Both
 * end up in the same library call, which is the point — there is one definition
 * of "signed in" and neither caller reimplements it.
 */
export async function getAtriumSession(
  auth: AtriumAuth,
  headers: Headers,
): Promise<AtriumSession | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.session || !result.user) return null;

  const { session, user } = result;
  return {
    sessionId: session.id,
    userId: session.userId,
    email: user.email,
    displayName: user.name,
    emailVerified: user.emailVerified,
    activeWorkspaceId: readActiveWorkspaceId(session),
  };
}

function readActiveWorkspaceId(session: unknown): string | null {
  if (typeof session !== 'object' || session === null) return null;
  const value = (session as { activeOrganizationId?: unknown }).activeOrganizationId;
  return typeof value === 'string' ? value : null;
}
