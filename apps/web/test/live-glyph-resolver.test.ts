import type { CovenantReadStatus } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import {
  anchorCertifies,
  liveGlyphResolver,
  type SyncedCovenantStatusRow,
} from '../lib/covenant-read.js';

/**
 * THE LIVE COVENANT GLYPH RESOLVER (#218 / T4 — the live flip).
 *
 * The client folds the `covenant_status` Electric shape into this resolver, and the
 * migrated readers source `✓`/`~` through the SAME `anchorCertifies` gate they always
 * have. These are the forward guards grok flagged as non-negotiable, proven as pure
 * folds (no Electric): `✓` ONLY on `status === 'ok'`; absence / any non-ok / an
 * unrecognised value / a not-yet-synced shape ⇒ `~`, fail-closed; and — the payoff —
 * a synced drift update flips a prior `✓` to `~`.
 */
describe('liveGlyphResolver — the ✓ gate over the live synced map', () => {
  it('certifies ✓ ONLY on status === "ok"', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([{ object_id: 'obj-ok', status: 'ok', generation: 1 }]);
    expect(anchorCertifies(resolver, 'obj-ok')).toBe(true);
    expect(resolver.peek('obj-ok').covenantStatus).toBe<CovenantReadStatus>('ok');
  });

  it('fails closed to ~ for an object absent from the map', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([{ object_id: 'present', status: 'ok', generation: 1 }]);
    expect(anchorCertifies(resolver, 'never-synced')).toBe(false);
    expect(resolver.peek('never-synced').covenantStatus).toBe<CovenantReadStatus>('drift');
  });

  it('fails closed to ~ for a non-ok verdict (drift / unresolved)', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([
      { object_id: 'obj-drift', status: 'drift', generation: 1 },
      { object_id: 'obj-unresolved', status: 'unresolved', generation: 1 },
    ]);
    expect(anchorCertifies(resolver, 'obj-drift')).toBe(false);
    expect(anchorCertifies(resolver, 'obj-unresolved')).toBe(false);
  });

  it('NEVER treats "a row exists" as ✓ — an unrecognised status is coerced to ~', () => {
    const resolver = liveGlyphResolver();
    // A corrupted wire value must never survive as a `✓`.
    resolver.replace([
      { object_id: 'obj', status: 'certified' as unknown as CovenantReadStatus, generation: 1 },
    ]);
    expect(anchorCertifies(resolver, 'obj')).toBe(false);
    expect(resolver.peek('obj').covenantStatus).toBe<CovenantReadStatus>('drift');
  });

  it('flips a prior ✓ to ~ when a synced drift update arrives — THE LIVE FLIP', () => {
    const resolver = liveGlyphResolver();
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

  it('drops a row that vanished from the shape (cascade prune) — reads ~', () => {
    const resolver = liveGlyphResolver();
    resolver.replace([
      { object_id: 'a', status: 'ok', generation: 1 },
      { object_id: 'b', status: 'ok', generation: 1 },
    ]);
    expect(anchorCertifies(resolver, 'a')).toBe(true);
    // `b` is gone from the shape's current rows; a full rebuild fails it closed.
    resolver.replace([{ object_id: 'a', status: 'ok', generation: 2 }]);
    expect(anchorCertifies(resolver, 'a')).toBe(true);
    expect(anchorCertifies(resolver, 'b')).toBe(false);
  });

  it('seeds from the SSR verdict map so the first paint is not a flash of all-~', () => {
    // `data.covenantReads` seeds the resolver before the shape connects.
    const resolver = liveGlyphResolver({ seeded: 'ok', drifted: 'drift' });
    expect(anchorCertifies(resolver, 'seeded')).toBe(true);
    expect(anchorCertifies(resolver, 'drifted')).toBe(false);

    // The shape's first up-to-date snapshot then REPLACES the seed wholesale.
    resolver.replace([{ object_id: 'drifted', status: 'ok', generation: 1 }]);
    expect(anchorCertifies(resolver, 'drifted')).toBe(true);
    // The seed-only object is no longer in the authoritative map.
    expect(anchorCertifies(resolver, 'seeded')).toBe(false);
  });

  it('folds newest-generation-wins on a duplicate object_id (defensive)', () => {
    const resolver = liveGlyphResolver();
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
    resolver.replace([{ object_id: 'y', status: 'ok', generation: '1' }]);
    expect(anchorCertifies(resolver, 'y')).toBe(true);
    resolver.replace([{ object_id: 'y', status: 'drift', generation: 2n }]);
    expect(anchorCertifies(resolver, 'y')).toBe(false);
  });
});
