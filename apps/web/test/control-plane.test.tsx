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
 *
 * ## THE CASE THIS FILE USED TO GET WRONG, WHICH IS WHY IT LEADS NOW
 *
 * It asserted `glyphFor(sessionState(session({ status: 'settled' }))) === '✓'`
 * and called it "a clean settle is ✓". The assertion was true of the code and
 * false of the covenant: a settled session nobody has certified had earned the
 * glyph whose tooltip reads "certified — a person has accepted this reading", off
 * nothing but a subprocess's exit code. A test that pins the defect is worse than
 * no test, because it makes the fix look like the regression.
 *
 * The rule these now assert: `✓` iff a HUMAN certified. Settled-uncertified is
 * `~` — the machine's own account. Every consumer moves on that one flip.
 *
 * ## THE VIEWER IS A HUMAN OR IT IS OWED NOTHING
 *
 * `sessionState`, `planState` and `agentState` take a `viewerIsHuman` flag. A
 * failed session and an unlanded artifact are owed to any HUMAN (any human may
 * certify), but to no agent — certifying is a human-only act. Almost every case
 * here reads as a human (`true`), which is the design's common path; the last
 * block flips the viewer to an agent and proves the room-wide "owed" drops.
 * ------------------------------------------------------------------------- */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ControlAgentRow,
  ControlDecisionRow,
  ControlPlaneData,
  ControlPlanRow,
  ControlSessionRow,
} from '../lib/control-plane-data';
import {
  ControlPin,
  type ControlPinItem,
  pinHardestFirst,
} from '../src/components/control/ControlPin';
import { ControlPlane } from '../src/components/control/ControlPlane';
import { ProcessTree } from '../src/components/control/ProcessTree';

/* ControlPlane is a client component that reaches for the app router and Link.
   Neither is under test here — the render is about the pin and decisions gating —
   so both are stubbed to their inert shapes. */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown>) => <a {...props} />,
}));

import {
  agentState,
  decisionState,
  planCost,
  planState,
  sessionAwaitsLanding,
  sessionCertified,
  sessionState,
} from '../src/components/control/state';
import { glyphFor } from '../src/components/model/glyph';

/* These cases query `document` for the FIRST match, so a previous render left
   mounted would answer for the current one — and a badge assertion that reads
   the last test's DOM is exactly the false green this file is here to remove. */
afterEach(cleanup);

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
    certifiedByKind: null,
    certifiedAt: null,
    certifiedHeldMs: null,
    certifyArmedAt: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A session a HUMAN certified — the only shape that earns the tick. It carries a
 * COMPLETE receipt (armed, held, stamped, signed); `sessionCertified` fails closed
 * on any missing part (CS-2), so a fixture short of one is uncertified.
 */
function certifiedSession(overrides: Partial<ControlSessionRow> = {}): ControlSessionRow {
  return session({
    status: 'settled',
    certifiedByName: 'Ada',
    certifiedByKind: 'human',
    certifiedAt: '2026-08-13T01:00:00.000Z',
    certifiedHeldMs: 2400,
    certifyArmedAt: '2026-08-13T00:59:57.600Z',
    ...overrides,
  });
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

describe('the tick comes from a human signature and from nothing else', () => {
  /**
   * THE CAMPAIGN-STOPPING ONE (#121 gauntlet, CS-1). The derivation read
   * `status === 'settled' → verification: 'verified'`, so this exact row — a
   * process that exited, that no person has looked at — rendered `✓`.
   *
   * MUTATION THAT MUST TURN THIS RED: put `verification: 'verified'` (or
   * `'accepted'`) back on the `status === 'settled'` branch of `sessionState`.
   */
  it('a settled session NOBODY certified is ~ — the machine reporting its own exit', () => {
    const settled = session({ status: 'settled' });
    expect(sessionCertified(settled)).toBe(false);
    expect(sessionState(settled, true).verification).toBe('self_reported');
    expect(glyphFor(sessionState(settled, true))).toBe('~');
  });

  it('running is routine ·, failed is ✗', () => {
    expect(glyphFor(sessionState(session({ status: 'open' }), true))).toBe('·');
    expect(glyphFor(sessionState(session({ status: 'failed' }), true))).toBe('✗');
  });

  it('FLIP THE SIGNATURE: the same settled row moves ~ → ✓ when a human certifies it', () => {
    const before = session({ status: 'settled' });
    const after = certifiedSession();
    expect(glyphFor(sessionState(before, true))).toBe('~');
    expect(glyphFor(sessionState(after, true))).toBe('✓');
    expect(sessionState(after, true).verification).toBe('accepted');
  });

  /**
   * A NAME IS NOT A SIGNATURE. Two triggers make this row unwritable (0032,
   * 0033) — this asserts the RENDER does not assume they held. The predicate is
   * @atrium/core's `epistemicStateOf`, so mutating that one function moves this.
   */
  it('a NON-HUMAN certifier does not mint a tick, whatever name is attached', () => {
    const machineSigned = certifiedSession({ certifiedByName: 'hexi', certifiedByKind: 'agent' });
    expect(sessionCertified(machineSigned)).toBe(false);
    expect(glyphFor(sessionState(machineSigned, true))).toBe('~');
  });

  it('an unreadable certifier kind fails CLOSED — ~, never the privileged glyph', () => {
    const unreadable = certifiedSession({ certifiedByKind: null });
    expect(sessionCertified(unreadable)).toBe(false);
    expect(glyphFor(sessionState(unreadable, true))).toBe('~');
  });

  it('a settled session with an uncertified artifact needs you, and certifying is not undoable (■)', () => {
    const awaiting = session({
      status: 'settled',
      artifact: { branch: 'feat/x', commit: 'abc123' },
    });
    expect(sessionAwaitsLanding(awaiting)).toBe(true);
    expect(glyphFor(sessionState(awaiting, true))).toBe('■');
  });

  it('once a human has certified it, the same artifact-bearing session reads ✓', () => {
    const artifact = { branch: 'feat/x', commit: 'abc123' };
    const before = session({ status: 'settled', artifact });
    const after = certifiedSession({ artifact });
    expect(glyphFor(sessionState(before, true))).toBe('■');
    expect(glyphFor(sessionState(after, true))).toBe('✓');
    expect(sessionAwaitsLanding(after)).toBe(false);
  });
});

describe('the tree badge and the tree glyph read the SAME predicate', () => {
  const agent = (sessions: readonly ControlSessionRow[]) => ({
    userId: 'agent-1',
    name: 'hexi',
    host: null,
    harness: null,
    model: null,
    budgetLimitMicros: null,
    plans: [plan({ id: 'p1', sessions })],
  });

  /* CATCHES the badge becoming a second source. It used to test
     `certifiedByName !== null`, which says "certified" beside a `~` the moment a
     non-human name reaches the column. */
  it('a settled-uncertified session wears ~ and no certified badge', () => {
    const row = session({ id: 's1', status: 'settled' });
    render(<ProcessTree agents={[agent([row])]} onOpenSession={() => {}} viewerIsHuman={true} />);
    const node = document.querySelector('[data-tree-session="s1"]');
    expect(node?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('~');
    expect(document.querySelector('[data-session-certified]')).toBeNull();
  });

  it('a human-certified session wears ✓ and the badge, together', () => {
    const row = certifiedSession({ id: 's1' });
    render(<ProcessTree agents={[agent([row])]} onOpenSession={() => {}} viewerIsHuman={true} />);
    const node = document.querySelector('[data-tree-session="s1"]');
    expect(node?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('✓');
    expect(document.querySelector('[data-session-certified]')?.textContent).toBe('certified');
  });

  it('a machine-named session wears neither — the badge moves with the glyph', () => {
    const row = certifiedSession({ id: 's1', certifiedByKind: 'agent' });
    render(<ProcessTree agents={[agent([row])]} onOpenSession={() => {}} viewerIsHuman={true} />);
    const node = document.querySelector('[data-tree-session="s1"]');
    expect(node?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('~');
    expect(document.querySelector('[data-session-certified]')).toBeNull();
  });
});

describe('a plan and an agent roll up the hardest thing beneath them', () => {
  it('a plan holding a failed session is ✗, even beside a running one', () => {
    const p = plan({
      sessions: [session({ id: 's1', status: 'open' }), session({ id: 's2', status: 'failed' })],
    });
    expect(glyphFor(planState(p, true))).toBe('✗');
  });

  /* THE SAME DEFECT ONE LEVEL UP. `plans` carries no certification column at
     all, so a settled plan is a machine's report of its own completion — and it
     used to render `✓`, which would have kept the tick alive on every plan and
     agent even after the session derivation was fixed. */
  it('a settled plan with no sessions is ~, not ✓ — no column on it holds a signature', () => {
    expect(glyphFor(planState(plan({ status: 'settled' }), true))).toBe('~');
    expect(glyphFor(planState(plan({ status: 'open' }), true))).toBe('·');
  });

  it('a plan rolls up its sessions: all human-certified is ✓, one uncertified is ~', () => {
    const allSigned = plan({ sessions: [certifiedSession({ id: 's1' })] });
    const oneUnsigned = plan({
      sessions: [certifiedSession({ id: 's1' }), session({ id: 's2', status: 'settled' })],
    });
    expect(glyphFor(planState(allSigned, true))).toBe('✓');
    expect(glyphFor(planState(oneUnsigned, true))).toBe('~');
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
        plan({ id: 'p1', sessions: [certifiedSession({ id: 's1' })] }),
        plan({ id: 'p2', sessions: [session({ id: 's2', status: 'failed' })] }),
      ],
    };
    expect(glyphFor(agentState(agent, true))).toBe('✗');
  });
});

/**
 * OWED IS OWED TO A HUMAN, NOT TO WHOEVER IS LOOKING (#121 round 3, fix 2).
 *
 * A failed session and an unlanded artifact are owed to any HUMAN in the room —
 * room-wide, because any human may certify — but they are owed to NO agent, since
 * certifying is a human-only act (the server refuses a non-human identity;
 * drizzle/0032, 0033 refuse the column). Telling an agent-principal viewer "needs
 * you" would point them at a control they can never operate.
 *
 * MUTATION THAT MUST TURN THIS RED: drop the `viewerIsHuman` gate from
 * `sessionState` — put `owedToViewer: true` back on the failed and
 * awaits-landing branches. The agent-viewer cases below then read the failed
 * session as owed and the artifact as ■ "needs you", which is the surface
 * pointing a machine at a human-only act.
 */
describe('the room-wide owed is gated on the viewer being human', () => {
  const awaiting = () =>
    session({ id: 's-await', status: 'settled', artifact: { branch: 'feat/x', commit: 'abc' } });
  const failed = () => session({ id: 's-fail', status: 'failed' });

  it('an unlanded artifact is ■ "needs you" for a HUMAN, and ~ for an agent viewer', () => {
    // The design's common path: a human is owed the certification, undoably-not.
    expect(sessionState(awaiting(), true).owedToViewer).toBe(true);
    expect(glyphFor(sessionState(awaiting(), true))).toBe('■');
    // The agent viewer sees the machine's own report, not a second-person debt.
    expect(sessionState(awaiting(), false).owedToViewer).toBe(false);
    expect(glyphFor(sessionState(awaiting(), false))).toBe('~');
  });

  it('a failed session is owed to a human, and owed to no agent (the glyph stays ✗ either way)', () => {
    // Failure outranks owed in the glyph, so ✗ is right for both — the flag is
    // what the pin and the NEEDS YOU framing read, and it is what must differ.
    expect(sessionState(failed(), true).owedToViewer).toBe(true);
    expect(sessionState(failed(), false).owedToViewer).toBe(false);
    expect(glyphFor(sessionState(failed(), true))).toBe('✗');
    expect(glyphFor(sessionState(failed(), false))).toBe('✗');
  });

  it('the gate rolls up: a plan of an awaiting session is ■ for a human, ~ for an agent', () => {
    const p = plan({ sessions: [awaiting()] });
    expect(glyphFor(planState(p, true))).toBe('■');
    expect(glyphFor(planState(p, false))).toBe('~');
  });

  it('the gate rolls up to the agent row too', () => {
    const agentRow = {
      userId: 'agent-1',
      name: 'hexi',
      host: null,
      harness: null,
      model: null,
      budgetLimitMicros: null,
      plans: [plan({ id: 'p1', sessions: [awaiting()] })],
    };
    expect(glyphFor(agentState(agentRow, true))).toBe('■');
    expect(glyphFor(agentState(agentRow, false))).toBe('~');
  });

  it('an agent-principal viewer sees the tree glyph without the needs-you, in the DOM', () => {
    const agentRow = {
      userId: 'agent-1',
      name: 'hexi',
      host: null,
      harness: null,
      model: null,
      budgetLimitMicros: null,
      plans: [plan({ id: 'p1', sessions: [awaiting()] })],
    };
    render(<ProcessTree agents={[agentRow]} onOpenSession={() => {}} viewerIsHuman={false} />);
    const node = document.querySelector('[data-tree-session="s-await"]');
    expect(node?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('~');
    cleanup();
    render(<ProcessTree agents={[agentRow]} onOpenSession={() => {}} viewerIsHuman={true} />);
    const humanNode = document.querySelector('[data-tree-session="s-await"]');
    expect(humanNode?.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('■');
  });
});

describe('an owed decision is owed to SOMEBODY, and the glyph knows who', () => {
  const item = (overrides: Partial<ControlDecisionRow> = {}): ControlDecisionRow => ({
    id: 'att-1',
    userId: 'ada',
    owedToViewer: true,
    class: 'needs_decision',
    subjectKind: 'object',
    subjectId: 'obj-1',
    createdAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  });

  /**
   * FLIP THE VIEWER. `owedToViewer` was the literal `true` for every item and
   * every reader, which made NEEDS YOU a room-wide queue wearing a second-person
   * label. The read model derives it now, and the glyph moves with it.
   *
   * MUTATION THAT MUST TURN THIS RED: hard-code `owedToViewer: true` back into
   * `decisionState`, or return the constant from the read model's derivation.
   */
  it('owed to this reader is ◆; the same item owed to somebody else is ~', () => {
    expect(glyphFor(decisionState(item({ owedToViewer: true })))).toBe('◆');
    expect(glyphFor(decisionState(item({ owedToViewer: false })))).toBe('~');
  });

  it('a blocking question owed to this reader is ?; owed to another it is still ?, uncoloured', () => {
    const mine = decisionState(item({ class: 'blocking_question', owedToViewer: true }));
    const theirs = decisionState(item({ class: 'blocking_question', owedToViewer: false }));
    expect(glyphFor(mine)).toBe('?');
    expect(mine.owedToViewer).toBe(true);
    expect(glyphFor(theirs)).toBe('?');
    expect(theirs.owedToViewer).toBe(false);
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
      state: sessionState(session({ status: 'failed' }), true),
      title: 'a failed session',
      detail: '',
      meta: '',
    },
    {
      id: 'certify',
      state: sessionState(session({ status: 'settled', artifact: { branch: 'b' } }), true),
      title: 'certify the work',
      detail: '',
      meta: '',
    },
  ];

  it('hardest first: ✗ failed, then ■ certify, then ◆ gate', () => {
    expect(pinHardestFirst(items).map((item) => item.id)).toEqual(['failed', 'certify', 'gate']);
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

/**
 * THE PIN AND THE DECISIONS COUNT ARE OWED TO A HUMAN TOO (#121 round 4, fix 1).
 *
 * Round 3 gated the GLYPH on the viewer being human (`sessionState`'s
 * `owedToViewer`), but `ControlPlane` still put every failed and awaits-landing
 * session into the PIN and the DECISIONS count UNCONDITIONALLY — so an
 * agent-principal viewer read the glyph as `~` yet still saw the row under NEEDS
 * YOU and counted in the surface. The membership of both collections is now gated
 * on the same `viewerIsHuman` the glyph is, so a non-human viewer sees neither.
 *
 * These flip the WHOLE component across the viewer kind (the unit tests above only
 * flip `ProcessTree`; the e2e only ever uses a human), asserting the pin and the
 * decisions surface are empty for an agent and populated for a human — from the
 * same data.
 *
 * MUTATION THAT MUST TURN THIS RED: drop the `viewerIsHuman` gate from either the
 * `pinItems` loop or the `decisionsLines` spread in `ControlPlane` — the agent
 * then reads the failed/awaiting sessions under NEEDS YOU and in the count again.
 */
describe('the pin and the decisions count are gated on the viewer being human', () => {
  const awaiting = (): ControlSessionRow =>
    session({ id: 's-await', status: 'settled', artifact: { branch: 'feat/x', commit: 'abc' } });
  const failed = (): ControlSessionRow => session({ id: 's-fail', status: 'failed' });

  const agentRow: ControlAgentRow = {
    userId: 'agent-1',
    name: 'hexi',
    host: null,
    harness: null,
    model: null,
    budgetLimitMicros: null,
    plans: [plan({ id: 'p1', sessions: [failed(), awaiting()] })],
  };

  const data = (viewerId: string): ControlPlaneData => ({
    room: { id: 'room-1', name: 'fleet' },
    viewerId,
    agents: [agentRow],
    // No owed decisions on purpose: the only things that could reach the pin and
    // the count here are the session-derived items, which is what the gate covers.
    decisions: [],
    unseen: [],
    updatedAt: '2026-08-13T00:00:00.000Z',
  });

  const noop = async () => ({ ok: true }) as const;

  function renderPlane(viewerKind: 'human' | 'agent') {
    return render(
      <ControlPlane
        armAction={noop}
        certifyAction={noop}
        data={data('viewer-1')}
        disarmAction={noop}
        roomSlug="fleet"
        viewerId="viewer-1"
        viewerKind={viewerKind}
        workspaceSlug="acme"
      />,
    );
  }

  it('a HUMAN viewer sees the failed and awaiting sessions in the pin, and the decisions count', () => {
    renderPlane('human');
    expect(document.querySelector('[data-pin-item="s-fail"]')).not.toBeNull();
    expect(document.querySelector('[data-pin-item="s-await"]')).not.toBeNull();
    // one awaits-landing session → one certify line in the decisions surface
    expect(
      document
        .querySelector('[data-surface="decisions"] [data-surface-count]')
        ?.getAttribute('data-surface-count'),
    ).toBe('1');
  });

  it('an AGENT viewer sees NEITHER — the pin is empty and the decisions count is 0', () => {
    renderPlane('agent');
    expect(document.querySelector('[data-pin-item="s-fail"]')).toBeNull();
    expect(document.querySelector('[data-pin-item="s-await"]')).toBeNull();
    expect(screen.getByText(/NOTHING NEEDS YOU IN THIS ROOM/i)).toBeTruthy();
    expect(
      document
        .querySelector('[data-surface="decisions"] [data-surface-count]')
        ?.getAttribute('data-surface-count'),
    ).toBe('0');
  });
});

/**
 * A `✓` REQUIRES A COMPLETE RECEIPT AT THE RENDER TOO (#121 round 4, fix 3b).
 *
 * The humanity triggers refuse a non-human name, but a `certified_by` set alone —
 * no arm, no held duration, no stamp — is a shape a raw write could once produce,
 * and `sessionCertified` read name + kind and minted `✓` from it. It now fails
 * CLOSED on any missing part of the hold, the same way it does on an unreadable
 * kind. A DB backstop (drizzle/0035) refuses the write; this is the render's own
 * refusal to trust one if it appears.
 *
 * MUTATION THAT MUST TURN THIS RED: drop the armed/held/stamped completeness check
 * from `sessionCertified` — an incomplete row then reads `✓`.
 */
describe('the render fails closed on an incomplete certification receipt', () => {
  it('a certified_by with no arm / held / stamp is ~, not ✓', () => {
    const noArm = certifiedSession({ certifyArmedAt: null });
    const noHeld = certifiedSession({ certifiedHeldMs: null });
    const noStamp = certifiedSession({ certifiedAt: null });
    for (const incomplete of [noArm, noHeld, noStamp]) {
      expect(sessionCertified(incomplete)).toBe(false);
      expect(glyphFor(sessionState(incomplete, true))).toBe('~');
    }
    // the complete receipt still mints the tick, so the check is closed, not broken
    expect(sessionCertified(certifiedSession())).toBe(true);
    expect(glyphFor(sessionState(certifiedSession(), true))).toBe('✓');
  });
});
