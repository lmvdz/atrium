import type { CovenantReadStatus } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import {
  anchorCertifies,
  liveGlyphResolver,
  type SyncedCovenantStatusRow,
} from '../lib/covenant-read.js';

/**
 * THE LIVE COVENANT GLYPH RESOLVER (#218 / T4 — the live flip, + the fix-round
 * liveness invariant).
 *
 * The client folds the `covenant_status` Electric shape into this resolver, and the
 * migrated readers source `✓`/`~` through the SAME `anchorCertifies` gate they always
 * have. These are the forward guards proven as pure folds (no Electric): `✓` ONLY on
 * `status === 'ok'` AND while the shape is currently LIVE (`setLive(true)`); absence /
 * any non-ok / an unrecognised value / a not-yet-live shape ⇒ `~`, fail-closed; and —
 * the payoff — a synced drift update flips a prior `✓` to `~`.
 *
 * The liveness gate is the #218 fix-round cardinal-sin fix: the map alone NEVER
 * certifies. Every `✓`-expecting case below must first `setLive(true)` — mirroring the
 * hook, which sets the resolver live only once the shape is connected + up-to-date.
 */
describe('liveGlyphResolver — the ✓ gate over the live synced map', () => {
  it('certifies ✓ ONLY on status === "ok" (while live)', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([{ object_id: 'obj-ok', status: 'ok', generation: 1 }]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(true);
    expect(resolver.peek('obj-ok').covenantStatus).toBe<CovenantReadStatus>('ok');
  });

  it('THE LIVENESS GATE: an ok row does NOT certify until the shape is live', () => {
    const resolver = liveGlyphResolver();
    // A folded `ok` row, but the shape has not been marked live: fail-closed to `~`
    // (`unresolved`, the honest "verifying" state) — the map alone never mints a `✓`.
    resolver.replace([{ object_id: 'obj-ok', status: 'ok', generation: 1 }]);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(false);
    expect(resolver.peek('obj-ok').covenantStatus).toBe<CovenantReadStatus>('unresolved');
    // The shape reaches an up-to-date snapshot → live → the same row now certifies.
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(true);
  });

  it('LOSS OF LIVE AUTHORITY demotes a prior ✓ to ~ without touching the map', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([{ object_id: 'obj-ok', status: 'ok', generation: 1 }]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(true);
    // The shape errors / disconnects / sleeps — the hook flips it not-live. The last
    // `ok` is STILL in the map, but a dead shape must never paint a stale `✓`.
    resolver.setLive(false);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(false);
    expect(resolver.peek('obj-ok').covenantStatus).toBe<CovenantReadStatus>('unresolved');
  });

  it('fails closed to ~ for an object absent from the map', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([{ object_id: 'present', status: 'ok', generation: 1 }]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'never-synced')).toBe(false);
    expect(resolver.peek('never-synced').covenantStatus).toBe<CovenantReadStatus>('drift');
  });

  it('fails closed to ~ for a non-ok verdict (drift / unresolved)', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([
      { object_id: 'obj-drift', status: 'drift', generation: 1 },
      { object_id: 'obj-unresolved', status: 'unresolved', generation: 1 },
    ]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'obj-drift')).toBe(false);
    expect(anchorCertifies(resolver, 'obj-unresolved')).toBe(false);
  });

  it('NEVER treats "a row exists" as ✓ — an unrecognised status is coerced to ~', () => {
    const resolver = liveGlyphResolver();
    // A corrupted wire value must never survive as a `✓`.
    resolver.replace([
      { object_id: 'obj', status: 'certified' as unknown as CovenantReadStatus, generation: 1 },
    ]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'obj')).toBe(false);
    expect(resolver.peek('obj').covenantStatus).toBe<CovenantReadStatus>('drift');
  });

  it('flips a prior ✓ to ~ when a synced drift update arrives — THE LIVE FLIP', () => {
    const resolver = liveGlyphResolver();
    resolver.setLive(true);
    // The span is certified and resolves clean: ✓.
    resolver.replace([{ object_id: 'span', status: 'ok', generation: 1 }]);
    expect(anchorCertifies(resolver, 'span')).toBe(true);

    // A peer edits the in-range span; the sweep re-verdicts `drift` and the shape
    // streams the updated row (a strictly-newer generation) — the glyph flips to ~.
    resolver.replace([{ object_id: 'span', status: 'drift', generation: 2 }]);
    expect(anchorCertifies(resolver, 'span')).toBe(false);

    // An exact revert: the sweep resolves `ok` once more (gen 3) — the glyph flips back.
    resolver.replace([{ object_id: 'span', status: 'ok', generation: 3 }]);
    expect(anchorCertifies(resolver, 'span')).toBe(true);
  });

  it('drops a row that vanished from the shape (cascade prune / DELETE) — reads ~', () => {
    const resolver = liveGlyphResolver();
    resolver.setLive(true);
    resolver.replace([
      { object_id: 'a', status: 'ok', generation: 1 },
      { object_id: 'b', status: 'ok', generation: 1 },
    ]);
    expect(anchorCertifies(resolver, 'a')).toBe(true);
    // `b` is gone from the shape's current rows (the client materialises the full set,
    // so a DELETE removes the row); a full rebuild fails it closed.
    resolver.replace([{ object_id: 'a', status: 'ok', generation: 2 }]);
    expect(anchorCertifies(resolver, 'a')).toBe(true);
    expect(anchorCertifies(resolver, 'b')).toBe(false);
  });

  it('SEED IS NON-CERTIFYING until the shape confirms it live (seed-window fix)', () => {
    // `data.covenantReads` seeds the map so a live sync has something to compare, but a
    // seed alone is provenance — it must NOT mint `✓` before the live shape confirms it.
    const resolver = liveGlyphResolver({ seeded: 'ok', drifted: 'drift' });
    expect(anchorCertifies(resolver, 'seeded')).toBe(false); // NOT live yet → ~
    expect(resolver.peek('seeded').covenantStatus).toBe<CovenantReadStatus>('unresolved');

    // The shape's first up-to-date snapshot REPLACES the seed wholesale and goes live.
    resolver.replace([{ object_id: 'drifted', status: 'ok', generation: 1 }]);
    resolver.setLive(true);
    expect(anchorCertifies(resolver, 'drifted')).toBe(true);
    // The seed-only object is no longer in the authoritative map.
    expect(anchorCertifies(resolver, 'seeded')).toBe(false);
  });

  it('folds newest-generation-wins on a duplicate object_id (defensive)', () => {
    const resolver = liveGlyphResolver();
    resolver.setLive(true);
    // Out-of-order within one batch: the newer generation's verdict must win,
    // regardless of iteration order.
    const rows: readonly SyncedCovenantStatusRow[] = [
      { object_id: 'x', status: 'drift', generation: 5 },
      { object_id: 'x', status: 'ok', generation: 2 },
    ];
    resolver.replace(rows);
    expect(anchorCertifies(resolver, 'x')).toBe(false);
  });

  it('coerces a bigint / string generation from the wire without minting a stale ✓', () => {
    const resolver = liveGlyphResolver();
    resolver.setLive(true);
    resolver.replace([{ object_id: 'y', status: 'ok', generation: '1' }]);
    expect(anchorCertifies(resolver, 'y')).toBe(true);
    resolver.replace([{ object_id: 'y', status: 'drift', generation: 2n }]);
    expect(anchorCertifies(resolver, 'y')).toBe(false);
  });

  it('FINITE-GEN GUARD: a NaN generation cannot overwrite a finite drift with ok', () => {
    const resolver = liveGlyphResolver();
    resolver.setLive(true);
    // A finite `drift` at gen 5, then a corrupt `ok` row whose generation is
    // non-numeric (NaN after `Number(...)`). Without the finite-gen guard the NaN
    // comparison (`5 >= NaN` is false) would slip past the monotone check and let the
    // `ok` overwrite the `drift` — minting a stale `✓`. The guard pins NaN → 0, so the
    // finite `drift` out-ranks it and survives.
    resolver.replace([
      { object_id: 'z', status: 'drift', generation: 5 },
      { object_id: 'z', status: 'ok', generation: 'not-a-number' },
    ]);
    expect(anchorCertifies(resolver, 'z')).toBe(false);
    expect(resolver.peek('z').covenantStatus).toBe<CovenantReadStatus>('drift');
  });
});
