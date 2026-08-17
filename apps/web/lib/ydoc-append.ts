import 'server-only';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WRITE DOOR'S DECISION (#202) — the write-side twin of `electric-shape.ts`.
 *
 * `app/api/rooms/[room]/ydoc/route.ts` does the Request/Response plumbing and
 * the rate limit; this file does the one thing that is the whole trust story and
 * so must be TESTED rather than described: turn "an authenticated session and a
 * room and some update bytes" into an authorized, attributed append — and refuse
 * everything else. Split out for exactly the reason `buildShapeTarget` is: a
 * mistake here (trusting a client field for the author, skipping emailVerified,
 * letting a non-member through) is silent in a route handler and loud in a test
 * that hands this function a session and watches what it does.
 *
 * ## THE PROPERTY, STATED ONCE
 *
 * The writer identity is `session.userId`, taken from the server-authenticated
 * session and from NOTHING the client sent — not a body field, not a query
 * param, not the Yjs update bytes (which this door never parses; it stores them
 * verbatim). The writer KIND is not even taken from the session's own claim: the
 * SQL function looks it up from the actor's immutable `users.principal_kind`
 * (migration 0054), so an agent that authenticated cannot be stamped human.
 *
 * ## WHY 403 FOR A NON-MEMBER, AND HOW THAT DIFFERS FROM THE READ DOOR
 *
 * The read door (`app/electric/v1/shape/route.ts`) answers a non-member 404 on
 * purpose, so a prober cannot use the status to learn a room exists. This write
 * door answers 403, per #202's acceptance: 401 = not authenticated, 403 =
 * authenticated but not a member — the conventional split. The room id is a uuid
 * in the path (unguessable), so the residual oracle is far weaker than the read
 * side's, but the divergence from the read door is DELIBERATE and named here
 * rather than left for a reader to trip over. A malformed (non-uuid) room still
 * answers 404, because it is not a room at all.
 * ═══════════════════════════════════════════════════════════════════════════ */

import type { AtriumSession } from '@atrium/auth';
import { loadRoomMembership } from '@atrium/auth';
import type { Database } from '@atrium/db';
import { sql } from 'drizzle-orm';

/**
 * `ydoc_updates.room` is a uuid, so anything else is not a room id. Checked
 * before the membership lookup for the same reason the read door checks it: a
 * non-uuid reaches the driver as `invalid input syntax for type uuid` and
 * escapes as a 500, a status a prober can tell apart from an authorization one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface YdocAppendOutcome {
  /** HTTP status the route should return. */
  status: number;
  /** A short, non-leaking message. */
  message: string;
  /** The appended (or, on a replay, the pre-existing) row id, on success only. */
  id?: string;
}

/**
 * Authorize and append one Yjs document update, attributing it to the session.
 *
 * Pure of HTTP: it takes the resolved session (or null) and the raw update
 * bytes, and returns a status + message the route maps to a `Response`. Every
 * refusal is a distinct status so a test can tell them apart, and the success
 * path is the ONLY place `ydoc_updates` is written from application code.
 */
export async function appendYdocUpdate(input: {
  db: Database;
  /** The already-resolved session — `null` when the request carried none. */
  session: AtriumSession | null;
  /** The room id from the request path. */
  room: string;
  /** The PUT body: y-electric's `writeVarUint8Array`-framed update, stored verbatim. */
  op: Uint8Array;
}): Promise<YdocAppendOutcome> {
  const { db, session, room, op } = input;

  // 1. AUTHENTICATE. An unverified address is not a session here either — the
  //    same rule the read door and `requireSession` apply, minus the redirect.
  if (!session?.emailVerified) {
    return { status: 401, message: 'sign in to write to this room’s document' };
  }

  // 2. A malformed room is a 404 — it is not a room, and answering the same 404
  //    as "no such uuid" keeps a non-uuid from escaping as a 500.
  if (!UUID.test(room)) {
    return { status: 404, message: 'no such room' };
  }

  // 3. An empty update folds to nothing and is refused by the table's
  //    op_not_empty check; catch it here as a 400 rather than letting it become a
  //    500 from the driver.
  if (op.byteLength === 0) {
    return { status: 400, message: 'an empty update is not a document update' };
  }

  // 4. AUTHORIZE. The same `loadRoomMembership` the read door uses and the same
  //    predicate the SQL function re-checks under a lock — a live membership of a
  //    non-archived room whose workspace still carries the member, with a role
  //    recognised on both sides. A non-member is 403 (authenticated, not
  //    authorized); see the header for why this differs from the read door's 404.
  const membership = await loadRoomMembership(db, room, session.userId);
  if (!membership) {
    return { status: 403, message: 'you are not a member of this room' };
  }

  // 5. APPEND, attributed to the SESSION. `p_actor_id` is `session.userId` and
  //    nothing the client named; the kind is looked up inside the function from
  //    the actor's immutable principal_kind. Parameterized args only — the room,
  //    the actor and the bytes are bind parameters, never interpolated.
  try {
    const [row] = await db.execute<{ id: string }>(
      sql`SELECT atrium_append_ydoc_update(${room}::uuid, ${session.userId}::uuid, ${Buffer.from(op)}::bytea) AS id`,
    );
    const id = row?.id;
    if (!id) {
      // The function returns the row id (new or, on a replay, the original); a
      // missing id is a contract break, not a client error.
      return { status: 500, message: 'the document update could not be recorded' };
    }
    return { status: 200, message: 'appended', id };
  } catch (error) {
    // The membership check above and the one inside the function can disagree
    // only across a concurrent revoke that landed between them: the function
    // raises 42501, and the correct answer is the same 403 the door would have
    // given had the revoke won the race. Fail closed to 403, never a 500 that
    // reads as "try again".
    if (isPgError(error) && error.code === '42501') {
      return { status: 403, message: 'you are not a member of this room' };
    }
    // The op_not_empty check, defensively (step 3 already caught the empty case).
    if (isPgError(error) && error.constraint_name === 'ydoc_updates_op_not_empty') {
      return { status: 400, message: 'an empty update is not a document update' };
    }
    throw error;
  }
}

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isPgError(error: unknown): error is PgError {
  return typeof error === 'object' && error !== null && 'code' in error;
}
