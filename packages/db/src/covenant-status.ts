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
 * ## Monotone generation, in one statement
 *
 * `(room, object_id)` is the primary key, so a re-verdict for the same span is an
 * upsert: INSERT at `generation = 1`, or on conflict bump `generation = generation + 1`
 * and re-stamp `updated_at = now()`. The bump is computed from the EXISTING row inside
 * the same statement, so it is atomic and monotone per span without a trigger or a
 * read-modify-write race.
 */
export async function upsertCovenantStatus(
  db: Pick<Database, 'insert'>,
  params: {
    readonly roomId: string;
    readonly objectId: string;
    /** The sweep's verdict, verbatim — `ok` ⇒ `✓`; `drift`/`unresolved` ⇒ `~`. */
    readonly status: CovenantReadStatus;
  },
): Promise<void> {
  await db
    .insert(covenantStatus)
    .values({
      room: params.roomId,
      objectId: params.objectId,
      status: params.status,
      // First write for the span; a re-verdict takes the conflict branch below.
      generation: 1,
    })
    .onConflictDoUpdate({
      target: [covenantStatus.room, covenantStatus.objectId],
      set: {
        status: params.status,
        // Monotone per span, computed from the existing row in this same statement.
        generation: sql`${covenantStatus.generation} + 1`,
        updatedAt: sql`now()`,
      },
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
    .where(and(eq(covenantStatus.room, params.roomId), eq(covenantStatus.objectId, params.objectId)))
    .limit(1);
  if (!row) return null;
  return { status: row.status, generation: row.generation };
}
