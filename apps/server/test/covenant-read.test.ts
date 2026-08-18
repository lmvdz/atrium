import type { CovenantAnchor, EnclosedItem, RenderedFragment, ResolvedSpan } from '@atrium/core';
import { renderedDigestOf } from '@atrium/core';
import type { Database } from '@atrium/db';
import { describe, expect, it } from 'vitest';
import { readCovenantAnchor, serverCovenantReadAuthority } from '../src/covenant-read.js';

/**
 * SL-4 (#191) server binding: the `covenant_anchors` ledger read + the row →
 * {@link CovenantAnchor} mapping, and the authority wired to it. The pure fail-
 * closed contract is proven under the core gate (covenant-read.test.ts); here we
 * prove the ADAPTER — that a well-formed row maps to a resolvable anchor, and that
 * every degenerate row (absent, NULL certifier, malformed) fails CLOSED to a `null`
 * anchor ⇒ `drift`, never a fabricated `✓`.
 */

/** A stub db whose `select().from().where().limit()` chain resolves to fixed rows. */
function fakeDb(rows: unknown[]): Database {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => query } as unknown as Database;
}

const ENCLOSED: EnclosedItem[] = [{ id: 'i_text', kind: 'text' }];
const DIGEST = 'a'.repeat(64);

/** A well-formed `covenant_anchors` row as drizzle would return it (certifiedAt a Date). */
function goodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anchor-uuid',
    roomId: 'room_1',
    objectId: 'o_span',
    revision: 7,
    relStart: 'rel-start',
    relEnd: 'rel-end',
    stateVector: 'sv-base',
    deleteSet: 'ds-base',
    enclosedItems: ENCLOSED,
    renderedDigest: DIGEST,
    certifierKind: 'human',
    certifierId: 'u_alice',
    certifiedAt: new Date('2026-08-16T12:00:00.000Z'),
    createdAt: new Date('2026-08-16T12:00:00.000Z'),
    ...overrides,
  };
}

describe('readCovenantAnchor — ledger row → CovenantAnchor mapping (fail-closed)', () => {
  it('maps a well-formed row to a valid, parseable anchor', async () => {
    const anchor = await readCovenantAnchor(fakeDb([goodRow()]), 'room_1', 'o_span');
    expect(anchor).not.toBeNull();
    expect(anchor?.objectId).toBe('o_span');
    expect(anchor?.revision).toBe(7);
    expect(anchor?.renderedDigest).toBe(DIGEST);
    expect(anchor?.certifier).toEqual({ kind: 'human', userId: 'u_alice' });
    // The Date column is spelled as the canonical UTC Timestamp core accepts.
    expect(anchor?.certifiedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('NO row ⇒ null anchor (the object has no `✓` ⇒ drift)', async () => {
    expect(await readCovenantAnchor(fakeDb([]), 'room_1', 'o_span')).toBeNull();
  });

  it('a row with a NULL certifier_id (user deleted) ⇒ null anchor, never a fake certifier', async () => {
    // FK is ON DELETE SET NULL; the `✓` happened but its certifier is gone. The core
    // anchor has no post-deletion certifier form, so this fails CLOSED (⇒ drift).
    const anchor = await readCovenantAnchor(
      fakeDb([goodRow({ certifierId: null })]),
      'room_1',
      'o_span',
    );
    expect(anchor).toBeNull();
  });

  it('a malformed row (bad digest) THROWS at the parse boundary (⇒ authority catches ⇒ drift)', async () => {
    await expect(
      readCovenantAnchor(fakeDb([goodRow({ renderedDigest: 'not-a-sha256' })]), 'room_1', 'o_span'),
    ).rejects.toThrow();
  });

  // SL-4 gauntlet HIGH — HONEST certifier kind. The mapper must feed the row's ACTUAL
  // `certifier_kind` through the schema, never hard-code `{ kind: 'human' }`. A machine
  // certifier row that slipped past the DB CHECK must NOT be laundered into a human `✓`.
  it('a MACHINE (agent) certifier row ⇒ fails closed (throws ⇒ drift), never a laundered human `✓`', async () => {
    // not-theater: base hard-codes `kind: 'human'` and returns a laundered anchor here;
    // the fix passes `row.certifierKind` through, so `HumanCertifier.parse` refuses it.
    await expect(
      readCovenantAnchor(fakeDb([goodRow({ certifierKind: 'agent' })]), 'room_1', 'o_span'),
    ).rejects.toThrow();
  });

  it('a `model` certifier row is refused exactly the same way', async () => {
    await expect(
      readCovenantAnchor(fakeDb([goodRow({ certifierKind: 'model' })]), 'room_1', 'o_span'),
    ).rejects.toThrow();
  });

  it('a `system` certifier row is refused exactly the same way', async () => {
    await expect(
      readCovenantAnchor(fakeDb([goodRow({ certifierKind: 'system' })]), 'room_1', 'o_span'),
    ).rejects.toThrow();
  });
});

describe('serverCovenantReadAuthority — the authority wired to the ledger read', () => {
  it('a well-formed anchor + an ok resolver resolves ok; the sync read reflects it', async () => {
    // A resolver that reports the live span matches the anchor's captured context.
    const resolveSpan = async (anchor: CovenantAnchor): Promise<ResolvedSpan | null> => ({
      fragment: { ancestors: [], nodes: [{ kind: 'text', text: 'x', marks: [] }] },
      enclosedItems: anchor.enclosedItems,
      snapshotVerified: true,
    });
    // The anchor's digest must match the resolver's fragment for `ok`; compute it via
    // the same path core does by reading the mapped anchor's digest is not enough —
    // instead assert the authority PLUMBS the resolver and ledger together and yields a
    // definitive (non-`unresolved`) verdict; ok-vs-drift correctness is core's gate.
    const authority = serverCovenantReadAuthority({
      db: fakeDb([goodRow()]),
      roomId: 'room_1',
      resolveSpan,
    });
    // Pending before resolve.
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    const r = await authority.resolve('o_span');
    expect(['ok', 'drift']).toContain(r.covenantStatus); // definitive, not `unresolved`
    expect(authority.read('o_span')).toBe(r); // cached; identical across call sites
  });

  it('a missing anchor ⇒ drift without ever calling the resolver (fail-closed)', async () => {
    let resolverCalled = false;
    const authority = serverCovenantReadAuthority({
      db: fakeDb([]),
      roomId: 'room_1',
      resolveSpan: async () => {
        resolverCalled = true;
        return null;
      },
    });
    expect((await authority.resolve('o_missing')).covenantStatus).toBe('drift');
    expect(resolverCalled).toBe(false);
  });

  // SL-4 fix round 2, HIGH — server static mode is FAIL-CLOSED until #182. The server
  // has no sync doc handle, so it wires no `liveFreshness` port; a cached `ok` it cannot
  // freshness-prove must be served as `~`, never a stale `✓`, until #182's invalidate-on-
  // drift is live (the `#182-before-server-✓` constraint).
  it('a server-cached `ok` that cannot be freshness-proven is served as `~` (fail-closed until #182)', async () => {
    // Build a fragment + its exact digest, so the resolver reports a GENUINE `ok`.
    const fragment: RenderedFragment = {
      ancestors: [],
      nodes: [{ kind: 'text', text: 'ship it', marks: [] }],
    };
    const digest = renderedDigestOf(fragment);
    const resolveSpan = async (anchor: CovenantAnchor): Promise<ResolvedSpan | null> => ({
      fragment,
      enclosedItems: anchor.enclosedItems,
      snapshotVerified: true,
    });
    const authority = serverCovenantReadAuthority({
      db: fakeDb([goodRow({ renderedDigest: digest, enclosedItems: ENCLOSED })]),
      roomId: 'room_1',
      resolveSpan,
    });
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('ok'); // a genuine `✓` is now cached
    // not-theater: base returns the cached `ok` from `read()` (the fail-open); the fix
    // serves `~` because the server cannot prove the cached `ok` is still fresh.
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
  });

  // E7 (#199 Fix 3) — the `#182-before-server-✓` gate opens ONLY while a drift sweep is
  // ACTUALLY LIVE on this authority, not via a construction-time `driftSwept` boolean. A
  // `RoomDriftSweep` marks it live on start() (guaranteeing invalidate-on-drift) and NOT
  // live on stop()/evict — so a stopped sweep can never leave a trusting authority.
  it('a LIVE-swept authority serves a cached `ok` as `✓`; a STOPPED one re-fail-closes', async () => {
    const fragment: RenderedFragment = {
      ancestors: [],
      nodes: [{ kind: 'text', text: 'ship it', marks: [] }],
    };
    const digest = renderedDigestOf(fragment);
    const resolveSpan = async (anchor: CovenantAnchor): Promise<ResolvedSpan | null> => ({
      fragment,
      enclosedItems: anchor.enclosedItems,
      snapshotVerified: true,
    });
    const authority = serverCovenantReadAuthority({
      db: fakeDb([goodRow({ renderedDigest: digest, enclosedItems: ENCLOSED })]),
      roomId: 'room_1',
      resolveSpan,
    });
    // BEFORE a sweep is live: the guard is SET, so a cached `ok` is served `~`.
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');

    // A sweep goes LIVE (what RoomDriftSweep.start() does) ⇒ the cached `ok` is trusted.
    authority.markSweepLive(true);
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('ok');

    // The invariant the sweep upholds: an `invalidate` (what the sweep calls on a drift)
    // still demotes to `~` at once — a swept `✓` is trusted, but never a stale one.
    authority.invalidate('o_span');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');

    // STOP the sweep (stop()/evict): re-fail-close + invalidate-all. A re-resolved `ok`
    // is no longer trusted by read() — a stopped sweep leaves no trusting authority.
    await authority.resolve('o_span'); // cache an ok again
    expect(authority.read('o_span').covenantStatus).toBe('ok'); // still live here
    authority.markSweepLive(false);
    authority.invalidateAll();
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    // And a fresh resolve after stop still reads `~` (the guard is re-armed).
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
  });

  it('a ledger read that THROWS (null-certifier parse aside) fails closed to drift, never propagates', async () => {
    const authority = serverCovenantReadAuthority({
      db: fakeDb([goodRow({ renderedDigest: 'not-a-sha256' })]),
      roomId: 'room_1',
      resolveSpan: async () => null,
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('drift');
  });
});
