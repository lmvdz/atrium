import 'server-only';
import { loadRoomMembershipRow, parsePrincipalKind } from '@atrium/auth';
import { type Database, sessions, users } from '@atrium/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CERTIFY_ARM_TTL_MS, CERTIFY_REQUIRED_HOLD_MS } from './certify-hold';

/* ---------------------------------------------------------------------------
 * CERTIFY A SESSION — the human-only act behind #121's hold-to-arm, in TWO steps
 * because one step could not be trusted.
 *
 * ## What the first cut got wrong, and why the shape changed
 *
 * The land was a single Server Action that accepted the hold's timing from the
 * CLIENT — `armedAt` (an ISO string) and `heldMs` (a number) — and wrote both to
 * the session's receipt. Three things followed, all of them found by a blind
 * gauntlet rather than by this file's own comments:
 *
 *   * `{ heldMs: 0 }` certified. So did `{ heldMs: 999999 }` from a shell. The
 *     asymmetric friction CONVENTIONS requires for a destructive act was measured
 *     on the side of the wire that is not trusted, which is the same as not
 *     measuring it.
 *   * `certified_at` was whatever ISO string the request carried, so the receipt's
 *     "when" was the caller's word.
 *   * membership was resolved by the CALLER (`loadRoom`) and then never re-read.
 *     A person removed from the room between that read and the write still landed
 *     the session — a time-of-check/time-of-use gap of exactly the shape #22 r1
 *     closed on the append path, reopened here.
 *
 * So certification is now ARM then CONFIRM, and every clock and every membership
 * read is the server's:
 *
 *   1. {@link armCertification} stamps `certify_armed_at = now()` — evaluated by
 *      Postgres, never a value that crossed the wire — and `certify_armed_by` with
 *      the authenticated viewer.
 *   2. {@link certifySession} computes `now() - certify_armed_at` IN SQL and
 *      refuses anything under {@link CERTIFY_REQUIRED_HOLD_MS}, anything armed by
 *      somebody else, anything armed longer ago than {@link CERTIFY_ARM_TTL_MS},
 *      and anything never armed at all. `certified_held_ms` is that measured
 *      interval; `certified_at` is `now()`. Neither function takes a timing
 *      argument, so there is no forged value for a guard to have to catch.
 *
 * ## The four conditions, and where each is enforced
 *
 *   1. HUMAN. Read from `users.principal_kind` and failed CLOSED — an unreadable
 *      kind is refused, never defaulted to a person (#99/#101's fail-open pattern
 *      this codebase refuses). Re-read inside the write transaction.
 *   2. IN THE ROOM, STILL. The caller resolves the room through the authorized
 *      read path (`loadRoom`, which joins through `@atrium/auth`) and hands its id
 *      here; this file re-derives the membership INSIDE the transaction with
 *      `loadRoomMembershipRow(tx, …, { lock: 'share' })`, which takes the same
 *      workspace join and the same row lock the realtime append path takes. A
 *      concurrent revocation now waits for this transaction rather than slipping
 *      between the check and the write. This file still never names `memberships`
 *      itself — the boundary `room-access.test.ts` enforces is intact, because the
 *      query lives in `@atrium/auth` where every other one does.
 *   3. SETTLED. A running or failed process has produced no landing to certify.
 *   4. ONCE. `isNull(certified_by)` scopes the write, the row is taken `FOR
 *      UPDATE`, and drizzle/0033's `sessions_certification_immutable` refuses a
 *      rewrite or a clear underneath both.
 *
 * Under all of it, drizzle/0032's `sessions_certified_by_is_human` and 0033's
 * `sessions_certify_armed_by_is_human` refuse a non-human name in either column
 * outright, so the table itself cannot hold a machine's signature. The guards here
 * fail legibly; the triggers are the backstop that holds if a future caller skips
 * them.
 *
 * The certification is NON-EPISTEMIC (#114 T3) in the ledger's sense: it records
 * who certified a process and when, on the session's own receipt columns. It does
 * not touch `accepted_objects`. What it DOES decide is the session's own glyph —
 * `src/components/control/state.ts` derives `✓` from this signature and from
 * nothing else, because a settled process is a machine's report and a machine's
 * report is `~`.
 * ------------------------------------------------------------------------- */

export type CertifyRefusal =
  | 'not_human'
  | 'not_in_room'
  | 'no_such_session'
  | 'not_settled'
  | 'already_certified'
  /** No pending server arm for this viewer — nothing was held. */
  | 'not_armed'
  /** The server-measured interval between arm and confirm was under the gate. */
  | 'held_too_short'
  /** The arm is older than its TTL; a stale intention is not a held control. */
  | 'arm_expired';

export type CertifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CertifyRefusal };

export type ArmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CertifyRefusal };

export interface CertifyInput {
  readonly database: Database;
  readonly viewerId: string;
  readonly sessionId: string;
  /**
   * The room the caller authorized the viewer into, resolved through
   * `@atrium/auth`'s room read. The session must belong to it — and the viewer
   * must STILL hold that membership when the write runs, which is re-checked here
   * rather than inherited from the caller's read.
   */
  readonly authorizedRoomId: string;
}

/**
 * Both steps' shared preamble: is this viewer, right now, inside this
 * transaction, a human who may act in this room?
 *
 * One function because two copies of a security predicate is how the fourth call
 * site forgets it — the same reason `@atrium/auth` owns the membership query.
 */
async function viewerMayCertify(
  tx: Pick<Database, 'select'>,
  viewerId: string,
  authorizedRoomId: string,
): Promise<CertifyRefusal | null> {
  const [viewer] = await tx
    .select({ kind: users.principalKind })
    .from(users)
    .where(eq(users.id, viewerId))
    .limit(1);
  if (parsePrincipalKind(viewer?.kind ?? null) !== 'human') return 'not_human';

  /* THE TOCTOU CLOSE. `loadRoom` ran in the Server Action, before this
     transaction opened; a membership revoked in between was invisible to it. This
     read is inside the transaction that writes and takes a shared lock on the
     membership row, so a concurrent DELETE waits for this commit or abort instead
     of landing between the check and the write. Same query, same workspace join
     and same fail-closed role clamp as every other authorization read. */
  const membership = await loadRoomMembershipRow(tx, authorizedRoomId, viewerId, {
    lock: 'share',
  });
  if (membership === null) return 'not_in_room';
  return null;
}

/**
 * STEP ONE — arm, with the server's clock.
 *
 * Writes `certify_armed_at = now()`. Idempotent in the sense that matters: a
 * second arm restarts the interval, so a person who presses, releases early and
 * presses again is measured from the second press rather than the first.
 */
export async function armCertification(input: CertifyInput): Promise<ArmOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    const [session] = await tx
      .select({
        roomId: sessions.roomId,
        status: sessions.status,
        certifiedBy: sessions.certifiedBy,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1);
    if (session === undefined) return { ok: false, reason: 'no_such_session' };
    if (session.roomId !== authorizedRoomId) return { ok: false, reason: 'not_in_room' };
    if (session.status !== 'settled') return { ok: false, reason: 'not_settled' };
    if (session.certifiedBy !== null) return { ok: false, reason: 'already_certified' };

    await tx
      .update(sessions)
      .set({
        certifyArmedBy: viewerId,
        /* `now()`, not `new Date()`. The value is produced by the database the
           interval will later be measured against, so the two clock reads are the
           same clock — and nothing about the arm's timing ever crossed a wire. */
        certifyArmedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.status, 'settled'),
          isNull(sessions.certifiedBy),
        ),
      );
    return { ok: true };
  });
}

/**
 * STEP TWO — confirm, gated on the interval the SERVER measured.
 *
 * Takes no timing argument, by construction: there is no `heldMs` to forge and no
 * `armedAt` to backdate. The held duration is `now() - certify_armed_at` computed
 * in SQL, and it is what lands in `certified_held_ms`.
 */
export async function certifySession(input: CertifyInput): Promise<CertifyOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    const [session] = await tx
      .select({
        roomId: sessions.roomId,
        status: sessions.status,
        certifiedBy: sessions.certifiedBy,
        armedBy: sessions.certifyArmedBy,
        /* The whole gate, in one expression the client cannot reach: milliseconds
           between the server's clock at the arm and the server's clock now. NULL
           when nothing is armed, which `heldMs === null` reads as "not armed"
           rather than as zero. `double precision` so postgres-js hands back a
           number — `extract(epoch …)` is numeric, and numeric arrives as a string. */
        heldMs: sql<
          number | null
        >`(extract(epoch from (now() - ${sessions.certifyArmedAt})) * 1000)::double precision`,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1);
    if (session === undefined) return { ok: false, reason: 'no_such_session' };
    if (session.roomId !== authorizedRoomId) return { ok: false, reason: 'not_in_room' };
    if (session.status !== 'settled') return { ok: false, reason: 'not_settled' };
    if (session.certifiedBy !== null) return { ok: false, reason: 'already_certified' };

    /* THE ARM MUST BE THIS VIEWER'S. Otherwise one person's hold would arm a
       control a second person confirms, and the signature would name somebody who
       never held anything. */
    if (session.armedBy === null || session.armedBy !== viewerId || session.heldMs === null) {
      return { ok: false, reason: 'not_armed' };
    }
    const heldMs = Number(session.heldMs);
    if (!Number.isFinite(heldMs)) return { ok: false, reason: 'not_armed' };
    if (heldMs > CERTIFY_ARM_TTL_MS) return { ok: false, reason: 'arm_expired' };
    if (heldMs < CERTIFY_REQUIRED_HOLD_MS) return { ok: false, reason: 'held_too_short' };

    // The write, scoped so a concurrent certify or a status change loses the race
    // rather than double-landing: settled, and still uncertified. Both triggers
    // re-check that `viewerId` is a human, and 0033 makes this write the only one.
    const landed = await tx
      .update(sessions)
      .set({
        certifiedBy: viewerId,
        certifiedAt: sql`now()`,
        certifiedHeldMs: Math.round(heldMs),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.status, 'settled'),
          isNull(sessions.certifiedBy),
        ),
      )
      .returning({ id: sessions.id });

    if (landed.length === 0) return { ok: false, reason: 'already_certified' };
    return { ok: true };
  });
}
