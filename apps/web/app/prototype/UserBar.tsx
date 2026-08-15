'use client';

/* USER BAR — who you are, at the foot of the left pane. Click for the account
   menu (profile / preferences / sign out). This is the prototype's own identity
   affordance, replacing the global top bar.

   #151 marriage table: UserBar is **port shell, wire routes** (#158). The shell
   is the design's; identity + the sign-out/preferences routes are the seam #158
   binds to `ControlPlane` identity + real routes. */

import { useEffect, useRef, useState } from 'react';
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
          {/* SEAM(#158): wire to a real preferences/profile route. */}
          <button
            type="button"
            className={styles.userMenuItem}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <IconUser size={14} />
            Profile
          </button>
          <button
            type="button"
            className={styles.userMenuItem}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <IconSettings size={14} />
            Preferences
          </button>
          <div className={styles.userMenuDiv} />
          {/* SEAM(#158): wire to the real sign-out action. */}
          <button
            type="button"
            className={`${styles.userMenuItem} ${styles.userMenuDanger}`}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <IconSignOut size={14} />
            Sign out
          </button>
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
