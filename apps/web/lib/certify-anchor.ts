import 'server-only';
import { loadRoomMembershipRow, parsePrincipalKind } from '@atrium/auth';
import {
  type CovenantAnchor,
  type CovenantDocReader,
  certifyAnchor,
  type HumanCertifier,
} from '@atrium/core';
import {
  acceptedObjects,
  type Database,
  insertCovenantAnchor,
  type ObjectPayload,
  users,
} from '@atrium/db';
import { eq } from 'drizzle-orm';

/* ---------------------------------------------------------------------------
 * CERTIFY AN OBJECT/SPAN — the gated ledger write of a DERIVED covenant anchor
 * (#190, SL-3 CERTIFY-PATH, under #181). The object/span analogue of the
 * session-certify door (`certify-session.ts`), and it carries the enforcement
 * SL-1 could only shape-guard: "the machine never certifies", and derive-and-sign.
 *
 * SL-1 made the core `CovenantAnchor` a shape-guard (a `HumanCertifier` type, a
 * `certifyAnchor` that refuses a non-human and signs the context from the reader).
 * That is defence-in-depth, but a pure type cannot know WHO is asking or WHAT the
 * live document is: only the server has the authenticated principal and the
 * authoritative reader. So the REAL enforcement is here, at the gate, backed by
 * the table:
 *
 *   1. CERTIFIER FROM THE SESSION, NEVER THE REQUEST. The certifier's kind and id
 *      come from the AUTHENTICATED session's `principal_kind` / `userId`. A
 *      non-human session is refused HERE, before the reader is even touched, with
 *      the covenant reason — a machine may draft a reading (~), never certify one
 *      (✓). The DB backstops it twice (0050's CHECK on `certifier_kind`, 0052's
 *      correlation trigger on `certifier_id` → `users.principal_kind`).
 *
 *   2. PERSIST ONLY `certifyAnchor(serverReader, meta)` OUTPUT. This function has
 *      no parameter for a `renderedDigest`, a `stateVector`, a `deleteSet`, or a
 *      span boundary. The only anchor that can reach the table is the one core
 *      derived and signed, so the `parse()` mint-bypass — persisting a client-built
 *      `CovenantAnchor` — is closed by construction, not by a guard that could be
 *      forgotten. `insertCovenantAnchor` writes those fields verbatim from the
 *      derived anchor and offers no field to override them.
 *
 *   3. SERVER-SIDE READER OVER THE LIVE DOC. `revision` / `stateVector` /
 *      `deleteSet` / `relStart` / `relEnd` / `renderedDigest` are all DERIVED by
 *      the caller-supplied {@link CovenantDocReader} — the production
 *      `CovenantDocReaderProd` over the authoritative live document —
 *      through `certifyAnchor`'s use of `authoritativeContext()` (the live-doc
 *      HEAD) and `captureSelection()`. Nothing resolution-bearing is accepted from
 *      the client. A selection captured against a revision that disagrees with the
 *      authoritative head (a stale / forged caller context) is REFUSED by core with
 *      `null`, so it can never be signed — this function turns that into a refusal
 *      and writes no row.
 *
 * ## The membership re-check is the certify path's, not the append path's
 *
 * Exactly as `certify-session.ts`: the caller (a Server Action) has already
 * resolved the room through `@atrium/auth`'s authorized read, but that read ran
 * BEFORE this transaction opened. A certification is IRREVERSIBLE (the anchor is
 * frozen by 0050/0051's immutability trigger), so this re-derives the membership
 * INSIDE the write transaction under the STRONGER `membership-and-workspace` lock —
 * a concurrent room OR workspace revocation waits for this commit instead of
 * slipping between the caller's check and the write. The humanity is re-read in the
 * same transaction and failed CLOSED, never defaulted to a person.
 *
 * ## What this does NOT do
 *
 * It owns the gated WRITE only. It does not read anchors back (the DETECT read
 * authority is SL-4, #191), does not schedule drift, and does not perform the
 * reserved certify-✓ ACT — a human actually certifying a span is Lars's; this is
 * the machinery, gated, and it never auto-certifies (a caller must present an
 * authenticated human session, a real selection, and a real object).
 * ------------------------------------------------------------------------- */

export type CertifyAnchorRefusal =
  /**
   * The session is not a human principal — the covenant reason. A machine may
   * draft a reading (~) and may never certify one (✓). Refused at the gate before
   * the reader is touched; nothing is derived, nothing is written. "The machine
   * never certifies."
   */
  | 'not_human'
  /** The viewer is not (still) a member of the room the object belongs to. */
  | 'not_in_room'
  /**
   * The live document could not be captured/signed: the doc is unavailable, the
   * selection did not resolve, or the selection's claimed resolution context
   * disagreed with the authoritative head (a stale / forged caller context). Core
   * returned `null`; a `✓` is never recorded over any of these (fail-closed).
   */
  | 'derive_failed'
  /**
   * A live anchor already exists for this (room, object) span — the unique
   * `(room_id, object_id)` index (0050). Re-certify is a fresh human act that
   * REPLACES the row (delete-then-insert), never a second silent insert; this
   * function does the single insert and reports the collision rather than
   * clobbering the standing signature.
   */
  | 'already_certified'
  /**
   * The SERVER REPLICA lags the durable stream head at request time (E3, #203).
   * The replica's content may be stale — a later durable update the replica has
   * not yet consumed could change (or delete) the span — so minting is REFUSED
   * rather than anchoring content that is not caught up. Fail-closed: a lagging or
   * absent replica never yields a `✓`. This is DISTINCT from #209's client
   * freshness witness — this proves the server replica is caught up to the stream,
   * not that a client's observed fragment matches.
   */
  | 'replica_lagging';

export type CertifyAnchorOutcome =
  | { readonly ok: true; readonly anchorId: string; readonly anchor: CovenantAnchor }
  | { readonly ok: false; readonly reason: CertifyAnchorRefusal };

/** The authenticated principal, as the server resolved it — never the request body. */
export interface CertifyAnchorSession {
  readonly userId: string;
  /** From `AtriumSession.principalKind`, derived from `users.principal_kind`. */
  readonly principalKind: 'human' | 'agent';
}

export interface CertifyAnchorInput {
  readonly database: Database;
  /** The authenticated session — the ONLY source of the certifier's identity. */
  readonly session: CertifyAnchorSession;
  /**
   * The room the caller authorized the viewer into, resolved through `@atrium/auth`.
   * The viewer must STILL hold membership when the write runs — re-checked here.
   */
  readonly authorizedRoomId: string;
  /** The accepted object whose span this `✓` is over. */
  readonly objectId: string;
  /**
   * The AUTHORITATIVE server reader over the live document — the production
   * `CovenantDocReaderProd`, positioned on the certified selection. Everything
   * resolution-bearing is derived from it; the client supplies none of it.
   */
  readonly reader: CovenantDocReader;
  /**
   * The certify instant, stamped by the SERVER (never the request). Defaults to
   * `new Date().toISOString()` — the honest "when" for this receipt. Frozen by the
   * immutability trigger once written.
   */
  readonly certifiedAt?: string;
  /**
   * The SERVER-REPLICA freshness gate (E3, #203). When present, minting is refused
   * (`replica_lagging`) unless the replica the reader resolves against has consumed
   * the durable stream up to {@link StreamFreshnessGate.requiredPosition} — the
   * stream head captured at request time. Absent ⇒ no stream-position gate is
   * applied (the reader's own live-doc HEAD check still guards content drift). The
   * caller (the certify action) wires the replica's consumed position and the head.
   */
  readonly streamFreshness?: StreamFreshnessGate;
  /**
   * THE YJS-SPAN → COVENANT-OBJECT BINDING (#220 / T6). When present, an
   * `accepted_objects` row for {@link CertifyAnchorInput.objectId} is UPSERTED
   * (ON CONFLICT DO NOTHING) INSIDE the same write transaction, immediately before
   * the anchor insert, so the anchor's composite FK to `accepted_objects(room_id,
   * id)` (migration 0050) resolves. This is the "one-accepted-object-per-certified-
   * span" model Lars endorsed: on the yjs surface a certified span has no ledger
   * proposal/acceptance to project an object from (that path is `apps/server`'s
   * event-sourced projection, for ledger rooms only), so the human certify gesture
   * derives the durable object directly. It is created HUMAN-touched (`acceptedBy` =
   * the certifier, `acceptedByKind` = `'human'`, `humanTouchedAt` = the certify
   * instant) because a human is performing the act; the covenant `✓` itself is still
   * the separate, gated anchor row over the exact span. Absent ⇒ the object must
   * already exist (the prototype / ledger path), unchanged.
   *
   * Atomic by construction: the insert shares {@link certifyObjectSpan}'s transaction,
   * so a refused anchor (derive failure caught earlier, membership/humanity refusal,
   * or a unique-collision at the anchor) rolls the object insert back too — a certify
   * that does not mint an anchor never strands a bare object.
   */
  readonly ensureObject?: {
    /** The object type for the derived row — `'claim'` on the yjs span surface. */
    readonly type: 'decision' | 'commitment' | 'open_question' | 'claim' | 'objective';
    /** The validated payload (a `ClaimPayload` for the span surface). */
    readonly payload: ObjectPayload;
  };
}

/**
 * The server-replica stream-position freshness gate (E3, #203). Compares where the
 * replica has caught up to against where the durable stream's head was at request
 * time; a replica that trails the head is refused so a stale span is never anchored.
 */
export interface StreamFreshnessGate {
  /**
   * The durable stream head position captured at request time — what the replica must
   * have reached. A `bigint` (the row's `stream_seq` is a Postgres `bigint`), so a head
   * above `2^31`/`2^53` is compared exactly rather than 500ing on an `::int` overflow
   * or silently narrowing (#203 hygiene).
   */
  readonly requiredPosition: bigint;
  /**
   * The replica's currently-consumed stream position ({@link
   * ServerRoomReplica.consumedStreamPosition}), read at mint time. A function, not a
   * value, so it reflects the replica as it stands when the gate fires — a replica
   * evicted between request and mint reads as {@link REPLICA_ABSENT_POSITION} and refuses.
   */
  readonly consumedPosition: () => bigint;
}

/**
 * The consumed position an ABSENT/EVICTED replica reports at mint time. A real stream
 * head coalesces to `>= 0`, so `-1n` is strictly below every possible required position
 * and the freshness gate always refuses (fail-closed) — the `bigint` analogue of the
 * `Number.NEGATIVE_INFINITY` this replaced when positions became `bigint` (#203).
 */
export const REPLICA_ABSENT_POSITION = -1n;

/**
 * Is a Postgres error a unique-violation on the `(room_id, object_id)` anchor key?
 * Walked through the `cause` chain because drizzle wraps the driver error, exactly
 * as `certify-session.ts`'s `refusal` helper does. `23505` is UNIQUE_VIOLATION.
 */
function isAnchorUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  while (cursor instanceof Error || (typeof cursor === 'object' && cursor !== null)) {
    const code = (cursor as { code?: unknown }).code;
    const constraint = (cursor as { constraint_name?: unknown }).constraint_name;
    if (code === '23505' && String(constraint ?? '').includes('covenant_anchors_object_key')) {
      return true;
    }
    const message = cursor instanceof Error ? cursor.message : '';
    if (message.includes('covenant_anchors_object_key')) return true;
    cursor = (cursor as { cause?: unknown }).cause;
    if (cursor === undefined || cursor === null) break;
  }
  return false;
}

export async function certifyObjectSpan(input: CertifyAnchorInput): Promise<CertifyAnchorOutcome> {
  const { database, session, authorizedRoomId, objectId, reader } = input;

  /* (1) THE MACHINE NEVER CERTIFIES — refuse a non-human SESSION here, at the gate,
     before the reader is touched or anything is derived. The kind is the server's
     (`AtriumSession.principalKind`, from `users.principal_kind`, declared to Better
     Auth `input: false`), never a value the request carried. A machine drafts ~,
     it does not sign ✓. */
  if (session.principalKind !== 'human') {
    return { ok: false, reason: 'not_human' };
  }

  /* THE SERVER-REPLICA FRESHNESS GATE (E3, #203) — refuse to mint against a replica
     that lags the durable stream head captured at request time. A trailing replica's
     content may be stale (a durable update it has not yet consumed could have changed
     or deleted the span), so anchoring it would sign content that is not caught up.
     Checked here, before anything is derived: fail-closed and cheap. An evicted
     replica reads `-Infinity` and refuses. Distinct from #209's client witness — this
     is about the SERVER replica's position on the stream, not a client's observation. */
  if (input.streamFreshness !== undefined) {
    if (input.streamFreshness.consumedPosition() < input.streamFreshness.requiredPosition) {
      return { ok: false, reason: 'replica_lagging' };
    }
  }

  /* The certifier is built FROM THE SESSION — kind fixed to the human variant, id
     the authenticated user's. There is no request field for either. */
  const certifier: HumanCertifier = { kind: 'human', userId: session.userId };
  const certifiedAt = input.certifiedAt ?? new Date().toISOString();

  /* (2) + (3) DERIVE-AND-SIGN from the authoritative server reader. `certifyAnchor`
     signs `revision`/`stateVector`/`deleteSet` from `authoritativeContext()` (the
     live-doc HEAD), captures the span materials from `captureSelection()`, computes
     the digest itself, and returns `null` when the certifier is not human, the doc
     is unavailable, the selection did not resolve, OR the selection's claimed
     context disagrees with the head (a stale/forged caller context). Nothing
     resolution-bearing crosses from the client. A `null` is fail-closed: no row. */
  const anchor = certifyAnchor(reader, {
    objectId,
    roomId: authorizedRoomId,
    certifier,
    certifiedAt,
  });
  if (anchor === null) {
    return { ok: false, reason: 'derive_failed' };
  }

  /* The unique `(room_id, object_id)` collision is caught OUTSIDE the transaction,
     deliberately: a constraint violation ABORTS the Postgres transaction it fires
     in ("commands ignored until end of transaction block"), so catching it inside
     and returning would only fail again at COMMIT. Letting the transaction reject
     and mapping the violation here is the honest shape — a re-certify collision is a
     legible refusal, not a clobber of the standing signature, and not a throw. */
  try {
    return await database.transaction(async (tx) => {
      /* HUMANITY, RE-READ IN THE WRITE TRANSACTION, FAILED CLOSED. `principal_kind`
         is immutable (0017), so this cannot legitimately disagree with the session —
         but reading it here rather than trusting the session across the transaction
         boundary is the same discipline `certify-session.ts` keeps: an unreadable or
         non-human kind refuses, never defaults to a person. */
      const [viewer] = await tx
        .select({ kind: users.principalKind })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      const kind = parsePrincipalKind(viewer?.kind ?? null);
      if (kind !== 'human') return { ok: false, reason: 'not_human' } as const;

      /* MEMBERSHIP, RE-DERIVED UNDER THE STRONGER LOCK (the TOCTOU close). Certification
         is irreversible, so — like the session-certify path — this takes the
         `membership-and-workspace` share lock, not the append path's membership-only
         one: a concurrent room OR workspace revocation waits for this commit instead
         of slipping between the caller's authorized read and this write. */
      const membership = await loadRoomMembershipRow(tx, authorizedRoomId, session.userId, {
        lock: 'membership-and-workspace',
      });
      if (membership === null) return { ok: false, reason: 'not_in_room' } as const;

      /* THE YJS-SPAN → COVENANT-OBJECT BINDING (#220 / T6). Derive the durable
         `accepted_objects` row the anchor's FK names, in THIS transaction, before the
         anchor insert. ON CONFLICT DO NOTHING so a re-certify (or a concurrent certify
         of another span under the same object id) reuses the standing object rather than
         erroring — the anchor's own unique `(room_id, object_id)` index (below) is what
         enforces one-live-anchor-per-span. Human-touched because a human is certifying;
         the machine never reaches this path (the non-human gate above already refused). */
      if (input.ensureObject !== undefined) {
        await tx
          .insert(acceptedObjects)
          .values({
            id: objectId,
            roomId: authorizedRoomId,
            type: input.ensureObject.type,
            payload: input.ensureObject.payload,
            acceptedBy: session.userId,
            acceptedByKind: 'human',
            humanTouchedAt: new Date(certifiedAt),
          })
          .onConflictDoNothing();
      }

      /* THE SINGLE GATED WRITE. `certifierKind` is the kind just re-read from the
         session's identity — the row's kind IS the authenticated principal's kind —
         and every signed field is the core-derived anchor's, verbatim. The FK to
         `accepted_objects` (same room) and the 0052 correlation trigger are the table
         backstops under this write; the unique `(room_id, object_id)` index is the
         re-certify guard, handled below. */
      const { id } = await insertCovenantAnchor(tx, { anchor, certifierKind: kind });
      return { ok: true, anchorId: id, anchor } as const;
    });
  } catch (error) {
    if (isAnchorUniqueViolation(error)) {
      return { ok: false, reason: 'already_certified' };
    }
    throw error;
  }
}
