import 'server-only';
import { loadRoomMembershipRow, parsePrincipalKind } from '@atrium/auth';
import { type Database, sessions, users } from '@atrium/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CERTIFY_ARM_TTL_MS, CERTIFY_REQUIRED_HOLD_MS, isReviewableArtifact } from './certify-hold';

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
 *   1. {@link armCertification} stamps `certify_armed_at = clock_timestamp()` —
 *      the REAL time the UPDATE runs, evaluated by Postgres, never a value that
 *      crossed the wire — and `certify_armed_by` with the authenticated viewer. It
 *      mints a fresh single-use attempt nonce and RETURNS it: that opaque
 *      server-issued token is the whole of the attempt's identity (round-7
 *      finding 2). Nothing the client counts participates in the authority.
 *   2. {@link certifySession} computes `clock_timestamp() - certify_armed_at` IN
 *      SQL and refuses anything under {@link CERTIFY_REQUIRED_HOLD_MS}, anything
 *      armed by somebody else, anything armed longer ago than
 *      {@link CERTIFY_ARM_TTL_MS}, anything whose ARTIFACT changed since the arm
 *      (the digest no longer matches — the person is confirming a revision they
 *      did not review, CS-1), and anything never armed or no longer carrying a
 *      live attempt nonce. `certified_held_ms` is that measured interval, and
 *      `certified_at` is stamped `clock_timestamp()` too (round-8) — the SAME real
 *      clock the interval is measured on, so a confirm that blocked on the row lock
 *      cannot stamp a `certified_at` that disagrees with `certified_held_ms` and
 *      trip drizzle/0036's consistency check on an honest hold. Neither function
 *      takes a timing argument, so
 *      there is no forged value for a guard to have to catch. A successful confirm
 *      sets `certified_by` AND consumes the arm's nonce and digest in the same
 *      statement, and every write here is scoped `isNull(certified_by)` — so the
 *      arm is SINGLE-USE twice over: the nonce it required is spent, and a second
 *      confirm finds the session certified and is refused. The arm is a specific
 *      attempt, not a standing 120s window a later direct confirm can walk into;
 *      drizzle/0033 freezes the arm columns underneath.
 *   3. {@link disarmCertification} clears a pending arm the person released
 *      without confirming. The browser's cancel is local; without a server disarm
 *      the arm outlived the release for its whole TTL, and "arm, release, wait,
 *      confirm" certified anyway (CS-3). Every cancellation path calls it.
 *
 * ## THE ROUND-7 CONSOLIDATION — THE ATTEMPT IS THE SERVER'S, END TO END
 *
 * The round-6 fix threaded CLIENT-supplied authority values through the arm/
 * confirm/disarm — an optional `reviewedDigest`, and a client-minted `attemptSeq`
 * wall-clock raised into a session-global cancel watermark. Both were holes:
 *
 *   * A REQUEST MISSING `reviewedDigest` FELL OPEN (round-7 finding 1). The value
 *     was optional, and absent it the stale-review check was SKIPPED — so a
 *     scripted caller that omitted it armed over whatever artifact was current with
 *     no attestation of what it had reviewed. `reviewedDigest` is REQUIRED now, at
 *     the Server Action and here; there is no absent-means-unchanged branch left.
 *   * THE CANCEL WATERMARK WAS A CLIENT WALL-CLOCK (round-7 finding 2). Any member
 *     could `disarm(attemptSeq = MAX_SAFE_INTEGER)` and raise a session-global,
 *     unbounded watermark that refused every honest arm forever (`arm_superseded`);
 *     cross-client clock skew did it by accident. The attempt is SERVER-ISSUED now:
 *     {@link armCertification} mints the nonce and returns it, and the disarm and
 *     confirm reference THAT token. A cancel affects only its own attempt — no
 *     client number reaches a global gate, so none can jam future arms.
 *
 * The arm binds to the reviewed artifact exactly as round 6 intended, and the
 * confirm carries that bind forward; a REVIEWABLE artifact (branch AND commit;
 * {@link isReviewableArtifact}) is still required at arm and confirm, an empty `{}`
 * refused, the DB backstop drizzle/0038.
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
 *      other one does. The DISARM is the one exception, and deliberately: the arm
 *      OWNER may retract their own pending arm even after losing membership
 *      (round-7 finding 4), so it authorizes on arm-ownership, not on the room.
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
   * The session carries no REVIEWABLE artifact — none at all, or one missing the
   * minimum content (a non-empty branch AND commit) a human can put a signature
   * on. A `✓` must mean "this human signed THIS artifact" (CS-1), and an empty
   * `{}` is a signature on a blank page (round-6 finding 2); refused at both arm
   * and confirm, and frozen out by drizzle/0034+0038.
   */
  | 'no_artifact'
  /**
   * The artifact changed between the moment the human REVIEWED it and this arm —
   * the digest the client attests reviewing no longer matches the one on the row
   * (round-6 finding 1). Certifying now would bind the `✓` to a revision the
   * person never saw; refused so the arm is over the reviewed artifact or not at
   * all. Press and hold again re-reviews the current one.
   */
  | 'stale_review'
  /** No pending server arm for this viewer — nothing was held. */
  | 'not_armed'
  /** The server-measured interval between arm and confirm was under the gate. */
  | 'held_too_short'
  /** The arm is older than its TTL; a stale intention is not a held control. */
  | 'arm_expired'
  /**
   * The artifact changed between the arm and the confirm, so the hold was
   * performed over a revision the person is no longer confirming. A `✓` must bind
   * to the artifact that was REVIEWED (CS-1); refused rather than certify B under a
   * hold armed over A.
   */
  | 'artifact_changed';

export type CertifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CertifyRefusal };

export type ArmOutcome =
  /**
   * The arm landed, and here is the SERVER-ISSUED attempt token (round-7 finding
   * 2) — the opaque nonce the arm minted. The confirm and the disarm of this same
   * press carry it back so the server can bind them to this exact attempt; no
   * client-minted number participates in the authority, so none can jam a future
   * arm. It is a single-use capability, spent by the confirm or cleared by the
   * disarm.
   */
  | { readonly ok: true; readonly attemptToken: string }
  | { readonly ok: false; readonly reason: CertifyRefusal };

export type DisarmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CertifyRefusal };

interface CertifyBase {
  readonly database: Database;
  readonly viewerId: string;
  readonly sessionId: string;
}

export interface ArmInput extends CertifyBase {
  /**
   * The room the caller authorized the viewer into, resolved through
   * `@atrium/auth`'s room read. The session must belong to it — and the viewer
   * must STILL hold that membership when the write runs, which is re-checked here
   * rather than inherited from the caller's read.
   */
  readonly authorizedRoomId: string;
  /**
   * THE DIGEST OF THE ARTIFACT THE HUMAN REVIEWED — the `md5(artifact::text)` the
   * render carried (projected by `loadControlPlane`), handed back verbatim so the
   * server can bind the signature to the revision that was on screen (round-6
   * finding 1). REQUIRED (round-7 finding 1): the Server Action's zod schema
   * demands it, and a raw internal caller (the integration suite driving the
   * function directly) computes it from the row. There is no absent-means-unchanged
   * branch — an arm without an attestation of what was reviewed is not something
   * this function will land. The arm refuses `stale_review` unless it matches the
   * artifact currently on the row.
   */
  readonly reviewedDigest: string;
}

export interface ConfirmInput extends CertifyBase {
  readonly authorizedRoomId: string;
  /**
   * THE SERVER-ISSUED ATTEMPT TOKEN — the nonce {@link armCertification} minted and
   * returned for this press (round-7 finding 2). REQUIRED (round-8): the Server
   * Action's zod schema demands it, and this type now demands it too, so the lib and
   * the wire agree. There is no omit-and-spend-whatever-is-live branch — a
   * tokenless confirm proved a green suite for a certify with no attempt behind it,
   * exactly the false-green this codebase must never ship. It must equal the pending
   * arm's nonce, so a confirm completes the exact press it began; a missing or
   * mismatched token is refused `not_armed`, not defaulted.
   */
  readonly attemptToken: string;
}

export interface DisarmInput extends CertifyBase {
  /**
   * THE SERVER-ISSUED ATTEMPT TOKEN of the press being released (round-7 finding
   * 2). REQUIRED (round-8): the Server Action demands it and so does this type —
   * there is no omit-and-clear-the-whole-arm branch. The clear is scoped to the arm
   * carrying exactly this nonce, so a stale release cannot clobber a newer press's
   * arm. No `authorizedRoomId`: the disarm authorizes on ARM-OWNERSHIP, not room
   * membership (round-7 finding 4), so the owner can retract even after losing it.
   */
  readonly attemptToken: string;
}

/**
 * Both certifying steps' shared preamble: is this viewer, right now, inside this
 * transaction, a human who may act in this room?
 *
 * One function because two copies of a security predicate is how the fourth call
 * site forgets it — the same reason `@atrium/auth` owns the membership query. The
 * disarm does NOT run this: it authorizes on arm-ownership rather than membership
 * (round-7 finding 4).
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
 * STEP ONE — arm, with the server's clock, and hand back the server's token.
 *
 * Writes `certify_armed_at = clock_timestamp()`. Idempotent in the sense that
 * matters: a second arm restarts the interval, so a person who presses, releases
 * early and presses again is measured from the second press rather than the first.
 * On success it RETURNS the freshly-minted attempt nonce — the opaque token the
 * confirm and disarm of this press carry back (round-7 finding 2).
 */
export async function armCertification(input: ArmInput): Promise<ArmOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId, reviewedDigest } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    const [session] = await tx
      .select({
        roomId: sessions.roomId,
        status: sessions.status,
        certifiedBy: sessions.certifiedBy,
        artifact: sessions.artifact,
        /* Whether the artifact on the row still matches the digest the human
           attests reviewing (round-6 finding 1). `true` when the client's
           reviewedDigest differs from the current `md5(artifact::text)` — the
           artifact moved between the render and this arm. `IS DISTINCT FROM` so a
           null current digest reads as changed rather than as a match. Always
           evaluated: `reviewedDigest` is REQUIRED (round-7 finding 1), so there is
           no absent-means-unchanged branch to fall open through. */
        reviewedChanged: sql<boolean>`(md5(${sessions.artifact}::text) IS DISTINCT FROM ${reviewedDigest})`,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
      .limit(1);
    if (session === undefined) return { ok: false, reason: 'no_such_session' };
    if (session.roomId !== authorizedRoomId) return { ok: false, reason: 'not_in_room' };
    if (session.status !== 'settled') return { ok: false, reason: 'not_settled' };
    if (session.certifiedBy !== null) return { ok: false, reason: 'already_certified' };
    /* NOTHING REVIEWABLE TO SIGN, NOTHING TO ARM. A null artifact, or one missing
       the minimum reviewable content (branch AND commit; round-6 finding 2), is not
       something a person can hold a control over. Refuse the arm outright; the DB
       backstop (drizzle/0034+0038) refuses the write. */
    if (!isReviewableArtifact(session.artifact)) return { ok: false, reason: 'no_artifact' };
    /* BOUND TO THE ARTIFACT REVIEWED. If the artifact moved between the render the
       human saw and this arm, arming would digest a revision they never reviewed —
       the round-6 finding 1 hole, one step earlier than the arm→confirm bind.
       Refuse; the person re-reviews the current artifact on the next press. */
    if (session.reviewedChanged) return { ok: false, reason: 'stale_review' };

    /* A FRESH SINGLE-USE ATTEMPT ID, MINTED AND RETURNED. The arm is a specific
       attempt, not a 120s standing permission a later direct confirm can walk into
       (CS-3). `gen_random_uuid()` is minted here — the one path that mints one —
       and RETURNED so the confirm and disarm of this press reference this exact
       token (round-7 finding 2); the confirm consumes it. Nothing the client counts
       reaches the row, so no client value can jam a future arm. */
    const [armed] = await tx
      .update(sessions)
      .set({
        certifyArmedBy: viewerId,
        /* `clock_timestamp()`, not `now()`. `now()` is the TRANSACTION-START time;
           if this arm blocked on the row lock for seconds, `now()` would backdate
           the stamp and a confirm's `clock_timestamp() - certify_armed_at` would
           read a hold that never happened (round-7 finding 3). `clock_timestamp()`
           is evaluated when this statement executes — after the lock is held — so
           the interval is measured from the real moment the arm landed. */
        certifyArmedAt: sql`clock_timestamp()`,
        certifyArmNonce: sql`gen_random_uuid()`,
        /* THE ARTIFACT THE HOLD IS ARMED OVER, digested. Equal to the reviewed
           digest checked above, so it carries the reviewed-revision bind forward:
           the confirm compares this to the artifact then present and refuses if it
           moved (CS-1). `md5` of jsonb's canonical text is stable for equal jsonb;
           `artifact` is reviewable (non-null) here. */
        certifyArmedArtifactDigest: sql`md5(${sessions.artifact}::text)`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.status, 'settled'),
          isNull(sessions.certifiedBy),
        ),
      )
      .returning({ nonce: sessions.certifyArmNonce });
    const attemptToken = armed?.nonce ?? null;
    if (attemptToken === null) return { ok: false, reason: 'not_armed' };
    return { ok: true, attemptToken };
  });
}

/**
 * STEP TWO — confirm, gated on the interval the SERVER measured.
 *
 * Takes no timing argument, by construction: there is no `heldMs` to forge and no
 * `armedAt` to backdate. The held duration is `clock_timestamp() -
 * certify_armed_at` computed in SQL, and it is what lands in `certified_held_ms`.
 */
export async function certifySession(input: ConfirmInput): Promise<CertifyOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId, attemptToken } = input;

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
        /* The live attempt id / server-issued token. A confirm honours only an arm
           that still carries one (CS-3): null means no pending attempt — a
           disarmed, spent, or forged arm — and is refused as `not_armed` however
           valid the rest looks. When the confirm carries an `attemptToken` it must
           equal this, so a confirm completes the exact press it began (round-7
           finding 2). */
        armNonce: sessions.certifyArmNonce,
        /* Whether the artifact under the hold still matches the one the arm was
           taken over. `true` when the current `md5(artifact::text)` differs from
           the digest stamped at arm — the artifact moved between review and
           confirm (CS-1). `IS DISTINCT FROM` so a null armed digest (a forged arm
           with no digest) also reads as changed rather than as a match. */
        artifactChanged: sql<boolean>`(${sessions.certifyArmedArtifactDigest} IS DISTINCT FROM md5(${sessions.artifact}::text))`,
        /* The whole gate, in one expression the client cannot reach: milliseconds
           between the server's real clock at the arm and the server's real clock
           now. Both reads are `clock_timestamp()` (round-7 finding 3) so a blocked
           arm cannot backdate the interval. NULL when nothing is armed, which
           `heldMs === null` reads as "not armed" rather than as zero. `double
           precision` so postgres-js hands back a number. */
        heldMs: sql<
          number | null
        >`(extract(epoch from (clock_timestamp() - ${sessions.certifyArmedAt})) * 1000)::double precision`,
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
       a session with no reviewable artifact (null, or missing branch/commit;
       round-6 finding 2) has nothing to certify. Refused here and frozen by
       drizzle/0034+0038, so a `✓` means "this human signed THIS artifact" — it
       cannot be minted over empty work, nor left standing when the work changes. */
    if (!isReviewableArtifact(session.artifact)) return { ok: false, reason: 'no_artifact' };

    /* THE ARM MUST BE THIS VIEWER'S, AND A LIVE ATTEMPT THE TOKEN COMPLETES.
       Otherwise one person's hold would arm a control a second person confirms, and
       the signature would name somebody who never held anything. The nonce is the
       single-use half: null means no pending attempt — a disarmed, already-spent, or
       hand-forged arm — and is not confirmable however valid the timing looks (CS-3).
       The server-issued `attemptToken` is REQUIRED (round-8) and must equal the
       pending arm's nonce: a confirm completes the exact press it began, and a
       missing token (a raw caller bypassing the type) reads as `armNonce !==
       undefined` → refused, never spends a live arm it cannot name (round-7 finding
       2). This is the unconditional compare — there is no absent-means-skip branch a
       tokenless confirm could fall open through. */
    if (
      session.armedBy === null ||
      session.armedBy !== viewerId ||
      session.armNonce === null ||
      session.heldMs === null ||
      session.armNonce !== attemptToken
    ) {
      return { ok: false, reason: 'not_armed' };
    }
    const heldMs = Number(session.heldMs);
    if (!Number.isFinite(heldMs)) return { ok: false, reason: 'not_armed' };
    if (heldMs > CERTIFY_ARM_TTL_MS) return { ok: false, reason: 'arm_expired' };
    if (heldMs < CERTIFY_REQUIRED_HOLD_MS) return { ok: false, reason: 'held_too_short' };
    /* BOUND TO THE REVIEWED REVISION. The hold was armed over a specific artifact;
       if it changed underneath the hold the person is confirming work they did not
       review (CS-1). Refuse rather than certify the new revision — and 0034 would
       otherwise freeze that unreviewed revision under the signature. */
    if (session.artifactChanged) return { ok: false, reason: 'artifact_changed' };

    // The write, scoped so a concurrent certify or a status change loses the race
    // rather than double-landing: settled, and still uncertified. Both triggers
    // re-check that `viewerId` is a human, and 0033 makes this write the only one.
    const landed = await tx
      .update(sessions)
      .set({
        certifiedBy: viewerId,
        /* `clock_timestamp()`, not `now()` (round-8). `now()` is the
           TRANSACTION-START time; if this confirm blocked on the row lock for
           seconds, `now()` would stamp a `certified_at` earlier than the moment
           `certified_held_ms` was measured (that interval ends at
           `clock_timestamp()`, above), and drizzle/0036's consistency check —
           `certified_held_ms ≈ certified_at − certify_armed_at` — would refuse an
           HONEST hold as inconsistent (a false negative). Stamping `certified_at`
           on the SAME real clock the interval is measured on keeps the arm stamp,
           the elapsed measurement and `certified_at` mutually consistent. */
        certifiedAt: sql`clock_timestamp()`,
        certifiedHeldMs: Math.round(heldMs),
        /* CONSUME THE ATTEMPT. The nonce and the armed digest were the pending
           hold's, not the receipt's — spent here in the same statement that lands
           the signature, so this arm cannot be confirmed a second time (CS-3) and
           nothing stale is left on the certified row. */
        certifyArmNonce: null,
        certifyArmedArtifactDigest: null,
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
 * ## IT AUTHORIZES ON ARM-OWNERSHIP, NOT ROOM MEMBERSHIP (round-7 finding 4)
 *
 * The round-6 disarm ran the same membership gate as the confirm, so "arm as a
 * member, lose membership, release" refused `not_in_room` — the arm stayed live,
 * and a confirm after regaining membership within the TTL spent the cancelled
 * hold. But retracting your OWN pending intention is not an act ON the room; it is
 * the owner taking back a hold they never completed. So this clears the arm wherever
 * it is THIS VIEWER'S own uncertified arm (`certify_armed_by = viewerId`,
 * `certified_by IS NULL`), with no membership check at all — the owner may always
 * cancel their own. A viewer who never armed this session owns no arm here and
 * clears nothing, so this is no back door onto anyone else's hold. The confirm is
 * NOT weakened: it still requires humanity, membership, and the elapsed gate.
 *
 * Scoped to the SERVER-ISSUED TOKEN, which is REQUIRED (round-8, round-7 finding
 * 2): the clear touches only the arm carrying exactly this nonce, so a stale
 * release cannot clobber a newer press's arm, and there is no omit-and-clear-the-
 * whole-arm branch. A certified session's arm is frozen (drizzle/0033)
 * and part of the receipt, so it is deliberately out of reach here — disarming is
 * for a hold that never completed, never for un-writing one that did.
 *
 * Best-effort by design: it returns `ok` even when there was nothing to clear (an
 * already-cancelled or never-armed session). The confirm gate and the arm TTL
 * remain the load-bearing backstops; this narrows the window a cancelled hold
 * leaves open, it does not replace them.
 */
export async function disarmCertification(input: DisarmInput): Promise<DisarmOutcome> {
  const { database, viewerId, sessionId, attemptToken } = input;

  return database.transaction(async (tx) => {
    /* THE CLEAR — the whole pending arm goes, nonce and digest included, wherever
       it is this viewer's own uncertified arm carrying EXACTLY this nonce. The
       token is required (round-8), so the clear is always nonce-scoped: only the arm
       carrying this exact nonce, never a newer press's. No room predicate: ownership
       is the authorization (round-7 finding 4). A cancelled hold leaves no live
       attempt a later confirm could spend (CS-3). */
    await tx
      .update(sessions)
      .set({
        certifyArmedAt: null,
        certifyArmedBy: null,
        certifyArmNonce: null,
        certifyArmedArtifactDigest: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.certifyArmedBy, viewerId),
          isNull(sessions.certifiedBy),
          eq(sessions.certifyArmNonce, attemptToken),
        ),
      );
    return { ok: true };
  });
}
