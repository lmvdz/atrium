import type { IncomingMessage } from 'node:http';
import type { Database } from '@atrium/db';
import { memberships } from '@atrium/db/schema';
import { and, eq } from 'drizzle-orm';

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
  /** Free-form label for logs — the stub's provenance, a real one's method. */
  method: string;
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
}

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
 */
export function createStubSessionAuthenticator(): SessionAuthenticator {
  return {
    authenticateUpgrade: async (request) => {
      const header = request.headers['x-atrium-user'];
      const fromHeader = Array.isArray(header) ? header[0] : header;
      const fromQuery = new URL(request.url ?? '/', 'http://placeholder').searchParams.get('user');
      const userId = (fromHeader ?? fromQuery ?? '').trim();
      if (!userId) return null;
      return { userId, method: 'stub' };
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
      const query = runner
        .select({
          roomId: memberships.roomId,
          userId: memberships.userId,
          role: memberships.role,
          seenSeq: memberships.seenSeq,
        })
        .from(memberships)
        .where(and(eq(memberships.roomId, roomId), eq(memberships.userId, session.userId)))
        .limit(1);
      // `FOR SHARE` when this is running inside the append transaction, and
      // only then. Re-reading in the transaction closes most of the TOCTOU gap;
      // the row lock closes the rest, by making a concurrent DELETE of the
      // membership wait for the append to commit or abort instead of slipping
      // between our read and our write. Cheap: one row, one shared lock, held
      // for the length of an append.
      const [row] = await (runner === db ? query : query.for('share'));
      return row ?? null;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
