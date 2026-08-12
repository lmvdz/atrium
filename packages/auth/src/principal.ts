import { agents, type Database, users } from '@atrium/db';
import { makeSignature } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import type { AtriumAuth } from './auth.js';

/**
 * What an identity is, and how a non-human one comes to exist.
 *
 * ## The gap this file closes
 *
 * Before it, Atrium could describe a non-human *writer* end to end — `Actor` had
 * a `model` variant, `core_events` had an `actor_kind` column, the reducer had
 * ten humanity gates — and had no concept of a non-human *identity*. An agent
 * could write as a model with no id, or hold an account and be stamped a person.
 * It could not be both a member and a machine, and that asymmetry, rather than
 * authentication or the reducer, was the whole blocker.
 *
 * ## Why provisioning is programmatic, and stays that way
 *
 * There is no HTTP route that creates an agent principal, and adding one is not
 * an omission to be corrected later. Three separate things make that true, and
 * they are independent on purpose:
 *
 *  1. `mounted.ts` publishes exactly three Better Auth paths — `/verify-email`,
 *     `/error`, `/callback/:id`. `/sign-up/email` is unreachable over HTTP by
 *     design and sign-in exists only as a Server Action.
 *  2. `principalKind` is declared to Better Auth with `input: false`
 *     (`@atrium/db`'s `authModelOptions`), so the library refuses to read it from
 *     a request body on any route — including the ones that are not mounted
 *     today and any that might be mounted tomorrow.
 *  3. An agent principal is provisioned with **no credential**: no password row,
 *     no OAuth account. Even reachable, the interactive routes have nothing to
 *     authenticate it with.
 *
 * So an agent enters the system the way a database row enters a database: an
 * operator, a migration, or a harness writes it. That is a deliberately small
 * and auditable surface, and it is the one init.md asks for — the product proves
 * agent participation before it grows an agent runtime, not after.
 *
 * ## Why the session is minted through Better Auth rather than inserted
 *
 * `mintAgentSession` calls Better Auth's own internal adapter and then signs the
 * cookie with Better Auth's own signature function. The session an agent holds is
 * therefore the same object, in the same table, read back by the same library
 * call (`getAtriumSession` → `auth.api.getSession`) as a person's. Hand-rolling a
 * row and a token would produce something that *looks* like a session to a test
 * and differs from a real one in whatever the library changes next — which is
 * the failure this package's one-configuration rule exists to prevent.
 */

/** The kinds of identity a `users` row can stand for. Mirrors `principal_kind`. */
export type PrincipalKind = 'human' | 'agent';

const PRINCIPAL_KINDS: readonly string[] = ['human', 'agent'];

/**
 * Read a principal kind off whatever Better Auth returned, or `null`.
 *
 * An **allowlist**, and `null` for everything else including `undefined`. The
 * tempting spelling is `value === 'agent' ? 'agent' : 'human'`, which answers
 * "human" for a missing column, a renamed field, a library upgrade that stopped
 * returning additional fields, and a typo — four different failures, all of them
 * reported as "this machine is a person". That is the exact direction #90 says
 * must never fail open: `kind: 'human'` decides every certification gate
 * downstream, so an unreadable kind has to end the session, not soften into the
 * privileged one. `getAtriumSession` is where that ending happens.
 */
export function parsePrincipalKind(value: unknown): PrincipalKind | null {
  return typeof value === 'string' && PRINCIPAL_KINDS.includes(value)
    ? (value as PrincipalKind)
    : null;
}

export interface ProvisionAgentPrincipalInput {
  db: Database;
  /**
   * The address this identity is keyed by. `users.email` is NOT NULL and
   * uniquely indexed, and an agent needs one for the same reason a person does:
   * it is the identity's stable name in a table Better Auth also owns.
   *
   * Nothing is ever sent to it — an agent principal has no verification mail, no
   * password reset and no invitation — so a domain the deployment controls and
   * does not deliver to is the right kind of value.
   */
  email: string;
  /** What the room calls it. */
  displayName: string;
  avatarUrl?: string | null;
}

export interface AgentPrincipal {
  userId: string;
  email: string;
  displayName: string;
  principalKind: 'agent';
}

/**
 * Create an agent identity. One row, no credential, no mail.
 *
 * `emailVerified: true` is set here rather than left to default, and it is not a
 * shortcut around a check. Verification answers "does a person control this
 * address?", and there is no person and no address to control; leaving it false
 * would make every agent session fail `ws-auth.ts`'s verification check for a
 * reason that does not apply to it, and the fix somebody would then reach for is
 * relaxing that check for everybody. This states the fact once, at provisioning,
 * where it is visible: an agent principal is verified because there was never an
 * unverified claim to check.
 *
 * Membership is *not* created here. An identity and a room membership are
 * different decisions — the same separation a person's signup and their
 * invitation already have — and conflating them would give provisioning the
 * power to put a participant into a room, which is `@atrium/auth`'s workspace
 * and room-access surface, not this one.
 */
export async function provisionAgentPrincipal(
  input: ProvisionAgentPrincipalInput,
): Promise<AgentPrincipal> {
  const [row] = await input.db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      emailVerified: true,
      principalKind: 'agent',
    })
    .returning({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      principalKind: users.principalKind,
    });

  if (!row) throw new Error('provisionAgentPrincipal: insert returned no row');
  if (row.principalKind !== 'agent') {
    // Reads as impossible and is asserted anyway: this is the one place the
    // value is chosen, and a default that silently won over it would produce an
    // identity that behaves like a person everywhere downstream. Cheaper to fail
    // here than to discover it in a room.
    throw new Error(
      `provisionAgentPrincipal: stored principal kind is "${row.principalKind}", not "agent"`,
    );
  }
  return {
    userId: row.id,
    email: row.email,
    displayName: row.displayName,
    principalKind: 'agent',
  };
}

export interface ProvisionAgentConfigInput {
  db: Database;
  /** The agent principal being configured — a `users` row with kind `agent`. */
  userId: string;
  /**
   * The human this agent belongs to. The `agents_owner_is_human` trigger
   * (drizzle/0021) refuses a non-human here, so "the ownership chain terminates
   * at a person" is enforced at this INSERT rather than trusted to this caller.
   */
  ownerUserId: string;
  /** The room this agent owns as its channel. */
  channelRoomId: string;
  host: string;
  harness: string;
  model: string;
  /** The agent's budget root, in micro-dollars. Omit or null for no cap. */
  budgetLimitMicros?: number | null;
}

export interface AgentConfig {
  userId: string;
  ownerUserId: string;
  channelRoomId: string;
  host: string;
  harness: string;
  model: string;
  budgetLimitMicros: number | null;
}

/**
 * Write an agent's config sidecar (#116), alongside `provisionAgentPrincipal`.
 *
 * A separate function rather than a limb of `provisionAgentPrincipal` for the
 * same reason membership is separate there: an identity, its ownership and its
 * channel are different decisions, and one that provisions all three at once
 * hides the moment each is made. The identity is minted first (the `users` row,
 * kind `agent`); this attaches the config once the owner and the channel room
 * exist.
 *
 * The two kind rules — owner is a human, subject is an agent — are NOT checked
 * here. They are triggers on the table (drizzle/0021), read off the referenced
 * rows' immutable `principal_kind`, so a caller cannot assert its way past them
 * and there is no second copy of the rule in this file to drift from the first.
 * This function's job is to state the config; the database's job is to refuse a
 * config that would break the chain.
 */
export async function provisionAgentConfig(input: ProvisionAgentConfigInput): Promise<AgentConfig> {
  const [row] = await input.db
    .insert(agents)
    .values({
      userId: input.userId,
      ownerUserId: input.ownerUserId,
      channelRoomId: input.channelRoomId,
      host: input.host,
      harness: input.harness,
      model: input.model,
      budgetLimitMicros: input.budgetLimitMicros ?? null,
    })
    .returning({
      userId: agents.userId,
      ownerUserId: agents.ownerUserId,
      channelRoomId: agents.channelRoomId,
      host: agents.host,
      harness: agents.harness,
      model: agents.model,
      budgetLimitMicros: agents.budgetLimitMicros,
    });
  if (!row) throw new Error('provisionAgentConfig: insert returned no row');
  return row;
}

/** A real Better Auth session, plus the cookie header that presents it. */
export interface MintedSession {
  sessionId: string;
  token: string;
  /**
   * `<name>=<token>.<signature>`, ready to set as a `cookie` request header on
   * an HTTP request or a WebSocket upgrade. The same bytes a browser would send.
   */
  cookie: string;
  cookieName: string;
  expiresAt: Date;
}

/**
 * The `cookie` request header that presents an existing session token.
 *
 * `<name>=<token>.<signature>`, with Better Auth's own cookie name and Better
 * Auth's own signature function, so what this produces is what the library sets
 * after an interactive sign-in and what `auth.api.getSession` reads back.
 *
 * Exported deliberately, and it is not a credential-minting function: it takes a
 * token the caller already holds, and a session token *is* the credential. What
 * it saves a caller is re-deriving the cookie name and the HMAC construction by
 * hand, which is the sort of copy that goes stale silently at the next library
 * upgrade and is then debugged as an auth outage.
 */
export async function sessionCookieHeader(auth: AtriumAuth, token: string): Promise<string> {
  const context = await auth.$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, context.secret)}`;
}

/**
 * Mint a session for an already-provisioned principal, without a sign-in.
 *
 * Refuses any principal that is not an agent. There is a legitimate interactive
 * path for a person and this is not it; a helper that mints a session for an
 * arbitrary user id is a sign-in bypass with a friendly name, and the check that
 * stops it being one is a database read rather than a parameter, so a caller
 * cannot assert its way past it.
 *
 * The refusal is deliberately *not* "the caller said agent". `principal_kind` is
 * read from the row, and the row is immutable in that column, so what this
 * function permits is a property of the identity rather than of the call.
 */
export async function mintAgentSession(input: {
  auth: AtriumAuth;
  db: Database;
  userId: string;
}): Promise<MintedSession> {
  const [row] = await input.db
    .select({ principalKind: users.principalKind })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!row) throw new Error(`mintAgentSession: no identity "${input.userId}"`);
  if (row.principalKind !== 'agent') {
    throw new Error(
      `mintAgentSession: identity "${input.userId}" is a ${row.principalKind} principal — a session for a person is minted by signing in, and this is not a route around that`,
    );
  }

  const context = await input.auth.$context;
  // Better Auth's own adapter writing its own row. An agent's session is a
  // session — same table, same shape, same expiry policy — and everything that
  // reads one reads this one the same way, which is the point of not
  // hand-rolling it.
  const session = await context.internalAdapter.createSession(input.userId, false);

  return {
    sessionId: session.id,
    token: session.token,
    cookieName: context.authCookies.sessionToken.name,
    cookie: await sessionCookieHeader(input.auth, session.token),
    expiresAt: session.expiresAt,
  };
}
