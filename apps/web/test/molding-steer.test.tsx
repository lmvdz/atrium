/* ---------------------------------------------------------------------------
 * #157 round-2 — THE STEER PATH, RENDERED, CANNOT SHOW A FAKE STOP.
 *
 * Round 1 killed the mock-stream FREEZE but left two render-level residuals the
 * seam-only tests could not see, because nothing rendered `MoldingSurface`:
 *
 *   D1 — submitting "@hexi stop" appended `→ @hexi stop` as an ordinary authored
 *        message BEFORE any covenant call, so a single action showed a
 *        sent-looking stop with no durable command behind it. The "NOT delivered"
 *        disclosure only arrived on a second composer step.
 *   residual 3 — the composer routed EVERY cue to `covenant.interrupt`, so a
 *        "steer" reached the interrupt door.
 *
 * These tests DRIVE the real surface. They go RED if either regresses: if the
 * first action ever renders the steer as an authored/sent message (a frozen
 * stream or a `→ @hexi stop` row) instead of a NOT-delivered system notice, or
 * if a steer cue reaches the interrupt door.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('the steer path never shows a sent-looking stop (#157 r2 D1)', () => {
  it('renders the very first "@hexi stop" as a NOT-delivered system notice, not an authored message', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, '@hexi stop');

    const echo = container.querySelector<HTMLElement>('[data-mm-id="echo-0"]');
    expect(echo).toBeTruthy();
    const row = echo as HTMLElement;

    // The one thing the whole defect turns on: the FIRST action is a system
    // NOT-delivered notice, never an authored ("human") row. A reintroduced
    // fake-stop appends the cue as a `said` echo → `data-mm-kind="human"` and a
    // `data-row="message"` — both asserted absent here.
    expect(row.getAttribute('data-mm-kind')).toBe('system');
    expect(row.querySelector('[data-row="system"]')).toBeTruthy();
    expect(row.querySelector('[data-row="message"]')).toBeNull();

    // And it says so in words, immediately — no second composer step required.
    expect((row.textContent ?? '').toLowerCase()).toContain('not delivered');
  });

  it('never renders a sent-looking "→ @hexi stop" delegation row for the steer cue', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, '@hexi stop');

    // A `→ @hexi …` authored delegation row is exactly the sent-looking stop the
    // ticket forbids. No message row may carry it.
    for (const messageRow of container.querySelectorAll('[data-row="message"]')) {
      expect(messageRow.textContent ?? '').not.toMatch(/→\s*@?hexi\s+stop/i);
    }
  });
});

describe('a steer cue reaches steer, a stop cue reaches interrupt (#157 r2 residual 3)', () => {
  it('routes "@hexi steer …" through the steer door', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, '@hexi steer toward billing'); // opens the steer composer
    submit(container, 'keep it in the invoice module'); // sends the drafted reason

    // The refused notice names the door the drafted send actually reached.
    expect(container.textContent ?? '').toMatch(
      /steer not delivered[\s\S]*signal_session\{steer\}/i,
    );
    expect(container.textContent ?? '').not.toMatch(/signal_session\{interrupt\}/i);
  });

  it('routes "@hexi stop" through the interrupt door', () => {
    const { container } = render(<MoldingSurface />);
    submit(container, '@hexi stop'); // opens the interrupt composer
    submit(container, 'you are off scope'); // sends the drafted reason

    expect(container.textContent ?? '').toMatch(
      /interrupt not delivered[\s\S]*signal_session\{interrupt\}/i,
    );
  });
});
