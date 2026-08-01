'use client';

/* ---------------------------------------------------------------------------
 * AppFrame — rail | workspace | lens, plus the 52px workspace strip.
 *
 * The corpus's rule: never render a component in isolation. Everything in this
 * library is designed to be seen inside this frame, which is why the gallery
 * renders full frames rather than a swatch board.
 * ------------------------------------------------------------------------- */

import type { ReactNode } from 'react';
import styles from './frame.module.css';

export interface AppFrameProps {
  /** the 52px strip: workspace tile, spacer, theme control, you */
  readonly strip: ReactNode;
  readonly rail: ReactNode;
  readonly workspace: ReactNode;
  readonly lens: ReactNode;
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
        {strip}
      </aside>
      {rail}
      <main className={styles.center}>{workspace}</main>
      {lens}
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
