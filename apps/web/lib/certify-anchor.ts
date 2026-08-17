import 'server-only';
import { loadRoomMembershipRow, parsePrincipalKind } from '@atrium/auth';
import {
  type CovenantAnchor,
  type CovenantDocReader,
  certifyAnchor,
  type HumanCertifier,
} from '@atrium/core';
import { type Database, insertCovenantAnchor, users } from '@atrium/db';
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
  | 'already_certified';

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
}

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
