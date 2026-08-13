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
 *   1. {@link armCertification} stamps `certify_armed_at = now()` — evaluated by
 *      Postgres, never a value that crossed the wire — and `certify_armed_by` with
 *      the authenticated viewer.
 *   2. {@link certifySession} computes `now() - certify_armed_at` IN SQL and
 *      refuses anything under {@link CERTIFY_REQUIRED_HOLD_MS}, anything armed by
 *      somebody else, anything armed longer ago than {@link CERTIFY_ARM_TTL_MS},
 *      anything whose ARTIFACT changed since the arm (the digest no longer
 *      matches — the person is confirming a revision they did not review, CS-1),
 *      and anything never armed or no longer carrying a live attempt nonce.
 *      `certified_held_ms` is that measured interval; `certified_at` is `now()`.
 *      Neither function takes a timing argument, so there is no forged value for a
 *      guard to have to catch. A successful confirm sets `certified_by` AND
 *      consumes the arm's nonce and digest in the same statement, and every write
 *      here is scoped `isNull(certified_by)` — so the arm is SINGLE-USE twice over:
 *      the nonce it required is spent, and a second confirm finds the session
 *      certified and is refused. The arm is a specific attempt, not a standing
 *      120s window a later direct confirm can walk into; drizzle/0033 freezes the
 *      arm columns underneath.
 *   3. {@link disarmCertification} clears a pending arm the person released
 *      without confirming. The browser's cancel is local; without a server disarm
 *      the arm outlived the release for its whole TTL, and "arm, release, wait,
 *      confirm" certified anyway (CS-3). Every cancellation path calls it.
 *
 * ## THE ROUND-6 CONSOLIDATION — ONE COHERENT ATTEMPT, BOUND TO THE REVIEWED WORK
 *
 * The round-5 fix left three subtle holes the arm/confirm/disarm now close together
 * rather than patch apart:
 *
 *   * BOUND TO THE ARTIFACT REVIEWED, not merely the arm-time one (finding 1). The
 *     render carries `md5(artifact::text)` and the arm carries it back; the arm
 *     refuses `stale_review` unless it still matches the row, so the person can only
 *     arm over the revision they saw. The stored armed digest then equals the
 *     reviewed one, and the confirm's `artifact_changed` bind carries that guarantee
 *     forward to the signature.
 *   * A REVIEWABLE artifact, not merely a non-null one (finding 2). Arm and confirm
 *     require a well-formed artifact (branch AND commit; {@link isReviewableArtifact}),
 *     so an empty `{}` is refused rather than signed over — the DB backstop is
 *     drizzle/0038.
 *   * ONE CORRELATED ATTEMPT, cancel-wins (finding 3). Each press mints a client
 *     `attemptSeq` carried on the arm, disarm and confirm alike. The disarm raises a
 *     per-session cancel watermark even before its own arm lands, so a late arm the
 *     network reordered ahead of a release refuses `arm_superseded`; the confirm
 *     honours only the arm whose sequence it is completing.
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
  /**
   * A release for this attempt (or a newer one) already reached the server, so a
   * late arm must not resurrect the cancelled hold (round-6 finding 3). The arm's
   * own sequence is at or below the session's cancel watermark; refused rather
   * than writing a fresh live nonce a direct confirm could then spend.
   */
  | 'arm_superseded'
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
  /**
   * THE DIGEST OF THE ARTIFACT THE HUMAN REVIEWED — the `md5(artifact::text)` the
   * render carried (projected by `loadControlPlane`), handed back verbatim so the
   * server can bind the signature to the revision that was on screen (round-6
   * finding 1). A legitimate human attestation of what they reviewed, distinct
   * from the server-internal arm nonce.
   *
   * The Server Action always supplies it (its zod schema requires it); it is
   * OPTIONAL here only so a raw internal caller — the integration suite driving
   * the function directly, which has no render — may omit it. When present, the
   * arm refuses `stale_review` unless it matches the artifact currently on the row.
   * The confirm's arm→signature digest bind (`artifact_changed`) then carries the
   * guarantee forward: the arm stored the reviewed digest, so a confirm over a
   * moved artifact is refused there.
   */
  readonly reviewedDigest?: string | null;
  /**
   * THE HOLD'S ATTEMPT SEQUENCE — the client-minted, strictly-monotonic id of the
   * single press this call belongs to (round-6 finding 3). Carried identically on
   * the arm, the disarm and the confirm of one hold, so a release can be
   * correlated to the arm it cancels and a late arm cannot outrun it.
   *
   * The Server Action always supplies it; OPTIONAL here only for the raw internal
   * caller. When present: the arm refuses if it is at or below the cancel
   * watermark and otherwise stamps it; the disarm raises the watermark to it and
   * clears the matching arm; the confirm honours only an arm carrying this exact
   * sequence. Absent (a raw call), the mechanism degrades to the nonce-only
   * single-use guarantee the round-5 path already had.
   */
  readonly attemptSeq?: number;
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
  const { database, viewerId, sessionId, authorizedRoomId, reviewedDigest, attemptSeq } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    const [session] = await tx
      .select({
        roomId: sessions.roomId,
        status: sessions.status,
        certifiedBy: sessions.certifiedBy,
        artifact: sessions.artifact,
        cancelSeq: sessions.certifyCancelSeq,
        /* Whether the artifact on the row still matches the digest the human
           attests reviewing (round-6 finding 1). `true` when the client's
           reviewedDigest differs from the current `md5(artifact::text)` — the
           artifact moved between the render and this arm. `IS DISTINCT FROM` so a
           null current digest reads as changed rather than as a match. Only
           meaningful when a reviewedDigest was supplied; the guard below skips it
           for a raw caller that has no render to attest. */
        reviewedChanged:
          reviewedDigest === undefined || reviewedDigest === null
            ? sql<boolean>`false`
            : sql<boolean>`(md5(${sessions.artifact}::text) IS DISTINCT FROM ${reviewedDigest})`,
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
    /* CANCEL WINS A RACE WITH A LATE ARM. If a release for this attempt (or a
       newer one) already raised the cancel watermark to at or above this arm's
       sequence, the arm arrived after its own cancellation and must not write a
       fresh live nonce (round-6 finding 3). A new press mints a strictly larger
       sequence and passes. Only enforced when the client supplied a sequence. */
    if (attemptSeq !== undefined && session.cancelSeq !== null && attemptSeq <= session.cancelSeq) {
      return { ok: false, reason: 'arm_superseded' };
    }

    await tx
      .update(sessions)
      .set({
        certifyArmedBy: viewerId,
        /* `now()`, not `new Date()`. The value is produced by the database the
           interval will later be measured against, so the two clock reads are the
           same clock — and nothing about the arm's timing ever crossed a wire. */
        certifyArmedAt: sql`now()`,
        /* A FRESH SINGLE-USE ATTEMPT ID. The arm is a specific attempt, not a
           120s standing permission a later direct confirm can walk into (CS-3).
           Minted here — the one path that mints one — and consumed by the confirm
           that spends it, so an arm is confirmable at most once and only if it
           carries a live nonce. */
        certifyArmNonce: sql`gen_random_uuid()`,
        /* THIS HOLD'S CLIENT-MINTED SEQUENCE. Correlates the disarm and the confirm
           of the same press to this exact arm (round-6 finding 3). `null` for a raw
           caller that supplied none. */
        certifyArmSeq: attemptSeq ?? null,
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
  const { database, viewerId, sessionId, authorizedRoomId, attemptSeq } = input;

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
        /* The live attempt id. A confirm honours only an arm that still carries
           one (CS-3): null means no pending attempt — a disarmed, spent, or forged
           arm — and is refused as `not_armed` however valid the rest looks. */
        armNonce: sessions.certifyArmNonce,
        /* The arm's client-minted sequence. When the confirm carries a sequence,
           it must match the pending arm's (round-6 finding 3): a confirm completes
           the specific press it began, not whatever arm happens to be on the row —
           so a superseded-then-refused arm cannot be confirmed by an older press. */
        armSeq: sessions.certifyArmSeq,
        /* Whether the artifact under the hold still matches the one the arm was
           taken over. `true` when the current `md5(artifact::text)` differs from
           the digest stamped at arm — the artifact moved between review and
           confirm (CS-1). `IS DISTINCT FROM` so a null armed digest (a forged arm
           with no digest) also reads as changed rather than as a match. */
        artifactChanged: sql<boolean>`(${sessions.certifyArmedArtifactDigest} IS DISTINCT FROM md5(${sessions.artifact}::text))`,
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
       a session with no reviewable artifact (null, or missing branch/commit;
       round-6 finding 2) has nothing to certify. Refused here and frozen by
       drizzle/0034+0038, so a `✓` means "this human signed THIS artifact" — it
       cannot be minted over empty work, nor left standing when the work changes. */
    if (!isReviewableArtifact(session.artifact)) return { ok: false, reason: 'no_artifact' };

    /* THE ARM MUST BE THIS VIEWER'S, AND A LIVE ATTEMPT. Otherwise one person's
       hold would arm a control a second person confirms, and the signature would
       name somebody who never held anything. The nonce is the single-use half:
       null means no pending attempt — a disarmed, already-spent, or hand-forged
       arm — and is not confirmable however valid the timing looks (CS-3). When the
       confirm carries an attempt sequence, it must be the pending arm's: a confirm
       completes the press it began, so a late arm that was refused as superseded
       leaves nothing for an older press to confirm (round-6 finding 3). */
    if (
      session.armedBy === null ||
      session.armedBy !== viewerId ||
      session.armNonce === null ||
      session.heldMs === null ||
      (attemptSeq !== undefined && session.armSeq !== attemptSeq)
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
        certifiedAt: sql`now()`,
        certifiedHeldMs: Math.round(heldMs),
        /* CONSUME THE ATTEMPT. The nonce, the armed digest and the arm sequence
           were the pending hold's, not the receipt's — spent here in the same
           statement that lands the signature, so this arm cannot be confirmed a
           second time (CS-3) and nothing stale is left on the certified row. */
        certifyArmNonce: null,
        certifyArmedArtifactDigest: null,
        certifyArmSeq: null,
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
 * Best-effort by design: it takes no lock beyond the rows it touches and returns
 * `ok` even when there was nothing to clear (an already-cancelled or never-armed
 * session). The confirm gate and the arm TTL remain the load-bearing backstops;
 * this narrows the window a cancelled hold leaves open, it does not replace them.
 *
 * ## CANCEL WINS A RACE WITH A LATE ARM (round-6 finding 3)
 *
 * Clearing the arm is not enough on its own: an arm request and a disarm request
 * are independent round-trips the network may REORDER. If the disarm reaches the
 * server first (before its own arm has landed) it would find nothing to clear, and
 * the delayed arm would then write a fresh live nonce a direct confirm could spend
 * — the release lost the race. So a disarm carrying an attempt sequence ALSO raises
 * the session's cancel watermark to at least that sequence, unconditionally,
 * whether or not an arm is present. A late arm at or below that watermark then
 * refuses (`arm_superseded`). The clear is surgical — it releases the arm only when
 * it belongs to this attempt (or an older one) — so a newer press already armed is
 * left holding.
 */
export async function disarmCertification(input: CertifyInput): Promise<DisarmOutcome> {
  const { database, viewerId, sessionId, authorizedRoomId, attemptSeq } = input;

  return database.transaction(async (tx) => {
    const refusal = await viewerMayCertify(tx, viewerId, authorizedRoomId);
    if (refusal !== null) return { ok: false, reason: refusal };

    /* THE CANCEL WATERMARK — raised to this attempt's sequence even when no arm is
       on the row yet, so a disarm that outran its own arm still blocks it. Scoped
       to the uncertified session in this room; a certified row's receipt is frozen
       and out of reach. Only when the client supplied a sequence. */
    if (attemptSeq !== undefined) {
      await tx
        .update(sessions)
        .set({
          certifyCancelSeq: sql`greatest(coalesce(${sessions.certifyCancelSeq}, 0), ${attemptSeq})`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.roomId, authorizedRoomId),
            isNull(sessions.certifiedBy),
          ),
        );
    }

    /* THE CLEAR — surgical when a sequence is given (only this attempt or an older
       one, never a newer press already armed), unconditional for the viewer's arm
       when none is (the raw round-5 behaviour). The whole pending arm goes, nonce,
       digest and sequence included — a cancelled hold leaves no live attempt a
       later confirm could spend (CS-3). */
    await tx
      .update(sessions)
      .set({
        certifyArmedAt: null,
        certifyArmedBy: null,
        certifyArmNonce: null,
        certifyArmedArtifactDigest: null,
        certifyArmSeq: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.roomId, authorizedRoomId),
          eq(sessions.certifyArmedBy, viewerId),
          isNull(sessions.certifiedBy),
          ...(attemptSeq === undefined
            ? []
            : [
                sql`(${sessions.certifyArmSeq} IS NULL OR ${sessions.certifyArmSeq} <= ${attemptSeq})`,
              ]),
        ),
      );
    return { ok: true };
  });
}
