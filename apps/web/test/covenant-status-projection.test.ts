import type { CovenantReadAuthority, CovenantReadResult, CovenantReadStatus } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RoomDriftSweep } from '../lib/room-drift-sweep.js';

/**
 * WRITE-ON-RECOMPUTE (#206, E6) — the drift sweep PROJECTS its verdict.
 *
 * The durable `covenant_status` table (and the REVOKE that guards it) is proven on a
 * real Postgres in `integration/db/covenant-status-projection.test.ts`. THIS unit test
 * proves the wiring that feeds it: `RoomDriftSweep.recordVerdict` invokes the injected
 * `onVerdict` hook with the DEFINITIVE, generation-current status on every recompute —
 * the seam the process singleton binds to `upsertCovenantStatus`. It uses a fake
 * authority so the exact status is controllable, and asserts the projection follows
 * the verdict `ok`→`drift`→`ok`.
 */

/** A fake read authority whose `resolve` returns a controllable status. */
function fakeAuthority(nextStatus: () => CovenantReadStatus): CovenantReadAuthority {
  return {
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    resolve: async (objectId: string): Promise<CovenantReadResult> =>
      ({ objectId, covenantStatus: nextStatus() }) as unknown as CovenantReadResult,
  } as unknown as CovenantReadAuthority;
}

describe('the sweep projects every recompute through onVerdict', () => {
  it('reports the resolved status for each certified object, following ok→drift→ok', async () => {
    const objectId = 'object-1';
    let status: CovenantReadStatus = 'ok';
    const projected: Array<[string, CovenantReadStatus]> = [];

    const sweep = new RoomDriftSweep({
      doc: new Y.Doc(),
      authority: fakeAuthority(() => status),
      loadCertifiedObjectIds: async () => [objectId],
      onVerdict: (id, s) => projected.push([id, s]),
    });

    // First recompute: the span resolves `ok` — the projection records `✓`.
    sweep.sweepNow();
    await sweep.settled();
    expect(projected.at(-1)).toEqual([objectId, 'ok']);

    // The content drifts: a later recompute resolves `drift` — the projection follows.
    status = 'drift';
    sweep.sweepNow();
    await sweep.settled();
    expect(projected.at(-1)).toEqual([objectId, 'drift']);

    // Reverted to the certified bytes: `ok` again — the machine never mints a `✓`, it
    // just reports the human anchor resolving clean once more.
    status = 'ok';
    sweep.sweepNow();
    await sweep.settled();
    expect(projected.at(-1)).toEqual([objectId, 'ok']);
  });

  it('does not require an onVerdict hook — the sweep runs without a projection sink', async () => {
    const sweep = new RoomDriftSweep({
      doc: new Y.Doc(),
      authority: fakeAuthority(() => 'drift'),
      loadCertifiedObjectIds: async () => ['object-1'],
    });
    sweep.sweepNow();
    await expect(sweep.settled()).resolves.toBeUndefined();
    // The in-process draft ledger still tracks the `~`, independent of the projection.
    expect(sweep.staleObjectIds().has('object-1')).toBe(true);
  });
});
