import { agents, type Database } from '@atrium/db';
import { eq } from 'drizzle-orm';
import type { AtriumAuth } from './auth.js';
import { type PrincipalKind, parsePrincipalKind } from './principal.js';

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
  /**
   * What sort of participant this session belongs to.
   *
   * **Required, not optional, and that is the whole design of this field.** The
   * server derives the trusted `Actor` from this session and from nothing else
   * (`apps/server/src/commands.ts`, `actorOf`), and every certification gate in
   * `@atrium/core` is decided by that actor's kind. An optional field would make
   * "nobody said" spell "human" at the one seam where "human" is the privileged
   * answer — which is #90's interlock exactly: `kind: 'human'` has always meant
   * "authenticated account", so the moment an agent holds an account, a session
   * that cannot say which it is must not be usable at all.
   *
   * It is therefore not defaulted here either. `getAtriumSession` returns `null`
   * rather than guessing.
   */
  principalKind: PrincipalKind;
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
 *
 * `db` is here for the same reason (#116 fix r3, F-C): the sidecar recheck below
 * is a database read, and keeping it inside this one function is what stops the
 * two callers each rolling their own — the query that decides whether an agent
 * still has an owner is written once, exactly like the `principal_kind` read.
 */
export async function getAtriumSession(
  auth: AtriumAuth,
  headers: Headers,
  db: Database,
): Promise<AtriumSession | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.session || !result.user) return null;

  const { session, user } = result;
  /**
   * No session at all rather than a session of assumed kind.
   *
   * `principal_kind` is NOT NULL on `users` and is declared to Better Auth as a
   * returned additional field, so this is `null` only when something structural
   * has gone wrong: the migration has not been applied, the field declaration was
   * dropped, or a library upgrade stopped returning additional fields. Every one
   * of those is a deployment fault, and the two available responses are "assume
   * human" and "refuse". Assuming human would silently re-open every gate this
   * field exists to keep closed, on a whole deployment at once, with no error
   * anywhere — so it refuses, and an agent-blind deployment fails to sign anyone
   * in instead of quietly certifying on machines' behalf.
   */
  const principalKind = parsePrincipalKind((user as { principalKind?: unknown }).principalKind);
  if (principalKind === null) return null;

  /**
   * An agent with no owner sidecar is not a usable session (#116 fix r3, F-C).
   *
   * `mintAgentSession` refuses to MINT a session for an agent with no `agents`
   * row — that is the only route an agent session is created by. But a cookie
   * outlives its mint: an agent configured, minted, and then de-sidecar'd
   * (`DELETE FROM agents WHERE user_id = …`) still presents a valid Better Auth
   * session, and round 2 would have let it keep operating — ownerless, the
   * "ownership chain terminates at a human" invariant (#114) silently bypassed
   * for the whole life of the cookie.
   *
   * So the check that ran at mint runs again HERE, on every resolution, the same
   * discipline `principal_kind === null` gets: refuse rather than operate. An
   * `agents` row cannot exist without a human `owner_user_id`
   * (`agents_owner_is_human`, 0021), so its mere existence is the owner — no
   * ownerless agent resolves to a session. A HUMAN principal needs no sidecar
   * and is not touched by this read; only an `agent` pays the round-trip.
   */
  if (principalKind === 'agent') {
    const [sidecar] = await db
      .select({ userId: agents.userId })
      .from(agents)
      .where(eq(agents.userId, session.userId))
      .limit(1);
    if (!sidecar) return null;
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    email: user.email,
    displayName: user.name,
    emailVerified: user.emailVerified,
    principalKind,
    activeWorkspaceId: readActiveWorkspaceId(session),
  };
}

function readActiveWorkspaceId(session: unknown): string | null {
  if (typeof session !== 'object' || session === null) return null;
  const value = (session as { activeOrganizationId?: unknown }).activeOrganizationId;
  return typeof value === 'string' ? value : null;
}
