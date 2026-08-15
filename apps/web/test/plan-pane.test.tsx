/* ---------------------------------------------------------------------------
 * #146 — THE FUND SURFACE MUST AUTHORIZE WHAT THE HUMAN CAN SEE.
 *
 * FIX 1 (load-bearing). The slice input authorizes draws of real spend. The old
 * `parseInt` read a DIFFERENT number than the field showed — `parseInt('1e2')`
 * is 1, `parseInt('3.5')` is 3, `parseInt('-0.5')` is 0 — so the hold authorized
 * an amount the person never typed. These tests pin the honest behavior: a slice
 * that is not a whole, non-negative decimal DISABLES the fund hold and shows why,
 * and NO command is issued. RED-ON-REVERT: restore the `parseInt` onChange and
 * drop the `disabled` wiring and each bad input silently funds a coerced slice —
 * the mock records a `set_plan_rlimit` these tests forbid, and the disabled
 * assertions fail because the control is live again.
 *
 * FIX 2. The non-human refusal copy used to claim "neither the command path nor
 * the table will let it" — false for an OPEN plan, whose `rlimit_slice` a raw
 * UPDATE moves freely (integration/db/budget-slice.test.ts). The real enforcement
 * is the human-only application spend gate on `set_plan_rlimit` (#115/#118). The
 * copy must state that and must NOT claim a DB-level guarantee it does not have.
 *
 * FIX 3. A fire-once fund returns the hold to idle, not `armed`, so an
 * already-funded plan's control does not read ambiguously.
 * ------------------------------------------------------------------------- */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlanRow } from '../lib/control-plane-data';

/* The pane reaches for the app router and the command socket; neither is under
   test here. The router is inert, and the command transport is a spy so a test
   can assert exactly what — if anything — the fund hold sent. */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const issueRoomCommand = vi.fn(async (_command: unknown) => ({
  ok: true as const,
  issues: [] as string[],
}));
vi.mock('@/lib/room-command', () => ({
  issueRoomCommand: (command: unknown) => issueRoomCommand(command),
}));

import { PlanPane } from '../src/components/control/PlanPane';

/* The hold is a real elapsed-time gate driven by `performance.now()` and rAF, so
   it needs the same fake clock the HoldToAct suite uses. */
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
  issueRoomCommand.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function plan(overrides: Partial<ControlPlanRow> = {}): ControlPlanRow {
  return {
    id: 'plan-1',
    agentUserId: 'agent-1',
    title: 'a plan',
    status: 'open',
    budgetLimitMicros: null,
    spentMicros: 0,
    rlimitSlice: null,
    authorizedDraws: 0,
    refusedDraws: 0,
    sessions: [],
    ...overrides,
  };
}

function renderFund(viewerKind: 'human' | 'agent' = 'human') {
  return render(
    <PlanPane
      agentName="agent"
      plan={plan()}
      roomId="room-1"
      viewerId="lars"
      viewerKind={viewerKind}
    />,
  );
}

function fundButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[data-hold-action="fund-plan-1"]',
  );
  if (button === null) throw new Error('fund hold not rendered');
  return button;
}

function typeSlice(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[data-fund-slice-input="true"]');
  if (input === null) throw new Error('slice input not rendered');
  fireEvent.change(input, { target: { value } });
}

describe('the fund input authorizes exactly what it shows (#146 FIX 1)', () => {
  /* Each of these read a DIFFERENT number under `parseInt` than the field shows.
     The honest surface refuses them: the hold is disabled, a validation line
     appears, and holding it (in case a synthesised event slips through) issues
     nothing. RED-ON-REVERT: `parseInt` makes 1e2→1, 3.5→3, -0.5→0 and the
     coerced slice reaches `issueRoomCommand`. */
  it.each([
    ['1e2', 'exponent notation the human does not read as an integer'],
    ['3.5', 'a fractional slice'],
    ['-0.5', 'a negative fractional slice'],
    ['', 'an empty field'],
  ])('%s (%s) disables the fund hold and issues no command', (bad) => {
    renderFund();
    typeSlice(bad);

    const button = fundButton();
    expect(button.disabled, `a bad slice (${JSON.stringify(bad)}) left the fund control live`).toBe(
      true,
    );
    expect(
      document.querySelector('[data-fund-invalid="true"]'),
      'no validation message shown for a bad slice',
    ).not.toBeNull();

    // Attempt the whole gesture anyway — a disabled safety control must fire nothing.
    fireEvent.pointerDown(button);
    fireEvent.keyDown(button, { key: ' ' });
    advance(4000);
    expect(
      issueRoomCommand,
      `a coerced slice was sent for ${JSON.stringify(bad)}`,
    ).not.toHaveBeenCalled();
  });

  /* THE POSITIVE HALF: a plain whole number is enabled, and the slice that
     reaches the command is EXACTLY the one shown — no rounding, no truncation. */
  it('a whole, non-negative slice is enabled and sends exactly that number', () => {
    renderFund();
    typeSlice('42');

    const button = fundButton();
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-fund-invalid="true"]')).toBeNull();

    fireEvent.pointerDown(button);
    advance(1600);

    expect(issueRoomCommand).toHaveBeenCalledTimes(1);
    expect(issueRoomCommand).toHaveBeenCalledWith({
      name: 'set_plan_rlimit',
      roomId: 'room-1',
      planId: 'plan-1',
      slice: 42,
    });
  });
});

describe('the non-human refusal names the real gate, not a DB guarantee (#146 FIX 2)', () => {
  /* CATCHES the reinstatement of the false claim. The DB trigger freezes only a
     SETTLED plan; an OPEN plan's slice is raw-SQL mutable, so "the table will not
     let it" is false. The honest copy points at the human-only application spend
     gate on `set_plan_rlimit`. */
  it('does not claim the table blocks it, and does name the spend gate', () => {
    renderFund('agent');
    const refused = document.querySelector('[data-fund-refused="true"]');
    expect(refused, 'the non-human refusal copy is not shown').not.toBeNull();
    const copy = refused?.textContent ?? '';
    expect(
      copy.toLowerCase(),
      'the copy still claims a DB-level guard that does not exist',
    ).not.toContain('table');
    expect(copy).toContain('set_plan_rlimit');
    expect(copy).toContain('#115');
  });
});

describe('a completed fund returns the control to idle (#146 FIX 3)', () => {
  /* CATCHES the fund hold resting at `armed` after it fired, which reads
     ambiguously on an already-funded plan. */
  it('the fund hold does not rest armed after it fires', () => {
    renderFund();
    typeSlice('7');
    const button = fundButton();
    fireEvent.pointerDown(button);
    advance(1600);

    expect(issueRoomCommand).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('data-armed')).toBeNull();
    expect(button.textContent).not.toContain('armed');
  });
});
