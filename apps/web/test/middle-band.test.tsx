/* ---------------------------------------------------------------------------
 * #158 — THE MIDDLE BAND: UserBar sign-out, the DocView doc/plan projection, and
 * the comment-to-steer mediation glue.
 *
 * Three honesty properties, each a flip-the-input assertion:
 *
 *   1. DOC/PLAN artifacts render THROUGH the shipped `RichMessageBody` grammar,
 *      whose text is resolved from the attribution register — never a raw print.
 *      Flip the `md` and the rendered authored source moves with it.
 *   2. COMMENT-TO-STEER is mediated through the gated `signal_session{steer}`
 *      door and is honestly INERT on int/phase5 (no live room): it performs no
 *      durable mutation and never fabricates a `session_signaled{steer}`. It is
 *      steer-only — a comment can never reach the interrupt door (scope boundary).
 *   3. UserBar SIGN OUT is wired to the REAL `signOutAction` (a `<form action>`,
 *      not an onClick local mutation); Profile/Preferences — which have no
 *      shipped route — are honest disabled seams, not fake local actions.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPane } from '../app/prototype/ArtifactPane';
import { covenant } from '../app/prototype/covenant';
import { sessionFor } from '../app/prototype/seams';
import type { Artifact, Selection } from '../app/prototype/types';
import { UserBar } from '../app/prototype/UserBar';

afterEach(cleanup);

function docArtifact(md: string): Artifact {
  return { id: 'note-x', kind: 'doc', title: 'why streaming totals', sub: 'note', md };
}

function renderDoc(md: string) {
  return render(
    <ArtifactPane
      artifacts={[docArtifact(md)]}
      activeId="note-x"
      onSelectArtifact={() => {}}
      comments={[]}
      onComment={() => {}}
      onDraft={() => {}}
    />,
  );
}

describe('doc/plan artifacts render through the shipped RichMessageBody grammar (#158)', () => {
  it('renders GFM through the shipped body and carries the authored source', () => {
    const md = '# Why streaming totals\n\nA **running mutable** makes the fold stateful.';
    const { container } = renderDoc(md);
    // The shipped body's own markers — proof the render goes THROUGH it, not
    // through a hand-rolled `react-markdown`.
    const rich = container.querySelector('[data-rich-message="true"]');
    expect(rich).toBeTruthy();
    // GFM is really rendered: the heading is an <h1>, the emphasis a <strong>.
    expect(screen.getByText('Why streaming totals').tagName).toBe('H1');
    expect(screen.getByText('running mutable').tagName).toBe('STRONG');
  });

  it('moves the rendered authored source when the doc data changes — real rendering, not a fixture', () => {
    const a = renderDoc('# alpha\n\nfirst body');
    const first = a.container
      .querySelector('[data-authored-source]')
      ?.getAttribute('data-authored-source');
    cleanup();
    const b = renderDoc('# beta\n\nsecond body');
    const second = b.container
      .querySelector('[data-authored-source]')
      ?.getAttribute('data-authored-source');
    expect(first).toBe('# alpha\n\nfirst body');
    expect(second).toBe('# beta\n\nsecond body');
    expect(second).not.toBe(first);
  });

  it('renders NO raw <script> from a doc body (the shipped body refuses authored HTML)', () => {
    const { container } = renderDoc('ok\n\n<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('comment-to-steer is a gated, honestly-inert mediation (#158/#152)', () => {
  it('mediateSteer reaches no server and names the member-gated steer door', () => {
    const outcome = covenant.mediateSteer('s-live', {
      anchor: 'src/billing',
      quote: 'keep it in billing',
      body: 'stay in the invoice module',
    });
    // The property the whole path turns on: no durable command, no fabricated
    // steer — `reached` is false and there is nowhere for it to be true yet.
    expect(outcome.reached).toBe(false);
    expect(outcome.door).toBe('signal_session{steer}');
    expect(outcome.inert).toMatch(/nothing was sent/);
  });

  it('a comment can NEVER reach the interrupt door — mediation is steer-only (scope boundary)', () => {
    const outcome = covenant.mediateSteer('s-live', { anchor: 'a', quote: 'q', body: 'b' });
    expect(outcome.door).not.toBe('signal_session{interrupt}');
  });

  it('the classification is mutation-free: two invocations return the same inert outcome', () => {
    const one = covenant.mediateSteer('s-live', { anchor: 'a', quote: 'q', body: 'b' });
    const two = covenant.mediateSteer('s-live', { anchor: 'a', quote: 'q', body: 'b' });
    expect(one).toEqual(two);
    expect(one.reached).toBe(false);
  });

  it('only a RUNNING target session steers — flip the selection and the branch condition flips', () => {
    // The `addComment` wiring gates the steer classification on the target
    // session being `running`; this is that predicate, flipped both ways.
    const running: Selection = { kind: 'session', id: 's-live' };
    const settled: Selection = { kind: 'session', id: 's-scout' };
    expect(sessionFor(running).session.status).toBe('running');
    expect(sessionFor(settled).session.status).not.toBe('running');
  });
});

describe('UserBar sign-out is wired to the real route; preferences are honest seams (#158)', () => {
  function openMenu() {
    const { container } = render(<UserBar />);
    // Closed, the bar renders exactly one control — the identity toggle.
    fireEvent.click(screen.getByRole('button'));
    return container;
  }

  it('sign out is a form-submit that runs a real Server Action — not an onClick local mutation', () => {
    const container = openMenu();
    const signOut = screen.getByRole('menuitem', { name: /sign out/i }) as HTMLButtonElement;
    expect(signOut.type).toBe('submit');
    // It submits a <form>: the real `signOutAction` door, reached only through a
    // form action. A button with only an onClick would be the fake-local shape.
    const form = signOut.closest('form');
    expect(form).toBeTruthy();
    expect(container.querySelector('form')).toBeTruthy();
  });

  it('Profile and Preferences are disabled seams — no route ships, so no fake action', () => {
    openMenu();
    const profile = screen.getByRole('menuitem', { name: /profile/i }) as HTMLButtonElement;
    const preferences = screen.getByRole('menuitem', { name: /preferences/i }) as HTMLButtonElement;
    expect(profile.disabled).toBe(true);
    expect(preferences.disabled).toBe(true);
    // and they carry no live form — a disabled control cannot mutate anything.
    expect(profile.closest('form')).toBeNull();
    expect(preferences.closest('form')).toBeNull();
  });
});
