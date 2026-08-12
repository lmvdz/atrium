import type { IncomingMessage } from 'node:http';
import {
  loadRoomMembershipRow,
  type PrincipalKind,
  parsePrincipalKind,
  roomMembershipKey,
  roomMembershipsHeld,
} from '@atrium/auth';
import type { Database } from '@atrium/db';

/**
 * Who is connected, and what they may touch.
 *
 * Two seams, deliberately separate, because #22 ships one of them for real and
 * stubs the other:
 *
 *  - `authenticateUpgrade` answers "who is this socket?". #22's scope boundary
 *    says no auth until #26, so the shipped implementation is a stub — but the
 *    seam is the real one, and swapping in a cookie/JWT reader is a change to
 *    this file and nothing else.
 *  - `authorize` answers "may this person act in this room?". That one is NOT
 *    stubbed. It reads `memberships` on every command, because membership is
 *    what stands between a connected socket and another team's room, and a
 *    membership check faked alongside the identity check would leave nothing
 *    at all in the way.
 *
 * The split matters for what the tests prove: with a stub identity you can
 * still demonstrate that a non-member is refused, and that refusal is the same
 * code path #26 will run under real identity.
 */

export interface Session {
  userId: string;
  /**
   * What sort of participant this is — the one thing besides `userId` that the
   * command layer reads off a session, because it is what `actorOf` branches on.
   *
   * **Required.** `AtriumSession` satisfies this interface structurally, so an
   * optional field here would be satisfied by every authenticator that simply
   * never thought about it, and the `?? 'human'` that would inevitably follow at
   * the read site is the fail-open default #90 names: `human` is the privileged
   * answer, so "nobody said" must not resolve to it. Required, a new
   * authenticator does not compile until it has decided.
   *
   * It is not the last line of defence, and it is not asked to be. The database
   * refuses an append whose `actor_kind` disagrees with the identity's own
   * `users.principal_kind` (drizzle/0017), so a session that gets this wrong
   * writes nothing at all rather than writing history under the wrong kind.
   */
  principalKind: PrincipalKind;
  /**
   * Free-form label for logs — the stub's provenance, a real one's method.
   *
   * OPTIONAL SINCE THE MERGE, AND ONLY THAT. The stub this seam was built
   * around is gone: `authenticateUpgrade` is now `@atrium/auth`'s Better Auth
   * reader, and an `AtriumSession` carries a `sessionId`, an email and a
   * verification flag but no `method` — there is one method and the type of the
   * function says what it is. Required here it would have to be invented at the
   * call site, and a field invented to satisfy a type is the fail-open seam
   * this file's header is about. Everything that matters — `userId` — is still
   * required, and every consumer reads only that.
   */
  method?: string;
}

export interface SessionAuthenticator {
  /**
   * Resolve the session for an incoming upgrade, or `null` to refuse it. Refusal
   * is a closed door, not an anonymous session: every command needs an actor.
   */
  authenticateUpgrade(request: IncomingMessage): Promise<Session | null>;
}

export interface RoomMembership {
  roomId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  seenSeq: number;
}

/** The read surface an authorization check needs: `db`, or a transaction. */
export type AuthorizerRunner = Pick<Database, 'select'>;

export interface Authorizer {
  /**
   * The caller's membership in this room, or `null` if they have none.
   *
   * `runner` exists so the check can be made **inside the transaction that
   * writes**. Round 1 checked before opening one, which left a
   * time-of-check/time-of-use gap: a membership revoked in between was still
   * good enough to append with, and what came out was durable history written
   * by someone who had been removed from the room (#22 gauntlet r1, major 4).
   */
  authorize(
    session: Session,
    roomId: string,
    runner?: AuthorizerRunner,
  ): Promise<RoomMembership | null>;
  /**
   * The same question asked of many `(user, room)` pairs at once: which of them
   * still hold a membership row?
   *
   * Exists because the fan-out set needs re-checking and `authorize` is the wrong
   * shape for it — one query per subscriber per pass is the cost the r8 comment
   * imagined when it deferred this, and it is not the cost. One statement covers
   * every subscription on the instance (see `ws-server.ts`, "Membership at
   * fan-out").
   *
   * Returns the pairs that are **still members**, keyed by `membershipKey`.
   * Deliberately that direction: an absent key is the answer for a revoked
   * membership, a room that never existed, a malformed id, and a user who was
   * never there. A "who was revoked" result would have to enumerate reasons, and
   * every reason it failed to think of would read as "still a member".
   */
  present(pairs: readonly MembershipPair[]): Promise<Set<string>>;
}

/** One subscription's identity, for the fan-out re-check. */
export interface MembershipPair {
  userId: string;
  roomId: string;
}

/**
 * The key `Authorizer.present` answers in.
 *
 * RE-EXPORTED, NOT REDECLARED. It moved to `@atrium/auth` with the query that
 * produces it, because "one function so the two sides cannot spell it
 * differently" stopped being true the moment the query lived in another
 * package: the merge that moved it spelled the separator `:` there against this
 * file's NUL here, and three integration tests came back with every subscriber
 * on the instance dropped — including the ones nobody had revoked, which is the
 * failure this docblock already predicted in as many words. The name stays so
 * `ws-server.ts`'s two call sites need not care where it lives.
 *
 * At its new home the separator is written as the escape `\u0000` rather than
 * as a raw NUL byte. That is not cosmetic: a raw NUL made this file report as
 * `data` to `file(1)`, so `grep` skipped it in silence and a search for
 * `membershipKey` came back empty while the function was sitting in it.
 */
export const membershipKey = roomMembershipKey;

/**
 * The #26 placeholder. Identity comes from the `x-atrium-user` header or a
 * `?user=` query parameter, and from nowhere else.
 *
 * This is not authentication and does not pretend to be: anyone who can open a
 * socket can claim any user id. It is here so the realtime layer can be built,
 * tested and reviewed against the interface #26 will implement, and so that
 * every call site is already asking the right question.
 *
 * It still refuses an unidentified socket. A default of "anonymous" would make
 * the membership check below vacuous the day someone forgets to pass a user,
 * and a test suite that connects without a user should fail loudly rather than
 * quietly exercise a path production will never take.
 *
 * ## The principal kind, and what this stub can and cannot prove about it
 *
 * `x-atrium-principal` / `?principal=` says which kind the caller claims to be,
 * defaulting to `human` — and *that default is not a fail-open hole here*, for
 * the same reason the user id is not: this authenticator already lets anyone
 * claim to be anyone, so there is nothing left for a principal claim to escalate.
 * An unrecognised value is refused rather than coerced, because a typo silently
 * meaning "human" is how a test that thinks it is exercising the agent path
 * quietly exercises the person path and passes.
 *
 * What follows is worth stating plainly, because it bounds what any test built
 * on this stub proves: a claim made here is **not** checked against
 * `users.principal_kind` by this function. It is checked by the database, on the
 * append (drizzle/0017), which refuses a row whose `actor_kind` disagrees with
 * the identity it names. So a stub session claiming `human` over an agent's user
 * id does not produce falsified history — it produces a failed append. The
 * session → kind half of the chain is proven against the real Better Auth
 * resolver instead; see `integration/server/agent-principal.test.ts`.
 */
export function createStubSessionAuthenticator(): SessionAuthenticator {
  return {
    authenticateUpgrade: async (request) => {
      const url = new URL(request.url ?? '/', 'http://placeholder');
      const header = request.headers['x-atrium-user'];
      const fromHeader = Array.isArray(header) ? header[0] : header;
      const userId = (fromHeader ?? url.searchParams.get('user') ?? '').trim();
      if (!userId) return null;

      const kindHeader = request.headers['x-atrium-principal'];
      const fromKindHeader = Array.isArray(kindHeader) ? kindHeader[0] : kindHeader;
      const claimed = (fromKindHeader ?? url.searchParams.get('principal') ?? '').trim();
      const principalKind = claimed === '' ? 'human' : parsePrincipalKind(claimed);
      if (principalKind === null) return null;

      return { userId, principalKind, method: 'stub' };
    },
  };
}

/** Membership, read from the database. Not a stub — see the note above. */
export function createMembershipAuthorizer(db: Database): Authorizer {
  return {
    authorize: async (session, roomId, runner = db) => {
      // A malformed room id is a miss, not a 500: `roomId` arrives off the
      // wire, and Postgres raises on a uuid cast it cannot parse.
      if (!isUuid(roomId) || !isUuid(session.userId)) return null;
      // `FOR SHARE` when this is running inside the append transaction, and
      // only then — see `loadRoomMembershipRow`, which is where the query and
      // the lock now live. This function used to hold its own copy of both,
      // over `memberships` alone; that is the stale-row class `@atrium/auth`'s
      // room-access header is about, and `packages/auth/test/room-access.test.ts`
      // fails the build if an app reaches the table directly again.
      return loadRoomMembershipRow(runner, roomId, session.userId, {
        lock: runner === db ? undefined : 'share',
      });
    },

    present: async (pairs) => {
      // A pair whose ids are not uuids can have no row — the column types say so
      // — and passing it to Postgres would raise on the cast rather than return
      // nothing. Dropped here, which leaves it absent from the result, which is
      // "not a member". Fail-closed by omission rather than by a branch.
      const probes = pairs.filter((pair) => isUuid(pair.userId) && isUuid(pair.roomId));
      return roomMembershipsHeld(db, probes);
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
