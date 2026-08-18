import {
  type AnchorLoader,
  CovenantAnchor,
  CovenantReadAuthority,
  type CovenantReadAuthorityOptions,
  type SpanResolver,
} from '@atrium/core';
import type { Database } from '@atrium/db';
import { covenantAnchors } from '@atrium/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * THE SERVER-SIDE BINDING of the covenant read authority (#191 / SL-4) — the app
 * adapter that wires `@atrium/core`'s pure {@link CovenantReadAuthority} to the
 * `covenant_anchors` ledger (migrations 0050/0051). The load-bearing fail-closed
 * contract — `pending ⇒ ~`, `unavailable/missing/throw ⇒ drift`, only a verified
 * digest ⇒ `ok` — lives in core; this file owns ONLY the ledger read and the
 * row → {@link CovenantAnchor} mapping, exactly as `ports.ts` owns its adapters.
 *
 * The `SpanResolver` (the live-doc re-resolve) is NOT bound here: the live Yjs doc
 * and its production reader (`CovenantDocReaderProd`, #189) live in `apps/web`,
 * where the surface holds the doc handle. The server binding takes the resolver as
 * an argument so a server-side drift sweep (#182) or a test can supply its own.
 */

/**
 * READ the single live covenant anchor for an object from the ledger and map it to
 * the core {@link CovenantAnchor} shape — the {@link AnchorLoader} port.
 *
 * FAIL-CLOSED at the mapping boundary: a row whose `certifier_id` is NULL (the FK is
 * `ON DELETE SET NULL`, so a valid historical `✓` can outlive the user who made it)
 * cannot form a core {@link CovenantAnchor}, whose certifier is a non-null
 * {@link HumanCertifier}. Rather than invent a certifier, this returns `null` for
 * such a row, which the authority reads as `drift`. That is a KNOWN BOUNDARY: the
 * core anchor type (#180) has no post-user-deletion certifier form, so a `✓` whose
 * certifier was later removed resolves `drift` even if its content is unchanged.
 * Widening the core type to carry a nullable certifier is #180/SL-3's call, not
 * SL-4's — the resolve seam must not silently mint a fake certifier to paper over it.
 *
 * Any OTHER malformed row (a digest the CHECK somehow let through, a bad enclosed
 * shape) fails `CovenantAnchor.parse` and throws; the authority catches it and fails
 * closed to `drift`. The `roomId` is bound per authority instance (the room is the
 * isolation boundary, migration 0050's cascade), so the query is keyed by the
 * unique `(room_id, object_id)` index.
 */
export async function readCovenantAnchor(
  db: Database,
  roomId: string,
  objectId: string,
): Promise<CovenantAnchor | null> {
  const rows = await db
    .select()
    .from(covenantAnchors)
    .where(and(eq(covenantAnchors.roomId, roomId), eq(covenantAnchors.objectId, objectId)))
    .limit(1);

  // Destructured rather than indexed, and not for taste. `rows` is derived from a
  // `Database` handle, and `@atrium/auth`'s room-membership boundary check treats
  // any element access on a handle-derived value with a non-string key as "we could
  // not tell what this reads" — so `rows[0]` fails that test. The guard is over-broad
  // there (a numeric literal cannot be a table name) but it is another lane's, and the
  // safe direction is to write the shape it can read (see apps/server/src/jobs/interpret.ts).
  const [row] = rows;
  if (!row) return null;

  // FAIL-CLOSED: a `✓` whose certifier was deleted (certifier_id NULL) has no core
  // certifier form — treat as no resolvable anchor (⇒ drift), never a fake certifier.
  if (row.certifierId === null) return null;

  // Parse THROUGH the core zod schema, so a row that cannot form a valid anchor
  // fails here (⇒ caught by the authority ⇒ drift) rather than resolving a lie.
  return CovenantAnchor.parse({
    objectId: row.objectId,
    roomId: row.roomId,
    revision: row.revision,
    relStart: row.relStart,
    relEnd: row.relEnd,
    stateVector: row.stateVector,
    deleteSet: row.deleteSet,
    enclosedItems: row.enclosedItems,
    renderedDigest: row.renderedDigest,
    // HONEST certifier kind (SL-4 gauntlet HIGH): feed the row's ACTUAL
    // `certifier_kind` through the schema — never hard-code `{ kind: 'human' }`. The
    // DB CHECK (`covenant_anchors_certifier_is_human`) is a backstop, not a licence to
    // launder: a corrupted / machine (`agent`/`model`/`system`) row that slipped past
    // it must NOT be minted into a human certification. `HumanCertifier.parse` (inside
    // `CovenantAnchor.parse`) REFUSES any non-`human` kind, so such a row THROWS here
    // ⇒ the authority catches it ⇒ `drift`, fail-closed. This is the read-side defence
    // that pairs with SL-3's migration 0052 human-at-write enforcement.
    certifier: { kind: row.certifierKind, userId: row.certifierId },
    // The ledger stores a timestamptz (a Date); core wants the canonical UTC spelling
    // Date#toISOString produces, which is exactly what the Timestamp type admits.
    certifiedAt: row.certifiedAt.toISOString(),
  });
}

/**
 * Build a {@link CovenantReadAuthority} bound to a room's ledger. The `loadAnchor`
 * port is the `covenant_anchors` read above; the `resolveSpan` port (the live-doc
 * re-resolve, deadline-bounded) is supplied by the caller — from `apps/web`'s
 * `CovenantDocReaderProd.resolveSpanAsync` on the surface, or a server-side reader
 * in a drift sweep (#182). One authority instance per room (the isolation boundary).
 */
export function serverCovenantReadAuthority(input: {
  readonly db: Database;
  readonly roomId: string;
  readonly resolveSpan: SpanResolver;
}): CovenantReadAuthority {
  const loadAnchor: AnchorLoader = (objectId) =>
    readCovenantAnchor(input.db, input.roomId, objectId);
  const options: CovenantReadAuthorityOptions = {
    loadAnchor,
    resolveSpan: input.resolveSpan,
    // Bind the authority to its room: an anchor loaded for a different room fails
    // closed (defence-in-depth over the `(room_id, object_id)`-keyed query).
    expectedRoomId: input.roomId,
    // THE `#182-before-server-✓` GATE (SL-4 fix round 2, HIGH), now tied to an
    // ACTUALLY-LIVE sweep (E7, #199 Fix 3). The server has no sync doc handle, so this
    // is ALWAYS SET; a cached `ok` is trusted ONLY while a drift sweep is genuinely
    // live on this authority (`RoomDriftSweep.start()` → `authority.markSweepLive(true)`,
    // `stop()`/evict → `markSweepLive(false)`). There is deliberately NO construction
    // boolean to clear the guard: the old `driftSwept: true` cleared it once and left a
    // STOPPED sweep still serving a cached `ok` as a trusted `✓` (the proved fail-open).
    // Trust now follows the sweep's real lifecycle, so a torn-down sweep re-fail-closes.
    failClosedWithoutFreshness: true,
  };
  return new CovenantReadAuthority(options);
}
