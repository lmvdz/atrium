/* ---------------------------------------------------------------------------
 * HOLD TO ARM — the safety claim, checked.
 *
 * Round 1: `data-hold="2000"` was written on five buttons and read by nothing,
 * while `onClick` fired on the first press. Every test here would have passed
 * against nothing in the pre-fix tree, because there was nothing to test — the
 * component did not exist and the attribute had no consumer.
 * ------------------------------------------------------------------------- */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(button.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      String(Math.round(half * 100)),
    );
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
