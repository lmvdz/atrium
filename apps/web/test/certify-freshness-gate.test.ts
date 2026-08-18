import type { CovenantDocReader } from '@atrium/core';
import type { Database } from '@atrium/db';
import { describe, expect, it, vi } from 'vitest';
import { certifyObjectSpan } from '@/lib/certify-anchor';

/* ═══════════════════════════════════════════════════════════════════════════
 * E3 (#203) — the SERVER-REPLICA STREAM-POSITION FRESHNESS GATE on certifyObjectSpan.
 *
 * A certify is REFUSED (`replica_lagging`) when the replica the reader resolves
 * against trails the durable stream head captured at request time — never anchor
 * content the server replica has not caught up to. The refusal fires BEFORE the
 * reader is touched or any transaction opens, so it is provable with no database;
 * the PASS path (a fresh replica mints a real anchor) is proven end-to-end over a
 * real Postgres in `integration/web/server-replica-restart.test.ts`.
 *
 * This gate is DISTINCT from #209's client freshness witness — it is about the
 * SERVER replica's position on the stream, not a client's observed fragment.
 * ═════════════════════════════════════════════════════════════════════════ */

const HUMAN = { userId: 'u_alice', principalKind: 'human' as const };

/** A database/reader the lag path must NEVER touch — accessing either fails the test. */
function forbiddenDatabase(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('the freshness gate must refuse before touching the database');
      },
    },
  ) as unknown as Database;
}
function forbiddenReader(): CovenantDocReader {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('the freshness gate must refuse before touching the reader');
      },
    },
  ) as unknown as CovenantDocReader;
}

describe('the freshness gate refuses a lagging replica before deriving anything', () => {
  it('refuses replica_lagging when the consumed position trails the required head', async () => {
    const consumedPosition = vi.fn(() => 3);
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 5, consumedPosition },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
    expect(consumedPosition).toHaveBeenCalled();
  });

  it('an evicted/absent replica (consumedPosition -Infinity) is refused too', async () => {
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 0, consumedPosition: () => Number.NEGATIVE_INFINITY },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
  });

  it('a non-human session is still refused first — the gate does not shadow the covenant reason', async () => {
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: { userId: 'agent_x', principalKind: 'agent' },
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 5, consumedPosition: () => 0 },
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
  });
});
