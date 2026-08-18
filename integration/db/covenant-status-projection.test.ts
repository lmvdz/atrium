import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptedObjects,
  covenantStatus,
  type DatabaseHandle,
  loadCovenantStatus,
  migrationsFolder,
  upsertCovenantStatus,
} from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrl } from '../support/env.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * THE COVENANT-STATUS PROJECTION (#206, E6), against a real Postgres with the real
 * migrations applied (migration 0056).
 *
 * The claim under test is the ticket's: the server-derived covenant verdict lands in
 * a durable `covenant_status` table, a client can NEVER author one (the write is
 * REVOKEd for every role a REVOKE binds), and the table is set up to sync read-only
 * over the same per-room Electric shape `ydoc_updates` uses (in the publication,
 * REPLICA IDENTITY FULL, no generated columns that would trip the shape's
 * all-columns read).
 *
 * The verdict SOURCE is the built drift sweep — this suite does NOT compute drift; it
 * proves the PROJECTION half: the OWNER upsert (`upsertCovenantStatus`) records and
 * re-records a verdict monotonically, and the REVOKE binds a real non-owner writer.
 *
 * Every refusal below is Postgres's, by code `42501`, proven over a live connection as
 * a real non-owner role rather than read off `information_schema`.
 */

/** The statements of one migration, from the file the server ships. */
function statementsOf(file: string): string[] {
  return readFileSync(join(migrationsFolder(), file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const MIGRATION = '0056_the_covenant_verdict_is_a_read_only_projection.sql';

let handle: DatabaseHandle;
let roomId: string;
let objectId: string;

/** Seed one accepted object so the projection's composite FK to it is satisfiable. */
async function seedObject(): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(acceptedObjects).values({
    id,
    roomId,
    type: 'claim',
    payload: { statement: 'a certified span', claimant: randomUUID(), verification: 'unverified' },
  });
  return id;
}

beforeEach(async () => {
  handle ??= openDatabase();
  await resetDatabase(handle);
  const seeded = await seedRoom(handle, ['alice']);
  roomId = seeded.roomId;
  objectId = await seedObject();
});

afterAll(async () => {
  await handle?.close();
});

describe('the projection is set up to sync read-only, like the ydoc stream', () => {
  it('exists as a table with the covenant_status_kind enum applied by the migration', async () => {
    const [table] = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'covenant_status'`,
    );
    expect(table?.n).toBe(1);
    const labels = await handle.db.execute<{ enumlabel: string }>(
      sql`SELECT e.enumlabel FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'covenant_status_kind' ORDER BY e.enumsortorder`,
    );
    expect(labels.map((r) => r.enumlabel)).toEqual(['ok', 'drift', 'unresolved']);
  });

  /**
   * The publication is the ceiling on what Electric can stream; 0056 ADDs
   * `covenant_status` to the SAME publication `ydoc_updates`/`ydoc_awareness` live in
   * (0053), reconciling rather than replacing.
   */
  it('is published to Electric alongside the two ydoc tables, and nothing else', async () => {
    const rows = await handle.db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_publication_tables
          WHERE pubname = 'electric_publication_default' ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'covenant_status',
      'ydoc_awareness',
      'ydoc_updates',
    ]);
  });

  /** Electric refuses a shape whose table is not REPLICA IDENTITY FULL; `f` is FULL. */
  it('has REPLICA IDENTITY FULL, which Electric requires and its role cannot set', async () => {
    const [row] = await handle.db.execute<{ relreplident: string }>(
      sql`SELECT relreplident FROM pg_class WHERE relname = 'covenant_status'`,
    );
    expect(row?.relreplident).toBe('f');
  });

  /**
   * The shape proxy forwards no `columns` param, so Electric streams every column — a
   * GENERATED column would then have to be named explicitly or Electric errors (T0's
   * op_digest lesson). This table deliberately has NONE: `generation` is a plain
   * bigint the upsert bumps. `attgenerated = ''` means "not generated".
   */
  it('has no generated columns, so the all-columns shape read is safe', async () => {
    const rows = await handle.db.execute<{ attname: string; attgenerated: string }>(
      sql`SELECT attname, attgenerated FROM pg_attribute
          WHERE attrelid = 'public.covenant_status'::regclass AND attnum > 0 AND NOT attisdropped`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const col of rows) {
      expect(col.attgenerated, `${col.attname} must not be a generated column`).toBe('');
    }
  });
});

describe('write-on-recompute: the OWNER upsert tracks the sweep', () => {
  it('inserts a verdict at generation 1, then bumps monotonically on re-recompute', async () => {
    await upsertCovenantStatus(handle.db, { roomId, objectId, status: 'ok' });
    const first = await loadCovenantStatus(handle.db, { roomId, objectId });
    expect(first).toEqual({ status: 'ok', generation: 1 });

    // A later recompute finds the span drifted: the row UPDATES in place, the
    // generation strictly increases, and the client sees the newest verdict.
    await upsertCovenantStatus(handle.db, { roomId, objectId, status: 'drift' });
    const second = await loadCovenantStatus(handle.db, { roomId, objectId });
    expect(second).toEqual({ status: 'drift', generation: 2 });

    // Still one row per (room, object) — the upsert replaced, never appended.
    const rows = await handle.db.select().from(covenantStatus).where(eq(covenantStatus.room, roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('drift');
  });

  it('advances updated_at on each recompute, so a reader can order verdicts by time', async () => {
    await upsertCovenantStatus(handle.db, { roomId, objectId, status: 'ok' });
    const [before] = await handle.db
      .select({ updatedAt: covenantStatus.updatedAt })
      .from(covenantStatus)
      .where(and(eq(covenantStatus.room, roomId), eq(covenantStatus.objectId, objectId)));
    await new Promise((r) => setTimeout(r, 5));
    await upsertCovenantStatus(handle.db, { roomId, objectId, status: 'unresolved' });
    const [after] = await handle.db
      .select({ updatedAt: covenantStatus.updatedAt })
      .from(covenantStatus)
      .where(and(eq(covenantStatus.room, roomId), eq(covenantStatus.objectId, objectId)));
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
  });

  /** A verdict for a span that is not a real accepted object in the room is refused. */
  it('refuses a verdict over a span that is not an accepted object in the room', async () => {
    await expect(
      upsertCovenantStatus(handle.db, { roomId, objectId: randomUUID(), status: 'ok' }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });
});

describe('the REVOKE — a client can never author a verdict (RESERVED for Lars, #208)', () => {
  /**
   * The migration's privilege loop identifies an application role exactly as 0004/0053
   * do — `rolcanlogin AND NOT rolsuper AND rolname <> owner AND
   * has_table_privilege(role, 'core_events', 'SELECT')`. This creates two roles
   * differing in only that thing, replays 0056's own privileges block over them, and
   * then CONNECTS as the app role and tries the writes for real. The `stranger` is the
   * second half: it must get nothing, so the loop is a rule about app roles rather than
   * a `GRANT ... TO PUBLIC` in a costume.
   *
   * Unlike `ydoc_updates`, there is NO write door to admit: the app role reads the
   * projection and never writes it. So the app role must be able to SELECT and unable
   * to INSERT/UPDATE/DELETE — the whole boundary.
   */
  it('leaves the app role able to read and unable to write the projection', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const appRole = `atrium_cov_app_${suffix}`;
    const stranger = `atrium_cov_stranger_${suffix}`;
    const privileges = statementsOf(MIGRATION).find((s) => s.includes('$privileges$'));
    if (!privileges) throw new Error(`${MIGRATION} has no privileges block to replay`);

    await handle.db.execute(sql.raw(`CREATE ROLE "${appRole}" LOGIN PASSWORD 'probe'`));
    await handle.db.execute(sql.raw(`CREATE ROLE "${stranger}" LOGIN PASSWORD 'probe'`));
    try {
      // The only difference between them, and the only thing the loop reads.
      await handle.db.execute(sql.raw(`GRANT SELECT ON TABLE public.core_events TO "${appRole}"`));
      await handle.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${appRole}"`));
      await handle.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${stranger}"`));
      await handle.db.execute(sql.raw(privileges));

      for (const role of [appRole, stranger]) {
        const [table] = await handle.db.execute<Record<string, boolean>>(
          sql`SELECT
                has_table_privilege(${role}, 'public.covenant_status', 'INSERT') AS "insert",
                has_table_privilege(${role}, 'public.covenant_status', 'UPDATE') AS "update",
                has_table_privilege(${role}, 'public.covenant_status', 'DELETE') AS "delete",
                has_table_privilege(${role}, 'public.covenant_status', 'TRUNCATE') AS "truncate"`,
        );
        expect(table, `${role} must hold no write privilege on covenant_status`).toEqual({
          insert: false,
          update: false,
          delete: false,
          truncate: false,
        });
      }

      // The app role reads; the stranger does not even read.
      const [reads] = await handle.db.execute<Record<string, boolean>>(
        sql`SELECT
              has_table_privilege(${appRole}, 'public.covenant_status', 'SELECT') AS "appRole",
              has_table_privilege(${stranger}, 'public.covenant_status', 'SELECT') AS "stranger"`,
      );
      expect(reads).toEqual({ appRole: true, stranger: false });

      // ── AND NOW FOR REAL, over a connection as the app role ──────────────────
      // Seed one verdict as the owner so the SELECT below has a row to return.
      await upsertCovenantStatus(handle.db, { roomId, objectId, status: 'ok' });
      const url = new URL(databaseUrl());
      url.username = appRole;
      url.password = 'probe';
      const asAppRole = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        // A client-role INSERT is refused by the REVOKE — a permission denial on the
        // table, code 42501, one layer before anything else. This is the acceptance:
        // a non-owner role can never author a covenant verdict.
        await expect(
          asAppRole.unsafe(
            `INSERT INTO public.covenant_status (room, object_id, status)
             VALUES ('${roomId}'::uuid, '${objectId}'::uuid, 'ok')`,
          ),
        ).rejects.toMatchObject({ code: '42501' });

        // Nor can it rewrite an existing verdict the server owns.
        await expect(
          asAppRole.unsafe(
            `UPDATE public.covenant_status SET status = 'ok'
             WHERE room = '${roomId}'::uuid AND object_id = '${objectId}'::uuid`,
          ),
        ).rejects.toMatchObject({ code: '42501' });

        // Nor delete one.
        await expect(
          asAppRole.unsafe(
            `DELETE FROM public.covenant_status
             WHERE room = '${roomId}'::uuid AND object_id = '${objectId}'::uuid`,
          ),
        ).rejects.toMatchObject({ code: '42501' });

        // But the read the sync path relies on works — this is a projection to read,
        // not a ban.
        const seen = await asAppRole.unsafe(
          `SELECT status FROM public.covenant_status
           WHERE room = '${roomId}'::uuid AND object_id = '${objectId}'::uuid`,
        );
        expect(seen[0]?.status).toBe('ok');
      } finally {
        await asAppRole.end();
      }
    } finally {
      await handle.db.execute(sql.raw(`REASSIGN OWNED BY "${appRole}" TO CURRENT_USER`));
      await handle.db.execute(sql.raw(`DROP OWNED BY "${appRole}"`));
      await handle.db.execute(sql.raw(`DROP OWNED BY "${stranger}"`));
      await handle.db.execute(sql.raw(`DROP ROLE "${appRole}"`));
      await handle.db.execute(sql.raw(`DROP ROLE "${stranger}"`));
    }
  });

  /** PUBLIC holds no write on the projection — the first line of the privileges block. */
  it('leaves PUBLIC with no write privilege on the projection', async () => {
    const [row] = await handle.db.execute<Record<string, boolean>>(
      sql`SELECT
            has_table_privilege('public', 'public.covenant_status', 'INSERT') AS "insert",
            has_table_privilege('public', 'public.covenant_status', 'UPDATE') AS "update",
            has_table_privilege('public', 'public.covenant_status', 'DELETE') AS "delete",
            has_table_privilege('public', 'public.covenant_status', 'TRUNCATE') AS "truncate"`,
    );
    expect(row).toEqual({ insert: false, update: false, delete: false, truncate: false });
  });
});
