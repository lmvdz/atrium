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
 *      argument, so there is no forged value for a guard to have to catch. A
 *      successful confirm sets `certified_by`, and every write here is scoped
 *      `isNull(certified_by)` — so the arm is SINGLE-USE in the only sense that
 *      matters: a second confirm on the same session finds it certified and is
 *      refused, and drizzle/0033 freezes the arm columns underneath.
 *   3. {@link disarmCertification} clears a pending arm the person released
 *      without confirming. The browser's cancel is local; without a server disarm
 *      the arm outlived the release for its whole TTL, and "arm, release, wait,
 *      confirm" certified anyway (CS-3). Every cancellation path calls it.
 *
 * ## WHAT THE HOLD PROVES, STATED HONESTLY
 *
 * The arm→confirm gate is a MINIMUM-DELAY TWO-STEP CONFIRMATION measured on the
 * server: it proves at least {@link CERTIFY_REQUIRED_HOLD_MS} of wall-clock passed
 * between two deliberate calls by the same authenticated human, and that the
 * timing was not supplied by the client. It does NOT prove a finger stayed on a
 * control for that whole interval — against a scripted client, continuous physical
 * holding is unprovable server-side without interaction attestation, which this
 * does not have. The disarm-on-cancel narrows the window a released hold leaves
 * open; it does not turn elapsed time into a proof of a continuous hold. The copy
 * and the affordance describe the friction as exactly that and claim no more.
 *
 * ## The four conditions, and where each is enforced
 *
 *   1. HUMAN. Read from `users.principal_kind` and failed CLOSED — an unreadable
 *      kind is refused, never defaulted to a person (#99/#101's fail-open pattern
 *      this codebase refuses). Re-read inside the write transaction.
 *   2. IN THE ROOM, STILL. The caller resolves the room through the authorized
 *      read path (`loadRoom`, which joins through `@atrium/auth`) and hands its id
 *      here; this file re-derives the membership INSIDE the transaction with
 *      `loadRoomMembershipRow(tx, …, { lock: 'membership-and-workspace' })`,
 *      which takes the same workspace join as the realtime append path but a
 *      STRONGER row lock — it locks the `workspace_members` row too, not only
 *      `memberships`. A concurrent revocation of either now waits for this
 *      transaction rather than slipping between the check and the write, because a
 *      certification is irreversible and cannot afford the one-second workspace
 *      revalidation window the append path is allowed to tolerate. This file still
 *      never names `memberships` itself — the boundary `room-access.test.ts`
 *      enforces is intact, because the query lives in `@atrium/auth` where every
 *      other one does.
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
  /**
   * The session carries no artifact to review, so there is nothing for a
   * signature to be a signature OF. A `✓` must mean "this human signed THIS
   * artifact" (CS-1); refused at both arm and confirm.
   */
  | 'no_artifact'
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

export type DisarmOutcome =
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
     read is inside the transaction that writes and takes a shared lock on BOTH the
     `memberships` row and the joined `workspace_members` row, so a concurrent
     DELETE of either waits for this commit or abort instead of landing between the
     check and the write. The `membership-and-workspace` scope is what the certify
     path needs and the append path does not: certification is irreversible
     (drizzle/0033), so the workspace-revocation window the append path defers to
     the one-second revalidation pass would here be a window in which a
     workspace-revoked member permanently lands an artifact. Same query, same
     workspace join and same fail-closed role clamp as every other authorization
     read — only the lock scope is stronger. */
  const membership = await loadRoomMembershipRow(tx, authorizedRoomId, viewerId, {
    lock: 'membership-and-workspace',
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
        artifact: sessions.artifact,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1);
    if (session === undefined) return { ok: false, reason: 'no_such_session' };
    if (session.roomId !== authorizedRoomId) return { ok: false, reason: 'not_in_room' };
    if (session.status !== 'settled') return { ok: false, reason: 'not_settled' };
    if (session.certifiedBy !== null) return { ok: false, reason: 'already_certified' };
    /* NOTHING TO SIGN, NOTHING TO ARM. Arming a null-artifact session would let a
       person hold a control over work that does not exist — and if the artifact
       arrived after the arm, the hold would have been performed against nothing.
       Refuse the arm outright; the DB backstop (drizzle/0034) refuses the write. */
    if (session.artifact === null) return { ok: false, reason: 'no_artifact' };

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
        artifact: sessions.artifact,
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
    /* BOUND TO THE REVIEWED ARTIFACT. The signature is a signature OF something;
       a session with no artifact has nothing to certify. Refused here and frozen
       by drizzle/0034, so a `✓` means "this human signed THIS artifact" — it
       cannot be minted over null work, nor left standing when the work changes. */
    if (session.artifact === null) return { ok: false, reason: 'no_artifact' };

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

/**
 * DISARM — clear a pending arm the person did not carry through to a confirm.
 *
 * CS-3, the half the client could not do for itself. Releasing the control early
 * cancels the hold IN THE BROWSER, but the server arm it stamped on hold-begin
 * lived on for its full TTL — so "arm, release immediately, wait past the gate,
 * confirm directly" certified, because the release changed nothing the server
 * could see. Every cancellation path in the control now calls this, so a
 * cancelled hold leaves no live arm behind.
 *
 * Scoped to THIS viewer's own uncertified arm: it clears `certify_armed_at` /
 * `certify_armed_by` only where the arm is this viewer's and the session is not
 * yet certified. A certified session's arm is frozen (drizzle/0033) and part of
 * the receipt, so it is deliberately out of reach here — disarming is for a hold
 * that never completed, never for un-writing one that did.
 *
 * Best-effort by design: it takes no lock beyond the row it clears and returns
 * `ok` even when there was nothing to clear (an already-cancelled or never-armed
 * session). The confirm gate and the arm TTL remain the load-bearing backstops;
 * this narrows the window a cancelled hold leaves open, it does not replace them.
 */
export async function disarmCertification(input: CertifyInput): Promise<DisarmOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    await tx
      .update(sessions)
      .set({ certifyArmedAt: null, certifyArmedBy: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.roomId, authorizedRoomId),
          eq(sessions.certifyArmedBy, viewerId),
          isNull(sessions.certifiedBy),
        ),
      );
    return { ok: true };
  });
}
