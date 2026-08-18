import type { CovenantReadStatus } from '@atrium/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { covenantStatus } from './schema.js';

/**
 * THE COVENANT-STATUS UPSERT — the ONE write into `covenant_status` (#206, E6), and
 * the SERVER/OWNER path the projection is authored through. It records the verdict the
 * drift sweep's read authority just computed for a certified span, so the durable
 * projection tracks the sweep and an Electric client can render `✓`/`~` from a synced
 * row instead of a server-baked SSR map.
 *
 * ## Why this is safe to write directly (no SECURITY DEFINER door)
 *
 * Unlike `ydoc_updates` — whose members legitimately APPEND through an authorizing
 * function — `covenant_status` has NO client/app writer to authorize. The verdict is
 * server-derived and server-owned: the only writer is the table OWNER (the server
 * process in every deployment this repo ships), and migration 0056 REVOKEs every
 * write verb from PUBLIC and from every application role. So this is a plain owner
 * upsert; the boundary is the REVOKE (durably, #208's app-as-non-owner deployment),
 * not an in-function membership check. The REVOKE/role semantics on this
 * covenant-authority table are DRAFTED for Lars's ratification.
 *
 * ## Generation-GUARDED upsert — the sweep's LOGICAL generation is the authority
 *
 * `(room, object_id)` is the primary key, so a re-verdict for the same span is an
 * upsert. The `generation` is NOT a blind arrival-order counter — it is the drift
 * sweep's per-object LOGICAL generation (`RoomDriftSweep`'s `draftGeneration`, bumped
 * once per re-resolve of the span), passed in verbatim so the ORDER OF INTENT, not the
 * order the writes happen to land in, decides the row.
 *
 * The conflict branch overwrites `status`/`generation`/`updated_at` ONLY WHEN the
 * incoming generation is STRICTLY GREATER than the stored one
 * (`setWhere: stored.generation < excluded.generation`). A stale or out-of-order
 * verdict — a lower/equal generation arriving after a newer one already landed — is a
 * NO-OP, never an overwrite. This is what stops the cardinal sin: an `ok(gen G1)`
 * whose DB write races behind and lands after a `drift(gen G2>G1)` can no longer strand
 * the row at `ok` over drifted content. The guard is enforced by Postgres in the one
 * statement, so it is atomic and needs no read-modify-write.
 *
 * The INSERT seeds `generation` from the caller too (first write for the span); the
 * check constraint `covenant_status_generation_positive` requires `>= 1`, which the
 * sweep's logical generation always satisfies (it starts at 1 and only grows).
 *
 * ## Forward notes for T4 (the client consumer — NOT built here)
 *
 *   * The client must render `✓` ONLY on `status === 'ok'`, never on mere row
 *     existence — a `drift`/`unresolved` row is a machine `~`, and a row's presence is
 *     not itself a verdict.
 *   * UN-CERTIFY is not built yet. If a span's anchor is deleted WITHOUT deleting the
 *     object, its `covenant_status` row survives (the FK cascades on object/room delete,
 *     not on anchor delete) at whatever generation it last held. The sweep's logical
 *     generation resets to 1 when an object is pruned from its in-process ledger, so a
 *     later re-certify + sweep could be rejected by this strictly-greater guard and
 *     strand a stale verdict. Guard that seam when un-certify lands (its own #217-shaped
 *     concern), e.g. delete the row on un-certify or reset generation together.
 */
export async function upsertCovenantStatus(
  db: Pick<Database, 'insert'>,
  params: {
    readonly roomId: string;
    readonly objectId: string;
    /** The sweep's verdict, verbatim — `ok` ⇒ `✓`; `drift`/`unresolved` ⇒ `~`. */
    readonly status: CovenantReadStatus;
    /**
     * The sweep's LOGICAL per-object generation for this verdict (>= 1). The guard
     * below keeps the row at the highest generation seen, so a lower/equal (stale,
     * out-of-order) generation is rejected rather than overwriting a newer verdict.
     */
    readonly generation: number;
  },
): Promise<void> {
  await db
    .insert(covenantStatus)
    .values({
      room: params.roomId,
      objectId: params.objectId,
      status: params.status,
      generation: params.generation,
    })
    .onConflictDoUpdate({
      target: [covenantStatus.room, covenantStatus.objectId],
      set: {
        status: params.status,
        generation: params.generation,
        updatedAt: sql`now()`,
      },
      // Only a STRICTLY-NEWER generation may overwrite. A stale/out-of-order verdict
      // (stored.generation >= incoming) is a no-op — the guard, and the whole fix.
      setWhere: sql`${covenantStatus.generation} < excluded.generation`,
    });
}

/**
 * Read one span's projected verdict back — the ledger side used by the E6 test and,
 * later, by the server render as a fast path. Room-scoped on the `(room, object_id)`
 * primary key; returns `null` when no verdict has been projected for the span yet.
 */
export async function loadCovenantStatus(
  db: Pick<Database, 'select'>,
  params: { readonly roomId: string; readonly objectId: string },
): Promise<{ status: CovenantReadStatus; generation: number } | null> {
  const [row] = await db
    .select({ status: covenantStatus.status, generation: covenantStatus.generation })
    .from(covenantStatus)
    .where(
      and(eq(covenantStatus.room, params.roomId), eq(covenantStatus.objectId, params.objectId)),
    )
    .limit(1);
  if (!row) return null;
  return { status: row.status, generation: row.generation };
}
