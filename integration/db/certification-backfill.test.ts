import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseHandle, migrationsFolder } from '@atrium/db';
import { acceptedObjects } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * Migration 0019's backfill reconstructs `accepted_by_kind` and
 * `human_touched_at` from the IMMUTABLE ledger (`core_events.actor_kind`), not
 * the nullable attribution FKs (`accepted_objects.accepted_by`,
 * `corrections.by_user_id`). Both FKs are `ON DELETE SET NULL`, so a backfill
 * keyed on them reads a historical `✓` whose accepting user was later deleted as
 * a `model` acceptance and downgrades it to `~` (#98 r2, finding 4).
 *
 * These rows are never touched by the projection (that writes the columns
 * directly from the fold), so nothing else in the suite exercises the backfill.
 * This runs the migration's OWN `UPDATE` statements against rows whose FK
 * attribution has been nulled — the deletion scenario — and proves the ledger,
 * not the FK, decides the glyph.
 */

let handle: DatabaseHandle;

beforeEach(async () => {
  handle ??= openDatabase(5);
  await resetDatabase(handle);
});

afterAll(async () => {
  await handle?.close();
});

/** The three reconstruction `UPDATE`s from 0019, replayed verbatim. */
function backfillStatements(): string[] {
  return readFileSync(
    join(migrationsFolder(), '0019_the_read_model_names_who_certified.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes('UPDATE "accepted_objects"'));
}

/** A strictly-increasing canonical UTC instant, so each append sorts after the last. */
let tick = 0;
function nextAt(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 7, 5, 12, 0, tick)).toISOString();
}

/** Append one event the way production does — through the procedure, under the lock. */
async function append(row: {
  roomId: string;
  id: string;
  type: string;
  actorKind: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT "seq" FROM atrium_append_core_event(
        ${row.roomId}::uuid,
        ${row.id}::text,
        ${row.type}::event_type,
        ${row.actorKind}::actor_kind,
        ${row.actorId}::text,
        ${JSON.stringify(row.payload)}::jsonb,
        ${row.occurredAt}::timestamptz
      )
    `);
  });
}

/** An `object_accepted` event minting a named object with the given accepter kind. */
async function appendAccepted(
  roomId: string,
  objectId: string,
  actorKind: 'human' | 'model',
  actorId: string | null,
): Promise<string> {
  const id = randomUUID();
  const at = nextAt();
  await append({
    roomId,
    id,
    type: 'object_accepted',
    actorKind,
    actorId,
    occurredAt: at,
    payload: {
      id,
      at,
      type: 'object_accepted',
      object: {
        id: objectId,
        roomId,
        type: 'claim',
        payload: { statement: 'ship it', claimant: null, verification: 'unverified' },
        objectiveId: null,
        provenance: { messageIds: [], proposalId: null, interpretationId: null },
        createdAt: at,
        updatedAt: at,
      },
    },
  });
  return at;
}

/** An `object_corrected` event by the given actor kind against a named object. */
async function appendCorrected(
  roomId: string,
  objectId: string,
  actorKind: 'human' | 'model',
  actorId: string | null,
): Promise<string> {
  const id = randomUUID();
  const at = nextAt();
  await append({
    roomId,
    id,
    type: 'object_corrected',
    actorKind,
    actorId,
    occurredAt: at,
    payload: {
      id,
      at,
      type: 'object_corrected',
      objectId,
      action: 'amend',
      patch: {},
      toType: null,
      provenance: { messageIds: [], proposalId: null, interpretationId: null },
      note: null,
    },
  });
  return at;
}

/** Insert an accepted-objects row in its PRE-backfill state: default kind, no touch. */
async function seedPreMigrationObject(
  roomId: string,
  objectId: string,
  createdAt: string,
): Promise<void> {
  await handle.db.insert(acceptedObjects).values({
    id: objectId,
    roomId,
    type: 'claim',
    payload: { statement: 'ship it', claimant: randomUUID(), verification: 'unverified' },
    revision: 0,
    // The two columns 0019 added, at the value existing rows carried before the
    // backfill: the fail-closed default and NULL. `accepted_by` is deliberately
    // NULL for every row — the deletion the finding is about already happened.
    acceptedBy: null,
    acceptedByKind: 'model',
    humanTouchedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });
}

describe('migration 0019 backfill reconstructs certification from the immutable ledger', () => {
  it('recovers a human acceptance whose user was deleted, and never reads the nulled FK', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice'], { slug: 'certify' });
    const alice = people.alice as string;

    // Three historical rows, each with `accepted_by` NULL (its user deleted):
    //  H  — accepted by a HUMAN; the ledger says so even though the FK is gone.
    //  M  — accepted by a MODEL; a machine's reading, stays `~`.
    //  MC — accepted by a MODEL, later CORRECTED by a human; promoted to `✓`.
    const objectH = randomUUID();
    const objectM = randomUUID();
    const objectMC = randomUUID();

    const acceptedH = await appendAccepted(roomId, objectH, 'human', alice);
    await appendAccepted(roomId, objectM, 'model', 'test-model');
    await appendAccepted(roomId, objectMC, 'model', 'test-model');
    const correctedMC = await appendCorrected(roomId, objectMC, 'human', alice);

    await seedPreMigrationObject(roomId, objectH, acceptedH);
    await seedPreMigrationObject(roomId, objectM, nextAt());
    await seedPreMigrationObject(roomId, objectMC, nextAt());

    // Precondition: the FK the OLD backfill trusted is NULL on every row, so an
    // `accepted_by IS NOT NULL` reconstruction would call all three machines.
    const before = await handle.db
      .select({ id: acceptedObjects.id, acceptedBy: acceptedObjects.acceptedBy })
      .from(acceptedObjects)
      .where(eq(acceptedObjects.roomId, roomId));
    expect(before.every((row) => row.acceptedBy === null)).toBe(true);

    // Replay 0019's own backfill statements.
    for (const statement of backfillStatements()) {
      await handle.db.execute(sql.raw(statement));
    }

    const read = async (objectId: string) => {
      const [row] = await handle.db
        .select({
          acceptedByKind: acceptedObjects.acceptedByKind,
          humanTouchedAt: acceptedObjects.humanTouchedAt,
          acceptedBy: acceptedObjects.acceptedBy,
        })
        .from(acceptedObjects)
        .where(and(eq(acceptedObjects.roomId, roomId), eq(acceptedObjects.id, objectId)));
      return row;
    };

    const h = await read(objectH);
    const m = await read(objectM);
    const mc = await read(objectMC);

    // H: the immutable ledger recovers the HUMAN acceptance the nulled FK lost —
    // a `✓` the old backfill would have silently downgraded to `~`.
    expect(h?.acceptedBy).toBeNull();
    expect(h?.acceptedByKind).toBe('human');
    expect(h?.humanTouchedAt?.toISOString()).toBe(new Date(acceptedH).toISOString());

    // M: a machine's reading, untouched — `~`.
    expect(m?.acceptedByKind).toBe('model');
    expect(m?.humanTouchedAt).toBeNull();

    // MC: model-accepted, then a human correction promotes it — the touch is the
    // correction's immutable `occurred_at`, recovered though `by_user_id` is gone.
    expect(mc?.acceptedByKind).toBe('model');
    expect(mc?.humanTouchedAt?.toISOString()).toBe(new Date(correctedMC).toISOString());
  });
});
