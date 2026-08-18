/* ---------------------------------------------------------------------------
 * HOLD TO ARM — the safety claim, checked.
 *
 * Round 1: `data-hold="2000"` was written on five buttons and read by nothing,
 * while `onClick` fired on the first press. Every test here would have passed
 * against nothing in the pre-fix tree, because there was nothing to test — the
 * component did not exist and the attribute had no consumer.
 * ------------------------------------------------------------------------- */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionCard, AttentionCompact } from '../src/components';
import type { AttentionItem } from '../src/components/model';
import { rationale } from '../src/components/model';
import type { Arming } from '../src/components/primitives/HoldToAct';
import { HoldToAct } from '../src/components/primitives/HoldToAct';

/* jsdom has no rAF clock of its own worth trusting, so the hold is driven by a
   fake one. `performance` is faked too, because the gate measures elapsed time
   with `performance.now()` rather than counting frames — a frame count would
   pass a hold through on a slow machine in a fraction of the time. */
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/* The hold's frames land outside React's event loop, so the clock has to be
   advanced inside `act` or the state change that marks the button armed is
   still queued when the assertion runs. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function destructive(): AttentionItem {
  return {
    id: 'X1',
    state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: true },
    title: 'Drop users_legacy at cutover',
    rationale: rationale('no automated path may drop a table that still takes live reads'),
    facts: ['destructive'],
    source: null,
    actions: [
      { id: 'authorise', label: 'Authorise the drop', emphasis: 'primary', statement: null },
    ],
  };
}

describe('press and hold', () => {
  /* CATCHES the exact round-1 defect: an `onClick` that fires immediately while
     the label promises a hold. A single click — the whole gesture, down and up —
     must do nothing at all. */
  it('a click does not act', () => {
    const acts: string[] = [];
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="drop the table"
        label="Drop"
        onAct={() => acts.push('act')}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    advance(5000);
    expect(acts).toEqual([]);
  });

  /* CATCHES: a hold that arms on a timer regardless of whether the control is
     still held. Release-before-complete has to cancel, or the "hold" is just a
     delay and the person who let go still destroyed the table. */
  it('releasing before the hold completes cancels it', () => {
    const events: string[] = [];
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="drop the table"
        label="Drop"
        onAct={() => events.push('act')}
        onArm={() => events.push('arm')}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1900);
    expect(Number(button.getAttribute('data-hold-progress'))).toBeGreaterThan(0.9);
    fireEvent.pointerUp(button);
    advance(5000);
    expect(events).toEqual([]);
    expect(button.getAttribute('data-hold-progress')).toBe('0.000');
  });

  /* CATCHES: firing the act without recording the arming, or recording it after
     the fact. The convention says the action records WHO armed it and WHEN; the
     record has to exist before the irreversible thing happens. */
  it('a completed hold arms first, then acts, with the arming recorded', () => {
    const order: string[] = [];
    let armed: Arming | null = null;
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="drop the table"
        label="Drop"
        onAct={() => order.push('act')}
        onArm={(arming) => {
          order.push('arm');
          armed = arming;
        }}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(2100);
    expect(order).toEqual(['arm', 'act']);
    expect(armed).not.toBeNull();
    const record = armed as unknown as Arming;
    expect(record.actionId).toBe('drop');
    expect(record.heldMs).toBeGreaterThanOrEqual(2000);
    expect(Number.isNaN(Date.parse(record.armedAt))).toBe(false);
    /* CONVENTIONS: "the action records WHO armed it and when". Round 2's record
       had no actor at all while its own comment claimed one. */
    expect(record.actor).toBe('lars');
    expect(button.getAttribute('data-armed')).toBe('true');
    expect(button.textContent).toContain('armed');
  });

  /* CATCHES: shortening the hold, or gating it on a frame count rather than
     elapsed time. Anything under the declared duration must not complete. */
  it('the gate is the declared elapsed time, not a frame count', () => {
    const events: string[] = [];
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="drop"
        holdMs={2000}
        label="Drop"
        onAct={() => events.push('act')}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1999);
    expect(events).toEqual([]);
    advance(2);
    expect(events).toEqual(['act']);
  });

  /* CATCHES: a keyboard user getting a one-press destruction because the
     browser synthesises a click for Space and Enter on a button. */
  it('the keyboard holds too, and cancels on release', () => {
    const events: string[] = [];
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="drop"
        label="Drop"
        onAct={() => events.push('act')}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: ' ' });
    advance(500);
    fireEvent.keyUp(button, { key: ' ' });
    advance(3000);
    expect(events).toEqual([]);

    fireEvent.keyDown(button, { key: 'Enter' });
    advance(2100);
    expect(events).toEqual(['act']);
  });

  /* CATCHES: a progress indicator that is decorative rather than driven by the
     same clock as the gate. What fills must be what is being measured. */
  it('the indicator fills from the clock that gates the action', () => {
    render(<HoldToAct actionId="drop" actor="lars" describe="drop" label="Drop" />);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1000);
    const half = Number(button.getAttribute('data-hold-progress'));
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    /* The meter is a SIBLING of the button, not a descendant — see the
       accessible-name test below for why. Same clock either way. */
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      String(Math.round(half * 100)),
    );
  });

  /* CATCHES: the progress indicator going back inside the button.
     `role="progressbar"` on a descendant contributes its value to the ancestor's
     computed accessible name, so the control announced as "0 Authorise the drop
     — hold" with a leading number that changed while the hold ran. Round 3's
     gauntlet found it; this asserts the NAME rather than the markup, so it stays
     true through a restructure that keeps the property. */
  it('the accessible name is the label, with no progress value welded to it', () => {
    render(
      <HoldToAct
        actionId="drop"
        actor="lars"
        describe="Authorise the drop"
        label="Authorise the drop"
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Authorise the drop — hold');
    expect(
      screen.getByRole('button', { name: 'Authorise the drop — hold' }),
      'the hold control announces its progress value as part of its name',
    ).toBeTruthy();
    // the fill is decoration and says so
    const fill = document.querySelector('[aria-hidden="true"]');
    expect(fill, 'the progress fill is not hidden from assistive technology').not.toBeNull();
    // and the progress is still exposed — moved, not deleted
    const meter = screen.getByRole('progressbar');
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toContain(meter.id);
  });
});

describe('friction follows the action, not the layout', () => {
  /* CATCHES: an irreversible primary rendering as a plain one-click button on
     the open card. */
  it('the open card holds an irreversible primary', () => {
    render(<AttentionCard item={destructive()} viewer="lars" />);
    const button = screen.getByRole('button', { name: /Authorise the drop — hold/ });
    expect(button.getAttribute('data-hold')).toBe('2000');
  });

  /* CATCHES the round-1 finding that compressing an item turned a two-second
     hold into a one-click destruction: the compressed row had no destructive
     variant at all. */
  it('the compressed row holds it too', () => {
    render(<AttentionCompact item={destructive()} viewer="lars" />);
    const button = screen.getByRole('button', { name: /Authorise the drop — hold/ });
    expect(button.getAttribute('data-hold')).toBe('2000');
    expect(button.getAttribute('data-hold-action')).toBe('authorise');
  });

  /* CATCHES: a reversible gate growing a hold. Friction is proportional to
     reversibility in BOTH directions — making the fast path slow is the other
     half of the same rule. */
  it('a reversible gate stays one click', () => {
    render(
      <AttentionCard
        item={{
          ...destructive(),
          state: {
            kind: 'decision',
            verification: 'proposed',
            owedToViewer: true,
            irreversible: false,
          },
        }}
        viewer="lars"
      />,
    );
    const button = screen.getByRole('button', { name: 'Authorise the drop' });
    expect(button.getAttribute('data-hold')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * THE ARMING RECORD CROSSES THE BOUNDARY WHOLE.
 *
 * Round 2's gauntlet: `Arming` carried `{actionId, armedAt, heldMs}` under a
 * comment claiming "who, when, how long held" — there was no actor field — and
 * the card and compressed row then flattened it to `(itemId, actionId,
 * armedAt)`, dropping the measured hold on the way out. A consumer putting an
 * irreversible act on the record got a timestamp and no evidence.
 * ------------------------------------------------------------------------- */
describe('the arming record reaches the consumer whole', () => {
  /* CATCHES: the card or the row re-flattening the record. Everything the
     control measured has to survive the boundary, or the measurement was for
     nobody. Against r2 this does not compile, and with the types loosened it
     fails on the missing `actor` and `heldMs`. */
  it.each([
    [
      'the open card',
      (armed: (id: string, arming: Arming) => void) => (
        <AttentionCard item={destructive()} onArm={armed} viewer="priya" />
      ),
    ],
    [
      'the compressed row',
      (armed: (id: string, arming: Arming) => void) => (
        <AttentionCompact item={destructive()} onArm={armed} viewer="priya" />
      ),
    ],
  ])('%s hands over actor, wall clock and measured hold', (_name, build) => {
    let seen: { id: string; arming: Arming } | null = null;
    render(
      build((id, arming) => {
        seen = { id, arming };
      }),
    );
    const button = screen.getByRole('button', { name: /Authorise the drop — hold/ });
    fireEvent.pointerDown(button);
    advance(2100);
    expect(seen).not.toBeNull();
    const record = seen as unknown as { id: string; arming: Arming };
    expect(record.id).toBe('X1');
    expect(record.arming.actionId).toBe('authorise');
    expect(record.arming.actor).toBe('priya');
    expect(record.arming.heldMs).toBeGreaterThanOrEqual(2000);
    expect(Number.isNaN(Date.parse(record.arming.armedAt))).toBe(false);
  });

  /* CATCHES: the actor being invented by the control rather than supplied by
     the surface that knows who is looking. It is on the DOM as well, so a
     browser can check the record the page would write. */
  it('the actor on the control is the viewer it was given', () => {
    render(<AttentionCard item={destructive()} viewer="dana" />);
    const button = screen.getByRole('button', { name: /Authorise the drop — hold/ });
    expect(button.getAttribute('data-hold-actor')).toBe('dana');
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 6, D12 — AN ID MINTED FROM A CALLER-SUPPLIED VALUE IS NOT UNIQUE.
 *
 * `${actionId}-hold-progress` and `-hold-describe`, from a value that repeats:
 * on /gallery the same five action ids render in five frames, so four of the
 * five destructive hold controls had `aria-describedby` pointing at ANOTHER
 * FRAME'S nodes and a screen-reader user heard a frozen meter belonging to a
 * different button. `getElementById` returns the first match; duplicate ids do
 * not error, they resolve somewhere else. The aria-snapshot test checked names,
 * not descriptions, so nothing saw it.
 * ------------------------------------------------------------------------- */
describe('the hold control’s aria ids are unique on the page', () => {
  /* CATCHES: the ids going back to the caller's `actionId`. Five instances with
     the SAME actionId is the shipped case, not a contrived one. */
  it('five holds with one action id mint five distinct describedby targets', () => {
    const { container } = render(
      <div>
        {[0, 1, 2, 3, 4].map((n) => (
          <HoldToAct actionId="authorise" actor="lars" describe="drop it" key={n} label="Drop" />
        ))}
      </div>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length, 'the control minted no ids at all').toBeGreaterThan(0);
    expect(new Set(ids).size, `duplicate DOM ids: ${ids.join(', ')}`).toBe(ids.length);

    /* AND EVERY BUTTON'S DESCRIPTION RESOLVES INSIDE ITS OWN CONTROL. Uniqueness
       is necessary and not sufficient: what a screen reader announces is
       whatever `getElementById` returns, so the assertion is about the LOOKUP. */
    for (const button of container.querySelectorAll('button')) {
      const described = (button.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(described.length).toBe(2);
      for (const id of described) {
        const target = container.querySelector(`[id="${id}"]`);
        expect(target, `${id} names nothing`).not.toBeNull();
        expect(
          button.parentElement?.contains(target as Node) ||
            button.nextElementSibling === target ||
            button.nextElementSibling?.nextElementSibling === target,
          `${id} resolves to a node belonging to a different control`,
        ).toBe(true);
      }
    }
  });

  /* CATCHES: the selector hook being dropped along with the id. `actionId` still
     has to be findable on the DOM — it is what tests and consumers select by,
     and an id was being abused for that job. */
  it('the action id is still on the DOM, as data rather than as an id', () => {
    const { container } = render(
      <HoldToAct actionId="authorise" actor="lars" describe="drop it" label="Drop" />,
    );
    expect(container.querySelector('[data-hold-action="authorise"]')).not.toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * #146 — THE DISABLED CONTROL, AND THE RESTING PHASE AFTER AN ACT.
 *
 * FIX 1 gave the primitive a `disabled` state so the fund pane can shut the door
 * on a slice the command would coerce, instead of holding-to-authorize a value
 * the surface would silently change. FIX 3 gave it `resetOnComplete` so a
 * fire-once act (fund/settle) returns to idle rather than resting at `armed`,
 * which reads ambiguously on an already-funded plan.
 * ------------------------------------------------------------------------- */
describe('a disabled hold begins nothing (#146 FIX 1)', () => {
  /* CATCHES: a `disabled` prop that renders inert visually but still lets a hold
     complete and fire the act — the exact failure the fund pane must not have,
     since a disabled control means "this value may not be authorized". */
  it('renders disabled and cannot be held to act', () => {
    const events: string[] = [];
    render(
      <HoldToAct
        actionId="fund"
        actor="lars"
        describe="fund it"
        disabled
        label="Authorize funding"
        onAct={() => events.push('act')}
        onArm={() => events.push('arm')}
      />,
    );
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(button);
    fireEvent.keyDown(button, { key: ' ' });
    advance(5000);
    expect(events).toEqual([]);
    expect(button.getAttribute('data-holding')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * E8 r2 BLOCKER — A HOLD IN FLIGHT WHEN THE CONTROL GOES DISABLED MUST NOT ACT.
 *
 * The certify pane flips `disabled` (`!canCertify`) the instant a body edit
 * invalidates the pending span. A hold begun BEFORE the edit kept a running
 * `requestAnimationFrame` chain whose closure was captured pre-edit, so it ran to
 * completion and fired the act over the STALE span. The fix cancels the frame when
 * `disabled` goes true AND re-checks `disabled` at fire time, so neither path can
 * fire the stale act.
 * ------------------------------------------------------------------------- */
describe('a hold abandoned by going disabled mid-press never acts (E8 r2)', () => {
  function Controlled({
    onAct,
    onCancel,
  }: {
    onAct: () => void;
    onCancel: () => void;
  }) {
    const [disabled, setDisabled] = useState(false);
    return (
      <>
        <HoldToAct
          actionId="certify"
          actor="lars"
          describe="certify the passage"
          disabled={disabled}
          label="Certify this passage"
          onAct={onAct}
          onCancel={onCancel}
          resetOnComplete
        />
        <button data-testid="invalidate" onClick={() => setDisabled(true)} type="button">
          invalidate
        </button>
      </>
    );
  }

  /* CATCHES: the running rAF completing over a span the edit already invalidated —
     the exact blocker both lineages converged on. Going disabled mid-hold cancels
     the frame and abandons the hold (firing onCancel, the server disarm), and the
     later frames fire nothing. */
  it('going disabled mid-hold cancels the in-flight hold and fires no act', () => {
    const events: string[] = [];
    render(
      <Controlled onAct={() => events.push('act')} onCancel={() => events.push('cancel')} />,
    );
    const hold = screen.getByRole('button', { name: /Certify this passage/ });
    fireEvent.pointerDown(hold);
    advance(1000); // mid-hold, well before the 2s gate
    expect(Number(hold.getAttribute('data-hold-progress'))).toBeGreaterThan(0.4);

    // The body edit lands: the pane flips the control disabled.
    fireEvent.click(screen.getByTestId('invalidate'));
    advance(5000); // long past the gate — a stale frame would have fired here

    expect(events).toEqual(['cancel']); // abandoned, never acted
    expect(hold.getAttribute('data-hold-progress')).toBe('0.000');
    expect(hold.getAttribute('data-armed')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * E8 r3 — A FIRE-TIME GUARD REFUSES A COMPLETED HOLD EVEN BEFORE `disabled` COMMITS.
 *
 * `disabled` is React state: a caller that invalidates the act on a synchronous
 * event (certify: a Yjs convergence) cannot flip `disabled` until React commits the
 * re-render, and a `requestAnimationFrame` chain already in flight can fire
 * `complete` in that pre-commit window, reading a stale `disabledRef`. The `guard`
 * predicate is re-evaluated at fire time against a value the caller updates
 * SYNCHRONOUSLY, so it closes that window regardless of commit ordering.
 * ------------------------------------------------------------------------- */
describe('a fire-time guard abandons a completed hold, independent of disabled (E8 r3)', () => {
  /* CATCHES: `complete` acting when the caller's synchronous validity has gone false
     but `disabled` has not yet committed. With the guard removed this fires the act;
     with it, the hold is abandoned (onCancel) and nothing acts. */
  it('guard=false at fire time aborts the act, with disabled never flipped', () => {
    const events: string[] = [];
    // A mutable validity flipped imperatively — no React state, so `disabled` stays
    // false throughout, exactly like the pre-commit window.
    const valid = { current: true };
    render(
      <HoldToAct
        actionId="certify"
        actor="lars"
        describe="certify the passage"
        guard={() => valid.current}
        label="Certify this passage"
        onAct={() => events.push('act')}
        onCancel={() => events.push('cancel')}
        resetOnComplete
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1000); // mid-hold
    expect((button as HTMLButtonElement).disabled).toBe(false);

    valid.current = false; // the doc converged synchronously; the guard's value is stale
    advance(5000); // past the gate — the completing frame evaluates the guard

    expect(events).toEqual(['cancel']); // abandoned, never acted
    expect(button.getAttribute('data-armed')).toBeNull();
    expect(button.getAttribute('data-hold-progress')).toBe('0.000');
  });

  /* CATCHES: the guard blocking a VALID completion — it must only refuse when it
     returns false, never gate an honest hold. */
  it('guard=true lets the hold complete and act as normal', () => {
    const events: string[] = [];
    render(
      <HoldToAct
        actionId="certify"
        actor="lars"
        describe="certify the passage"
        guard={() => true}
        holdMs={1500}
        label="Certify this passage"
        onAct={() => events.push('act')}
        onArm={() => events.push('arm')}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1600);
    expect(events).toEqual(['arm', 'act']);
  });
});

describe('resetOnComplete returns a fire-once act to idle (#146 FIX 3)', () => {
  /* CATCHES: a fund/settle control resting at `armed` after it fired. The act
     still fires (arm then act); only the resting phase changes — so the control
     no longer reads `armed` on a plan whose funding already went through. */
  it('the act still fires, but the control rests idle, not armed', () => {
    const order: string[] = [];
    render(
      <HoldToAct
        actionId="fund"
        actor="lars"
        describe="fund it"
        holdMs={1500}
        label="Authorize funding"
        onAct={() => order.push('act')}
        onArm={() => order.push('arm')}
        resetOnComplete
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1600);
    expect(order).toEqual(['arm', 'act']);
    expect(button.getAttribute('data-armed')).toBeNull();
    expect(button.textContent).toContain('hold');
    expect(button.textContent).not.toContain('armed');
    expect(button.getAttribute('data-hold-progress')).toBe('0.000');
  });

  /* CATCHES: the default drifting — every OTHER caller (certify, attention)
     relies on the armed rest, so it must stay the default when the prop is off. */
  it('without the prop, a completed hold still rests at armed', () => {
    render(<HoldToAct actionId="drop" actor="lars" describe="drop" holdMs={1500} label="Drop" />);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    advance(1600);
    expect(button.getAttribute('data-armed')).toBe('true');
    expect(button.textContent).toContain('armed');
  });
});
