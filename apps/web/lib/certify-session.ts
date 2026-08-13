import 'server-only';
import { parsePrincipalKind } from '@atrium/auth';
import { type Database, sessions, users } from '@atrium/db';
import { and, eq, isNull } from 'drizzle-orm';

/* ---------------------------------------------------------------------------
 * CERTIFY A SESSION'S LANDING — the human-only act behind #121's hold-to-arm.
 *
 * The review pane's certify/land control is gated in the UI on a formal human
 * hold-to-arm (HoldToAct). This is the server half, and it is where "no
 * non-human/programmatic path can land" is made true rather than trusted to the
 * affordance:
 *
 *   1. The viewer must be a HUMAN principal. Read from `users.principal_kind`
 *      and failed CLOSED — an unreadable kind is refused, not defaulted to a
 *      person (the #99/#101 fail-open pattern this codebase refuses). An agent
 *      or a model, even one holding a session cookie, is refused here.
 *   2. The session must live in a room the caller ALREADY authorized. The room's
 *      membership boundary is @atrium/auth's to enforce and this file may not
 *      read `memberships` directly (room-access.test.ts's import boundary), so
 *      the caller resolves the room through the authorized read path
 *      (`loadRoom`, which joins through `@atrium/auth`) and hands its id here;
 *      this only checks the session belongs to THAT room.
 *   3. The session must have SETTLED. A running or failed process has not
 *      produced a landing to certify.
 *   4. It must not already be certified — one landing, once.
 *
 * And underneath all four, the database's own `sessions_certified_by_is_human`
 * trigger (drizzle/0032) refuses a non-human `certified_by` outright, so the
 * table itself cannot hold a machine's name in that column. The guards here fail
 * legibly; the trigger is the backstop that holds even if a future caller skips
 * them.
 *
 * The certification is NON-EPISTEMIC (#114 T3): it records who landed a process
 * and when, on the session's own receipt columns. It does not touch
 * `accepted_objects` and cannot flip a `~` to a `✓` — a session settling never
 * certifies a claim, and neither does a person landing one.
 * ------------------------------------------------------------------------- */

export type CertifyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_human'
        | 'not_in_room'
        | 'no_such_session'
        | 'not_settled'
        | 'already_certified';
    };

export interface CertifyInput {
  readonly database: Database;
  readonly viewerId: string;
  readonly sessionId: string;
  /**
   * The room the caller authorized the viewer into, resolved through
   * `@atrium/auth`'s room read. The session must belong to it — this is how the
   * membership boundary is enforced without this file touching `memberships`.
   */
  readonly authorizedRoomId: string;
  /** The wall clock the hold completed, ISO — from the Arming record. */
  readonly armedAt: string;
  /** How long the control was actually held, measured — from the Arming record. */
  readonly heldMs: number;
}

export async function certifySession(input: CertifyInput): Promise<CertifyOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId, armedAt, heldMs } = input;

  // 1. Human-only, failed closed on an unreadable kind.
  const [viewer] = await database
    .select({ kind: users.principalKind })
    .from(users)
    .where(eq(users.id, viewerId))
    .limit(1);
  if (parsePrincipalKind(viewer?.kind ?? null) !== 'human') {
    return { ok: false, reason: 'not_human' };
  }

  // 2/3/4. The session, and that it lives in the room the caller authorized.
  const [session] = await database
    .select({
      id: sessions.id,
      roomId: sessions.roomId,
      status: sessions.status,
      certifiedBy: sessions.certifiedBy,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (session === undefined) return { ok: false, reason: 'no_such_session' };

  if (session.roomId !== authorizedRoomId) return { ok: false, reason: 'not_in_room' };

  if (session.status !== 'settled') return { ok: false, reason: 'not_settled' };
  if (session.certifiedBy !== null) return { ok: false, reason: 'already_certified' };

  // The write, scoped so a concurrent certify or a status change loses the race
  // rather than double-landing: settled, and still uncertified. The trigger
  // re-checks that `viewerId` is a human.
  const landed = await database
    .update(sessions)
    .set({
      certifiedBy: viewerId,
      certifiedAt: new Date(armedAt),
      certifiedHeldMs: Math.max(0, Math.round(heldMs)),
      updatedAt: new Date(),
    })
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.status, 'settled'), isNull(sessions.certifiedBy)),
    )
    .returning({ id: sessions.id });

  if (landed.length === 0) return { ok: false, reason: 'already_certified' };
  return { ok: true };
}
