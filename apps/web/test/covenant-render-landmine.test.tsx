/* ---------------------------------------------------------------------------
 * NO COVENANT ACT FUNCTION IS INVOKED DURING RENDER (#168 B1).
 *
 * THE LANDMINE THIS GUARDS: `ThreadStatus` used to read a door's NAME for a
 * label by CALLING `covenant.steer(...)` / `covenant.interrupt(...)` in render
 * position. That is harmless only while the act body is inert — the moment
 * go-live B2 gives `steer`/`interrupt` a live durable body, EVERY render of the
 * status strip would fire a durable `signal_session`. B1 removes it: the label
 * reads the `DOOR_NAMES` constant, and a covenant ACT function is never called
 * during render.
 *
 * This test spies on EVERY covenant act function and asserts ZERO calls after
 * rendering the status strip and the whole surface (fixture route AND a live
 * mount). It goes RED the instant a render-time invocation is (re)introduced —
 * the exact regression B2 must not ship.
 * ------------------------------------------------------------------------- */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadStatus } from '../app/prototype/ChatChrome';
import { covenant, DOOR_NAMES } from '../app/prototype/covenant';
import { MoldingSurface } from '../app/prototype/MoldingSurface';
import type { StreamState } from '../app/prototype/mock';
import type { Selection } from '../app/prototype/types';
import type { ControlPlaneData } from '../lib/control-plane-data';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STREAM: StreamState = {
  phase: 'planning',
  lines: [],
  added: 3,
  removed: 1,
  files: 1,
  elapsedMs: 0,
  spendMicros: 0,
  concern: null,
};
const SELECTED: Selection = { kind: 'session', id: 's-live' };

/** Every act function on the covenant seam — the ones that MUST NOT be called
    in render position, and whose live bodies B2 will make durable. */
const ACT_NAMES = [
  'certify',
  'certifyClaim',
  'fund',
  'steer',
  'mediateSteer',
  'interrupt',
  'retract',
  'supersede',
  'run',
] as const;

/** Spy on every act function; return the spies so a test can assert 0 calls. */
function spyOnActs() {
  return ACT_NAMES.map((name) => vi.spyOn(covenant, name));
}

/** A minimal live plane so the surface can mount on the "real room" path too. */
function livePlane(): ControlPlaneData {
  const now = '2026-08-15T12:00:00.000Z';
  return {
    room: { id: 'r-live-42', name: 'ledger-migration' },
    viewerId: 'u-viewer',
    updatedAt: now,
    decisions: [],
    unseen: [],
    unseenTotal: 0,
    agents: [
      {
        userId: 'a-quill',
        name: 'quill',
        host: 'linux-ci-11',
        harness: 'claude-code',
        model: 'opus-5',
        budgetLimitMicros: 4_000_000,
        plans: [
          {
            id: 'p-migrate',
            agentUserId: 'a-quill',
            title: 'migrate the ledger spine',
            status: 'open',
            budgetLimitMicros: 4_000_000,
            spentMicros: 900_000,
            rlimitSlice: 10,
            authorizedDraws: 4,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-migrate-1',
                planId: 'p-migrate',
                harness: 'claude-code',
                model: 'opus-5',
                status: 'settled',
                contextPct: 0.33,
                progress: null,
                spendMicros: 900_000,
                exitSummary: null,
                artifact: null,
                artifactDigest: null,
                certifiedById: null,
                certifyArmedById: null,
                certifiedByName: null,
                certifiedByKind: null,
                certifiedAt: null,
                certifiedHeldMs: null,
                certifyArmedAt: null,
                certifyArmedByName: null,
                certifyArmedByKind: null,
                createdAt: '2026-08-15T11:50:00.000Z',
                updatedAt: now,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('rendering never invokes a covenant act function (#168 B1 landmine)', () => {
  it('ThreadStatus fires ZERO covenant acts and still labels its doors', () => {
    const spies = spyOnActs();
    const { container } = render(<ThreadStatus selected={SELECTED} stream={STREAM} />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // the labels are still present — read from the DOOR_NAMES constant, not a call.
    const footerHtml = container.querySelector('footer')?.innerHTML ?? '';
    expect(footerHtml).toContain(DOOR_NAMES.steer);
    expect(footerHtml).toContain(DOOR_NAMES.interrupt);
  });

  it('the whole surface (fixture route) fires ZERO covenant acts', () => {
    const spies = spyOnActs();
    render(<MoldingSurface />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('the whole surface mounted on a LIVE plane fires ZERO covenant acts', () => {
    const spies = spyOnActs();
    render(<MoldingSurface tree={livePlane()} />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('DOOR_NAMES is the single source of truth for each act’s door', () => {
  it('each act returns the door its DOOR_NAMES entry names', () => {
    expect(covenant.certify('s').door).toBe(DOOR_NAMES.certify);
    expect(covenant.certifyClaim('o').door).toBe(DOOR_NAMES.certifyClaim);
    expect(covenant.fund('p', 1).door).toBe(DOOR_NAMES.fund);
    expect(covenant.steer('s', '').door).toBe(DOOR_NAMES.steer);
    expect(covenant.interrupt('s', '').door).toBe(DOOR_NAMES.interrupt);
    expect(covenant.retract('o').door).toBe(DOOR_NAMES.retract);
    expect(covenant.supersede('a', 'b').door).toBe(DOOR_NAMES.supersede);
    expect(covenant.run('s').door).toBe(DOOR_NAMES.run);
    expect(covenant.mediateSteer('s', { anchor: 'a', quote: 'q', body: 'b' }).door).toBe(
      DOOR_NAMES.mediateSteer,
    );
  });
});
