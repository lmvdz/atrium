/* ---------------------------------------------------------------------------
 * #157 round 3 — STEER/INTERRUPT IS STRUCTURED, NEVER INFERRED FROM CHAT PROSE.
 *
 * Rounds 1–2 detected steer/interrupt by matching a finite regex over free chat
 * text in the composer. The round-2 gauntlet (codex) found that mechanism wrong
 * in BOTH directions, and unfixable as inference:
 *
 *   D1 (bypass) — "@hexi cancel", "@hexi cease work", a zero-width "@hexi st​op"
 *        all MISS the regex, so they fell through and posted as a normal, delivered-
 *        looking authored message with no ✗ notice: a covenant cue that reached no
 *        door yet looked sent — a fake-success hole.
 *   D2 (swallow) — any `hexi`+cue sentence ("hexi should not stop", "mira: ask
 *        whether hexi can stop") was REMOVED from chat and replaced with an
 *        interrupt notice: ordinary speech lost / misclassified.
 *
 * The fix removes the inference entirely. A chat message is ALWAYS just a chat
 * message. Steer/interrupt is a discrete STRUCTURED control on the running session
 * (ThreadStatus's steer/interrupt buttons), an honest inert seam naming
 * `signal_session{steer|interrupt}` for go-live (#168).
 *
 * These tests DRIVE the real surface. Part (a) goes RED on the current
 * keyword-inference code: it asserts that stop/cancel/zero-width cues post as
 * NORMAL authored messages — not intercepted, not swallowed, not a fake stop.
 * Part (b) asserts the structured affordance is inert/seamed and never fakes a
 * signal.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { covenant } from '../app/prototype/covenant';
import { MoldingSurface } from '../app/prototype/MoldingSurface';

afterEach(cleanup);

/** Type one line into the room's single composer and submit it (Enter). */
function submit(container: HTMLElement, text: string): void {
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[name="atrium-message"]');
  expect(composer).toBeTruthy();
  const field = composer as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

describe('(a) a chat cue posts as a NORMAL authored message — never intercepted (#157 r3)', () => {
  // The exact cues the round-2 gauntlet named: a matched stop, an UNMATCHED cue
  // (cancel), and a zero-width bypass of the old regex (`st​op`). Every one
  // must post as an ordinary authored message now.
  const cues = ['@hexi stop', '@hexi cancel', '@hexi cease work', '@hexi st​op'] as const;

  for (const cue of cues) {
    it(`"${cue.replace('​', '<zwsp>')}" posts as an authored message, not a NOT-delivered notice`, () => {
      const { container } = render(<MoldingSurface />);
      submit(container, cue);

      const echo = container.querySelector<HTMLElement>('[data-mm-id="echo-0"]');
      expect(echo, 'the cue produced no feed row at all').toBeTruthy();
      const row = echo as HTMLElement;

      // It is an authored ("human") message row — NOT a system notice. The old
      // keyword-inference code turned a matched cue into `data-mm-kind="system"`
      // with a `[data-row="system"]` ✗ notice; the unmatched cues it let through
      // as messages. This asserts the ONE honest outcome for all of them: a
      // normal authored line.
      expect(row.getAttribute('data-mm-kind')).toBe('human');
      expect(row.querySelector('[data-row="message"]')).toBeTruthy();
      expect(row.querySelector('[data-row="system"]')).toBeNull();

      // Nothing anywhere claims a covenant act happened: no "not delivered"
      // notice, and the cue was not swallowed — its words are on the row verbatim.
      expect((container.textContent ?? '').toLowerCase()).not.toContain('not delivered');
      expect((row.textContent ?? '').toLowerCase()).toContain('hexi');
    });
  }

  it('does not SWALLOW an ordinary sentence that merely mentions stopping (#157 r3 D2)', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, 'hexi should not stop until the invoice totals are done');

    const echo = container.querySelector<HTMLElement>('[data-mm-id="echo-0"]');
    expect(echo).toBeTruthy();
    const row = echo as HTMLElement;
    // The whole sentence survives as an authored message — not removed, not turned
    // into an interrupt notice.
    expect(row.querySelector('[data-row="message"]')).toBeTruthy();
    expect(row.querySelector('[data-row="system"]')).toBeNull();
    expect(row.textContent ?? '').toContain('should not stop');
    expect((container.textContent ?? '').toLowerCase()).not.toContain('not delivered');
  });

  it('never renders a NOT-delivered / interrupt notice for any chat line', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, '@hexi stop');
    submit(container, '@hexi cancel');
    // No feed row is a NOT-delivered covenant notice: the composer no longer
    // manufactures one from prose.
    for (const messageRow of container.querySelectorAll('[data-mm-id^="echo-"]')) {
      expect((messageRow.textContent ?? '').toLowerCase()).not.toContain('not delivered');
    }
  });
});

describe('(b) steer/interrupt is a STRUCTURED, honestly-inert affordance (#157 r3)', () => {
  it('the covenant seam is mutation-free, reached:false, and names its gated door', () => {
    // The seam the affordance is wired to. It never reports success and names the
    // exact server-gated command go-live (#168) must call.
    const steer = covenant.steer('s-live', 'keep it in billing');
    const interrupt = covenant.interrupt('s-live', 'stop');
    expect(steer.reached).toBe(false);
    expect(steer.door).toBe('signal_session{steer}');
    expect(interrupt.reached).toBe(false);
    expect(interrupt.door).toBe('signal_session{interrupt}');
  });

  it('renders steer and interrupt as DISABLED controls that name their doors', () => {
    const { container } = render(<MoldingSurface />);
    const footer = container.querySelector<HTMLElement>('footer');
    expect(footer).toBeTruthy();
    const scope = within(footer as HTMLElement);

    const steerBtn = scope.getByLabelText(/^steer/i) as HTMLButtonElement;
    const interruptBtn = scope.getByLabelText(/^interrupt/i) as HTMLButtonElement;

    // Structured controls, not chat: both present, both disabled — a disabled
    // control cannot mutate, cannot dispatch, cannot fake a stop.
    expect(steerBtn.disabled).toBe(true);
    expect(interruptBtn.disabled).toBe(true);
    // Each names the exact gated door it will reach when live.
    expect(steerBtn.getAttribute('title') ?? '').toContain('signal_session{steer}');
    expect(interruptBtn.getAttribute('title') ?? '').toContain('signal_session{interrupt}');
  });

  it('clicking the disabled controls emits no session_signaled and adds no feed row', () => {
    const { container } = render(<MoldingSurface />);
    const before = container.querySelectorAll('[data-mm-id^="echo-"]').length;
    const footer = container.querySelector<HTMLElement>('footer') as HTMLElement;
    const scope = within(footer);

    // A disabled button ignores clicks; assert it regardless — no new feed line,
    // and nothing anywhere claims a signal was delivered.
    fireEvent.click(scope.getByLabelText(/^steer/i));
    fireEvent.click(scope.getByLabelText(/^interrupt/i));

    const after = container.querySelectorAll('[data-mm-id^="echo-"]').length;
    expect(after).toBe(before);
    expect((container.textContent ?? '').toLowerCase()).not.toContain('not delivered');
    // The word appears only as a door NAME in a control's title, never as a
    // delivered-signal claim in the feed.
    for (const echo of container.querySelectorAll('[data-mm-id^="echo-"]')) {
      expect(echo.textContent ?? '').not.toMatch(/session_signaled/i);
    }
  });
});
