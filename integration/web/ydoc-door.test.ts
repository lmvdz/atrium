import { randomUUID } from 'node:crypto';
import type { AtriumSession } from '@atrium/auth';
import type { DatabaseHandle } from '@atrium/db';
import { ydocUpdates } from '@atrium/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendYdocUpdate } from '../../apps/web/lib/ydoc-append.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * THE WRITE DOOR'S DECISION (#202), against a real Postgres.
 *
 * `appendYdocUpdate` is the whole trust decision the route handler delegates to
 * (the handler adds only Request/Response plumbing and the rate limit). It is
 * driven here with a constructed session — the ONE input that legitimately comes
 * from outside the database, the server-authenticated session — over the real
 * migrations and the real append function. So these assert what the door does
 * WITH a session: refuse the unauthenticated and the non-member, and, for a
 * member, stamp the row to the session and to nothing the client could name.
 */

let handle: DatabaseHandle;

const OP = new Uint8Array([1, 2, 3, 4, 5]);

/** A session as `getAtriumSession` would return it — the door reads userId + emailVerified. */
function session(userId: string, over: Partial<AtriumSession> = {}): AtriumSession {
  return {
    sessionId: randomUUID(),
    userId,
    email: `${userId}@example.test`,
    displayName: 'someone',
    emailVerified: true,
    principalKind: 'human',
    activeWorkspaceId: null,
    ...over,
  };
}

async function rowCount(roomId: string): Promise<number> {
  const rows = await handle.db.select().from(ydocUpdates).where(eq(ydocUpdates.room, roomId));
  return rows.length;
}

beforeEach(async () => {
  handle ??= openDatabase();
  await resetDatabase(handle);
});

afterAll(async () => {
  await handle?.close();
});

describe('the write door refuses everyone it should', () => {
  it('401s an unauthenticated request and lands no row', async () => {
    const { roomId } = await seedRoom(handle, ['alice']);
    const outcome = await appendYdocUpdate({ db: handle.db, session: null, room: roomId, op: OP });
    expect(outcome.status).toBe(401);
    expect(await rowCount(roomId)).toBe(0);
  });

  it('401s a signed-in-but-unverified session and lands no row', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice']);
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(people.alice as string, { emailVerified: false }),
      room: roomId,
      op: OP,
    });
    expect(outcome.status).toBe(401);
    expect(await rowCount(roomId)).toBe(0);
  });

  it('403s an authenticated non-member and lands no row', async () => {
    const { roomId } = await seedRoom(handle, ['alice']);
    const elsewhere = await seedRoom(handle, ['mallory']);
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(elsewhere.people.mallory as string),
      room: roomId,
      op: OP,
    });
    expect(outcome.status).toBe(403);
    expect(await rowCount(roomId)).toBe(0);
  });

  it('404s a malformed (non-uuid) room', async () => {
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(randomUUID()),
      room: 'not-a-room',
      op: OP,
    });
    expect(outcome.status).toBe(404);
  });

  it('400s an empty update', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice']);
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(people.alice as string),
      room: roomId,
      op: new Uint8Array(0),
    });
    expect(outcome.status).toBe(400);
    expect(await rowCount(roomId)).toBe(0);
  });
});

describe('the write door stamps a member’s write to their session', () => {
  it('200s a member and lands a row stamped to them', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice']);
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(people.alice as string),
      room: roomId,
      op: OP,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.id).toBeTruthy();
    const [row] = await handle.db
      .select()
      .from(ydocUpdates)
      .where(eq(ydocUpdates.id, outcome.id as string));
    expect(row?.writerUserId).toBe(people.alice);
    expect(row?.writerKind).toBe('human');
  });

  /**
   * The acceptance's sharpest case: an AGENT session whose object claims to be a
   * human. The door never consults `session.principalKind` — it passes only
   * `session.userId`, and the function looks the kind up from the immutable
   * `users` row — so the lie is inert and the row is stamped `agent`.
   */
  it('stamps an agent by its true kind even when the session claims human', async () => {
    const { roomId, people } = await seedRoom(handle, ['bot'], { agents: ['bot'] });
    const outcome = await appendYdocUpdate({
      db: handle.db,
      // The session LIES: principalKind 'human' for a user that is really an agent.
      session: session(people.bot as string, { principalKind: 'human' }),
      room: roomId,
      op: OP,
    });
    expect(outcome.status).toBe(200);
    const [row] = await handle.db
      .select()
      .from(ydocUpdates)
      .where(eq(ydocUpdates.id, outcome.id as string));
    expect(row?.writerKind).toBe('agent');
    expect(row?.writerUserId).toBe(people.bot);
  });

  it('ignores an identity carried in the update bytes', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice', 'mallory']);
    const bytes = new TextEncoder().encode(`from ${people.mallory}`);
    const outcome = await appendYdocUpdate({
      db: handle.db,
      session: session(people.alice as string),
      room: roomId,
      op: bytes,
    });
    const [row] = await handle.db
      .select()
      .from(ydocUpdates)
      .where(eq(ydocUpdates.id, outcome.id as string));
    expect(row?.writerUserId).toBe(people.alice);
  });

  it('dedupes a replay through the door and keeps the original attribution', async () => {
    const { roomId, people } = await seedRoom(handle, ['alice', 'mallory']);
    const first = await appendYdocUpdate({
      db: handle.db,
      session: session(people.alice as string),
      room: roomId,
      op: OP,
    });
    // Mallory replays Alice's exact bytes through her own authenticated session.
    const replay = await appendYdocUpdate({
      db: handle.db,
      session: session(people.mallory as string),
      room: roomId,
      op: OP,
    });
    expect(replay.status).toBe(200);
    expect(replay.id).toBe(first.id);
    expect(await rowCount(roomId)).toBe(1);
    const [row] = await handle.db
      .select()
      .from(ydocUpdates)
      .where(eq(ydocUpdates.id, first.id as string));
    expect(row?.writerUserId).toBe(people.alice);
  });
});
