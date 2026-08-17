import { createHash } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import { ydocUpdates } from '@atrium/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { violatesConstraint } from '../support/constraints.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * THE WRITER STAMP (#202, migration 0054), against a real Postgres with the real
 * migrations applied.
 *
 * 0053 authorized WHO may append to a room's document; 0054 records WHO DID, on
 * the row, from the server-authenticated session — and it is the covenant-
 * critical half, because a `✓` signs content folded from these rows and DETECT
 * can only re-stale drift it can ATTRIBUTE. Every claim below is the database's,
 * not a route's: the append function is called directly with an actor id (the
 * only thing the HTTP door passes it), so what these prove is the property no
 * layer above can weaken — the stamp is the actor and the kind is the actor's
 * true `principal_kind`, a byte-replay never re-attributes, and concurrent
 * writers never cross.
 */

let handle: DatabaseHandle;

const OP = Buffer.from([1, 2, 3, 4, 5]);

function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

async function appendAs(actorId: string, room: string, op: Buffer = OP): Promise<string> {
  const [row] = await handle.db.execute<{ id: string }>(
    sql`SELECT atrium_append_ydoc_update(${room}::uuid, ${actorId}::uuid, ${op}::bytea) AS id`,
  );
  return row?.id as string;
}

async function rowOf(id: string) {
  const [row] = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.id, id));
  return row;
}

beforeEach(async () => {
  handle ??= openDatabase();
  await resetDatabase(handle);
});

afterAll(async () => {
  await handle?.close();
});

describe('the append stamps the authenticated writer', () => {
  it('stamps the appending member as the human writer, with the digest of the bytes', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice']);
    const id = await appendAs(people.alice as string, roomId);
    const row = await rowOf(id);
    expect(row?.writerUserId).toBe(people.alice);
    expect(row?.writerKind).toBe('human');
    // The digest is the hash of the stored bytes — generated, not supplied.
    expect(Buffer.from(row?.opDigest as Uint8Array)).toEqual(sha256(OP));
  });

  /**
   * An agent member is stamped `agent` because the kind is read from the
   * immutable `users.principal_kind`, not from anything the caller says. There is
   * no writer-kind PARAMETER to forge — the acceptance "an agent claiming human
   * is stamped by its true kind" holds here by there being nothing to claim with.
   */
  it('stamps an agent member as agent, from its true principal kind', async () => {
    const { roomId, people } = await seedRoom(handle, ['bot'], { agents: ['bot'] });
    const id = await appendAs(people.bot as string, roomId);
    const row = await rowOf(id);
    expect(row?.writerUserId).toBe(people.bot);
    expect(row?.writerKind).toBe('agent');
  });

  /**
   * The function never parses the Yjs bytes, so whatever identity the bytes claim
   * is irrelevant: the stamp is the session actor. Proven by appending bytes that
   * literally contain ANOTHER member's uuid and asserting the row is the actor's.
   */
  it('ignores an identity embedded in the update bytes — the stamp is the actor', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice', 'mallory']);
    const forgedBytes = Buffer.from(`hi i am really ${people.mallory}`, 'utf8');
    const id = await appendAs(people.alice as string, roomId, forgedBytes);
    const row = await rowOf(id);
    expect(row?.writerUserId).toBe(people.alice);
    expect(row?.writerKind).toBe('human');
  });
});

describe('append-only with replay dedupe — never re-attribute', () => {
  it('dedupes a byte-replay by another member and keeps the original attribution', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice', 'mallory']);
    const original = await appendAs(people.alice as string, roomId);

    // Mallory captures the exact bytes and replays them through her own session.
    const replayed = await appendAs(people.mallory as string, roomId);

    // Same row, not a second one, and still attributed to Alice.
    expect(replayed).toBe(original);
    const rows = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.writerUserId).toBe(people.alice);
  });

  it('is idempotent for a legitimate resend by the same writer', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice']);
    const first = await appendAs(people.alice as string, roomId);
    const again = await appendAs(people.alice as string, roomId);
    expect(again).toBe(first);
    const rows = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
    expect(rows).toHaveLength(1);
  });

  it('dedupes per room, not globally — identical bytes in two rooms are two updates', async () => {
    const a = await seedRoom(handle, ['alice']);
    const b = await seedRoom(handle, ['bob']);
    const idA = await appendAs(a.people.alice as string, a.roomId);
    const idB = await appendAs(b.people.bob as string, b.roomId);
    expect(idA).not.toBe(idB);
    expect((await rowOf(idA))?.writerUserId).toBe(a.people.alice);
    expect((await rowOf(idB))?.writerUserId).toBe(b.people.bob);
  });
});

describe('interleaved concurrent writers never cross stamps', () => {
  /**
   * Each call carries its own `p_actor_id` and its own bytes, so a crossed stamp
   * could only come from shared state inside the append path. Fired concurrently
   * over the real pool with distinct ops, then every landed row is checked: the
   * writer on the row for op N is the actor that wrote op N, for all N.
   */
  it('attributes every one of many concurrent appends to its own actor', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice', 'bob']);
    const actors = [people.alice as string, people.bob as string];
    const writes = Array.from({ length: 24 }, (_, i) => ({
      actor: actors[i % 2] as string,
      // Distinct bytes per write, so none dedupes into another.
      op: Buffer.from([0xaa, i, (i * 7) & 0xff]),
    }));

    await Promise.all(writes.map((w) => appendAs(w.actor, roomId, w.op)));

    const rows = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
    expect(rows).toHaveLength(writes.length);
    // Map each stored row back to the write that produced it, by its digest.
    const byDigest = new Map(
      rows.map((r) => [Buffer.from(r.opDigest as Uint8Array).toString('hex'), r]),
    );
    for (const w of writes) {
      const row = byDigest.get(sha256(w.op).toString('hex'));
      expect(row, `no row for op ${w.op.toString('hex')}`).toBeTruthy();
      expect(row?.writerUserId, 'a concurrent write was attributed to the wrong actor').toBe(
        w.actor,
      );
    }
  });
});

describe('a door-less write is honestly unattributed, not silently a person', () => {
  /**
   * A comment-forged direct INSERT (0009: the guard is an accident check a comment
   * defeats) that omits the stamp lands as `system` / no user — the fail-closed
   * default. It is NOT recorded as a human, so a write that skipped the
   * authenticated door can never masquerade as one.
   */
  it('records a stamp-less direct INSERT as system with no user', async () => {
    const { roomId } = await seedRoom(handle, ['alice']);
    await handle.db.execute(
      sql.raw(
        `DO $forge$ BEGIN
           INSERT INTO ydoc_updates (room, op) /* function atrium_append_ydoc_update( */
           VALUES ('${roomId}'::uuid, '\\x0102'::bytea);
         END $forge$;`,
      ),
    );
    const [row] = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
    expect(row?.writerKind).toBe('system');
    expect(row?.writerUserId).toBeNull();
  });

  /**
   * The stamp cannot be internally inconsistent: a `human` row with no user, or a
   * `system` row that names one, is refused by the check constraint — so even an
   * owner-level direct write cannot forge a half-formed attribution.
   */
  it('refuses a human stamp with no user (the consistency check)', async () => {
    const { roomId } = await seedRoom(handle, ['alice']);
    await violatesConstraint('ydoc_updates_writer_stamp_consistent', () =>
      handle.db.execute(
        sql.raw(
          `DO $forge$ BEGIN
             INSERT INTO ydoc_updates (room, op, writer_kind, writer_user_id)
               /* function atrium_append_ydoc_update( */
             VALUES ('${roomId}'::uuid, '\\x0102'::bytea, 'human', NULL);
           END $forge$;`,
        ),
      ),
    );
  });
});
