import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseHandle, migrationsFolder, workspaceMembers } from '@atrium/db';
import { rooms, ydocAwareness, ydocUpdates } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { violatesConstraint } from '../support/constraints.js';
import { databaseUrl } from '../support/env.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * The document stream's boundary, against a real Postgres with the real
 * migrations applied (#201, migration 0053).
 *
 * The claim under test is the one the ticket calls the covenant-adjacent corner:
 * **the content a human `✓` signs cannot be written by anything except the
 * authorized append path.** A `✓` (0050/0051) is a signature over rendered
 * content, and that content is folded from `ydoc_updates`. A writer who can put
 * a row in that table can move the ground under a signature; DETECT (#164) can
 * only re-stale drift it can attribute, and an unattributable write is exactly
 * the case it cannot.
 *
 * So this asserts the same two-layer shape 0003/0004 gave `core_events`, because
 * one layer is not enough and each covers the other's blind spot:
 *
 *   * the **REVOKE**, which binds every role except the owner and a superuser,
 *     proven by connecting as a real non-owner login role rather than by reading
 *     `information_schema`; and
 *   * the **guard trigger**, which is the only thing that binds the owner — and
 *     the owner is what the application connects as in every deployment this
 *     repo ships, and what the test role here happens to be.
 *
 * Every refusal below is Postgres's, named by constraint, and every grant is
 * asserted against `has_table_privilege` rather than against a GRANT statement
 * somebody remembered to write.
 */

/** The statements of one migration, from the file the server ships. */
function statementsOf(file: string): string[] {
  return readFileSync(join(migrationsFolder(), file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const MIGRATION = '0053_the_document_stream_is_a_gated_append.sql';

let handle: DatabaseHandle;
let roomId: string;
let workspaceId: string;
let alice: string;
let outsider: string;

const OP = Buffer.from([1, 2, 3, 4, 5]);

beforeEach(async () => {
  handle ??= openDatabase();
  await resetDatabase(handle);
  const seeded = await seedRoom(handle, ['alice']);
  roomId = seeded.roomId;
  workspaceId = seeded.workspaceId;
  alice = seeded.people.alice as string;
  // A real user with a real workspace, and no membership of `roomId`. Seeded as
  // its own room rather than as a bare `users` row so the negative below is
  // "a person the system knows, who is not in THIS room" — which is the case a
  // membership check can get wrong — rather than "a uuid nobody has heard of".
  const elsewhere = await seedRoom(handle, ['mallory']);
  outsider = elsewhere.people.mallory as string;
});

afterAll(async () => {
  await handle?.close();
});

async function appendAs(actorId: string, room = roomId, op: Buffer = OP): Promise<string> {
  const [row] = await handle.db.execute<{ id: string }>(
    sql`SELECT atrium_append_ydoc_update(${room}::uuid, ${actorId}::uuid, ${op}::bytea) AS id`,
  );
  return row?.id as string;
}

describe('the sync fabric is standing (#201 acceptance)', () => {
  /**
   * Acceptance item 1. Asserted against the SERVER, not against the compose
   * file: `docker-compose.yml` and `docker-compose.test.yml` both set
   * `wal_level=logical`, and a test that read the yaml would pass on a database
   * that had never been restarted. Electric's replication slot cannot be created
   * at all below `logical`, so this is the fabric's precondition and not a
   * preference.
   */
  it('runs Postgres at wal_level=logical, so a replication slot is possible', async () => {
    const [row] = await handle.db.execute<{ wal_level: string }>(sql`SHOW wal_level`);
    expect(row?.wal_level).toBe('logical');
  });

  /**
   * The publication is the CEILING on what the sync service can ever see, and it
   * is a database object rather than a line in a config file. Electric connects
   * as a role that owns nothing and cannot alter it, so a table absent from this
   * list is a table Electric is refused — measured against electricsql/electric
   * 1.7.11, which answers `503 … missing from the publication … and Electric
   * lacks privileges to add it`.
   *
   * The negative is the half that matters: naming the two tables proves the
   * shape works, and `core_events` being absent proves the ceiling is low.
   */
  it('publishes exactly the two document tables to Electric, and nothing else', async () => {
    const rows = await handle.db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_publication_tables
          WHERE pubname = 'electric_publication_default' ORDER BY tablename`,
    );
    expect(rows.map((row) => row.tablename)).toEqual(['ydoc_awareness', 'ydoc_updates']);
  });

  /**
   * Electric refuses a shape whose table is not `REPLICA IDENTITY FULL`, and it
   * normally sets that itself by ALTERing the table — which needs ownership the
   * least-privilege replication role deliberately does not have. So the
   * migration sets it, and this is the assertion that keeps it set: `f` is FULL,
   * `d` is the default.
   */
  it('gives both tables REPLICA IDENTITY FULL, which Electric requires and cannot set', async () => {
    const rows = await handle.db.execute<{ relname: string; relreplident: string }>(
      sql`SELECT relname, relreplident FROM pg_class
          WHERE relname IN ('ydoc_updates', 'ydoc_awareness') ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: 'ydoc_awareness', relreplident: 'f' },
      { relname: 'ydoc_updates', relreplident: 'f' },
    ]);
  });
});

describe('ydoc_updates is writable only through the append door', () => {
  it('appends through the function, and the row is what a shape would carry', async () => {
    const id = await appendAs(alice);
    const [row] = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.id, id));
    expect(row?.room).toBe(roomId);
    expect(Buffer.from(row?.op as Uint8Array)).toEqual(OP);
  });

  /**
   * THE GUARD, and the layer that binds the owner.
   *
   * This suite connects as the test database's owner — which is also a superuser
   * — so no REVOKE in the migration reaches it. That is not a weakness of the
   * test, it is the case the guard exists for: the application connects as the
   * owner in every deployment this repo ships, so "the app cannot write this
   * table directly" is a claim only the trigger can make. A direct insert
   * through the drizzle table object is exactly the mistake a future lane would
   * make, so that is the shape the test takes.
   */
  it('refuses a direct INSERT even as the table owner', async () => {
    await violatesConstraint('ydoc_updates_append_through_procedure', () =>
      handle.db.insert(ydocUpdates).values({ room: roomId, op: OP, streamSeq: 1 }),
    );
  });

  /**
   * THE GUARD IS AN ACCIDENT CHECK, NOT A BOUNDARY — recorded as truth, not left
   * to a test that only tries the unadorned insert (which the trigger DOES catch,
   * above). The guard reads `PG_CONTEXT`, the caller's own PL/pgSQL frame text,
   * for the substring `function atrium_append_ydoc_update(`. #22's gauntlet r7
   * proved on real PG16 that a single SQL COMMENT carrying that substring rides
   * into the frame text and satisfies the check at no privilege cost; migration
   * 0009 is the write-up, and this asserts the same defeat for ydoc_updates so the
   * corpus does not claim a boundary the code does not have.
   *
   * Run inside a `DO` block on purpose: `PG_CONTEXT` only carries a statement's
   * text when it executes as a nested SQL statement of a PL/pgSQL frame — which is
   * exactly why a bare top-level insert (the test above) is refused and this one
   * is not. The row LANDS, with no membership authorized, which is the finding.
   */
  it('does NOT stop a comment-forged direct INSERT — the guard costs a comment, not a privilege (0009)', async () => {
    const before = await handle.db.select().from(ydocUpdates);
    // The comment embeds the exact substring the frame check searches for.
    await handle.db.execute(
      sql.raw(
        `DO $forge$ BEGIN
           INSERT INTO ydoc_updates (room, op, stream_seq) /* function atrium_append_ydoc_update( */
           VALUES ('${roomId}'::uuid, '\\x0102'::bytea, 1);
         END $forge$;`,
      ),
    );
    const after = await handle.db.select().from(ydocUpdates);
    expect(
      after.length,
      'the comment-forged direct INSERT landed a row — the frame guard is an accident check, not a boundary',
    ).toBe(before.length + 1);
  });

  /**
   * An in-place rewrite is the one mutation DETECT (#182) could not see: it
   * watches for NEW updates, and an UPDATE produces none while changing what the
   * document folds to. Refused unconditionally rather than gated, because there
   * is no legitimate caller — a Yjs update is an immutable fact.
   */
  it('refuses an UPDATE of an op, which drift detection could not have seen', async () => {
    const id = await appendAs(alice);
    await violatesConstraint('ydoc_updates_append_only', () =>
      handle.db
        .update(ydocUpdates)
        .set({ op: Buffer.from([9, 9, 9]) })
        .where(eq(ydocUpdates.id, id)),
    );
  });

  it('refuses an append by somebody who is not a member of that room', async () => {
    await violatesConstraint('ydoc_updates_append_actor_authorized', () => appendAs(outsider));
  });

  it('refuses an append with no author at all', async () => {
    await violatesConstraint('ydoc_updates_append_actor_authorized', () =>
      handle.db.execute(
        sql`SELECT atrium_append_ydoc_update(${roomId}::uuid, NULL::uuid, ${OP}::bytea)`,
      ),
    );
  });

  /**
   * The write gate and the read gate check the SAME three conditions —
   * `loadRoomMembership`'s membership row, live room, surviving workspace member
   * — so they cannot drift into a room somebody may read but not write, or the
   * other way round. Archiving is the cheapest of the three to move, so it is
   * the one asserted: a member of an archived room is refused by the function
   * for the same reason `loadRoomMembership` returns null for them.
   */
  it('refuses an append into an archived room, exactly as the read gate refuses to open one', async () => {
    await handle.db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, roomId));
    await violatesConstraint('ydoc_updates_append_actor_authorized', () => appendAs(alice));
  });

  it('refuses an empty op, which folds to nothing and costs a round trip', async () => {
    await violatesConstraint('ydoc_updates_op_not_empty', () =>
      appendAs(alice, roomId, Buffer.alloc(0)),
    );
  });
});

/**
 * THE WRITE GATE AGREES WITH THE READ GATE (#201 finding 2).
 *
 * `loadRoomMembership` denies — returns null — in more cases than "no membership
 * row": `effectiveRoomRole` resolves an unrecognised role on EITHER the room or
 * the workspace side to null, and the join to `workspace_members` means a
 * workspace-level revoke closes the room even while a stale `memberships` row
 * survives. The append function must refuse the same cases, or a removed member —
 * or one whose role string the read cannot parse — could keep writing a document
 * they can no longer open. These flip each condition and assert the write refuses
 * exactly where the read denies.
 *
 * WHERE AN UNPARSEABLE ROLE CAN ACTUALLY LIVE. `memberships.role` is a Postgres
 * enum (`membership_role` = {owner, admin, member}), so the column itself refuses
 * an unknown value — the write's `atrium_role_is_known(m.role)` half is defensive
 * against enum drift and never fires today. `workspace_members.role` is free
 * `text` (Better Auth's organization plugin stores a comma list), so THAT is the
 * side where a `'billing'` or a `'suspended,admin'` is storable and where the
 * read side's `parseRole` null-branch — and this write's matching refusal — earn
 * their keep. The tests below flip the text side accordingly.
 */
describe('the write gate refuses everywhere the read gate denies', () => {
  it('accepts a comma-listed workspace role the read side would still parse (owner,member)', async () => {
    // parseRole is lenient about a list of KNOWN roles, taking the strongest, so
    // the write must be too — refusing this would be a gate STRICTER than the read.
    // The room role stays the valid enum default; only the free-text workspace
    // role can carry a list at all.
    await handle.db
      .update(workspaceMembers)
      .set({ role: 'owner,member' })
      .where(
        and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, alice)),
      );
    const id = await appendAs(alice);
    expect(id).toBeTruthy();
  });

  it('refuses an append when the workspace role is a single unrecognised value, as the read denies', async () => {
    // 'billing' is not one of {owner, admin, member}; parseRole returns null and
    // loadRoomMembership denies. The write must refuse for the same reason. The
    // room role is an enum and cannot hold this, so the workspace text column is
    // the only place the case is reachable.
    await handle.db
      .update(workspaceMembers)
      .set({ role: 'billing' })
      .where(
        and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, alice)),
      );
    await violatesConstraint('ydoc_updates_append_actor_authorized', () => appendAs(alice));
  });

  it('refuses an append when the workspace role list contains an unknown component, as the read denies', async () => {
    // parseRole is STRICT: one unknown component ('suspended') poisons the whole
    // value even beside a known 'admin'. effectiveRoomRole then denies, and so
    // must the write.
    await handle.db
      .update(workspaceMembers)
      .set({ role: 'suspended,admin' })
      .where(
        and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, alice)),
      );
    await violatesConstraint('ydoc_updates_append_actor_authorized', () => appendAs(alice));
  });

  it('refuses an append after a workspace-level revoke, exactly as the read gate closes the room', async () => {
    // The workspace membership is deleted while the derived `memberships` row
    // survives — the stale-row case room-access.ts exists for. The read joins
    // workspace_members and returns null; the write joins it too and refuses.
    await handle.db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, alice)),
      );
    await violatesConstraint('ydoc_updates_append_actor_authorized', () => appendAs(alice));
  });

  it('presence also refuses an unrecognised role, matching the append', async () => {
    await handle.db
      .update(workspaceMembers)
      .set({ role: 'billing' })
      .where(
        and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, alice)),
      );
    await violatesConstraint('ydoc_awareness_actor_authorized', () =>
      handle.db.execute(
        sql`SELECT atrium_upsert_ydoc_awareness(${roomId}::uuid, ${alice}::uuid, 'c', ${OP}::bytea)`,
      ),
    );
  });

  /**
   * THE LOCK COVERS workspace_members, NOT JUST memberships (#201 finding 2).
   *
   * The append takes `FOR SHARE OF m, wm`. The bug this pins: locking `m` alone
   * lets a concurrent workspace-level revoke (`DELETE FROM workspace_members`)
   * slip between the check and the insert, landing a covenant-adjacent write for
   * someone the read side already rejects. Content in ydoc_updates is what a `✓`
   * signs, so this write is treated like the irreversible CERTIFY path, not the
   * tolerant broadcast path.
   *
   * Proven deterministically by a lock conflict rather than by racing wall clock:
   * a second connection holds the workspace_members row under `FOR UPDATE`
   * (standing in for the revoke transaction mid-flight), and the append — which
   * now takes a share lock on that same row — must BLOCK. A short
   * `statement_timeout` turns "blocked" into an observable `57014`. With the
   * pre-fix `FOR SHARE OF m` alone, the append would not touch the wm lock and the
   * row would land instead of timing out.
   */
  it('blocks on a workspace_members lock held by a concurrent revoke (57014, not a landed row)', async () => {
    const url = databaseUrl();
    const locker = postgres(url, { max: 1, onnotice: () => undefined });
    const appender = postgres(url, { max: 1, onnotice: () => undefined });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the workspace_members row exclusively in an open transaction.
    const locking = locker.begin(async (tx) => {
      await tx.unsafe(
        `SELECT 1 FROM workspace_members
           WHERE organization_id = '${workspaceId}'::uuid AND user_id = '${alice}'::uuid
           FOR UPDATE`,
      );
      await held;
    });
    // Give the locker a moment to actually acquire the row lock.
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await expect(
        appender.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
          await tx.unsafe(
            `SELECT atrium_append_ydoc_update('${roomId}'::uuid, '${alice}'::uuid, '\\x0a0b'::bytea)`,
          );
        }),
      ).rejects.toMatchObject({ code: '57014' });
    } finally {
      release?.();
      await locking;
      await locker.end();
      await appender.end();
    }
    // The blocked append inserted nothing: no membership was revoked, but none was
    // written past the lock either.
    const rows = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
    expect(rows).toHaveLength(0);
  });
});

describe('ydoc_awareness is presence, and still attributable', () => {
  it('upserts through the function and overwrites in place', async () => {
    const client = `client-${randomUUID().slice(0, 8)}`;
    await handle.db.execute(
      sql`SELECT atrium_upsert_ydoc_awareness(${roomId}::uuid, ${alice}::uuid, ${client}, ${OP}::bytea)`,
    );
    await handle.db.execute(
      sql`SELECT atrium_upsert_ydoc_awareness(${roomId}::uuid, ${alice}::uuid, ${client}, ${Buffer.from([7])}::bytea)`,
    );
    const rows = await handle.db.select().from(ydocAwareness);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.op as Uint8Array)).toEqual(Buffer.from([7]));
  });

  it('refuses a direct write, so a cursor cannot be attributed to a stranger', async () => {
    await violatesConstraint('ydoc_awareness_write_through_procedure', () =>
      handle.db.insert(ydocAwareness).values({ clientId: 'forged', room: roomId, op: OP }),
    );
  });

  it('refuses presence in a room the actor is not in', async () => {
    await violatesConstraint('ydoc_awareness_actor_authorized', () =>
      handle.db.execute(
        sql`SELECT atrium_upsert_ydoc_awareness(${roomId}::uuid, ${outsider}::uuid, 'c', ${OP}::bytea)`,
      ),
    );
  });
});

describe('the REVOKE, against a role a REVOKE can actually bind', () => {
  /**
   * The half the guard cannot prove and the half the guard does not need.
   *
   * The migration's privilege loop identifies an application role the way 0004
   * does — `rolcanlogin AND NOT rolsuper AND rolname <> owner AND
   * has_table_privilege(role, 'core_events', 'SELECT')` — so this creates two
   * roles differing in exactly the thing the loop reads, replays the migration's
   * own `DO` block over them, and then **connects as one of them** and tries the
   * insert for real. Asserting `has_table_privilege` alone would be asserting
   * that a catalog says what a GRANT said; the live connection is what proves
   * the refusal reaches a writer.
   *
   * The `stranger` is the second half: it must get nothing at all, so that the
   * loop is a rule about app roles rather than a `GRANT ... TO PUBLIC` in a
   * costume.
   */
  it('leaves the app role able to call the door and unable to write the table', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const appRole = `atrium_ydoc_app_${suffix}`;
    const stranger = `atrium_ydoc_stranger_${suffix}`;
    const privileges = statementsOf(MIGRATION).find((statement) =>
      statement.includes('$privileges$'),
    );
    if (!privileges) throw new Error(`${MIGRATION} has no privileges block to replay`);

    await handle.db.execute(sql.raw(`CREATE ROLE "${appRole}" LOGIN PASSWORD 'probe'`));
    await handle.db.execute(sql.raw(`CREATE ROLE "${stranger}" LOGIN PASSWORD 'probe'`));
    try {
      // The only difference between them, and the only thing the loop reads.
      await handle.db.execute(sql.raw(`GRANT SELECT ON TABLE public.core_events TO "${appRole}"`));
      await handle.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${appRole}"`));
      await handle.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${stranger}"`));
      await handle.db.execute(sql.raw(privileges));

      const [granted] = await handle.db.execute<Record<string, boolean>>(
        sql`SELECT
              has_function_privilege(${appRole}, p.oid, 'EXECUTE') AS "appRole",
              has_function_privilege(${stranger}, p.oid, 'EXECUTE') AS "stranger",
              has_function_privilege('public', p.oid, 'EXECUTE') AS "everyone"
            FROM pg_proc p
            WHERE p.proname = 'atrium_append_ydoc_update'
              AND p.pronamespace = 'public'::regnamespace`,
      );
      expect(granted).toEqual({ appRole: true, stranger: false, everyone: false });

      for (const role of [appRole, stranger]) {
        const [table] = await handle.db.execute<Record<string, boolean>>(
          sql`SELECT
                has_table_privilege(${role}, 'public.ydoc_updates', 'INSERT') AS "insert",
                has_table_privilege(${role}, 'public.ydoc_updates', 'UPDATE') AS "update",
                has_table_privilege(${role}, 'public.ydoc_updates', 'DELETE') AS "delete",
                has_table_privilege(${role}, 'public.ydoc_updates', 'TRUNCATE') AS "truncate"`,
        );
        expect(table, `${role} must hold no write privilege on ydoc_updates`).toEqual({
          insert: false,
          update: false,
          delete: false,
          truncate: false,
        });
      }

      // ── AND NOW FOR REAL, over a connection as that role ──────────────────
      const url = new URL(databaseUrl());
      url.username = appRole;
      url.password = 'probe';
      const asAppRole = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        // The direct write is refused by the REVOKE, one layer BEFORE the guard:
        // this role never reaches the trigger at all, which is why the error is
        // a permission denial on the table rather than the guard's sentence.
        await expect(
          asAppRole.unsafe(
            `INSERT INTO public.ydoc_updates (room, op) VALUES ('${roomId}'::uuid, '\\x01'::bytea)`,
          ),
        ).rejects.toMatchObject({ code: '42501' });

        // And the legitimate call still works, which is what makes this a
        // boundary rather than a ban: the app role writes documents through the
        // door and only through the door.
        const appended = await asAppRole.unsafe(
          `SELECT atrium_append_ydoc_update('${roomId}'::uuid, '${alice}'::uuid, '\\x0a0b'::bytea) AS id`,
        );
        expect(appended[0]?.id).toBeTruthy();

        // The same role cannot forge an append for somebody who is not a member,
        // because the authorization is INSIDE the SECURITY DEFINER function and
        // not in whatever called it.
        await expect(
          asAppRole.unsafe(
            `SELECT atrium_append_ydoc_update('${roomId}'::uuid, '${outsider}'::uuid, '\\x0a0b'::bytea)`,
          ),
        ).rejects.toMatchObject({ code: '42501' });
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

  /** PUBLIC holds nothing on either table — the first line of the privileges block. */
  it('leaves PUBLIC with no write privilege on either document table', async () => {
    for (const table of ['public.ydoc_updates', 'public.ydoc_awareness']) {
      const [row] = await handle.db.execute<Record<string, boolean>>(
        sql`SELECT
              has_table_privilege('public', ${table}, 'INSERT') AS "insert",
              has_table_privilege('public', ${table}, 'UPDATE') AS "update",
              has_table_privilege('public', ${table}, 'DELETE') AS "delete",
              has_table_privilege('public', ${table}, 'TRUNCATE') AS "truncate"`,
      );
      expect(row, `${table} must be closed to PUBLIC`).toEqual({
        insert: false,
        update: false,
        delete: false,
        truncate: false,
      });
    }
  });
});
