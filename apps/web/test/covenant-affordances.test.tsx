/* ---------------------------------------------------------------------------
 * #157 — COVENANT AFFORDANCES CALL A GATED DOOR OR ARE PROVABLY INERT — NEVER A
 * LOCAL setState THAT FAKES SUCCESS.
 *
 * The married surface's covenant actions (certify ✓, fund, steer/interrupt,
 * retract, supersede, run ▶) must each reach an EXISTING server-gated door, or,
 * where the live control plane is not yet under this route, be honestly inert.
 * The defect this ticket kills is the inverse: a `✓` that flips a boolean and
 * never reaches the server, or an "@hexi stop" that freezes the view while the
 * agent keeps spending.
 *
 * On int/phase5 the `/prototype` route holds no live room (no `roomId`, no
 * `RealtimeClient`, no real ledger ids — everything is a seeded fixture), so
 * every ACTION door is inert THROUGH the covenant seam. These tests are the
 * flip-the-input assertions:
 *   - the seam performs no durable mutation and names the exact gated command;
 *   - the certify `✓` is DERIVED from `certified`, not a control that sets it;
 *   - the run ▶ is disabled, not a no-op that looks live.
 * The WIRED half — the real `signal_session` client verb the steer must reach —
 * is asserted in `realtime.test.ts` (a durable command leaves the client).
 * ------------------------------------------------------------------------- */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPane } from '../app/prototype/ArtifactPane';
import { ThreadStatus } from '../app/prototype/ChatChrome';
import { type CovenantDoor, type CovenantOutcome, covenant } from '../app/prototype/covenant';
import type { StreamState } from '../app/prototype/mock';
import type { Artifact, Selection } from '../app/prototype/types';

afterEach(cleanup);

describe('the covenant seam is honestly inert and names its gated door', () => {
  /* Each surfaced (or ticket-named) covenant door: invoking it must NOT report
     success, and must name the exact server command it will call when live. */
  const cases: ReadonlyArray<{ label: string; run: () => CovenantOutcome }> = [
    { label: 'certify', run: () => covenant.certify('sess-1') },
    { label: 'certifyClaim', run: () => covenant.certifyClaim('obj-1') },
    { label: 'fund', run: () => covenant.fund('plan-1', 5) },
    { label: 'steer', run: () => covenant.steer('sess-1', 'keep it in billing') },
    { label: 'interrupt', run: () => covenant.interrupt('sess-1', 'stop') },
    { label: 'retract', run: () => covenant.retract('obj-1') },
    { label: 'supersede', run: () => covenant.supersede('old-1', 'new-1') },
    { label: 'run', run: () => covenant.run('sess-1') },
  ];

  const expectedDoor: Record<string, CovenantDoor> = {
    // The ArtifactPane hosts a session LANDING, so its certify names the
    // server-timed session hold, NOT the claim-certify `amend` (#157 r1 D2).
    certify: 'certifySession{arm→confirm}',
    certifyClaim: "correctObject('amend',{verification:'verified'})",
    fund: 'set_plan_rlimit',
    steer: 'signal_session{steer}',
    interrupt: 'signal_session{interrupt}',
    retract: "correctObject('retract')",
    supersede: 'supersede_object',
    run: 'open_session|resume_session',
  };

  for (const { label, run } of cases) {
    it(`${label} reaches no server yet and names its door`, () => {
      const outcome = run();
      // The one property the whole ticket turns on: a covenant act may NEVER
      // report success off a local call. Until app-integration, `reached` is
      // false — there is nowhere for it to be true.
      expect(outcome.reached).toBe(false);
      expect(outcome.door).toBe(expectedDoor[label]);
      expect(outcome.inert).toMatch(/nothing was sent/);
    });
  }
});

describe('the certify ✓ is derived, not a control that fakes it', () => {
  function planArtifact(certified: boolean): Artifact {
    return {
      id: 'plan-invoice',
      kind: 'plan',
      title: 'streaming invoice totals',
      sub: 'plan',
      certified,
      md: '# plan\n\n~ draft',
    };
  }

  function renderPane(certified: boolean) {
    return render(
      <ArtifactPane
        artifacts={[planArtifact(certified)]}
        activeId="plan-invoice"
        onSelectArtifact={() => {}}
        comments={[]}
        onComment={() => {}}
        onDraft={() => {}}
      />,
    );
  }

  it('states it is awaiting a human and offers no certify control', () => {
    renderPane(false);
    expect(screen.getByText('awaiting a human')).toBeTruthy();
    // No button anywhere in the pane certifies: the footer is a status, not an
    // act. A certify BUTTON here would be the setState theater the ticket kills.
    for (const button of screen.queryAllByRole('button')) {
      expect(button.getAttribute('aria-label') ?? button.textContent ?? '').not.toMatch(/certif/i);
    }
  });

  it('moves the glyph when the receipt flips — proof it is derived, not painted', () => {
    const uncertified = renderPane(false);
    const draftGlyph = uncertified.container
      .querySelector('[data-glyph]')
      ?.getAttribute('data-glyph');
    cleanup();
    const certified = renderPane(true);
    const verifiedGlyph = certified.container
      .querySelector('[data-glyph]')
      ?.getAttribute('data-glyph');
    // Flip the input (the `certified` receipt) and the rendered mark moves. A
    // faked `✓` — a literal glyph or a local boolean — would not track the input.
    expect(draftGlyph).toBeTruthy();
    expect(verifiedGlyph).toBeTruthy();
    expect(verifiedGlyph).not.toBe(draftGlyph);
  });
});

describe('the run ▶ affordance is disabled, not a live-looking no-op', () => {
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

  it('renders run as disabled — clicking it cannot dispatch or fake a run', () => {
    render(<ThreadStatus selected={SELECTED} stream={STREAM} />);
    const run = screen.getByRole('button', { name: /run/i }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });
});
