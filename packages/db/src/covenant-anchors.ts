import type { CovenantAnchor } from '@atrium/core';
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
