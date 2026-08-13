/* ---------------------------------------------------------------------------
 * THE CONTROL PLANE'S GLYPHS AND COST, DERIVED — flip the state, the glyph moves.
 *
 * The process tree renders a status glyph on every agent, plan and session, and
 * the one rule the product turns on is that a glyph is DERIVED from state, never
 * hand-set (model/glyph.ts). These are the deterministic, no-database proofs
 * that a session's lifecycle status decides its glyph, that a plan and an agent
 * roll up the hardest thing beneath them, that the pin's order is the glyph's
 * hardness, and that burn-vs-budget is read off the plan's columns — so
 * FLIPPING the input (a session's status, a plan's budget) moves the output.
 * The end-to-end DB proof is e2e/control-plane.spec.ts.
 * ------------------------------------------------------------------------- */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ControlPlanRow, ControlSessionRow } from '../lib/control-plane-data';
import {
  ControlPin,
  type ControlPinItem,
  pinHardestFirst,
} from '../src/components/control/ControlPin';
import {
  agentState,
  planCost,
  planState,
  sessionAwaitsLanding,
  sessionState,
} from '../src/components/control/state';
import { glyphFor } from '../src/components/model/glyph';

function session(overrides: Partial<ControlSessionRow>): ControlSessionRow {
  return {
    id: 'sess-1',
    planId: 'plan-1',
    harness: 'claude-code',
    model: 'opus',
    status: 'open',
    contextPct: null,
    spendMicros: 0,
    exitSummary: null,
    artifact: null,
    certifiedByName: null,
    certifiedAt: null,
    certifiedHeldMs: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

function plan(overrides: Partial<ControlPlanRow>): ControlPlanRow {
  return {
    id: 'plan-1',
    agentUserId: 'agent-1',
    title: 'a plan',
    status: 'open',
    budgetLimitMicros: null,
    spentMicros: 0,
    rlimitSlice: null,
    authorizedDraws: 0,
    sessions: [],
    ...overrides,
  };
}

describe("a session's glyph is its lifecycle status, derived", () => {
  it('running is routine · , failed is ✗ , clean settle is ✓', () => {
    expect(glyphFor(sessionState(session({ status: 'open' })))).toBe('·');
    expect(glyphFor(sessionState(session({ status: 'failed' })))).toBe('✗');
    expect(glyphFor(sessionState(session({ status: 'settled' })))).toBe('✓');
  });

  it('a settled session with an uncertified artifact needs you, and landing is not undoable (■)', () => {
    const awaiting = session({
      status: 'settled',
      artifact: { branch: 'feat/x', commit: 'abc123' },
      certifiedByName: null,
    });
    expect(sessionAwaitsLanding(awaiting)).toBe(true);
    expect(glyphFor(sessionState(awaiting))).toBe('■');
  });

  it('once a human has landed it, the same session reads ✓ — the flip moves the glyph', () => {
    const artifact = { branch: 'feat/x', commit: 'abc123' };
    const before = session({ status: 'settled', artifact, certifiedByName: null });
    const after = session({ status: 'settled', artifact, certifiedByName: 'Ada' });
    expect(glyphFor(sessionState(before))).toBe('■');
    expect(glyphFor(sessionState(after))).toBe('✓');
    expect(sessionAwaitsLanding(after)).toBe(false);
  });

  it('a settled session with no artifact has nothing to land — a clean ✓', () => {
    const clean = session({ status: 'settled', artifact: null });
    expect(sessionAwaitsLanding(clean)).toBe(false);
    expect(glyphFor(sessionState(clean))).toBe('✓');
  });
});

describe('a plan and an agent roll up the hardest thing beneath them', () => {
  it('a plan holding a failed session is ✗, even beside a running one', () => {
    const p = plan({
      sessions: [session({ id: 's1', status: 'open' }), session({ id: 's2', status: 'failed' })],
    });
    expect(glyphFor(planState(p))).toBe('✗');
  });

  it('a settled plan with no sessions is a clean ✓; an open one is routine ·', () => {
    expect(glyphFor(planState(plan({ status: 'settled' })))).toBe('✓');
    expect(glyphFor(planState(plan({ status: 'open' })))).toBe('·');
  });

  it('an agent is the hardest session across all its plans', () => {
    const agent = {
      userId: 'agent-1',
      name: 'hexi',
      host: null,
      harness: null,
      model: null,
      budgetLimitMicros: null,
      plans: [
        plan({ id: 'p1', sessions: [session({ id: 's1', status: 'settled' })] }),
        plan({ id: 'p2', sessions: [session({ id: 's2', status: 'failed' })] }),
      ],
    };
    expect(glyphFor(agentState(agent))).toBe('✗');
  });
});

describe('cost is burn vs budget, read off the plan columns', () => {
  it('a funded plan within its slice does not warn', () => {
    const cost = planCost(plan({ rlimitSlice: 4, authorizedDraws: 2 }));
    expect(cost.warn).toBe(false);
    expect(cost.draws.overCeiling).toBe(false);
  });

  it('an over-ceiling plan warns — flip the ceiling below the draws', () => {
    const cost = planCost(plan({ rlimitSlice: 1, authorizedDraws: 3 }));
    expect(cost.draws.overCeiling).toBe(true);
    expect(cost.warn).toBe(true);
  });

  it('an unfunded plan that drew anything warns; a dollar overrun warns', () => {
    expect(planCost(plan({ rlimitSlice: null, authorizedDraws: 1 })).warn).toBe(true);
    expect(
      planCost(
        plan({ rlimitSlice: 9, authorizedDraws: 1, budgetLimitMicros: 100, spentMicros: 200 }),
      ).warn,
    ).toBe(true);
  });
});

describe('the pin is ordered by glyph hardness, and it renders only what needs a human', () => {
  const items: ControlPinItem[] = [
    {
      id: 'gate',
      state: {
        kind: 'decision',
        verification: 'proposed',
        owedToViewer: true,
        irreversible: false,
      },
      title: 'a decision',
      detail: '',
      meta: '',
    },
    {
      id: 'failed',
      state: sessionState(session({ status: 'failed' })),
      title: 'a failed session',
      detail: '',
      meta: '',
    },
    {
      id: 'land',
      state: sessionState(
        session({ status: 'settled', artifact: { branch: 'b' }, certifiedByName: null }),
      ),
      title: 'land the work',
      detail: '',
      meta: '',
    },
  ];

  it('hardest first: ✗ failed, then ■ land, then ◆ gate', () => {
    expect(pinHardestFirst(items).map((item) => item.id)).toEqual(['failed', 'land', 'gate']);
  });

  it('renders the failed session as the first pin row', () => {
    render(<ControlPin items={items} />);
    const rows = screen.getAllByRole('generic').filter((el) => el.dataset.pinItem);
    // The first pin item in DOM order is the hardest — the failed session.
    const firstWithData = document.querySelector('[data-pin-item]');
    expect(firstWithData?.getAttribute('data-pin-item')).toBe('failed');
    expect(rows.length).toBeGreaterThan(0);
    // the head glyph announces the hardest thing in the pin — a failure
    expect(
      document.querySelector('[data-pin-glyph] [data-glyph]')?.getAttribute('data-glyph'),
    ).toBe('✗');
  });

  it('an empty pin says so — a result, not an absence', () => {
    render(<ControlPin items={[]} />);
    expect(screen.getByText(/NOTHING NEEDS YOU IN THIS ROOM/i)).toBeTruthy();
  });
});
