'use client';

/* USER BAR — who you are, at the foot of the left pane. Click for the account
   menu (profile / preferences / sign out). This is the prototype's own identity
   affordance, replacing the global top bar.

   #151 marriage table: UserBar is **port shell, wire routes** (#158). The shell
   is the design's; identity + the sign-out/preferences routes are the seam #158
   binds to `ControlPlane` identity + real routes. */

import { useEffect, useRef, useState } from 'react';
/* The REAL, reachable sign-out door: the `signOutAction` Server Action the
   shipped top-bar (`app/account-bar.tsx`) already uses. It calls
   `auth().api.signOut()` and redirects to `/sign-in`, terminating the session on
   the server — no auth token ever near the client bundle. A client component may
   hand a Server Action to a `<form action>`, so this is a genuine wiring, not a
   local mutation (#158). */
import { signOutAction } from '../(auth)/actions';
import { IconSettings, IconSignOut, IconUpDown, IconUser } from './icons';
import styles from './prototype.module.css';

export function UserBar() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={styles.userBar} ref={wrapRef}>
      {open ? (
        <div className={styles.userMenu} role="menu" aria-label="account">
          <div className={styles.userMenuHead}>
            {/* SEAM(#158): bind to real identity (initials + name + email from `ControlPlane`). */}
            <span className={`${styles.face} ${styles.faceHuman}`} aria-hidden>
              op
            </span>
            <div className={styles.userMenuId}>
              <span className={styles.userName}>Operator</span>
              <span className={styles.userEmail}>operator@atrium.dev</span>
            </div>
          </div>
          {/* Profile / Preferences have NO shipped route yet, so they are HONEST
              SEAMS — disabled, labelled, and inert — never a fake local action.
              SEAM(#168 go-live): MUST call the real preferences/profile route
              once one exists; wire like sign-out below, do not flip local state. */}
          <button
            type="button"
            className={styles.userMenuItem}
            role="menuitem"
            disabled
            aria-disabled
            title="not yet wired — no preferences route ships yet (#168)"
          >
            <IconUser size={14} />
            Profile
          </button>
          <button
            type="button"
            className={styles.userMenuItem}
            role="menuitem"
            disabled
            aria-disabled
            title="not yet wired — no preferences route ships yet (#168)"
          >
            <IconSettings size={14} />
            Preferences
          </button>
          <div className={styles.userMenuDiv} />
          {/* Sign out is WIRED to the real gated door: the `signOutAction` Server
              Action ends the session on the server and redirects to `/sign-in`.
              A `<form action>` submit, not an `onClick` local mutation. */}
          <form action={signOutAction} className={styles.userMenuForm}>
            <button
              type="submit"
              className={`${styles.userMenuItem} ${styles.userMenuDanger}`}
              role="menuitem"
            >
              <IconSignOut size={14} />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
      <button
        type="button"
        className={styles.userBtn}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* SEAM(#158): bind to real identity. */}
        <span className={`${styles.face} ${styles.faceHuman}`} aria-hidden>
          op
        </span>
        <span className={styles.userMeta}>
          <span className={styles.userName}>Operator</span>
          <span className={styles.userSub}>you · online</span>
        </span>
        <span className={styles.grow} />
        <span className={styles.userCaret}>
          <IconUpDown size={12} />
        </span>
      </button>
    </div>
  );
}
