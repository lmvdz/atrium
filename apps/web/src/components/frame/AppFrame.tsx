'use client';

/* ---------------------------------------------------------------------------
 * AppFrame — rail | workspace | lens, plus the 52px workspace strip.
 *
 * The corpus's rule: never render a component in isolation. Everything in this
 * library is designed to be seen inside this frame, which is why the gallery
 * renders full frames rather than a swatch board.
 *
 * The four holes are `Slot`s, not `ReactNode`s. Round 1: an unrestricted
 * `ReactNode` slot let a consumer hand `<q>invented words</q>` through the
 * frame with no cast, which is the whole no-synthesized-speech model routed
 * around. See model/slot.ts for what the slot stops and what it does not.
 * ------------------------------------------------------------------------- */

import { useState } from 'react';
import { systemText } from '../model/quotation';
import type { Slot } from '../model/slot';
import styles from './frame.module.css';

export interface AppFrameProps {
  /** the 52px strip: workspace tile, spacer, theme control, you */
  readonly strip: Slot;
  readonly rail: Slot;
  readonly workspace: Slot;
  readonly lens: Slot;
  /**
   * The gallery boxes frames at a fixed size instead of the viewport, so a full
   * frame can sit inside a scrolling page and still be a full frame.
   */
  readonly boxed?: boolean;
  readonly label?: string;
  /**
   * Whether the room rail starts unfolded. Folded is the v8 default and stays
   * the default here; this exists so a gallery still can put the OPEN canvas on
   * record. A state reachable in one click that no still ever shows is a state
   * nobody reviews — and three of the six registered non-text graphics live in
   * that column, so it is also the difference between measuring them and not.
   */
  readonly railOpen?: boolean;
}

/**
 * The narrowest window this shell fits in, in CSS pixels.
 *
 * ONE NUMBER, IN TWO PLACES THAT ARE CHECKED AGAINST EACH OTHER. `.app` declares
 * `min-width: 1280px`; this states it to the reader. `test/viewport.test.tsx`
 * reads both out of the sources and asserts they agree, and that the media query
 * which reveals the notice sits exactly one pixel below — a floor that moves
 * while the sentence stays put is a sentence that lies.
 *
 * THE FLOOR IS MEASURED, NOT DECLARED. The v8 batch set this to 1340 and the
 * browser audit then reported every element on the page ending at exactly 1340
 * in a 1280 viewport — the offenders inherited this container's own `min-width`,
 * so the number WAS the overflow. The grid is `44px minmax(0, 1fr) 300px`: 344
 * fixed pixels, leaving 936 fluid at 1280, more than the 680 the pre-v8 shell
 * lived on at 1024 while also carrying a 190px rail. The audit at 1280 is what
 * makes this number true; if you move it, move it because the audit said so.
 */
export const MINIMUM_WIDTH = 1280;

export function AppFrame({
  strip,
  rail,
  workspace,
  lens,
  boxed = false,
  label,
  railOpen: railOpenInitial = false,
}: AppFrameProps) {
  /* THE FOLD IS A CONTROL, NOT A COMMENT.
     v8 folds the room rail by default, and the batch that adopted v8 shipped
     that as `display: none` with a comment promising the affordance "will return
     through the V8 fold affordance". It did not return, so inside a room there
     was no way to reach another room at all — a person had to leave for the
     workspace page — and every check that drove the rail timed out against a
     button that was in the DOM and could never be seen. A hidden column with no
     control to open it is not a folded rail; it is a deleted one with the markup
     still in the page, which also means assistive technology still finds it.
     Folded is the default, so the v8 canvas is what the reader gets first. */
  const [railOpen, setRailOpen] = useState(railOpenInitial);
  return (
    <>
      {/* THE FLOOR, STATED — r8 D10. Below the floor the shell is wider than the
          window and the page scrolls sideways; that was true before this notice
          and nothing said it. The page still works and still scrolls: this is
          the shell declaring its own bound, the same way every refusal in this
          codebase says what it could not do rather than going quiet. See
          frame.module.css, `.belowMin`. */}
      <div className={styles.belowMin} data-below-minimum-width={String(MINIMUM_WIDTH)}>
        this layout needs a window at least {MINIMUM_WIDTH} pixels wide — the three columns are
        wider than this one, so the page scrolls sideways
      </div>
      <div
        className={[styles.app, railOpen ? styles.appRailOpen : null, boxed ? styles.boxed : null]
          .filter(Boolean)
          .join(' ')}
        data-frame={label ?? 'atrium'}
        data-rail={railOpen ? 'open' : 'folded'}
      >
        <aside className={styles.ws} aria-label="Workspace">
          {/* `#` is this app's rooms mark already — `Rail`'s own room rows carry
              it — so the control is drawn in the vocabulary the page uses rather
              than in a new one. The accessible name says which way the button
              goes; `aria-expanded` says which way it currently is. */}
          <button
            aria-expanded={railOpen}
            aria-label={railOpen ? 'Hide rooms and participants' : 'Show rooms and participants'}
            className={styles.railFold}
            onClick={() => setRailOpen((open) => !open)}
            type="button"
          >
            <span aria-hidden="true">#</span>
          </button>
          {strip.node}
        </aside>
        {rail.node}
        <main className={styles.center}>{workspace.node}</main>
        {lens.node}
      </div>
    </>
  );
}

export interface WorkspaceTileProps {
  readonly code: string;
  readonly title: string;
}

export function WorkspaceMark() {
  return (
    <svg
      aria-label="Atrium"
      className={styles.wsMark}
      fill="none"
      role="img"
      stroke="currentColor"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <path d="M12 3 3 9v12h18V9l-9-6Z" />
      <path d="M12 3v18M3 9h18" />
    </svg>
  );
}

export function WorkspaceTile({ code, title }: WorkspaceTileProps) {
  return (
    <div className={styles.wsTile} title={systemText(title, 'WorkspaceTile title')}>
      {systemText(code, 'WorkspaceTile code')}
    </div>
  );
}

export function WorkspaceSpacer() {
  return <div className={styles.wsSpacer} />;
}

export interface WorkspaceYouProps {
  readonly initials: string;
  readonly title: string;
}

export function WorkspaceYou({ initials, title }: WorkspaceYouProps) {
  return (
    <div className={styles.wsYou} title={systemText(title, 'WorkspaceYou title')}>
      {systemText(initials, 'WorkspaceYou')}
    </div>
  );
}
