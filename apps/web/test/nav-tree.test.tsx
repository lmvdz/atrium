/* ---------------------------------------------------------------------------
 * THE PROCESS TREE IS BOUND TO REAL STATE — flip the input, the cell moves (#154).
 *
 * `NavTree` (the prototype's designed process tree) reads the REAL control-plane
 * shape — `ControlPlaneData` from `lib/control-plane-data.ts` — and derives every
 * cost and glyph through the shipped `control/state.ts` selectors, the same ones
 * `ProcessTree.tsx` uses. These prove the binding is a derivation and not a
 * coincidence:
 *
 *   * FLIP A COST. Mutating a plan's `spentMicros` in the seeded plane moves the
 *     rendered cost cell — the tree reads the column through `planCost` /
 *     `formatMicros`, it did not memoise a mock string.
 *   * THE `✓` IS `sessionCertified`, NOT A BOOLEAN. The certified scout wears the
 *     badge; break one part of its hold receipt and the badge is gone — the tick
 *     is the human-signature predicate and nothing else.
 *   * A BRANCH IS THE SETTLED ARTIFACT'S, NEVER FABRICATED. The settled scout
 *     shows its branch; an open session with no artifact shows none.
 * ------------------------------------------------------------------------- */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlPlaneFixture } from '../app/prototype/control-fixture';
import { NavTree } from '../app/prototype/NavTree';
import type { ControlPlaneData } from '../lib/control-plane-data';

afterEach(cleanup);

function renderTree(data: ControlPlaneData) {
  return render(
    <NavTree
      data={data}
      selected={{ kind: 'session', id: 's-live' }}
      onSelect={vi.fn()}
      concern={false}
    />,
  );
}

/** The hexi plan (`p-invoices`) in a fresh copy of the seeded plane. */
function invoicesPlan(data: ControlPlaneData) {
  const plan = data.agents
    .flatMap((agent) => agent.plans)
    .find((candidate) => candidate.id === 'p-invoices');
  if (plan === undefined) throw new Error('fixture lost the p-invoices plan');
  return plan as { spentMicros: number };
}

describe('the process tree is bound to real ControlPlaneData', () => {
  it('renders live agents, plans and the plan cost read off the columns', () => {
    renderTree(controlPlaneFixture());
    expect(screen.getByText('hexi')).toBeTruthy();
    expect(screen.getByText('streaming invoice totals')).toBeTruthy();
    expect(screen.getByText('re-rank on embeddings')).toBeTruthy();
    /* draws off `authorizedDraws`/`rlimitSlice`, dollars off
       `spentMicros`/`budgetLimitMicros`, both through `planCost`. */
    expect(screen.getByText('3/8 draws')).toBeTruthy();
    expect(screen.getByText('$0.78 / $5.00')).toBeTruthy();
    /* the unfunded audit plan — a null slice reads `unfunded`, not `0 draws`. */
    expect(screen.getByText('1 draws · unfunded')).toBeTruthy();
  });

  it('FLIP THE COST: a mutated fixture spentMicros moves the rendered cell', () => {
    const before = controlPlaneFixture();
    renderTree(before);
    expect(screen.getByText('$0.78 / $5.00')).toBeTruthy();
    cleanup();

    const after = controlPlaneFixture();
    invoicesPlan(after).spentMicros = 1_780_000;
    renderTree(after);
    /* the cell moved with the column — a memoised mock string could not. */
    expect(screen.getByText('$1.78 / $5.00')).toBeTruthy();
    expect(screen.queryByText('$0.78 / $5.00')).toBeNull();
  });

  it('the ✓ badge is sessionCertified, not a client boolean', () => {
    renderTree(controlPlaneFixture());
    /* the settled, human-signed scout wears the badge and reads "certified". */
    expect(screen.getByTitle('human-certified')).toBeTruthy();
    expect(screen.getByText(/certified/)).toBeTruthy();
  });

  it('FLIP THE SIGNATURE: break the hold receipt and the badge is gone', () => {
    const data = controlPlaneFixture();
    for (const agent of data.agents) {
      for (const plan of agent.plans) {
        for (const session of plan.sessions) {
          if (session.id === 's-scout') {
            /* a machine "certifier" is no certification — `sessionCertified`
               refuses a non-human kind through the one predicate. */
            (session as { certifiedByKind: 'agent' }).certifiedByKind = 'agent';
          }
        }
      }
    }
    renderTree(data);
    expect(screen.queryByTitle('human-certified')).toBeNull();
    expect(screen.queryByText(/certified/)).toBeNull();
  });

  it('a branch is the settled artifact’s, and an open session shows none', () => {
    renderTree(controlPlaneFixture());
    /* the settled scout landed on a branch. */
    expect(screen.getByText('scout/invoice-schema')).toBeTruthy();
    /* the open live session has no settled artifact — so no branch, not a
       fabricated one (the mock's `feat/streaming-invoice-totals` is gone). */
    expect(screen.queryByText('feat/streaming-invoice-totals')).toBeNull();
  });
});
