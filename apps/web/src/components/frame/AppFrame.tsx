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
}

export function AppFrame({ strip, rail, workspace, lens, boxed = false, label }: AppFrameProps) {
  return (
    <div
      className={[styles.app, boxed ? styles.boxed : null].filter(Boolean).join(' ')}
      data-frame={label ?? 'atrium'}
    >
      <aside className={styles.ws} aria-label="Workspace">
        {strip.node}
      </aside>
      {rail.node}
      <main className={styles.center}>{workspace.node}</main>
      {lens.node}
    </div>
  );
}

export interface WorkspaceTileProps {
  readonly code: string;
  readonly title: string;
}

export function WorkspaceTile({ code, title }: WorkspaceTileProps) {
  return (
    <div className={styles.wsTile} title={title}>
      {code}
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
    <div className={styles.wsYou} title={title}>
      {initials}
    </div>
  );
}
