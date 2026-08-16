/* ---------------------------------------------------------------------------
 * THE MARRIED SURFACE IS MOUNTED ON LIVE CONTROL-PLANE DATA (#168 go-live A).
 *
 * `nav-tree.test.tsx` proves `NavTree` derives from a `ControlPlaneData` column.
 * These prove the OTHER half: the go-live mount hands a LIVE plane THROUGH
 * `MoldingSurface` to that tree. The real room route (`app/[workspace]/[room]/
 * surface/page.tsx`) loads the projection server-side with `loadControlPlane`
 * (server-only, covered by `integration/web/control-plane-data.test.ts`) and
 * passes the serializable result as the `tree` prop; this exercises that seam
 * with a plane whose ids/names are NOT the fixture's, so a pass cannot come from
 * the `treeData()` fallback.
 *
 *   * LIVE DATA REACHES THE TREE. A plane built here (not the seeded fixture)
 *     renders its own agents/plans/cost through the surface.
 *   * FLIP THE INPUT. Mutating a plan's `spentMicros` in the passed plane moves
 *     the rendered cost cell — the mount forwards the column, it did not memoise
 *     a mock string.
 *   * THE DOORS STAY INERT. Mounting live READ data wires no covenant ACTION
 *     door: steer/interrupt remain disabled and name their gated doors (go-live
 *     B wires them under the security gauntlet).
 * ------------------------------------------------------------------------- */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MoldingSurface } from '../app/prototype/MoldingSurface';
import type { ControlPlaneData } from '../lib/control-plane-data';

afterEach(cleanup);

/** A LIVE-shaped plane with distinct ids/names — not the seeded fixture, so a
    pass proves the mount forwarded THIS data, not the `treeData()` fallback. */
function livePlane(spentMicros = 1_250_000): ControlPlaneData {
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
            spentMicros,
            rlimitSlice: 10,
            authorizedDraws: 4,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-migrate-1',
                planId: 'p-migrate',
                harness: 'claude-code',
                model: 'opus-5',
                status: 'open',
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

describe('the married surface mounts live control-plane data (#168)', () => {
  it('renders the LIVE plane’s own agents and plans in the tree, not the fixture', () => {
    const { container } = render(<MoldingSurface tree={livePlane()} />);
    /* the PROCESS TREE is the seam this lane flips — scope the assertions to it.
       (The conversation/roster seams are the design shell until #159, so mock
       titles still appear in the chat header; that is out of this lane's scope
       and asserted-around here rather than falsely claimed as live.) */
    const tree = within(container.querySelector('nav[role="tree"]') as HTMLElement);
    /* the passed plane's names — the seeded fixture has none of these. */
    expect(tree.getByText('quill')).toBeTruthy();
    expect(tree.getByText('migrate the ledger spine')).toBeTruthy();
    /* and NOT the fixture's, IN THE TREE — proving the fallback did not fire. */
    expect(tree.queryByText('streaming invoice totals')).toBeNull();
    /* cost read off the passed column through `planCost`/`formatMicros`. */
    expect(tree.getByText('$1.25 / $4.00')).toBeTruthy();
  });

  it('FLIP THE INPUT: a mutated spentMicros in the mounted plane moves the cell', () => {
    render(<MoldingSurface tree={livePlane(1_250_000)} />);
    expect(screen.getByText('$1.25 / $4.00')).toBeTruthy();
    cleanup();

    render(<MoldingSurface tree={livePlane(3_250_000)} />);
    expect(screen.getByText('$3.25 / $4.00')).toBeTruthy();
    expect(screen.queryByText('$1.25 / $4.00')).toBeNull();
  });

  it('mounting live READ data leaves the covenant ACTION doors inert (go-live B)', () => {
    const { container } = render(<MoldingSurface tree={livePlane()} />);
    const footer = container.querySelector<HTMLElement>('footer');
    expect(footer).toBeTruthy();
    const scope = within(footer as HTMLElement);
    const steerBtn = scope.getByLabelText(/^steer/i) as HTMLButtonElement;
    const interruptBtn = scope.getByLabelText(/^interrupt/i) as HTMLButtonElement;
    expect(steerBtn.disabled).toBe(true);
    expect(interruptBtn.disabled).toBe(true);
    expect(steerBtn.getAttribute('title') ?? '').toContain('signal_session{steer}');
    expect(interruptBtn.getAttribute('title') ?? '').toContain('signal_session{interrupt}');
  });
});
