import { CovenantAnchor } from '@atrium/core';
import { and, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { covenantAnchors } from './schema.js';

/**
 * THE COVENANT ANCHOR WRITE — the ONE typed insert into `covenant_anchors`
 * (#190, SL-3 CERTIFY-PATH). Every column that describes WHAT WAS SIGNED comes
 * from the `CovenantAnchor` `@atrium/core`'s `certifyAnchor` derived-and-signed,
 * and from nowhere else. That is enforcement req 2 made structural: this function
 * has no parameter for a `rendered_digest`, a `state_vector`, a `delete_set`, or
 * a span boundary, so there is no field through which a client-built anchor could
 * substitute its own values for the server reader's. The `parse()` mint-bypass
 * SL-1's gauntlet found is closed by construction — the only shape that reaches
 * the table is the one core signed.
 *
 * ## certifier_kind rides in SEPARATELY, from the SESSION (enforcement req 1)
 *
 * The persisted `certifier_kind` is NOT read off the anchor and NOT off the
 * request — it is the caller-supplied `certifierKind`, which the gate
 * (`apps/web/lib/certify-anchor.ts`) sets from the AUTHENTICATED session's
 * `principal_kind`. The gate refuses a non-human before it ever calls this, so in
 * practice the value is always `'human'`; passing it explicitly (rather than
 * hardcoding `'human'` here) keeps the data-flow honest — the kind on the row is
 * the kind of the identity the server authenticated — and the DB backstops
 * (0050's `covenant_anchors_certifier_is_human` CHECK and 0052's
 * `covenant_anchor_certifier_is_human` correlation trigger) refuse the row if a
 * caller ever hands a machine kind or an agent uuid dressed as the certifier.
 *
 * `certifier_id` is the anchor's `certifier.userId` — a `HumanCertifier` always
 * names one, so a fresh anchor is never anonymous (0052 also refuses a null
 * certifier_id on INSERT).
 *
 * The unique `(room_id, object_id)` index (0050) makes "one live anchor per span"
 * a table fact: a second certify over the same span is a fresh human act that
 * REPLACES the row, never a silent second insert. Callers that mean "re-certify"
 * delete-then-insert under that key; this function performs the single insert and
 * returns the new row's id.
 */
export async function insertCovenantAnchor(
  db: Pick<Database, 'insert'>,
  params: {
    /** The complete anchor `certifyAnchor(serverReader, meta)` derived and signed. */
    readonly anchor: CovenantAnchor;
    /**
     * The KIND to persist, from the authenticated session's `principal_kind` — the
     * gate's only honest source. Never the request, never the anchor's own copy.
     */
    readonly certifierKind: 'human' | 'agent' | 'model' | 'system';
  },
): Promise<{ readonly id: string }> {
  const { anchor, certifierKind } = params;
  const [row] = await db
    .insert(covenantAnchors)
    .values({
      roomId: anchor.roomId,
      objectId: anchor.objectId,
      // Every signed field, verbatim from the core-derived anchor.
      revision: anchor.revision,
      relStart: anchor.relStart,
      relEnd: anchor.relEnd,
      stateVector: anchor.stateVector,
      deleteSet: anchor.deleteSet,
      enclosedItems: anchor.enclosedItems,
      renderedDigest: anchor.renderedDigest,
      // The kind rides in from the session; the id names the human on the anchor.
      certifierKind,
      certifierId: anchor.certifier.userId,
      certifiedAt: new Date(anchor.certifiedAt),
    })
    .returning({ id: covenantAnchors.id });
  // `returning` yields exactly one row for a single-row insert; the table's
  // constraints/triggers RAISE (rejecting the write) rather than return zero rows.
  return { id: (row as { id: string }).id };
}

/**
 * THE COVENANT ANCHOR READ — the ledger side of the read authority's
 * {@link import('@atrium/core').AnchorLoader} port (#198, P6F-4). The write above
 * (`insertCovenantAnchor`) puts the ONE core-signed anchor into the table; this
 * fetches it back so `webCovenantReadAuthority` can re-resolve the certified span
 * against the live document and decide `✓`/`~`. It is deliberately its own function
 * (explicitly OUT of SL-4's scope, owned by the resolver-wiring here) so the read
 * path is as narrow and typed as the write.
 *
 * ROOM-SCOPED, and re-VALIDATED. The `(room_id, object_id)` lookup rides the unique
 * index (0050): it returns the room's live anchor for the object, or `null`. Scoping
 * by room is the first of the two foreign-room guards — an anchor that carries the
 * requested `object_id` but lives in a DIFFERENT room is simply not selected here, so
 * it can never paint this room's `✓` (the second guard is the authority's
 * `expectedRoomId`, defence-in-depth). The row is reconstructed into the core shape
 * and run through `CovenantAnchor.parse`, so a row that cannot form a valid anchor —
 * a non-human `certifier_kind`, a `certifier_id` nulled by a user delete
 * (`onDelete: 'set null'`), a non-canonical timestamp — fails CLOSED to `null` (⇒
 * `drift` ⇒ `~`) rather than being trusted. `certified_at` is re-spelled through
 * `Date#toISOString()`, the exact canonical form `Timestamp` admits.
 */
export async function loadCovenantAnchor(
  db: Pick<Database, 'select'>,
  params: { readonly roomId: string; readonly objectId: string },
): Promise<CovenantAnchor | null> {
  const [row] = await db
    .select()
    .from(covenantAnchors)
    .where(
      and(eq(covenantAnchors.roomId, params.roomId), eq(covenantAnchors.objectId, params.objectId)),
    )
    .limit(1);
  if (!row) return null;
  const parsed = CovenantAnchor.safeParse({
    objectId: row.objectId,
    roomId: row.roomId,
    revision: row.revision,
    relStart: row.relStart,
    relEnd: row.relEnd,
    stateVector: row.stateVector,
    deleteSet: row.deleteSet,
    enclosedItems: row.enclosedItems,
    renderedDigest: row.renderedDigest,
    // Only a human is a valid certifier; a row that somehow carries another kind, or
    // whose certifier_id was nulled by a user delete, fails the parse ⇒ `null` ⇒ `~`.
    certifier: { kind: row.certifierKind, userId: row.certifierId },
    certifiedAt: row.certifiedAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * THE AUTHORITATIVE CERTIFIED-OBJECT SET for a room (E7, #199 Fix 1) — every
 * `object_id` that HAS a live covenant anchor in `covenant_anchors`, read straight
 * from the ledger. This is the set the drift-on-update sweep re-resolves: deriving it
 * from the ledger (not from a caller-passed list) is what closes the false-`✓` hole —
 * an object a caller forgot to enumerate would never be swept and a stale `✓` over it
 * would go undetected, whereas the ledger names EVERY certified span by construction.
 *
 * Deliberately UNFILTERED and un-parsed: it returns the raw certified `object_id`s
 * (a malformed anchor still names a span that must be swept — the per-object resolve
 * fails it closed to `drift`, so over-covering here is the fail-closed direction).
 * Room-scoped on the `(room_id, object_id)` index; distinct because the unique index
 * already guarantees one live anchor per object, but `DISTINCT` keeps it robust if a
 * future migration relaxes that.
 */
export async function listCovenantAnchorObjectIds(
  db: Pick<Database, 'selectDistinct'>,
  params: { readonly roomId: string },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ objectId: covenantAnchors.objectId })
    .from(covenantAnchors)
    .where(eq(covenantAnchors.roomId, params.roomId));
  return rows.map((r) => r.objectId);
}
